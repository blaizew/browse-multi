#!/usr/bin/env node
// browse-multi-mcp.js
// Minimal MCP server (stdio, JSON-RPC 2.0) for browse-multi lifecycle.
// Runs OUTSIDE the sandbox — can launch Chromium.
// Agents use this to start/stop instances, then send commands via Bash (HTTP).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import {
  readState, allocatePort, generateToken, writeStateAtomic,
  deleteState, healthCheck, waitForReady, sendCommand, listAllStates,
  sessionsDir, sessionFilePath, resolvePath, pidAlive, isReachable
} from './lib/instance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'browse-multi-server.js');

// --- MCP Protocol (stdio JSON-RPC 2.0, newline-delimited) ---

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'browse_start',
    description: 'Start a browse-multi Chromium instance. Must be called before using browse-multi commands in Bash. Each agent needs its own unique name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name (unique per agent, e.g. "agent1", "research")' },
        session: { type: 'string', description: 'Path to session/cookie file for authenticated browsing (e.g. ~/.claude/sessions/x.com.json)' },
        headed: { type: 'boolean', description: 'Show browser window (default: true). Pass false for headless.' },
        viewport: { type: 'string', description: 'Viewport size as "WIDTHxHEIGHT" (e.g. "1920x1080"). Default: 1920x1080.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'browse_stop',
    description: 'Stop a browse-multi instance by name. To stop EVERY instance (across all sessions — instances are a shared pool), pass all:true explicitly. Omitting both is an error, so a stray call can never tear down other sessions\' browsers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name to stop.' },
        all: { type: 'boolean', description: 'Stop ALL instances across all sessions. Must be set true explicitly; there is no implicit stop-all.' },
      },
    },
  },
  {
    name: 'browse_status',
    description: 'List all running browse-multi instances with port, PID, and health status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browse_command',
    description: 'Send a command to a running browse-multi instance. Use this instead of CLI Bash commands — it runs outside the sandbox so localhost connections always work. Common commands: goto <url>, text [--limit N], screenshot [path], click <selector>, fill <selector> <value>, html [selector], snapshot, url, back, reload, scroll, js <expr>, console, network, tabs, newtab, closetab, stop.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name' },
        command: { type: 'string', description: 'Browse command (goto, text, screenshot, click, fill, html, snapshot, url, back, reload, scroll, js, console, network, tabs, newtab, closetab, stop, etc.)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (e.g. ["https://example.com"] for goto, ["#submit"] for click)' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'browse_login',
    description: 'Open a headed browser for the user to log into a site. After calling this, ask the user to log in, then call browse_login_complete to save the session.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to (e.g. https://x.com/login)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browse_login_complete',
    description: 'Export session cookies from a login instance, save to .claude/sessions/<domain>.json, and stop the instance. Call this after the user confirms they have logged in.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Login instance name (default: auto-detect login-* instance)' },
        domain: { type: 'string', description: 'Override domain name for the session file (default: extracted from current page URL)' },
      },
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'browse_start':
      return await handleStart(args);
    case 'browse_command':
      return await handleBrowseCommand(args);
    case 'browse_stop':
      return await handleStop(args);
    case 'browse_status':
      return await handleStatus();
    case 'browse_login':
      return await handleLogin(args);
    case 'browse_login_complete':
      return await handleLoginComplete(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleStart({ name, session, headed = true, viewport }) {
  if (!name) throw new Error('name is required');

  // Resolve tilde in session path
  const resolvedSession = resolvePath(session);

  // Check if already running
  const existing = readState(name);
  if (existing) {
    const health = await isReachable(existing.port);
    if (health && health.ok) {
      return { text: `Instance "${name}" already running on port ${existing.port} (uptime: ${health.uptime}s)` };
    }
    // Unreachable but pid still alive => busy/contended, not dead. Don't evict it or spawn a
    // duplicate on top of it (that races on its port). Only reclaim the name if the process is gone.
    if (pidAlive(existing.pid)) {
      return { text: `Instance "${name}" (pid ${existing.pid}) exists but isn't responding — likely busy/CPU-contended. Not starting a duplicate; retry shortly, or browse_stop "${name}" first.` };
    }
    deleteState(name);
  }

  // Retry loop — handles cross-session port collisions (different CC sessions
  // have separate MCP server processes, so they can race on port allocation)
  const MAX_ATTEMPTS = 3;
  const triedPorts = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Allocate port, skipping previously failed ports
    const port = allocatePort(triedPorts);
    if (!port) {
      throw new Error('No free ports in 9400-9420 range. Run browse_status to see running instances.');
    }

    // Pre-check: is something already listening on this port? (orphaned process)
    const preCheck = await healthCheck(port, 1000);
    if (preCheck && preCheck.ok) {
      triedPorts.add(port);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(`Port ${port} occupied by orphaned instance "${preCheck.name}". Kill pid manually or restart.`);
    }

    triedPorts.add(port);

    const token = generateToken();
    writeStateAtomic(name, { port, token, pid: null, startedAt: new Date().toISOString() });

    // Spawn server
    const serverArgs = ['--name', name, '--port', String(port), '--token', token];
    if (resolvedSession) serverArgs.push('--session', resolvedSession);
    if (headed) serverArgs.push('--headed');
    if (viewport) serverArgs.push('--viewport', viewport);

    const child = spawn('node', [SERVER_SCRIPT, ...serverArgs], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(__dirname, 'browsers') },
    });
    child.unref();

    writeStateAtomic(name, { port, token, pid: child.pid, startedAt: new Date().toISOString() });

    // Wait for ready
    const ready = await waitForReady(port);
    if (ready) {
      // Verify the server that responded is actually ours (not an orphaned process)
      const verify = await healthCheck(port, 2000);
      if (verify && verify.name === name) {
        return { text: `Started "${name}" on port ${port} (pid: ${child.pid}). Use browse_command to send commands.` };
      }
      // Wrong instance on this port — our server likely failed to bind
      deleteState(name);
      if (attempt < MAX_ATTEMPTS) continue;
      throw new Error(`Port ${port} occupied by orphaned instance "${verify?.name}". Kill pid manually or restart.`);
    }

    // Startup failed — clean up and retry with next port
    deleteState(name);
    if (attempt < MAX_ATTEMPTS) {
      continue;
    }
  }

  throw new Error(`Server failed to start after ${MAX_ATTEMPTS} attempts. Check logs in state directory.`);
}

async function handleBrowseCommand({ name, command, args = [] }) {
  if (!name) throw new Error('name is required');
  if (!command) throw new Error('command is required');

  const state = readState(name);
  if (!state) throw new Error(`Instance "${name}" not found. Start it first with browse_start.`);

  const health = await isReachable(state.port);
  if (!health) {
    // A single failed 2s probe is NOT proof of death — a busy/CPU-contended instance can miss it.
    // Only clean up when the process is actually gone; otherwise preserve state so a transient
    // blip can't orphan a live instance (the cross-session eviction bug).
    if (pidAlive(state.pid)) {
      throw new Error(`Instance "${name}" (pid ${state.pid}) is alive but not responding right now — likely busy or CPU-contended (e.g. several headed Chromes at once). State preserved; retry shortly.`);
    }
    deleteState(name);
    throw new Error(`Instance "${name}" process is gone (stale state cleaned up). Start it again with browse_start.`);
  }

  const result = await sendCommand(state.port, state.token, command, args);
  if (!result.ok) {
    throw new Error(result.error || `Command "${command}" failed`);
  }

  if (result.result === undefined || result.result === null) {
    return { text: 'OK' };
  }
  const text = typeof result.result === 'string'
    ? result.result
    : JSON.stringify(result.result, null, 2);
  // Sanitize lone surrogates to prevent JSON encoding errors in downstream API calls.
  // Lone surrogates (high without low, or low without high) are invalid in UTF-8/JSON
  // and cause "no low surrogate in string" errors when the agent's context is serialized.
  const sanitized = text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
  return { text: sanitized };
}

async function handleStop({ name, all } = {}) {
  if (!name && !all) {
    throw new Error('browse_stop needs a name (to stop one instance) or all:true (to stop EVERY instance across all sessions — instances are a shared pool). Refusing an implicit stop-all.');
  }
  if (all) {
    // Stop all — only on explicit all:true, never implicitly (it tears down other sessions too).
    const states = listAllStates();
    if (states.length === 0) return { text: 'No running instances.' };
    const results = [];
    for (const s of states) {
      try {
        await sendCommand(s.port, s.token, 'stop', []);
        results.push(`Stopped: ${s.name}`);
      } catch {
        if (pidAlive(s.pid)) { try { process.kill(s.pid); } catch {} }
        deleteState(s.name);
        results.push(`${s.name}: force-stopped / cleaned up`);
      }
    }
    return { text: results.join('\n') };
  }

  const state = readState(name);
  if (!state) return { text: `No instance named "${name}" is running.` };

  const health = await healthCheck(state.port);
  if (!health || !health.ok) {
    // Explicit stop: if the process is still alive but unresponsive, kill it so we don't leak an
    // orphaned Chrome, then clear state. (Unlike status/command, stop is meant to remove it.)
    if (pidAlive(state.pid)) { try { process.kill(state.pid); } catch {} }
    deleteState(name);
    return { text: `Cleaned up "${name}" (was unresponsive).` };
  }

  try {
    await sendCommand(state.port, state.token, 'stop', []);
    return { text: `Stopped: ${name}` };
  } catch {
    deleteState(name);
    return { text: `Force cleaned: ${name}` };
  }
}

async function handleStatus() {
  const states = listAllStates();
  if (states.length === 0) return { text: 'No running instances.' };

  const lines = [];
  for (const s of states) {
    const health = await healthCheck(s.port);
    let status;
    if (health && health.ok) status = `UP (uptime: ${health.uptime}s)`;
    else if (pidAlive(s.pid)) status = 'UNRESPONSIVE (pid alive — likely busy)';
    else status = 'DEAD (process gone — browse_stop to clean up)';
    // Read-only: status must never garbage-collect. Deleting here let any session evict another
    // session's busy instance on a transient health blip. Cleanup is now explicit (browse_stop).
    lines.push(`${s.name}\tport:${s.port}\tpid:${s.pid}\t${status}`);
  }
  return { text: lines.join('\n') };
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function handleLogin({ url }) {
  if (!url) throw new Error('url is required');

  const domain = extractDomain(url);
  if (!domain) throw new Error(`Invalid URL: ${url}`);

  const instanceName = `login-${domain}`;

  // Stop any existing login instance for this domain
  const existing = readState(instanceName);
  if (existing) {
    try { await sendCommand(existing.port, existing.token, 'stop', []); } catch {}
    deleteState(instanceName);
  }

  // Start a headed instance
  const result = await handleStart({ name: instanceName, headed: true });

  // Navigate to the URL
  const state = readState(instanceName);
  if (!state) throw new Error('Failed to start login instance');
  await sendCommand(state.port, state.token, 'goto', [url]);

  return {
    text: `Headed browser opened and navigated to ${url}.\n\nInstance: ${instanceName}\n\nPlease log in to ${domain} in the browser window. When you're done, the agent should call browse_login_complete to save your session.`
  };
}

async function handleLoginComplete({ name, domain: domainOverride } = {}) {
  // Find the login instance
  let instanceName = name;
  if (!instanceName) {
    // Auto-detect: find the first login-* instance
    const states = listAllStates();
    const loginState = states.find(s => s.name.startsWith('login-'));
    if (!loginState) throw new Error('No login instance found. Call browse_login first.');
    instanceName = loginState.name;
  }

  const state = readState(instanceName);
  if (!state) throw new Error(`No instance named "${instanceName}" is running.`);

  const health = await healthCheck(state.port);
  if (!health || !health.ok) {
    deleteState(instanceName);
    throw new Error(`Instance "${instanceName}" is not healthy. Start a new login.`);
  }

  // Get the current URL to extract domain
  const urlResult = await sendCommand(state.port, state.token, 'url', []);
  const currentUrl = urlResult.ok ? urlResult.result : null;
  const domain = domainOverride || (currentUrl ? extractDomain(currentUrl) : null) || instanceName.replace(/^login-/, '');

  // Export the session
  const sessionResult = await sendCommand(state.port, state.token, 'export-session', []);
  if (!sessionResult.ok) throw new Error('Failed to export session: ' + (sessionResult.error || 'unknown'));

  // Delete old session file if it exists
  const savePath = sessionFilePath(domain);
  try { unlinkSync(savePath); } catch {}

  // Save new session
  const sessionData = typeof sessionResult.result === 'string' ? sessionResult.result : JSON.stringify(sessionResult.result, null, 2);
  writeFileSync(savePath, sessionData);

  // Stop the login instance
  try {
    await sendCommand(state.port, state.token, 'stop', []);
  } catch {
    deleteState(instanceName);
  }

  return {
    text: `Session saved to ${savePath}\n\nDomain: ${domain}\nAgents can now use this session with:\n  browse_start(name: "myagent", session: "${savePath}")\n\nThe login browser has been closed.`
  };
}

// --- Message handler ---

async function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;
  if (jsonrpc !== '2.0') return;

  // Notifications (no id) — ignore
  if (id === undefined) return;

  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'browse-multi', version: '1.0.0' },
      });
      break;

    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const result = await handleToolCall(toolName, toolArgs);
        sendResult(id, { content: [{ type: 'text', text: result.text }] });
      } catch (err) {
        sendResult(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
      break;
    }

    case 'ping':
      sendResult(id, {});
      break;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

// Serialize message processing — prevents port allocation races when
// multiple agents call browse_start concurrently via the same MCP server.
const messageQueue = [];
let processing = false;

async function processQueue() {
  if (processing) return;
  processing = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    await handleMessage(msg);
  }
  processing = false;
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    messageQueue.push(JSON.parse(line));
    processQueue();
  } catch {
    // Malformed JSON — ignore
  }
});

// Keep process alive
process.stdin.resume();
