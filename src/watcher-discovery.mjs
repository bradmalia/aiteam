import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function repositoryIdentity(repo) {
  try { return fs.realpathSync(repo); } catch { return path.resolve(repo); }
}

// A successful HTTP connection is not proof that a port hosts our watcher.
function matchesRepository(repo, port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/state' }, response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) request.destroy();
      });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(response.statusCode === 200 && typeof data.repository === 'string'
            && repositoryIdentity(data.repository) === repositoryIdentity(repo));
        } catch { resolve(false); }
      });
    });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => { request.destroy(); resolve(false); });
  });
}

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function launchWatcher(repo, port) {
  return spawn(process.execPath, [fileURLToPath(new URL('./watch-server.mjs', import.meta.url)),
    '--repo', repo, '--host', '127.0.0.1', '--port', String(port)],
  { detached: true, stdio: 'ignore' });
}

const pending = new Map();

export async function ensureWatcher(repo, options = {}) {
  const identity = repositoryIdentity(repo);
  const key = `${identity}:${options.basePort ?? 4317}`;
  if (pending.has(key)) return pending.get(key);
  const operation = discover(identity, options);
  pending.set(key, operation);
  try { return await operation; } finally { pending.delete(key); }
}

async function discover(repo, { basePort = 4317, portCount = 16,
  startupTimeoutMs = 5000, launch = launchWatcher } = {}) {
  const ports = Array.from({ length: portCount }, (_, i) => basePort + i);
  // Search the whole range for an existing matching watcher before allocating.
  for (const port of ports) {
    if (await matchesRepository(repo, port)) return `http://localhost:${port}`;
  }
  for (const port of ports) {
    if (!await portAvailable(port)) continue;
    const child = launch(repo, port);
    let failure = null;
    child.once('error', error => { failure = error; });
    child.unref();
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      // Verify actual repository ownership, including a possible bind race.
      if (await matchesRepository(repo, port)) return `http://localhost:${port}`;
      if (failure || child.exitCode !== null || child.signalCode) break;
      await delay(50);
    }
    child.kill();
    if (failure) throw new Error(`Watcher startup failed for ${repo}: ${failure.message}`);
    // Another process may have claimed this port after the availability check.
  }
  throw new Error(`No verified watcher available for ${repo} on ports ${basePort}–${basePort + portCount - 1}`);
}
