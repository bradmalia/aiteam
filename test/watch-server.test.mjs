import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWatchServer } from '../src/watch-server.mjs';

function temporaryWatchRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-watch-'));
  fs.mkdirSync(path.join(repo, '.aiteam', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.aiteam', 'session.json'), JSON.stringify({
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeRun: { agentId: 'qa', stage: 'qa', startedAt: new Date().toISOString() },
    stageEvidence: {}
  }));
  return repo;
}

test('watch server presents Agy stdout when stderr has no Codex progress stream', async (t) => {
  const repo = temporaryWatchRepository();
  const runBase = '2026-08-22T12-00-00-000Z-qa';
  fs.writeFileSync(path.join(repo, '.aiteam', 'runs', `${runBase}.stdout.txt`), 'Agy specialist validation output\n');
  fs.writeFileSync(path.join(repo, '.aiteam', 'runs', `${runBase}.stderr.txt`), 'non-fatal warning\n');

  const server = createWatchServer({ repo, port: 0 });
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.repository, repo);
  assert.equal(state.activeLogTail, 'Agy specialist validation output');
});

test('dashboard treats no-change tasks as integrated and has no fixed app port', () => {
  const html = fs.readFileSync(new URL('../src/watch-dashboard.html', import.meta.url), 'utf8');
  assert.match(html, /reason === 'no_changes'/);
  assert.doesNotMatch(html, /localhost:3000/);
});

test('watch server serves screenshots via /api/screenshot endpoint', async (t) => {
  const repo = temporaryWatchRepository();
  const testPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
  const shotsDir = path.join(repo, '.aiteam', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.writeFileSync(path.join(shotsDir, 'modal-preview.png'), testPng);

  const server = createWatchServer({ repo, port: 0 });
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();

  // 1. Relative path to repository
  const res1 = await fetch(`http://127.0.0.1:${port}/api/screenshot?path=${encodeURIComponent('.aiteam/screenshots/modal-preview.png')}`);
  assert.equal(res1.status, 200);
  assert.equal(res1.headers.get('content-type'), 'image/png');
  const buf1 = Buffer.from(await res1.arrayBuffer());
  assert.deepEqual(buf1, testPng);

  // 2. Absolute path within repo
  const res2 = await fetch(`http://127.0.0.1:${port}/api/screenshot?path=${encodeURIComponent(path.join(shotsDir, 'modal-preview.png'))}`);
  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get('content-type'), 'image/png');

  // 3. Non-existent path returns 404
  const res3 = await fetch(`http://127.0.0.1:${port}/api/screenshot?path=missing.png`);
  assert.equal(res3.status, 404);

  // 4. Disallowed path outside bounds returns 403 or 400
  const res4 = await fetch(`http://127.0.0.1:${port}/api/screenshot?path=/etc/shadow`);
  assert.equal(res4.status, 400); // extension not supported
});
