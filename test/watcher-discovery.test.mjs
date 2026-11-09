import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { ensureWatcher } from '../src/watcher-discovery.mjs';

async function fixture(t, handler = (_req, res) => { res.writeHead(404); res.end('unrelated'); }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-discovery-'));
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(repo, { recursive: true, force: true });
  });
  return { repo, server, port };
}

function launcher(t) {
  return (repo, port) => {
    const child = spawn(process.execPath, ['src/watch-server.mjs', '--repo', repo,
      '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
    t.after(async () => {
      if (child.exitCode === null && !child.signalCode) {
        child.ref();
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    });
    return child;
  };
}

test('reuse only the watcher serving the requested repository, including symlink identity', async t => {
  let repo;
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ repository: repo })));
  repo = f.repo;
  const alias = `${repo}-alias`;
  fs.symlinkSync(repo, alias);
  t.after(() => fs.unlinkSync(alias));
  const url = await ensureWatcher(alias, { basePort: f.port, portCount: 1,
    launch: () => assert.fail('must reuse the existing watcher') });
  assert.equal(url, `http://localhost:${f.port}`);
});

for (const [name, handler] of [
  ['other repository', (_req, res) => res.end(JSON.stringify({ repository: '/another/project' }))],
  ['non-watcher HTTP server', (_req, res) => { res.writeHead(404); res.end('unrelated'); }],
  ['invalid JSON', (_req, res) => res.end('<html>another application</html>')],
]) {
  test(`never return an occupied port belonging to ${name}`, async t => {
    const f = await fixture(t, handler);
    await assert.rejects(ensureWatcher(f.repo, { basePort: f.port, portCount: 1,
      launch: () => assert.fail('must not launch on an occupied port') }), /No verified watcher/);
    assert.equal((await fetch(`http://127.0.0.1:${f.port}`)).status, name === 'non-watcher HTTP server' ? 404 : 200);
  });
}

test('start a watcher and return only after its endpoint verifies repository ownership; coalesce concurrent calls', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  let launches = 0;
  const launch = launcher(t);
  const options = { basePort: f.port, portCount: 1,
    launch: (repo, port) => { launches++; return launch(repo, port); } };
  const urls = await Promise.all([ensureWatcher(f.repo, options), ensureWatcher(f.repo, options)]);
  assert.deepEqual(urls, [`http://localhost:${f.port}`, `http://localhost:${f.port}`]);
  assert.equal(launches, 1);
  assert.equal((await (await fetch(`${urls[0]}/api/state`)).json()).repository, f.repo);
});

test('failed child startup is an explicit error, never a fallback dashboard URL', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  await assert.rejects(ensureWatcher(f.repo, { basePort: f.port, portCount: 1,
    launch: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.unref = () => {};
      child.kill = () => {};
      process.nextTick(() => child.emit('error', new Error('spawn denied')));
      return child;
    } }), /Watcher startup failed.*spawn denied/);
});

test('skip an unrelated occupied port and verify the new watcher on another port', async t => {
  const f = await fixture(t);
  const url = await ensureWatcher(f.repo, { basePort: f.port, portCount: 4, launch: launcher(t) });
  assert.notEqual(url, `http://localhost:${f.port}`);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).repository, f.repo);
});

test('search the full range for the correct watcher before using an earlier free port', async t => {
  let repo;
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ repository: repo })));
  repo = f.repo;
  assert.equal(await ensureWatcher(repo, { basePort: f.port - 1, portCount: 2,
    launch: () => assert.fail('existing watcher must take precedence over free ports') }),
  `http://localhost:${f.port}`);
});
