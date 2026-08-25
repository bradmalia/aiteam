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
  assert.ok(session.phasePlan.includes('qa-planning'));
  assert.ok(session.phasePlan.indexOf('planning') < session.phasePlan.indexOf('qa-planning'));
  assert.ok(session.phasePlan.indexOf('qa-planning') < session.phasePlan.indexOf('critical-review'));
  assert.ok(session.phasePlan.indexOf('trd-review') < session.phasePlan.indexOf('environment-readiness'));
  assert.ok(session.phasePlan.indexOf('environment-readiness') < session.phasePlan.indexOf('implementation'));
  assert.equal(session.environmentProfile, null);
  assert.equal(readSession(repo).id, session.id);
  patchSession(repo, { currentStage: 'planning' });
  assert.equal(readSession(repo).currentStage, 'planning');
  const ev = appendEvent(repo, { type: 'test_event' });
  assert.equal(ev.type, 'test_event');
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.aiteam\/$/m);

  fs.rmSync(path.join(repo, '.aiteam'), { recursive: true });
  assert.equal(readSession(repo).id, session.id, 'protected Git-local state survives workspace state deletion');
});
