// browse-multi-server.js — HTTP daemon for a single browser instance
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { writeFileSync, appendFileSync, statSync, truncateSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stateFilePath, logFilePath, deleteState } from './lib/instance.js';

// Set browser path BEFORE dynamically importing playwright (static imports hoist above this)
const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH = join(__dirname, 'browsers');

const { chromium } = await import('playwright');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const NAME = getArg('name');
const PORT = parseInt(getArg('port'), 10);
const TOKEN = getArg('token');
const SESSION = getArg('session');
const HEADED = args.includes('--headed');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LOG_BYTES = 1024 * 1024; // 1MB

if (!NAME || !PORT || !TOKEN) {
  console.error('Usage: browse-multi-server.js --name <n> --port <p> --token <t> [--session <file>] [--headed]');
  process.exit(1);
}

// Logging
const LOG_PATH = logFilePath(NAME);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const stats = statSync(LOG_PATH).size;
    if (stats > MAX_LOG_BYTES) truncateSync(LOG_PATH, 0);
  } catch {}
  appendFileSync(LOG_PATH, line);
}

// Browser + context
let browser, context, page;
const startTime = Date.now();
let lastCommandTime = Date.now();

// Ring buffers for console/network
const MAX_BUFFER = 500;
let consoleBuffer = [];
let consoleTotalCount = 0;
let networkBuffer = [];
let networkTotalCount = 0;

// @ref map
let refMap = new Map();
let refCounter = 0;

function clearRefs() {
  refMap.clear();
  refCounter = 0;
}

function clearBuffers() {
  consoleBuffer = [];
  consoleTotalCount = 0;
  networkBuffer = [];
  networkTotalCount = 0;
}

// Command registry — commands will register themselves here
const commands = {};

export function registerCommand(name, handler) {
  commands[name] = handler;
}

export function getServerState() {
  return { browser, context, page, refMap, refCounter, consoleBuffer, consoleTotalCount, networkBuffer, networkTotalCount, NAME };
}

export function setPage(p) {
  page = p;
  // Re-wire console/network listeners on new page
  page.on('console', msg => {
    pushConsole({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
  });
  page.on('response', response => {
    pushNetwork({
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      timestamp: Date.now(),
    });
  });
}
export function setRefMap(map, counter) { refMap = map; refCounter = counter; }
export function pushConsole(entry) {
  consoleTotalCount++;
  consoleBuffer.push(entry);
  if (consoleBuffer.length > MAX_BUFFER) consoleBuffer.shift();
}
export function pushNetwork(entry) {
  networkTotalCount++;
  networkBuffer.push(entry);
  if (networkBuffer.length > MAX_BUFFER) networkBuffer.shift();
}

// Register all command modules
import { register as registerNavigation } from './commands/navigation.js';
import { register as registerContent } from './commands/content.js';
import { register as registerInteraction } from './commands/interaction.js';
import { register as registerInspection } from './commands/inspection.js';
import { register as registerVisual } from './commands/visual.js';
import { register as registerTabs } from './commands/tabs.js';
import { register as registerSession } from './commands/session.js';

registerNavigation(registerCommand);
registerContent(registerCommand);
registerInteraction(registerCommand);
registerInspection(registerCommand);
registerVisual(registerCommand);
registerTabs(registerCommand);
registerSession(registerCommand);

async function startup() {
  log(`Starting: port=${PORT} pid=${process.pid} session=${SESSION || 'none'}`);

  browser = await chromium.launch({ headless: !HEADED });

  // On macOS, send headed browser windows to background so they don't steal focus
  // Skip for login instances — user needs to interact with the window
  if (HEADED && process.platform === 'darwin' && !NAME.startsWith('login-')) {
    setTimeout(() => {
      try {
        execFileSync('osascript', ['-e', 'tell application "System Events" to set visible of process "Chromium" to false'], { timeout: 3000 });
        log('Sent Chromium window to background');
      } catch {}
    }, 1500);
  }

  const contextOpts = {};
  if (SESSION) contextOpts.storageState = SESSION;
  context = await browser.newContext(contextOpts);

  page = await context.newPage();

  // Capture console messages
  page.on('console', msg => {
    pushConsole({ type: msg.type(), text: msg.text(), timestamp: Date.now() });
  });

  // Capture network requests
  page.on('response', response => {
    pushNetwork({
      url: response.url(),
      status: response.status(),
      method: response.request().method(),
      timestamp: Date.now(),
    });
  });

  // Browser disconnect handler
  browser.on('disconnected', () => {
    log('Chromium disconnected unexpectedly');
    deleteState(NAME);
    process.exit(1);
  });

  // HTTP server
  const server = http.createServer(async (req, res) => {
    // Health check — no auth required
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: NAME, uptime: Math.floor((Date.now() - startTime) / 1000) }));
      return;
    }

    // All other requests need auth
    if (req.method !== 'POST' || req.url !== '/command') {
      res.writeHead(404);
      res.end();
      return;
    }

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }

    // Parse body
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      lastCommandTime = Date.now();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const { command: cmd, args: cmdArgs = [] } = parsed;
      const cmdStart = Date.now();

      if (cmd === 'stop') {
        log(`Command: stop (shutting down)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: 'Shutting down' }));
        await shutdown('stop command');
        return;
      }

      const handler = commands[cmd];
      if (!handler) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Unknown command: ${cmd}` }));
        log(`Command: ${cmd} — UNKNOWN (${Date.now() - cmdStart}ms)`);
        return;
      }

      try {
        const result = await handler(cmdArgs, { page, context, browser, refMap, refCounter, clearRefs, clearBuffers, setPage, setRefMap, pushConsole, pushNetwork, consoleBuffer, consoleTotalCount, networkBuffer, networkTotalCount, NAME });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
        log(`Command: ${cmd} — OK (${Date.now() - cmdStart}ms)`);
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        log(`Command: ${cmd} — ERROR: ${err.message} (${Date.now() - cmdStart}ms)`);
      }
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    log(`HTTP server listening on 127.0.0.1:${PORT}`);
  });

  // Idle timer
  const idleCheck = setInterval(() => {
    if (Date.now() - lastCommandTime > IDLE_TIMEOUT_MS) {
      log('Idle timeout reached');
      clearInterval(idleCheck);
      shutdown('idle timeout');
    }
  }, 60000);

  // Graceful shutdown on signals
  async function shutdown(reason) {
    log(`Shutdown: reason=${reason} uptime=${Math.floor((Date.now() - startTime) / 1000)}s`);
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    deleteState(NAME);
    server.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startup().catch(err => {
  log(`Startup failed: ${err.message}`);
  deleteState(NAME);
  process.exit(1);
});
