import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

export const DEFAULT_PHASE_PLAN = [
  'intake',
  'prd-review',
  'architecture',
  'planning',
  'qa-planning',
  'critical-review',
  'trd-review',
  'environment-readiness',
  'implementation',
  'code-review',
  'qa',
  'integration'
];

export function stateDir(repo) {
  return path.join(repo, '.aiteam');
}

export function protectedStateDir(repo) {
  const gitPath = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'aiteam'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  return path.resolve(repo, gitPath);
}

function ensureGitExclude(repo) {
  const excludePath = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const absolute = path.resolve(repo, excludePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  let current = '';
  try { current = fs.readFileSync(absolute, 'utf8'); } catch { /* file doesn't exist yet */ }
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes('.aiteam/')) {
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(absolute, `${separator}.aiteam/\n`);
  }
}

export function ensureStateDir(repo) {
  const dir = stateDir(repo);
  const protectedDir = protectedStateDir(repo);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(protectedDir, 'runs'), { recursive: true });
  ensureGitExclude(repo);
  return dir;
}

export function newSession(repo, request) {
  ensureStateDir(repo);
  const now = new Date().toISOString();
  const session = {
    schema: 2,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    repository: repo,
    request,
    status: 'ACTIVE',
    currentActor: 'coordinator',
    currentStage: 'intake',
    phasePlan: DEFAULT_PHASE_PLAN,
    completedStages: [],
    stageEvidence: {},
    taskLedger: [],
    currentTaskId: null,
    recruiterQueue: [],
    resumeStage: null,
    activeRun: null,
    integration: null,
    environmentProfile: null,
    lockedCriticalFindings: [],
    completedTasks: [],
    pendingUserInput: null,
    interviewHistory: []
  };
  writeSession(repo, session);
  appendEvent(repo, { type: 'session_started', request, sessionId: session.id });
  return session;
}

export function sessionPath(repo) {
  return path.join(stateDir(repo), 'session.json');
}

export function protectedSessionPath(repo) {
  return path.join(protectedStateDir(repo), 'session.json');
}

// --- Advisory file locking (C2) ---
const LOCK_STALE_MS = 60_000;     // consider a lock stale after 60 seconds
const LOCK_RETRY_MS = 100;        // sleep between retries
const LOCK_MAX_WAIT_MS = 30_000;  // give up after 30 seconds

function lockPath(repo) {
  return sessionPath(repo) + '.lock';
}

/**
 * Acquire an advisory lock for session mutations.
 * Uses O_EXCL (exclusive create) which is atomic on POSIX.
 * Automatically breaks stale locks older than LOCK_STALE_MS.
 */
export function lockSession(repo) {
  const lock = lockPath(repo);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Check if the existing lock is stale
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lock); } catch { /* race: another process removed it */ }
          continue; // retry immediately after breaking stale lock
        }
      } catch { continue; } // lock was removed by another process, retry
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for session lock (${lock}). If no other AITEAM process is running, delete this file manually.`);
      }
      // Synchronous sleep using execSync to avoid async complexity
      try { execSync(`sleep 0.1`, { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }
}

export function unlockSession(repo) {
  try { fs.unlinkSync(lockPath(repo)); } catch { /* already removed */ }
}

// --- TOCTOU-safe file reading (H3) ---
function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null; // corrupted/empty JSON
    throw err;
  }
}

export function readSession(repo) {
  const protectedPath = protectedSessionPath(repo);
  const workspacePath = sessionPath(repo);
  // Try protected path first, fall back to workspace (TOCTOU-safe)
  const session = readJsonFile(protectedPath) || readJsonFile(workspacePath);
  if (!session) return null;
  // If we loaded from workspace, sync to protected
  if (!readJsonFile(protectedPath)) {
    ensureStateDir(repo);
    atomicWrite(protectedPath, JSON.stringify(session, null, 2) + '\n');
  }
  return session;
}

export function writeSession(repo, session) {
  ensureStateDir(repo);
  const next = { ...session, updatedAt: new Date().toISOString() };
  const serialized = JSON.stringify(next, null, 2) + '\n';
  atomicWrite(sessionPath(repo), serialized);
  atomicWrite(protectedSessionPath(repo), serialized);
  return next;
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export function patchSession(repo, patch) {
  lockSession(repo);
  try {
    const current = readSession(repo);
    if (!current) throw new Error('No active AITEAM session exists in this repository.');
    return writeSession(repo, { ...current, ...patch });
  } finally {
    unlockSession(repo);
  }
}

export function appendEvent(repo, event) {
  const dir = ensureStateDir(repo);
  const protectedDir = protectedStateDir(repo);
  const row = { at: new Date().toISOString(), ...event };
  const serialized = JSON.stringify(row) + '\n';
  fs.appendFileSync(path.join(dir, 'events.jsonl'), serialized);
  fs.appendFileSync(path.join(protectedDir, 'events.jsonl'), serialized);
  return row;
}
