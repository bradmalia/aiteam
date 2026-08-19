import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function stateDir(repo) {
  return path.join(repo, '.aiteam');
}

export function ensureStateDir(repo) {
  const dir = stateDir(repo);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  return dir;
}

export function newSession(repo, request) {
  const dir = ensureStateDir(repo);
  const now = new Date().toISOString();
  const session = {
    schema: 1,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    repository: repo,
    request,
    status: 'ACTIVE',
    currentActor: 'coordinator',
    currentStage: 'intake',
    lockedCriticalFindings: [],
    completedTasks: [],
    pendingUserInput: null
  };
  writeSession(repo, session);
  appendEvent(repo, { type: 'session_started', request, sessionId: session.id });
  return session;
}

export function sessionPath(repo) {
  return path.join(stateDir(repo), 'session.json');
}

export function readSession(repo) {
  const p = sessionPath(repo);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeSession(repo, session) {
  ensureStateDir(repo);
  const next = { ...session, updatedAt: new Date().toISOString() };
  fs.writeFileSync(sessionPath(repo), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function patchSession(repo, patch) {
  const current = readSession(repo);
  if (!current) throw new Error('No active AITEAM session exists in this repository.');
  return writeSession(repo, { ...current, ...patch });
}

export function appendEvent(repo, event) {
  const dir = ensureStateDir(repo);
  const row = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(row) + '\n');
  return row;
}
