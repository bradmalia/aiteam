import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newSession, readSession, patchSession, appendEvent } from '../src/state.mjs';

test('session lifecycle persists state', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-state-'));
  const session = newSession(repo, 'build pong');
  assert.equal(session.request, 'build pong');
  assert.equal(readSession(repo).id, session.id);
  patchSession(repo, { currentStage: 'planning' });
  assert.equal(readSession(repo).currentStage, 'planning');
  const ev = appendEvent(repo, { type: 'test_event' });
  assert.equal(ev.type, 'test_event');
});
