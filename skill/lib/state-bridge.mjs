import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeFingerprint, verifyFingerprint } from './fingerprint.mjs';

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
  'qa-manual',
  'integration'
];

export const ROLE_FOR_STAGE = {
  intake: 'Analyst',
  'prd-review': 'Human Gate (PRD)',
  architecture: 'Architect',
  'ui-design': 'UI Designer',
  planning: 'Planner',
  qa_planning: 'QA Planner',
  'qa-planning': 'QA Planner',
  'critical-review': 'Critical Reviewer',
  'trd-review': 'Human Gate (TRD)',
  'environment-readiness': 'Env Readiness',
  implementation: 'Programmer',
  'code-review': 'Code Reviewer',
  qa: 'QA Engineer',
  'qa-manual': 'Human Gate (QA)',
  integration: 'Maintainer'
};

// Human-approval gate stages. Each gate id maps to the review stage it occupies
// in the phase plan. These are HARD GATES: downstream stages cannot start, and the
// git commit cannot proceed, until the user's approval is recorded for the gate.
export const GATE_STAGE_FOR_GATE = {
  prd: 'prd-review',
  trd: 'trd-review',
  qa: 'qa-manual'
};

export function syncActiveRunForSession(session, now = new Date().toISOString()) {
  if (!session) return null;
  // Normalize legacy phasePlan ordering where trd-review was before ui-design
  if (Array.isArray(session.phasePlan)) {
    const trdIdx = session.phasePlan.indexOf('trd-review');
    const critIdx = session.phasePlan.indexOf('critical-review');
    if (trdIdx !== -1 && critIdx !== -1 && trdIdx < critIdx) {
      session.phasePlan = [...DEFAULT_PHASE_PLAN];
    }
  }
  const stage = session.currentStage;
  const isGateStage = stage === 'prd-review' || stage === 'trd-review' || stage === 'qa-manual';
  const hasOpenGate = Boolean(session.pendingUserInput && session.pendingUserInput.response == null);
  if (session.status !== 'ACTIVE' || !stage || isGateStage || hasOpenGate) {
    session.activeRun = null;
    return null;
  }
  const taskId = session.currentTaskId ?? null;
  const role = ROLE_FOR_STAGE[stage] || stage;
  if (session.activeRun && session.activeRun.stage === stage && (session.activeRun.taskId ?? null) === taskId) {
    return session.activeRun;
  }
  const agentId = role.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  session.activeRun = {
    runId: `${now.replace(/[:.]/g, '-')}-${agentId}`,
    stage,
    taskId,
    agentId,
    role,
    startedAt: now
  };
  return session.activeRun;
}

const SELF_APPROVAL_PATTERNS = [
  /^approved by user$/i,
  /^auto[- ]?approved$/i,
  /^self[- ]?approved$/i,
  /^approved autonomously$/i
];

function defaultGateQuestions(gate, taskId, doc = null) {
  if (gate === 'prd') {
    const target = doc || '.aiteam/docs/prd.html';
    return [`Review the PRD at ${target} (scope, user stories, acceptance criteria). Approve in the Watcher Portal or reply APPROVED in chat to proceed, or describe the changes you want.`];
  }
  if (gate === 'trd') {
    const target = doc || '.aiteam/docs/trd.html';
    return [`Review the TRD at ${target} (architecture, components, data models). Approve in the Watcher Portal or reply APPROVED in chat to proceed, or describe the changes you want.`];
  }
  if (gate === 'qa') {
    return [`Automated QA PASSED for ${taskId || 'this task'}. Confirm the behavior works in the running app/environment, then approve in the Watcher Portal or reply "PASS: ..." in chat to proceed to commit, or "FAIL: <defects>" to route the task back to the programmer.`];
  }
  return ['Approve in the Watcher Portal or reply APPROVED in chat to proceed, or describe the changes you want.'];
}

function qaManualQuestions(taskId, result) {
  const checks = (result && result.manualChecks && result.manualChecks.length)
    ? result.manualChecks
    : (result && result.checks ? result.checks.map((c) =>
        (c && c.name) ? `${c.name}: ${c.expected || c.actual || c.evidence || ''}` : (typeof c === 'string' ? c : ''))
        .filter(Boolean) : []);
  const body = checks.length ? checks : ['Confirm the task behavior works end-to-end in the running application.'];
  return [`Automated QA PASSED for ${taskId}. Verify these behaviors in the running app/environment before committing:`, ...body];
}

// Which human-approval gates must already be APPROVED before `stage` may be entered.
function requiredApprovals(stage, taskId) {
  const need = [];
  const afterPrd = ['architecture', 'ui-design', 'planning', 'qa-planning', 'critical-review', 'environment-readiness', 'implementation', 'code-review', 'qa', 'integration'];
  const afterTrd = ['environment-readiness', 'implementation', 'code-review', 'qa', 'integration'];
  if (afterPrd.includes(stage)) need.push('prd');
  if (afterTrd.includes(stage)) need.push('trd');
  if (stage === 'integration' && taskId) need.push(`qa:${taskId}`);
  return need;
}

function gateBlockMessage(stage, missing) {
  const first = missing[0] || 'prd';
  const [gate, taskId] = first.includes(':') ? first.split(':') : [first, null];
  return [
    `AITEAM_GATE_BLOCKED: stage "${stage}" is HARD-BLOCKED by unapproved human-approval gate (${missing.join(', ')}).`,
    `Call aiteam_wait_for_approval(gate="${gate}"${taskId ? `, taskId="${taskId}"` : ''}) (or run: node state-bridge.mjs wait-approval --repo "$PWD" --gate ${gate}${taskId ? ` --taskId ${taskId}` : ''}) to pause until the human user clicks "Approve Gate" or "Request Changes" in the Watcher Dashboard Portal.`
  ].join(' ');
}

function enforceApprovals(session, stage, taskId) {
  const need = requiredApprovals(stage, taskId);
  if (!need.length) return;
  const approved = (id) => Boolean(session.approvals && session.approvals[id] && session.approvals[id].decision === 'APPROVED');
  const missing = need.filter((id) => !approved(id));
  if (missing.length) throw new Error(gateBlockMessage(stage, missing));
}

/**
 * Enforces strict sequential order across the pre-implementation setup phases:
 * intake -> prd-review -> architecture -> ui-design -> planning -> qa-planning -> critical-review -> trd-review -> environment-readiness
 */
function enforceSetupStageOrder(session, stage) {
  // If TRD is already approved (e.g. during task loop or unit test setup), setup phases are already satisfied
  if (session.approvals?.trd?.decision === 'APPROVED') return;

  const completed = new Set(session.completedStages || []);
  const prereqFor = {
    'ui-design': 'architecture',
    'planning': 'ui-design',
    'qa-planning': 'planning',
    'critical-review': 'qa-planning'
  };
  const needed = prereqFor[stage];
  if (needed && !completed.has(needed)) {
    throw new Error(
      `AITEAM_STAGE_ORDER_VIOLATION: Cannot execute stage "${stage}" before completing "${needed}". Required setup order: architecture -> ui-design -> planning -> qa-planning -> critical-review -> trd-review -> environment-readiness.`
    );
  }
}

/**
 * Enforces strict per-task stage ordering so the coordinator cannot skip
 * implementation, code-review, qa, or qa-manual sign-off.
 */
function enforceTaskStageOrder(session, stage, taskId) {
  if (!taskId || !Array.isArray(session.taskLedger) || session.taskLedger.length === 0) return;
  const task = session.taskLedger.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`AITEAM_TASK_NOT_FOUND: Task "${taskId}" does not exist in session.taskLedger.`);
  }

  const status = task.status || 'planned';

  if (stage === 'implementation') {
    if (status === 'qa-passed' && (task.integration?.integrated || task.integration?.committed)) {
      throw new Error(`AITEAM_STAGE_ORDER_VIOLATION: Task "${taskId}" is already integrated and complete.`);
    }
    return;
  }

  if (stage === 'code-review') {
    if (status !== 'implemented' && status !== 'review-passed') {
      throw new Error(
        `AITEAM_STAGE_ORDER_VIOLATION: Cannot execute "code-review" for task "${taskId}" because its status is "${status}". Task must complete "implementation" first.`
      );
    }
    return;
  }

  if (stage === 'qa') {
    if (status !== 'review-passed' && status !== 'qa-auto-passed') {
      throw new Error(
        `AITEAM_STAGE_ORDER_VIOLATION: Cannot execute "qa" for task "${taskId}" because its status is "${status}". Task must pass "code-review" first.`
      );
    }
    return;
  }

  if (stage === 'integration') {
    if (status !== 'qa-passed') {
      throw new Error(
        `AITEAM_STAGE_ORDER_VIOLATION: Cannot execute "integration" for task "${taskId}" because its status is "${status}". Task must pass automated "qa" AND receive human QA sign-off first.`
      );
    }
  }
}

function hasQaTestFiles(repo) {
  const qaDir = path.join(repo, 'tests', 'qa');
  if (!fs.existsSync(qaDir)) return false;
  try {
    const entries = fs.readdirSync(qaDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /\.(?:test|spec)\.[a-z0-9]+$|\.(?:mjs|cjs|js|ts|tsx|py|sh)$/i.test(entry.name)) {
        const stat = fs.statSync(path.join(qaDir, entry.name));
        if (stat.size > 0) return true;
      }
      if (entry.isDirectory()) {
        const subEntries = fs.readdirSync(path.join(qaDir, entry.name));
        if (subEntries.length > 0) return true;
      }
    }
  } catch {}
  return false;
}

function isRedundantIntakeApprovalQuestion(question) {
  const asksForApproval = /\b(?:approve|confirm|sign[\s-]?off)\b/i.test(question);
  const targetsWholeArtifact = /\b(?:prd|product requirements document|requirements artifact|final(?:ized)? requirements|complete requirements|all requirements|requirements and acceptance criteria|everything)\b/i.test(question);
  return asksForApproval && targetsWholeArtifact;
}

/**
 * Validates that required disk artifacts and structured evidence exist before
 * allowing a stage to complete with PASS (or AWAITING_USER for intake).
 */
function validateStageCompletion(repo, session, stage, taskId, result) {
  const outcome = result.outcome || 'PASS';

  if (stage === 'intake' && outcome === 'AWAITING_USER') {
    const rawQuestions = Array.isArray(result.questions) ? result.questions : [];
    const cleanQuestions = rawQuestions
      .map((q) => (typeof q === 'string' ? q.trim() : typeof q?.question === 'string' ? q.question.trim() : ''))
      .filter(Boolean);
    if (cleanQuestions.length === 0) {
      throw new Error(
        `AITEAM_INTAKE_QUESTIONS_EMPTY: Cannot return outcome "AWAITING_USER" in stage "intake" without a non-empty "questions" array of concrete clarifying questions.`
      );
    }
    if (cleanQuestions.some(isRedundantIntakeApprovalQuestion)) {
      throw new Error(
        `AITEAM_INTAKE_INVALID_QUESTION: Do not ask for generic PRD approval during the intake interview. Ask concrete product, UX, scope, or edge-case clarifying questions.`
      );
    }
    return;
  }

  if (outcome !== 'PASS' && outcome !== 'PASS_WITH_MANUAL_VALIDATION') return;

  if (stage === 'intake') {
    if (!session.intakeClarified) {
      throw new Error(
        `AITEAM_INTAKE_INTERVIEW_REQUIRED: Cannot complete stage "intake" with PASS before asking the user clarifying questions! First inspect the repository, formulate 3-5 concrete product/UX/scope clarifying questions (each with a recommended default), and call aiteam_advance with stage="intake", outcome="AWAITING_USER", and questions=[...]. Wait for the user's answers before generating .aiteam/docs/prd.html and completing intake with PASS.`
      );
    }
    const prdPath = path.join(docsDir(repo), 'prd.html');
    if (!fs.existsSync(prdPath) || fs.statSync(prdPath).size === 0) {
      throw new Error(
        `AITEAM_ARTIFACT_MISSING: Cannot complete stage "intake" with PASS because ".aiteam/docs/prd.html" does not exist or is empty. You must generate the PRD HTML document before completing intake.`
      );
    }
  } else if (stage === 'architecture' || stage === 'critical-review') {
    const trdPath = path.join(docsDir(repo), 'trd.html');
    if (!fs.existsSync(trdPath) || fs.statSync(trdPath).size === 0) {
      throw new Error(
        `AITEAM_ARTIFACT_MISSING: Cannot complete stage "${stage}" with PASS because ".aiteam/docs/trd.html" does not exist or is empty. You must generate/update the TRD HTML document before completing ${stage}.`
      );
    }
  } else if (stage === 'planning') {
    const tasks = session.taskLedger || [];
    if (tasks.length === 0) {
      throw new Error(
        `AITEAM_LEDGER_EMPTY: Cannot complete stage "planning" with an empty taskLedger. Author TASK_LEDGER.md and register tasks first.`
      );
    }
  } else if (stage === 'implementation' && taskId) {
    const task = (session.taskLedger || []).find((t) => t.id === taskId);
    const filesChanged = result.filesChanged || task?.filesChanged || [];
    if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
      throw new Error(
        `AITEAM_EVIDENCE_MISSING: Cannot complete "implementation" for task "${taskId}" without a non-empty "filesChanged" array.`
      );
    }
    for (const rel of filesChanged) {
      const full = path.isAbsolute(rel) ? rel : path.join(repo, rel);
      if (!fs.existsSync(full)) {
        throw new Error(
          `AITEAM_EVIDENCE_MISSING: Reported changed file "${rel}" for task "${taskId}" does not exist on disk.`
        );
      }
    }
  } else if (stage === 'code-review' && taskId) {
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const severe = findings.filter((f) => f && (f.severity === 'BLOCKER' || f.severity === 'MAJOR'));
    if (severe.length > 0) {
      throw new Error(
        `AITEAM_REVIEW_CONFLICT: Cannot PASS "code-review" for task "${taskId}" when ${severe.length} BLOCKER/MAJOR finding(s) are present.`
      );
    }
  } else if (stage === 'qa' && taskId) {
    if (!hasQaTestFiles(repo)) {
      throw new Error(
        `AITEAM_QA_TEST_MISSING: Cannot PASS stage "qa" for task "${taskId}" because no automated black-box test files exist under "tests/qa/". Per the QA contract, you must author and run dedicated black-box tests in tests/qa/ before completing QA.`
      );
    }
    const hasChecks = Array.isArray(result.checks) && result.checks.length > 0;
    const hasEvidence = Array.isArray(result.evidence) && result.evidence.length > 0;
    if (!hasChecks && !hasEvidence) {
      throw new Error(
        `AITEAM_EVIDENCE_MISSING: Cannot PASS stage "qa" for task "${taskId}" without reporting executed "checks" or "evidence".`
      );
    }
  }
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
    questions: questions || defaultGateQuestions(gate, taskId, doc),
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

export function recordApproval(repo, { gate, taskId = null, decision, response = '', approvedBy = 'user', enforceDwell = false }) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  const approved = String(decision).toUpperCase() === 'APPROVED' || String(decision).toLowerCase() === 'approved';
  const gateId = taskId ? `${gate}:${taskId}` : gate;
  const now = new Date().toISOString();

  // Anti-self-approval guard when called by an agent CLI/MCP rather than the human portal
  if (approved && approvedBy !== 'human-portal') {
    const trimmedResp = String(response || '').trim();
    if (SELF_APPROVAL_PATTERNS.some((re) => re.test(trimmedResp))) {
      throw new Error(
        `AITEAM_SELF_APPROVAL_BLOCKED: Boilerplate response "${trimmedResp}" rejected. You must wait for the actual human user to approve in the Watcher Portal or reply in chat.`
      );
    }

    if (
      enforceDwell &&
      !process.env.NODE_TEST_CONTEXT &&
      process.env.AITEAM_TEST_MODE !== '1' &&
      session.pendingUserInput &&
      session.pendingUserInput.gateId === gateId &&
      session.pendingUserInput.openedAt
    ) {
      const elapsedMs = Date.now() - Date.parse(session.pendingUserInput.openedAt);
      if (Number.isFinite(elapsedMs) && elapsedMs < 2500) {
        throw new Error(
          `AITEAM_SELF_APPROVAL_BLOCKED: Gate "${gateId}" was opened less than 3 seconds ago in this same turn. Call aiteam_wait_for_approval to wait for the human user's decision in the Watcher Portal.`
        );
      }
    }
  }

  // Enforce that per-task QA approval can only be recorded after automated QA has passed
  if (gate === 'qa' && taskId && Array.isArray(session.taskLedger) && session.taskLedger.length > 0) {
    const targetTask = session.taskLedger.find((t) => t.id === taskId);
    if (!targetTask) {
      throw new Error(`AITEAM_TASK_NOT_FOUND: Task "${taskId}" does not exist in session.taskLedger.`);
    }
    if (approved && targetTask.status !== 'qa-auto-passed' && targetTask.status !== 'qa-passed') {
      throw new Error(
        `AITEAM_STAGE_ORDER_VIOLATION: Cannot approve QA gate for task "${taskId}" because its current status is "${targetTask.status}" (must pass automated "qa" stage first).`
      );
    }
  }

  if (!session.approvals) session.approvals = {};
  session.approvals[gateId] = { gate, taskId: taskId ?? null, decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED', response, approvedBy, at: now };

  if (session.pendingUserInput && session.pendingUserInput.gateId === gateId) {
    session.pendingUserInput.response = (approved ? 'APPROVED' : 'CHANGES_REQUESTED') + (response ? `: ${response}` : '');
  }

  const reviewStage = GATE_STAGE_FOR_GATE[gate];
  if (gate === 'intake') {
    if (approved) {
      session.intakeClarified = true;
      session.intakeAnswers = response || 'Use recommended defaults for any unanswered questions.';
      if (!Array.isArray(session.intakeHistory)) session.intakeHistory = [];
      session.intakeHistory.push({
        questions: session.intakeQuestions || session.pendingUserInput?.questions || [],
        answers: session.intakeAnswers,
        approvedBy,
        at: now
      });
      session.currentStage = 'intake';
    } else {
      session.intakeClarified = false;
      session.intakeFeedback = response || '';
      session.currentStage = 'intake';
    }
  } else if (gate === 'qa' && taskId) {
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
    if (approved) {
      session.currentStage = 'integration';
      session.currentTaskId = taskId;
    } else {
      session.currentStage = 'implementation';
      session.currentTaskId = taskId;
    }
  } else if (reviewStage) {
    if (approved) {
      if (!session.completedStages.includes(reviewStage)) session.completedStages.push(reviewStage);
      if (!session.stageEvidence) session.stageEvidence = {};
      session.stageEvidence[reviewStage] = { completedAt: now, result: { outcome: 'PASS', approval: { approvedBy, response } } };
      if (gate === 'prd' && session.currentStage === 'prd-review') {
        archiveDocIfPresent(repo, '.aiteam/docs/trd.html');
        session.currentStage = 'architecture';
      } else if (gate === 'trd' && session.currentStage === 'trd-review') {
        session.currentStage = 'environment-readiness';
      }
    } else {
      const i = session.completedStages.indexOf(reviewStage);
      if (i !== -1) session.completedStages.splice(i, 1);
      if (gate === 'prd') session.currentStage = 'intake';
      if (gate === 'trd') {
        const critIdx = session.completedStages.indexOf('critical-review');
        if (critIdx !== -1) session.completedStages.splice(critIdx, 1);
        session.currentStage = 'critical-review';
      }
    }
  }

  session.activeRun = null;
  syncActiveRunForSession(session, now);
  writeSession(repo, session);
  appendEvent(repo, { type: 'approval_gate_decided', gate, gateId, decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED', approvedBy, at: now });
  return session;
}

export function stateDir(repo) {
  return path.join(repo, '.aiteam');
}

function protectedStateDir(repo) {
  const gitDir = path.join(repo, '.git');
  try {
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      const dir = path.join(gitDir, 'aiteam');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
  } catch {}
  return null;
}

export function ensureStateDir(repo) {
  const dir = stateDir(repo);
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'archive'), { recursive: true });
  protectedStateDir(repo);
  return dir;
}

export function docsDir(repo) {
  return path.join(stateDir(repo), 'docs');
}

export function docsArchiveDir(repo) {
  return path.join(docsDir(repo), 'archive');
}

export function archiveDocIfPresent(repo, docRelPath) {
  ensureStateDir(repo);
  const baseName = path.basename(docRelPath);
  const sourcePath = path.isAbsolute(docRelPath) ? docRelPath : path.join(repo, docRelPath);
  if (!fs.existsSync(sourcePath)) return null;

  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  const archiveDir = docsArchiveDir(repo);
  const sourceContent = fs.readFileSync(sourcePath, 'utf8');
  try {
    const existing = fs
      .readdirSync(archiveDir)
      .filter((f) => f.startsWith(`${stem}-`) && f.endsWith(ext))
      .sort();
    if (existing.length > 0) {
      const latestArchive = path.join(archiveDir, existing.at(-1));
      if (fs.readFileSync(latestArchive, 'utf8') === sourceContent) {
        return path.relative(repo, latestArchive);
      }
    }
  } catch {}

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivedName = `${stem}-${timestamp}${ext}`;
  const destPath = path.join(archiveDir, archivedName);

  fs.copyFileSync(sourcePath, destPath);
  const archiveRelPath = path.relative(repo, destPath);
  appendEvent(repo, {
    type: 'doc_archived',
    source: docRelPath,
    archivedPath: archiveRelPath,
    archivedAt: new Date().toISOString()
  });
  return archiveRelPath;
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
  const pDir = protectedStateDir(repo);
  const protectedFile = pDir ? path.join(pDir, 'session.json') : null;
  const workspaceFile = sessionPath(repo);

  // Prefer protected .git/aiteam/session.json mirror if present so workspace tampering cannot bypass gates
  if (protectedFile && fs.existsSync(protectedFile)) {
    try {
      const raw = fs.readFileSync(protectedFile, 'utf8');
      const parsed = JSON.parse(raw);
      // Restore workspace copy if missing or out of sync
      try {
        if (!fs.existsSync(workspaceFile) || fs.readFileSync(workspaceFile, 'utf8') !== raw) {
          ensureStateDir(repo);
          atomicWrite(workspaceFile, raw);
        }
      } catch {}
      return parsed;
    } catch {}
  }

  try {
    return JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(repo, session) {
  ensureStateDir(repo);
  const next = { ...session, updatedAt: new Date().toISOString() };
  const payload = JSON.stringify(next, null, 2) + '\n';
  atomicWrite(sessionPath(repo), payload);
  const pDir = protectedStateDir(repo);
  if (pDir) {
    try {
      atomicWrite(path.join(pDir, 'session.json'), payload);
    } catch {}
  }
  return next;
}

export function appendEvent(repo, event) {
  ensureStateDir(repo);
  const row = { at: new Date().toISOString(), ...event };
  const line = JSON.stringify(row) + '\n';
  fs.appendFileSync(eventsPath(repo), line, 'utf8');
  const pDir = protectedStateDir(repo);
  if (pDir) {
    try {
      fs.appendFileSync(path.join(pDir, 'events.jsonl'), line, 'utf8');
    } catch {}
  }
  return row;
}

export function initSession(repo, request) {
  const dir = ensureStateDir(repo);
  const activeLogFile = path.join(dir, 'runs', 'active.log');
  try {
    if (fs.existsSync(activeLogFile)) {
      fs.unlinkSync(activeLogFile);
    }
  } catch {}
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
    phasePlan: [...DEFAULT_PHASE_PLAN],
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
  syncActiveRunForSession(session, now);
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
  // Strict setup stage ordering (architecture -> ui-design -> planning -> qa-planning -> critical-review)
  enforceSetupStageOrder(session, stage);
  // Strict per-task stage ordering
  enforceTaskStageOrder(session, stage, taskId);

  // In brownfield projects, if a previous PRD or TRD exists when re-entering
  // intake or architecture, archive it so it is never overwritten or lost.
  if (stage === 'intake') {
    archiveDocIfPresent(repo, '.aiteam/docs/prd.html');
  } else if (stage === 'architecture') {
    archiveDocIfPresent(repo, '.aiteam/docs/trd.html');
  }

  const now = new Date().toISOString();
  const runId = `${now.replace(/[:.]/g, '-')}-${agentId || stage}`;
  const activeRun = {
    runId,
    stage,
    taskId,
    agentId: agentId || stage,
    role: role || stage,
    startedAt: now
  };

  if (taskId && Array.isArray(session.taskLedger)) {
    session.taskLedger = session.taskLedger.map((t) => {
      if (t.id !== taskId) return t;
      return { ...t, startedAt: t.startedAt || now };
    });
  }

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
  enforceSetupStageOrder(session, stage);
  enforceTaskStageOrder(session, stage, taskId);
  validateStageCompletion(repo, session, stage, taskId, result);

  const now = new Date().toISOString();
  const outcome = result.outcome || 'PASS';
  const runId = session.activeRun?.runId || `${now.replace(/[:.]/g, '-')}-${stage}`;

  // Handle task-specific state transitions & cryptographic fingerprint verification
  if (taskId && Array.isArray(session.taskLedger)) {
    let fingerprintError = null;

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
          updated.implFingerprint = computeFingerprint(repo, updated.filesChanged);
          // Clear stale downstream review/QA state after implementation rework
          updated.review = null;
          updated.qa = null;
          updated.qaFingerprint = null;
          updated.integration = null;
          if (session.approvals) delete session.approvals[`qa:${taskId}`];
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
        const hasManualChecks = Array.isArray(result.manualChecks) && result.manualChecks.length > 0;
        const requiresManual = outcome === 'PASS_WITH_MANUAL_VALIDATION' || result.requiresManualValidation === true || hasManualChecks;

        if (outcome === 'PASS' && !requiresManual) {
          // Pure automated QA pass for headless/backend task with no manual human testing needed.
          // Direct bypass to qa-passed so integration can proceed without blocking on human sign-off.
          updated.status = 'qa-passed';
          updated.qa = result;
          updated.qaFailure = null;
          updated.qaFingerprint = computeFingerprint(repo, updated.filesChanged || []);
          updated.completedAt = now;
          if (!Array.isArray(updated.attemptHistory)) updated.attemptHistory = [];
          updated.attemptHistory.push({ stage: 'qa-automated', at: now, outcome: 'PASS' });
          if (!session.completedTasks.includes(taskId)) session.completedTasks.push(taskId);
          if (!session.approvals) session.approvals = {};
          session.approvals[`qa:${taskId}`] = {
            gate: 'qa',
            taskId,
            decision: 'APPROVED',
            approvedBy: 'qa-automated-bypass',
            at: now,
            response: 'Automated black-box QA passed with zero manual verification checks.'
          };
        } else if (outcome === 'PASS' || outcome === 'PASS_WITH_MANUAL_VALIDATION') {
          // Automated QA passed, but human manual verification is required (e.g. UI/browser check).
          // Held in "qa-auto-passed" until human user approves in portal/chat.
          updated.status = 'qa-auto-passed';
          updated.qa = result;
          updated.qaFailure = null;
          updated.qaFingerprint = computeFingerprint(repo, updated.filesChanged || []);
        } else {
          updated.status = 'needs-rework';
          updated.qaFailure = result;
        }
      } else if (stage === 'integration') {
        if (outcome === 'PASS') {
          const filesToVerify = updated.filesChanged || [];
          if (updated.qaFingerprint && filesToVerify.length > 0) {
            const valid = verifyFingerprint(repo, filesToVerify, updated.qaFingerprint);
            if (!valid) {
              updated.status = 'needs-rework';
              updated.integration = null;
              if (session.approvals) delete session.approvals[`qa:${taskId}`];
              fingerprintError = new Error(
                `AITEAM_FINGERPRINT_MISMATCH: Files for task "${taskId}" (${filesToVerify.join(', ')}) were modified after QA approval! Approval invalidated and task routed back to "needs-rework".`
              );
              return updated;
            }
          }
          updated.status = 'qa-passed';
          updated.integration = {
            committed: true,
            integrated: true,
            at: now,
            summary: result.summary || 'Integrated into Git',
            commitMessage: result.commitMessage || null,
            filesCommitted: result.filesCommitted || filesToVerify,
            fingerprint: updated.qaFingerprint || null
          };
        } else {
          updated.status = 'needs-rework';
          updated.integration = null;
        }
      }

      return updated;
    });

    if (fingerprintError) {
      session.activeRun = null;
      session.currentStage = 'implementation';
      writeSession(repo, session);
      appendEvent(repo, {
        type: 'workflow_fingerprint_mismatch',
        stage,
        taskId,
        error: fingerprintError.message
      });
      throw fingerprintError;
    }
  }

  // Record stage evidence
  if (!session.stageEvidence) session.stageEvidence = {};
  const evidenceKey = taskId ? `${stage}:${taskId}` : stage;
  session.stageEvidence[evidenceKey] = {
    completedAt: now,
    runId,
    result
  };

  if (outcome !== 'AWAITING_USER' && !session.completedStages.includes(stage)) {
    session.completedStages.push(stage);
  }

  // Check if all tasks in ledger are QA-passed AND integrated
  const isTaskIntegrated = (t) => Boolean(
    (t.status === 'qa-passed' && (t.integration?.integrated || t.integration?.committed || t.integration?.reason === 'no_changes')) ||
    t.status === 'integrated' ||
    t.status === 'completed'
  );
  const allTasksDone = session.taskLedger.length > 0 && session.taskLedger.every(isTaskIntegrated);

  if (allTasksDone && stage === 'integration') {
    session.status = 'COMPLETE';
    session.completedAt = now;
  }

  // Advance through the 9-stage setup pipeline and open human-approval gates at intake (clarification), prd-review, trd-review, and qa-manual
  if (stage === 'intake' && outcome === 'AWAITING_USER') {
    const cleanQuestions = (result.questions || [])
      .map((q) => (typeof q === 'string' ? q.trim() : typeof q?.question === 'string' ? q.question.trim() : ''))
      .filter(Boolean);
    session.intakeQuestions = cleanQuestions;
    openGateOnSession(session, {
      gate: 'intake',
      kind: 'intake',
      stage: 'intake',
      taskId: null,
      doc: null,
      questions: cleanQuestions
    });
  } else if (stage === 'intake' && outcome === 'PASS') {
    openGateOnSession(session, { gate: 'prd', kind: 'prd', taskId: null, doc: '.aiteam/docs/prd.html' });
  } else if (stage === 'architecture' && outcome === 'PASS') {
    session.currentStage = 'ui-design';
  } else if (stage === 'ui-design' && outcome === 'PASS') {
    session.currentStage = 'planning';
  } else if (stage === 'planning' && outcome === 'PASS') {
    session.currentStage = 'qa-planning';
  } else if (stage === 'qa-planning' && outcome === 'PASS') {
    session.currentStage = 'critical-review';
  } else if (stage === 'critical-review' && outcome === 'PASS') {
    openGateOnSession(session, { gate: 'trd', kind: 'trd', taskId: null, doc: '.aiteam/docs/trd.html' });
  } else if (stage === 'environment-readiness' && outcome === 'PASS') {
    session.currentStage = 'implementation';
    session.currentTaskId = session.taskLedger[0]?.id || null;
  } else if (stage === 'implementation' && taskId) {
    session.currentStage = outcome === 'PASS' ? 'code-review' : 'implementation';
    session.currentTaskId = taskId;
  } else if (stage === 'code-review' && taskId) {
    session.currentStage = outcome === 'PASS' ? 'qa' : 'implementation';
    session.currentTaskId = taskId;
  } else if (stage === 'qa') {
    const qt = (session.taskLedger || []).find((x) => x.id === taskId);
    if (qt && qt.status === 'qa-auto-passed') {
      openGateOnSession(session, { gate: 'qa', kind: 'qa-manual', taskId, questions: qaManualQuestions(taskId, result) });
    } else if (qt && qt.status === 'qa-passed') {
      session.currentStage = 'integration';
      session.currentTaskId = taskId;
    } else if (taskId && outcome === 'FAIL') {
      session.currentStage = 'implementation';
      session.currentTaskId = taskId;
    }
  } else if (stage === 'integration' && taskId && outcome === 'PASS' && !allTasksDone) {
    const nextTask = (session.taskLedger || []).find((t) => !isTaskIntegrated(t));
    if (nextTask) {
      session.currentStage = 'implementation';
      session.currentTaskId = nextTask.id;
    }
  }

  session.activeRun = null;
  syncActiveRunForSession(session, now);
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

export function parseTaskLedgerMarkdown(content) {
  const tasks = [];
  const taskBlocks = String(content || '').split(/^###\s+/m).slice(1);
  for (const block of taskBlocks) {
    const firstLine = block.split(/\r?\n/)[0].trim();
    const idMatch = firstLine.match(/^\[?([A-Za-z0-9_-]+)\]?:\s*(.+)$/) || firstLine.match(/^([A-Za-z0-9_-]+)\s*-\s*(.+)$/);
    const id = idMatch ? idMatch[1] : `T${tasks.length + 1}`;
    const title = idMatch ? idMatch[2] : firstLine;

    const acMatches = [...block.matchAll(/^\s*-\s*(?:\[[ xX]\]\s*)?(AC-\d+:?.+)$/gm)].map((m) => m[1].trim());
    const bulletMatches = acMatches.length
      ? acMatches
      : [...block.matchAll(/^\s*-\s*(?:\[[ xX]\]\s*)?(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);

    tasks.push({
      id,
      title,
      status: 'planned',
      description: block.slice(0, 400).trim(),
      acceptanceCriteria: bulletMatches.length ? bulletMatches : ['Pass all assigned unit and integration tests.']
    });
  }
  return tasks;
}

export function updateTaskLedger(repo, tasks) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  session.taskLedger = tasks;
  if (!session.completedStages.includes('planning')) {
    session.completedStages.push('planning');
  }
  writeSession(repo, session);
  appendEvent(repo, { type: 'task_ledger_updated', taskCount: tasks.length });
  return session;
}

export function writeActiveLog(repo, text, agentId = null) {
  ensureStateDir(repo);
  const session = readSession(repo);
  const now = new Date().toISOString();
  const runId = session?.activeRun?.runId || `${now.replace(/[:.]/g, '-')}-${agentId || 'active'}`;

  const runsDir = path.join(stateDir(repo), 'runs');
  const logFile = path.join(runsDir, 'active.log');
  const runStderr = path.join(runsDir, `${runId}.stderr.txt`);

  const formatted = /^\[\d{4}-\d{2}-\d{2}T/.test(String(text)) ? String(text) : `[${now}] ${text}`;
  fs.appendFileSync(logFile, formatted + '\n', 'utf8');
  fs.appendFileSync(runStderr, formatted + '\n', 'utf8');
}

export async function waitForApproval(repo, { gate, taskId = null, pollMs = 750, timeoutMs = 3600000 } = {}) {
  let session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  if (!gate) {
    gate = session.pendingUserInput?.gate || (session.currentStage === 'prd-review' ? 'prd' : session.currentStage === 'trd-review' ? 'trd' : 'qa');
  }
  if (!taskId && gate === 'qa') {
    taskId = session.pendingUserInput?.taskId || session.currentTaskId || null;
  }
  const gateId = taskId ? `${gate}:${taskId}` : gate;

  // If the gate isn't already decided and isn't currently open on pendingUserInput, open it so the Watcher UI displays the buttons
  const existingApproval = session.approvals?.[gateId];
  if (!existingApproval && (!session.pendingUserInput || session.pendingUserInput.gateId !== gateId || session.pendingUserInput.response !== null)) {
    const doc = gate === 'prd' ? '.aiteam/docs/prd.html' : gate === 'trd' ? '.aiteam/docs/trd.html' : null;
    openGate(repo, { gate, taskId, kind: gate === 'qa' ? 'qa-manual' : gate, doc });
  }

  writeActiveLog(
    repo,
    `⏸ Waiting for human decision on [${gateId.toUpperCase()}] gate in Watcher Dashboard Portal...`,
    'coordinator'
  );

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    session = readSession(repo);
    const approval = session?.approvals?.[gateId];
    if (approval && (approval.decision === 'APPROVED' || approval.decision === 'CHANGES_REQUESTED')) {
      writeActiveLog(
        repo,
        `▶ Portal gate [${gateId.toUpperCase()}] decided: ${approval.decision}${approval.response ? ` (${approval.response})` : ''}`,
        'coordinator'
      );
      return { session, approval };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(`AITEAM_WAIT_TIMEOUT: Timed out after ${Math.round(timeoutMs / 1000)}s waiting for human approval on gate "${gateId}".`);
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

  (async () => {
    try {
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
      } else if (cmd === 'update-ledger') {
        const session = readSession(repo);
        if (!session) throw new Error(`No active session found in ${repo}`);
        enforceApprovals(session, 'planning', null);
        const ledgerArg = getArg('--ledger', 'TASK_LEDGER.md');
        const ledgerPath = path.isAbsolute(ledgerArg) ? ledgerArg : path.join(repo, ledgerArg);
        if (!fs.existsSync(ledgerPath)) {
          throw new Error(`AITEAM_ARTIFACT_MISSING: Ledger file "${ledgerArg}" does not exist.`);
        }
        const content = fs.readFileSync(ledgerPath, 'utf8');
        const tasks = parseTaskLedgerMarkdown(content);
        if (tasks.length === 0) {
          throw new Error(`AITEAM_LEDGER_EMPTY: No tasks ("### T1: Title") found in "${ledgerArg}".`);
        }
        const sess = updateTaskLedger(repo, tasks);
        console.log(JSON.stringify({ ok: true, taskCount: sess.taskLedger.length, tasks: sess.taskLedger.map((t) => t.id) }));
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
      } else if (cmd === 'wait-approval') {
        const gate = getArg('--gate');
        const taskId = getArg('--taskId');
        const timeoutMs = Number(getArg('--timeoutMs', '3600000'));
        const pollMs = Number(getArg('--pollMs', '750'));
        const { session, approval } = await waitForApproval(repo, { gate, taskId, pollMs, timeoutMs });
        console.log(JSON.stringify({
          ok: true,
          gate: approval.gate,
          taskId: approval.taskId,
          decision: approval.decision,
          response: approval.response || '',
          currentStage: session.currentStage,
          currentTaskId: session.currentTaskId
        }));
      } else if (cmd === 'record-approval') {
        const gate = getArg('--gate');
        const taskId = getArg('--taskId');
        const decision = getArg('--decision');
        const response = getArg('--response', '');
        const approvedBy = getArg('--approvedBy', 'user');
        const gateId = taskId ? `${gate}:${taskId}` : gate;
        const sess = recordApproval(repo, { gate, taskId, decision, response, approvedBy, enforceDwell: true });
        console.log(JSON.stringify({ ok: true, gate, taskId, decision: sess.approvals[gateId]?.decision }));
      } else if (cmd === 'log') {
        const text = getArg('--text', '');
        writeActiveLog(repo, text);
        console.log(JSON.stringify({ ok: true }));
      } else if (cmd === 'archive-doc') {
        const doc = getArg('--doc');
        if (!doc) {
          console.error('Usage: state-bridge.mjs archive-doc --doc <relative-path> [--repo <repo>]');
          process.exit(1);
        }
        const archivedPath = archiveDocIfPresent(repo, doc);
        console.log(JSON.stringify({ ok: true, archived: Boolean(archivedPath), archivedPath }));
      } else if (cmd === 'status') {
        const sess = readSession(repo);
        console.log(JSON.stringify(sess || { status: 'NO_SESSION' }, null, 2));
      } else {
        console.error('Usage: state-bridge.mjs <init|stage-start|stage-complete|update-ledger|request-approval|wait-approval|record-approval|archive-doc|log|status> [options]');
        process.exit(1);
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
