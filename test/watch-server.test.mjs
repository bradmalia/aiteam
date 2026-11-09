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
  t.after(() => { server.close(); fs.rmSync(repo, { recursive: true, force: true }); });
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
  t.after(() => { server.close(); fs.rmSync(repo, { recursive: true, force: true }); });
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

test('review assets serve exact packet bytes, content types, HEAD and media ranges on the Watcher origin', async (t) => {
  const repo = temporaryWatchRepository();
  const packet = path.join(repo, '.aiteam', 'reviews', 'T1');
  fs.mkdirSync(packet, { recursive:true });
  const report = '{"outcome":"pending","label":"actual & observed"}\n';
  const clip = Buffer.from('0123456789');
  fs.writeFileSync(path.join(packet, 'result report.json'), report);
  fs.writeFileSync(path.join(packet, 'clip.webm'), clip);
  fs.writeFileSync(path.join(packet, 'style.css'), 'body{color:teal}\n');
  const server = createWatchServer({ repo, port:0, host:'127.0.0.1' });
  t.after(() => { server.close(); fs.rmSync(repo, { recursive:true, force:true }); });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/review-assets/T1/result%20report.json`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), report);
  const head = await fetch(url, { method:'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(report));
  assert.equal(await head.text(), '');
  const css = await fetch(`${origin}/review-assets/T1/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  assert.equal(await css.text(), 'body{color:teal}\n');
  const media = `${origin}/review-assets/T1/clip.webm`;
  for (const [range, expected, contentRange] of [['bytes=2-5','2345','bytes 2-5/10'],['bytes=-3','789','bytes 7-9/10']]) {
    const partial = await fetch(media, { headers:{ range } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-type'), 'video/webm');
    assert.equal(partial.headers.get('content-range'), contentRange);
    assert.equal(await partial.text(), expected);
  }
  assert.equal((await fetch(media, { headers:{ range:'bytes=99-' } })).status, 416);
  assert.equal((await fetch(media, { headers:{ range:'bytes=0-1,4-5' } })).status, 416);
});

test('review assets reject missing files, unsupported formats, traversal and symlink escapes without changing approval state', async (t) => {
  const repo = temporaryWatchRepository();
  const packet = path.join(repo, '.aiteam', 'reviews', 'T1');
  fs.mkdirSync(packet, { recursive:true });
  fs.writeFileSync(path.join(repo, '.aiteam', 'private.txt'), 'outside review root');
  fs.writeFileSync(path.join(packet, 'unsupported.bin'), 'not a review format');
  fs.symlinkSync(path.join(repo, '.aiteam', 'private.txt'), path.join(packet, 'escape.txt'));
  const before = fs.readFileSync(path.join(repo, '.aiteam', 'session.json'), 'utf8');
  const server = createWatchServer({ repo, port:0, host:'127.0.0.1' });
  t.after(() => { server.close(); fs.rmSync(repo, { recursive:true, force:true }); });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [resource, status] of [
    ['T1/missing.json',404], ['T1/unsupported.bin',415], ['T1',404],
    ['%2e%2e%2fprivate.txt',403], ['T1/escape.txt',403], ['%GG',400], ['T1%5cescape.txt',400]
  ]) assert.equal((await fetch(`${origin}/review-assets/${resource}`)).status, status, resource);
  assert.equal((await fetch(`${origin}/review-assets/T1/missing.json`, { method:'POST' })).status, 405);
  assert.equal(fs.readFileSync(path.join(repo, '.aiteam', 'session.json'), 'utf8'), before);
});
