import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeFingerprint } from './fingerprint.mjs';

export const DEFAULT_PHASE_PLAN = [
  'intake',
  'prd-review',
  'architecture',
  'ui-design',
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

export function ensureStateDir(repo) {
  const dir = stateDir(repo);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

export function sessionPath(repo) {
  return path.join(stateDir(repo), 'session.json');
}

export function eventsPath(repo) {
  return path.join(stateDir(repo), 'events.jsonl');
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.' + crypto.randomUUID().slice(0, 8) + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (process.platform === 'win32') {
      fs.copyFileSync(tmp, filePath);
      try { fs.unlinkSync(tmp); } catch {}
    } else {
      throw err;
    }
  }
}

export function readSession(repo) {
  const file = sessionPath(repo);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(repo, session) {
  ensureStateDir(repo);
  const next = { ...session, updatedAt: new Date().toISOString() };
  atomicWrite(sessionPath(repo), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function appendEvent(repo, event) {
  ensureStateDir(repo);
  const row = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(eventsPath(repo), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

export function initSession(repo, request) {
  ensureStateDir(repo);
  const now = new Date().toISOString();
  const session = {
    schema: 2,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    repository: path.resolve(repo),
    request,
    status: 'ACTIVE',
    currentActor: 'coordinator',
    currentStage: 'intake',
    phasePlan: DEFAULT_PHASE_PLAN,
    completedStages: [],
    stageEvidence: {},
    taskLedger: [],
    currentTaskId: null,
    activeRun: null,
    integration: null,
    environmentProfile: null,
    lockedCriticalFindings: [],
    completedTasks: [],
    pendingUserInput: null
  };
  writeSession(repo, session);
  appendEvent(repo, { type: 'session_started', request, sessionId: session.id });
  return session;
}

export function startStage(repo, stage, taskId = null, agentId = null, role = null) {
  let session = readSession(repo);
  if (!session) {
    session = initSession(repo, 'AITeam Managed Workflow');
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${agentId || stage}`;
  const activeRun = {
    runId,
    stage,
    taskId,
    agentId: agentId || stage,
    role: role || stage,
    startedAt: new Date().toISOString()
  };

  session.currentStage = stage;
  session.currentTaskId = taskId;
  session.activeRun = activeRun;

  writeSession(repo, session);
  appendEvent(repo, {
    type: 'workflow_stage_started',
    stage,
    taskId,
    agentId: activeRun.agentId,
    role: activeRun.role,
    runId,
    startedAt: activeRun.startedAt
  });

  return activeRun;
}

export function completeStage(repo, stage, taskId = null, result = {}) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);

  const now = new Date().toISOString();
  const outcome = result.outcome || 'PASS';
  const runId = session.activeRun?.runId || `${now.replace(/[:.]/g, '-')}-${stage}`;

  // Record stage evidence
  if (!session.stageEvidence) session.stageEvidence = {};
  const evidenceKey = taskId ? `${stage}:${taskId}` : stage;
  session.stageEvidence[evidenceKey] = {
    completedAt: now,
    runId,
    result
  };

  if (!session.completedStages.includes(stage)) {
    session.completedStages.push(stage);
  }

  // Handle task-specific state transitions
  if (taskId && Array.isArray(session.taskLedger)) {
    session.taskLedger = session.taskLedger.map((t) => {
      if (t.id !== taskId) return t;

      const updated = { ...t };
      if (!Array.isArray(updated.attemptHistory)) updated.attemptHistory = [];
      updated.attemptHistory.push({
        stage,
        agentId: session.activeRun?.agentId || stage,
        runId,
        at: now,
        outcome
      });

      if (stage === 'implementation') {
        if (outcome === 'PASS') {
          updated.status = 'implemented';
          updated.filesChanged = result.filesChanged || updated.filesChanged || [];
          updated.validations = result.validations || [];
        } else {
          updated.status = 'needs-rework';
        }
      } else if (stage === 'code-review') {
        if (outcome === 'PASS') {
          updated.status = 'review-passed';
          updated.review = result;
          updated['code-reviewFailure'] = null;
        } else {
          updated.status = 'needs-rework';
          updated['code-reviewFailure'] = result;
        }
      } else if (stage === 'qa') {
        if (outcome === 'PASS' || outcome === 'PASS_WITH_MANUAL_VALIDATION') {
          updated.status = 'qa-passed';
          updated.qa = result;
          updated.qaFailure = null;
          updated.qaFingerprint = computeFingerprint(repo, updated.filesChanged || []);
          updated.completedAt = now;
          if (!session.completedTasks.includes(taskId)) {
            session.completedTasks.push(taskId);
          }
        } else {
          updated.status = 'needs-rework';
          updated.qaFailure = result;
        }
      }

      return updated;
    });
  }

  // Check if all tasks in ledger are complete
  const allTasksDone = session.taskLedger.length > 0 &&
    session.taskLedger.every((t) => ['qa-passed', 'completed', 'integrated'].includes(t.status));

  if (allTasksDone && stage === 'integration') {
    session.status = 'COMPLETE';
    session.completedAt = now;
  }

  session.activeRun = null;
  writeSession(repo, session);

  appendEvent(repo, {
    type: 'workflow_stage_result',
    stage,
    taskId,
    outcome,
    summary: result.summary || 'Stage completed',
    evidence: result.evidence || [],
    runId
  });

  return session;
}

export function updateTaskLedger(repo, tasks) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  session.taskLedger = tasks;
  writeSession(repo, session);
  appendEvent(repo, { type: 'task_ledger_updated', taskCount: tasks.length });
  return session;
}

export function writeActiveLog(repo, text, agentId = null) {
  ensureStateDir(repo);
  const session = readSession(repo);
  const runId = session?.activeRun?.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${agentId || 'active'}`;
  
  const runsDir = path.join(stateDir(repo), 'runs');
  const logFile = path.join(runsDir, 'active.log');
  const runStderr = path.join(runsDir, `${runId}.stderr.txt`);
  
  fs.appendFileSync(logFile, text + '\n', 'utf8');
  fs.appendFileSync(runStderr, text + '\n', 'utf8');
}

// --- CLI Execution Interface ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  function getArg(flag, fallback = null) {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : fallback;
  }

  const repo = path.resolve(getArg('--repo', process.cwd()));

  if (cmd === 'init') {
    const request = getArg('--request', 'AITeam Managed Workflow');
    const sess = initSession(repo, request);
    console.log(JSON.stringify({ ok: true, sessionId: sess.id, status: sess.status }));
  } else if (cmd === 'stage-start') {
    const stage = getArg('--stage');
    const taskId = getArg('--taskId');
    const agentId = getArg('--agentId');
    const role = getArg('--role');
    const run = startStage(repo, stage, taskId, agentId, role);
    console.log(JSON.stringify({ ok: true, run }));
  } else if (cmd === 'stage-complete') {
    const stage = getArg('--stage');
    const taskId = getArg('--taskId');
    const resultRaw = getArg('--result', '{}');
    let result = {};
    try { result = JSON.parse(resultRaw); } catch {}
    const sess = completeStage(repo, stage, taskId, result);
    console.log(JSON.stringify({ ok: true, stage, taskId, status: sess.status }));
  } else if (cmd === 'log') {
    const text = getArg('--text', '');
    writeActiveLog(repo, text);
    console.log(JSON.stringify({ ok: true }));
  } else if (cmd === 'status') {
    const sess = readSession(repo);
    console.log(JSON.stringify(sess || { status: 'NO_SESSION' }, null, 2));
  } else {
    console.error('Usage: state-bridge.mjs <init|stage-start|stage-complete|log|status> [options]');
    process.exit(1);
  }
}

