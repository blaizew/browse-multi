// lib/instance.js — instance management (state files, ports, health checks)
// Paths configurable via BROWSE_MULTI_STATE_DIR and BROWSE_MULTI_SESSIONS_DIR env vars.
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * Resolve a file path, expanding ~ to the user's home directory.
 */
export function resolvePath(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

const STATE_DIR = process.env.BROWSE_MULTI_STATE_DIR || join(homedir(), '.browse-multi');
const SESSIONS_DIR = process.env.BROWSE_MULTI_SESSIONS_DIR || join(homedir(), '.claude', 'sessions');
const PORT_MIN = 9400;
const PORT_MAX = 9420;

// Ensure directories exist
mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

export function sessionsDir() {
  return SESSIONS_DIR;
}

export function sessionFilePath(domain) {
  return join(SESSIONS_DIR, `${domain}.json`);
}

export function stateFilePath(name) {
  return join(STATE_DIR, `browse-multi-${name}.json`);
}

export function logFilePath(name) {
  return join(STATE_DIR, `browse-multi-${name}.log`);
}

export function defaultScreenshotPath(name) {
  return join(STATE_DIR, `browse-multi-screenshot-${name}.png`);
}

export function readState(name) {
  try {
    return JSON.parse(readFileSync(stateFilePath(name), 'utf-8'));
  } catch {
    return null;
  }
}

export function listAllStates() {
  try {
    return readdirSync(STATE_DIR)
      .filter(f => f.startsWith('browse-multi-') && f.endsWith('.json') && !f.endsWith('.tmp'))
      .map(f => {
        const name = f.replace(/^browse-multi-/, '').replace(/\.json$/, '');
        try {
          return { name, ...JSON.parse(readFileSync(join(STATE_DIR, f), 'utf-8')) };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function claimedPorts() {
  return listAllStates().map(s => s.port);
}

export function allocatePort(exclude = new Set()) {
  const used = new Set(claimedPorts());
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p) && !exclude.has(p)) return p;
  }
  return null;
}

export function generateToken() {
  return randomBytes(16).toString('hex');
}

export function writeStateAtomic(name, state) {
  const path = stateFilePath(name);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function deleteState(name) {
  try { unlinkSync(stateFilePath(name)); } catch {}
}

/**
 * Is the OS process with this pid still alive? Signal 0 doesn't kill — it only
 * probes existence. ESRCH = gone; EPERM = alive but owned by another user (still alive).
 * Used to distinguish a *busy/slow* instance (live pid, failing a health probe) from a
 * genuinely dead one — so a transient health-check failure never deletes a live instance.
 */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/**
 * Health-check with retries — a single 2s probe can time out on a busy/CPU-contended
 * instance (e.g. several headed Chromes running at once). Returns the first ok result, else null.
 */
export async function isReachable(port, tries = 3, timeoutMs = 2000) {
  for (let i = 0; i < tries; i++) {
    const h = await healthCheck(port, timeoutMs);
    if (h && h.ok) return h;
    if (i < tries - 1) await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

export function healthCheck(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export async function waitForReady(port, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = await healthCheck(port, 1000);
    if (result && result.ok) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

export function sendCommand(port, token, command, args = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, args });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/command',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}
