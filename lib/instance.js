// lib/instance.js
import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const STATE_DIR = process.env.BROWSE_MULTI_STATE_DIR || join(homedir(), '.browse-multi');
const PORT_MIN = 9400;
const PORT_MAX = 9420;

// Ensure state directory exists
mkdirSync(STATE_DIR, { recursive: true });

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

export function allocatePort() {
  const used = new Set(claimedPorts());
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
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
