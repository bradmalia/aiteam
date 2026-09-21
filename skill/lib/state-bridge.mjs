import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeFingerprint } from './fingerprint.mjs';

export const DEFAULT_PHASE_PLAN = [
  'intake',
  'prd-review',
  'architecture',
  'trd-review',
  'ui-design',
  'planning',
  'qa-planning',
  'critical-review',
  'environment-readiness',
  'implementation',
  'code-review',
  'qa',
  'qa-manual',
  'integration'
];

// Human-approval gate stages. Each gate id maps to the review stage it occupies
// in the phase plan. These are HARD GATES: downstream stages cannot start, and the
// git commit cannot proceed, until the user's approval is recorded for the gate.
export const GATE_STAGE_FOR_GATE = {
  prd: 'prd-review',
  trd: 'trd-review',
  qa: 'qa-manual'
};

function defaultGateQuestions(gate, taskId) {
  if (gate === 'prd') {
    return ['Review the PRD at .aiteam/docs/prd.html (scope, user stories, acceptance criteria). Reply APPROVED to proceed, or describe the changes you want.'];
  }
  if (gate === 'trd') {
    return ['Review the TRD at .aiteam/docs/trd.html (architecture, components, data models). Reply APPROVED to proceed, or describe the changes you want.'];
  }
  if (gate === 'qa') {
    return [`Automated QA PASSED for ${taskId || 'this task'}. Confirm the behavior works in the running app/environment, then reply "PASS: ..." to proceed to commit, or "FAIL: <defects>" to route the task back to the programmer.`];
  }
  return ['Reply APPROVED to proceed, or describe the changes you want.'];
}

function qaManualQuestions(taskId, result) {
  const checks = (result && result.manualChecks && result.manualChecks.length)
    ? result.manualChecks
    : (result && result.checks ? result.checks.map((c) =>
        (c && c.name) ? `${c.name}: ${c.expected || c.actual || ''}` : (typeof c === 'string' ? c : ''))
        .filter(Boolean) : []);
  const body = checks.length ? checks : ['Confirm the task behavior works end-to-end in the running application.'];
  return [`Automated QA PASSED for ${taskId}. Verify these behaviors in the running app/environment before committing:`, ...body];
}

// Which human-approval gates must already be APPROVED before `stage` may be entered.
function requiredApprovals(stage, taskId) {
  const need = [];
  const afterPrd = ['architecture', 'ui-design', 'planning', 'qa-planning', 'critical-review', 'environment-readiness', 'implementation', 'code-review', 'qa', 'integration'];
  const afterTrd = ['planning', 'qa-planning', 'critical-review', 'environment-readiness', 'implementation', 'code-review', 'qa', 'integration'];
  if (afterPrd.includes(stage)) need.push('prd');
  if (afterTrd.includes(stage)) need.push('trd');
  if (stage === 'integration' && taskId) need.push(`qa:${taskId}`);
  return need;
}

function gateBlockMessage(stage, missing) {
  const cmds = missing.map((id) => {
    const [gate, taskId] = id.includes(':') ? id.split(':') : [id, null];
    return `  node state-bridge.mjs record-approval --repo "$PWD" --gate ${gate}${taskId ? ` --taskId ${taskId}` : ''} --decision approved --response "approved by user"`;
  }).join('\n');
  return `AITEAM_GATE_BLOCKED: stage "${stage}" is blocked by an unapproved human-approval gate (${missing.join(', ')}). The matching gate is open (see .aiteam/session.json "pendingUserInput"). Get the user's explicit decision in chat, then record it:\n${cmds}`;
}

function enforceApprovals(session, stage, taskId) {
  const need = requiredApprovals(stage, taskId);
  if (!need.length) return;
  const approved = (id) => Boolean(session.approvals && session.approvals[id] && session.approvals[id].decision === 'APPROVED');
  const missing = need.filter((id) => !approved(id));
  if (missing.length) throw new Error(gateBlockMessage(stage, missing));
}

// Mutates an in-memory session to open a human-approval gate (pendingUserInput).
function openGateOnSession(session, { gate, kind, stage, taskId, doc, questions }) {
  const gateId = taskId ? `${gate}:${taskId}` : gate;
  const now = new Date().toISOString();
  session.currentStage = stage || GATE_STAGE_FOR_GATE[gate] || gate;
  session.currentTaskId = taskId ?? null;
  if (!session.approvals) session.approvals = {};
  delete session.approvals[gateId]; // reopening a review clears any prior decision
  session.pendingUserInput = {
    kind: kind || gate,
    gate,
    gateId,
    taskId: taskId ?? null,
    doc: doc || null,
    questions: questions || defaultGateQuestions(gate, taskId),
    response: null,
    openedAt: now
  };
  return session;
}

export function openGate(repo, opts) {
  let session = readSession(repo);
  if (!session) session = initSession(repo, 'AITeam Managed Workflow');
  openGateOnSession(session, opts || {});
  writeSession(repo, session);
  appendEvent(repo, { type: 'approval_gate_opened', gate: opts?.gate, gateId: opts?.taskId ? `${opts.gate}:${opts.taskId}` : opts?.gate, taskId: opts?.taskId ?? null });
  return session;
}

export function recordApproval(repo, { gate, taskId = null, decision, response = '', approvedBy = 'user' }) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  const approved = String(decision).toUpperCase() === 'APPROVED' || String(decision).toLowerCase() === 'approved';
  const gateId = taskId ? `${gate}:${taskId}` : gate;
  const now = new Date().toISOString();

  if (!session.approvals) session.approvals = {};
  session.approvals[gateId] = { gate, taskId: taskId ?? null, decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED', response, approvedBy, at: now };

  if (session.pendingUserInput && session.pendingUserInput.gateId === gateId) {
    session.pendingUserInput.response = (approved ? 'APPROVED' : 'CHANGES_REQUESTED') + (response ? `: ${response}` : '');
  }

  const reviewStage = GATE_STAGE_FOR_GATE[gate];
  if (gate === 'qa' && taskId) {
    // Human sign-off is what promotes an auto-passed QA result to a real pass.
    session.taskLedger = (session.taskLedger || []).map((t) => {
      if (t.id !== taskId) return t;
      if (!Array.isArray(t.attemptHistory)) t.attemptHistory = [];
      t.attemptHistory.push({ stage: 'qa-manual', at: now, outcome: approved ? 'PASS' : 'FAIL' });
      if (approved) {
        t.status = 'qa-passed';
        t.completedAt = now;
        if (!session.completedTasks.includes(taskId)) session.completedTasks.push(taskId);
      } else {
        t.status = 'needs-rework';
        t.qaFailure = { ...t.qaFailure, decision: 'CHANGES_REQUESTED', response };
      }
      return t;
    });
  } else if (reviewStage) {
    if (approved) {
      if (!session.completedStages.includes(reviewStage)) session.completedStages.push(reviewStage);
      if (!session.stageEvidence) session.stageEvidence = {};
      session.stageEvidence[reviewStage] = { completedAt: now, result: { outcome: 'PASS', approval: { approvedBy, response } } };
    } else {
      const i = session.completedStages.indexOf(reviewStage);
      if (i !== -1) session.completedStages.splice(i, 1);
    }
  }

  writeSession(repo, session);
  appendEvent(repo, { type: 'approval_gate_decided', gate, gateId, decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED', approvedBy, at: now });
  return session;
}

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
    schema: 3,
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
    approvals: {},
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

  // Hard human-approval gate: cannot enter a stage until its prerequisite gates are approved.
  enforceApprovals(session, stage, taskId);

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
  enforceApprovals(session, stage, taskId);

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
          // Automated QA passed, but the task is NOT complete yet: it is held in
          // "qa-auto-passed" and the human sign-off gate opens. The recordApproval
          // (gate "qa") step is what promotes it to "qa-passed" and completes it.
          updated.status = 'qa-auto-passed';
          updated.qa = result;
          updated.qaFailure = null;
          updated.qaFingerprint = computeFingerprint(repo, updated.filesChanged || []);
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

  // Automatically open the human-approval gate that gates the next stage, so the
  // coordinator cannot skip it. The gate is hard: the following stage will throw
  // (AITEAM_GATE_BLOCKED) until the user's decision is recorded via recordApproval.
  if (stage === 'intake') {
    openGateOnSession(session, { gate: 'prd', kind: 'prd', taskId: null, doc: '.aiteam/docs/prd.html' });
  } else if (stage === 'architecture') {
    openGateOnSession(session, { gate: 'trd', kind: 'trd', taskId: null, doc: '.aiteam/docs/trd.html' });
  } else if (stage === 'qa') {
    const qt = (session.taskLedger || []).find((x) => x.id === taskId);
    if (qt && qt.status === 'qa-auto-passed') {
      openGateOnSession(session, { gate: 'qa', kind: 'qa-manual', taskId, questions: qaManualQuestions(taskId, result) });
    }
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
  } else if (cmd === 'request-approval') {
    const gate = getArg('--gate');
    const taskId = getArg('--taskId');
    const kind = getArg('--kind');
    const doc = getArg('--doc');
    const stage = getArg('--stage');
    let questions = null;
    const qRaw = getArg('--questions');
    if (qRaw) { try { questions = JSON.parse(qRaw); } catch {} }
    const sess = openGate(repo, { gate, taskId, kind, doc, stage, questions });
    console.log(JSON.stringify({ ok: true, gate, gateId: taskId ? `${gate}:${taskId}` : gate, status: 'AWAITING_APPROVAL' }));
  } else if (cmd === 'record-approval') {
    const gate = getArg('--gate');
    const taskId = getArg('--taskId');
    const decision = getArg('--decision');
    const response = getArg('--response', '');
    const approvedBy = getArg('--approvedBy', 'user');
    const gateId = taskId ? `${gate}:${taskId}` : gate;
    const sess = recordApproval(repo, { gate, taskId, decision, response, approvedBy });
    console.log(JSON.stringify({ ok: true, gate, taskId, decision: sess.approvals[gateId]?.decision }));
  } else if (cmd === 'log') {
    const text = getArg('--text', '');
    writeActiveLog(repo, text);
    console.log(JSON.stringify({ ok: true }));
  } else if (cmd === 'status') {
    const sess = readSession(repo);
    console.log(JSON.stringify(sess || { status: 'NO_SESSION' }, null, 2));
  } else {
    console.error('Usage: state-bridge.mjs <init|stage-start|stage-complete|request-approval|record-approval|log|status> [options]');
    process.exit(1);
  }
}

