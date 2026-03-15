#!/usr/bin/env node
// browse-multi.js — CLI client for browse-multi
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readState, allocatePort, generateToken, writeStateAtomic,
  deleteState, healthCheck, waitForReady, sendCommand,
  listAllStates, stateFilePath
} from './lib/instance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'browse-multi-server.js');

// Parse args
const rawArgs = process.argv.slice(2);

// Extract --name
let name = null;
const nameIdx = rawArgs.indexOf('--name');
if (nameIdx !== -1 && nameIdx + 1 < rawArgs.length) {
  name = rawArgs[nameIdx + 1];
  rawArgs.splice(nameIdx, 2);
}

// Extract --session
let session = null;
const sessIdx = rawArgs.indexOf('--session');
if (sessIdx !== -1 && sessIdx + 1 < rawArgs.length) {
  session = rawArgs[sessIdx + 1];
  rawArgs.splice(sessIdx, 2);
}

// Extract --headless (default is headed)
let headed = true;
const headlessIdx = rawArgs.indexOf('--headless');
if (headlessIdx !== -1) {
  headed = false;
  rawArgs.splice(headlessIdx, 1);
}
// Legacy --headed flag (no-op, already default)
const headedIdx = rawArgs.indexOf('--headed');
if (headedIdx !== -1) {
  rawArgs.splice(headedIdx, 1);
}

const command = rawArgs[0];
const commandArgs = rawArgs.slice(1);

// Client-side commands that don't need --name
if (command === 'status') {
  await handleStatus();
  process.exit(0);
}

if (command === 'help' || !command) {
  printHelp();
  process.exit(0);
}

// stop --all doesn't need --name
if (command === 'stop' && (commandArgs.includes('--all') || rawArgs.includes('--all'))) {
  await handleStopAll();
  process.exit(0);
}

// login command — auto-generates name, starts headed, navigates
if (command === 'login') {
  const url = commandArgs[0];
  if (!url) {
    console.error('Usage: browse-multi login <url>');
    process.exit(1);
  }
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }
  const loginName = name || `login-${domain}`;
  await ensureServer(loginName, null, true);
  const loginState = readState(loginName);
  await sendCommand(loginState.port, loginState.token, 'goto', [url]);
  console.log(`Headed browser opened at ${url}`);
  console.log(`Instance: ${loginName}`);
  console.log(`\nLog in to ${domain}, then run:`);
  console.log(`  node ${process.argv[1]} --name ${loginName} save-session`);
  process.exit(0);
}

// All other commands require --name
if (!name) {
  console.error('Error: --name is required. Usage: browse-multi --name <instance> <command> [args...]');
  process.exit(1);
}

// start command — explicitly start an instance without sending a browser command
if (command === 'start') {
  await ensureServer(name, session, headed);
  console.log(`Instance ${name} started.`);
  process.exit(0);
}

// stop — only send if server exists, don't auto-start
if (command === 'stop') {
  const state = readState(name);
  if (!state) {
    console.log(`No instance named "${name}" is running.`);
    process.exit(0);
  }
  const health = await healthCheck(state.port);
  if (!health || !health.ok) {
    deleteState(name);
    console.log(`Cleaned up stale state for "${name}".`);
    process.exit(0);
  }
  try {
    await sendCommand(state.port, state.token, 'stop', []);
    console.log(`Stopped: ${name}`);
  } catch {
    deleteState(name);
    console.log(`Force cleaned: ${name}`);
  }
  process.exit(0);
}

// For eval command, read code from stdin
if (command === 'eval') {
  if (process.stdin.isTTY) {
    console.error('Usage: echo "code" | browse-multi --name <n> eval');
    process.exit(1);
  }
  let stdinData = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    stdinData += chunk;
  }
  commandArgs[0] = stdinData;
}

// For chain command, read JSON from stdin
if (command === 'chain') {
  if (process.stdin.isTTY) {
    console.error('Usage: echo \'[["goto","url"],["text"]]\' | browse-multi --name <n> chain');
    process.exit(1);
  }
  let stdinData = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    stdinData += chunk;
  }
  // Parse and execute chain
  const state = await ensureServer(name, session, headed);
  let steps;
  try { steps = JSON.parse(stdinData); } catch { console.error('Invalid JSON on stdin'); process.exit(1); }
  let timeoutMs = 300000; // 5 min default
  const tIdx = rawArgs.indexOf('--timeout');
  if (tIdx !== -1 && rawArgs[tIdx + 1]) timeoutMs = parseInt(rawArgs[tIdx + 1], 10);
  const deadline = Date.now() + timeoutMs;

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ step: i, command: steps[i][0], ok: false, error: 'Chain timeout' }));
      process.exit(1);
    }
    const [cmd, ...cArgs] = steps[i];
    try {
      const result = await sendCommand(state.port, state.token, cmd, cArgs);
      console.log(JSON.stringify({ step: i, command: cmd, ok: result.ok, result: result.result, error: result.error }));
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.log(JSON.stringify({ step: i, command: cmd, ok: false, error: err.message }));
      process.exit(1);
    }
  }
  process.exit(0);
}

// Ensure server is running
const state = await ensureServer(name, session, headed);

// Send command
try {
  const result = await sendCommand(state.port, state.token, command, commandArgs);
  if (result.ok) {
    if (result.result !== undefined && result.result !== null) {
      console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2));
    }
    process.exit(0);
  } else {
    console.error(result.error || 'Command failed');
    process.exit(1);
  }
} catch (err) {
  // Server might have died — try once to recover
  deleteState(name);
  try {
    const newState = await ensureServer(name, session, headed);
    const retryResult = await sendCommand(newState.port, newState.token, command, commandArgs);
    if (retryResult.ok) {
      if (retryResult.result !== undefined && retryResult.result !== null) {
        console.log(typeof retryResult.result === 'string' ? retryResult.result : JSON.stringify(retryResult.result, null, 2));
      }
      process.exit(0);
    } else {
      console.error(retryResult.error || 'Command failed after retry');
      process.exit(1);
    }
  } catch (retryErr) {
    console.error(`Server unreachable after retry: ${retryErr.message}`);
    process.exit(1);
  }
}

// --- Functions ---

async function ensureServer(instanceName, sessionFile, useHeaded) {
  // Check existing state
  let state = readState(instanceName);
  if (state) {
    const health = await healthCheck(state.port);
    if (health && health.ok) return state;
    // Stale state file
    deleteState(instanceName);
  }

  // Allocate port
  const port = allocatePort();
  if (!port) {
    console.error('No free ports in 9400-9420 range. Run `browse-multi status` to see running instances.');
    process.exit(1);
  }

  const token = generateToken();

  // Atomic claim
  writeStateAtomic(instanceName, { port, token, pid: null, startedAt: new Date().toISOString() });

  // Spawn server
  const serverArgs = ['--name', instanceName, '--port', String(port), '--token', token];
  if (sessionFile) serverArgs.push('--session', sessionFile);
  if (useHeaded) serverArgs.push('--headed');

  const child = spawn('node', [SERVER_SCRIPT, ...serverArgs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(__dirname, 'browsers') },
  });
  child.unref();

  // Update state with PID
  writeStateAtomic(instanceName, { port, token, pid: child.pid, startedAt: new Date().toISOString() });

  // Wait for server to be ready
  const ready = await waitForReady(port);
  if (!ready) {
    deleteState(instanceName);
    console.error('Server failed to start within 10s.');
    process.exit(1);
  }

  return { port, token };
}

async function handleStatus() {
  const states = listAllStates();
  if (states.length === 0) {
    console.log('No running instances.');
    return;
  }
  for (const s of states) {
    const health = await healthCheck(s.port);
    const status = health && health.ok ? `UP (uptime: ${health.uptime}s)` : 'DEAD';
    console.log(`${s.name}\tport:${s.port}\tpid:${s.pid}\t${status}`);
    if (status === 'DEAD') deleteState(s.name);
  }
}

async function handleStopAll() {
  const states = listAllStates();
  for (const s of states) {
    try {
      await sendCommand(s.port, s.token, 'stop', []);
      console.log(`Stopped: ${s.name}`);
    } catch {
      console.log(`${s.name}: already dead, cleaning up state`);
      deleteState(s.name);
    }
  }
}

function printHelp() {
  console.log(`browse-multi — Persistent headless Chromium CLI

Usage: browse-multi --name <instance> <command> [args...]

Navigation:   goto <url> | back | reload | url
Content:      text [--limit N] | html [sel] | snapshot [-i] [-s sel] | scroll [sel|up|down]
Interaction:  click <sel|@ref> | fill <sel|@ref> <val> | type <text> | press <key>
              select <sel> <val> | hover <sel|@ref> | drag <from> <to>
              wait <sel> [--timeout ms] | dialog <accept|dismiss> | upload <sel> <file> | resize <WxH>
Inspection:   js <expr> | eval (stdin) | console | network
Visual:       screenshot [path]
Tabs:         tabs | tab <id> | newtab [url] | closetab [id]
Session:      export-session | save-session [domain] | login <url> | start [--session file] | stop | stop --all
Instance:     status | chain [--timeout ms] | help`);
}
