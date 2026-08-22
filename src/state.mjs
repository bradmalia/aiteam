import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const DEFAULT_PHASE_PLAN = [
  'intake',
  'architecture',
  'planning',
  'critical-review',
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
  const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
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

export function readSession(repo) {
  const protectedPath = protectedSessionPath(repo);
  const workspacePath = sessionPath(repo);
  const source = fs.existsSync(protectedPath) ? protectedPath : workspacePath;
  if (!fs.existsSync(source)) return null;
  const session = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (source === workspacePath) {
    ensureStateDir(repo);
    fs.writeFileSync(protectedPath, JSON.stringify(session, null, 2) + '\n');
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
  const current = readSession(repo);
  if (!current) throw new Error('No active AITEAM session exists in this repository.');
  return writeSession(repo, { ...current, ...patch });
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
