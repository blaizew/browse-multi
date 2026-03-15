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
  sessionsDir, sessionFilePath
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
      },
      required: ['name'],
    },
  },
  {
    name: 'browse_stop',
    description: 'Stop a browse-multi instance or all instances.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name to stop. Omit to stop all.' },
      },
    },
  },
  {
    name: 'browse_status',
    description: 'List all running browse-multi instances with port, PID, and health status.',
    inputSchema: { type: 'object', properties: {} },
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

async function handleStart({ name, session, headed = true }) {
  if (!name) throw new Error('name is required');

  // Check if already running
  const existing = readState(name);
  if (existing) {
    const health = await healthCheck(existing.port);
    if (health && health.ok) {
      return { text: `Instance "${name}" already running on port ${existing.port} (uptime: ${health.uptime}s)` };
    }
    deleteState(name);
  }

  // Allocate port
  const port = allocatePort();
  if (!port) {
    throw new Error('No free ports in 9400-9420 range. Run browse_status to see running instances.');
  }

  const token = generateToken();
  writeStateAtomic(name, { port, token, pid: null, startedAt: new Date().toISOString() });

  // Spawn server
  const serverArgs = ['--name', name, '--port', String(port), '--token', token];
  if (session) serverArgs.push('--session', session);
  if (headed) serverArgs.push('--headed');

  const child = spawn('node', [SERVER_SCRIPT, ...serverArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(__dirname, 'browsers') },
  });
  child.unref();

  writeStateAtomic(name, { port, token, pid: child.pid, startedAt: new Date().toISOString() });

  // Wait for ready
  const ready = await waitForReady(port);
  if (!ready) {
    deleteState(name);
    throw new Error('Server failed to start within 10s. Check logs in state directory.');
  }

  return { text: `Started "${name}" on port ${port} (pid: ${child.pid}). Use browse-multi commands in Bash now.` };
}

async function handleStop({ name } = {}) {
  if (!name) {
    // Stop all
    const states = listAllStates();
    if (states.length === 0) return { text: 'No running instances.' };
    const results = [];
    for (const s of states) {
      try {
        await sendCommand(s.port, s.token, 'stop', []);
        results.push(`Stopped: ${s.name}`);
      } catch {
        deleteState(s.name);
        results.push(`${s.name}: cleaned up stale state`);
      }
    }
    return { text: results.join('\n') };
  }

  const state = readState(name);
  if (!state) return { text: `No instance named "${name}" is running.` };

  const health = await healthCheck(state.port);
  if (!health || !health.ok) {
    deleteState(name);
    return { text: `Cleaned up stale state for "${name}".` };
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
    const status = health && health.ok ? `UP (uptime: ${health.uptime}s)` : 'DEAD';
    lines.push(`${s.name}\tport:${s.port}\tpid:${s.pid}\t${status}`);
    if (status === 'DEAD') deleteState(s.name);
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

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleMessage(JSON.parse(line));
  } catch {
    // Malformed JSON — ignore
  }
});

// Keep process alive
process.stdin.resume();
