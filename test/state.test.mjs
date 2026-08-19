import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { newSession, readSession, patchSession, appendEvent } from '../src/state.mjs';

function repository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-state-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  return repo;
}

test('session lifecycle persists state', () => {
  const repo = repository();
  const session = newSession(repo, 'build pong');
  assert.equal(session.request, 'build pong');
  assert.equal(readSession(repo).id, session.id);
  patchSession(repo, { currentStage: 'planning' });
  assert.equal(readSession(repo).currentStage, 'planning');
  const ev = appendEvent(repo, { type: 'test_event' });
  assert.equal(ev.type, 'test_event');
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.aiteam\/$/m);

  fs.rmSync(path.join(repo, '.aiteam'), { recursive: true });
  assert.equal(readSession(repo).id, session.id, 'protected Git-local state survives workspace state deletion');
});
