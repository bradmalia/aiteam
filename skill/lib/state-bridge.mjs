import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { computeFingerprint, verifyFingerprint } from './fingerprint.mjs';
import { validateMotionEvidence } from './motion-evidence.mjs';
import { checkForUpgrade, performUpgrade } from './upgrader.mjs';

export const OBLIGATION_TYPES = {
  ACTUAL_INPUT: 'actualInput',
  RENDERED_CHECKS: 'renderedChecks',
  MOTION_EVIDENCE: 'motionEvidence',
  HUMAN_REVIEW: 'humanReview'
};

export const EXECUTION_METHODS = {
  COMPONENT: 'component',
  INTEGRATED: 'integrated',
  ACTUAL_INPUT: 'actual-input',
  RENDERED_MEASUREMENT: 'rendered-measurement',
  HUMAN_JUDGMENT: 'human-judgment'
};

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
  if (gate === 'upgrade') {
    return ['A newer version of AITeam is available on GitHub. Approve in the Watcher Portal or reply "yes" in chat to pull from GitHub and update this project now, or click Request Changes / reply "skip" to continue without upgrading.'];
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

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectQaFiles(dir, rootDir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectQaFiles(full, rootDir, out);
    } else if (
      entry.isFile() &&
      /\.(?:test|spec)\.[a-z0-9]+$|\.(?:mjs|cjs|js|ts|tsx|py|sh|gd)$/i.test(entry.name)
    ) {
      const stat = fs.statSync(full);
      if (stat.size > 0) {
        out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

export function hasQaTestFiles(repo, taskId = null) {
  const qaDir = path.join(repo, 'tests', 'qa');
  if (!fs.existsSync(qaDir)) return false;
  try {
    const files = collectQaFiles(qaDir, qaDir);
    if (files.length === 0) return false;
    if (!taskId) return true;

    const idLower = String(taskId).trim().toLowerCase();
    const stem = idLower.replace(/[^a-z0-9]+/g, '');
    const idBoundaryRe = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(idLower)}(?:$|[^a-z0-9])`);
    const stemBoundaryRe = stem ? new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(stem)}(?:$|[^0-9])`) : null;

    return files.some((relPath) => {
      const relLower = relPath.toLowerCase();
      if (idBoundaryRe.test(relLower)) return true;
      if (stemBoundaryRe) {
        const relCompact = relLower.replace(/[-_\s]+/g, '');
        if (stemBoundaryRe.test(relCompact)) return true;
      }
      return false;
    });
  } catch {}
  return false;
}

function isRedundantIntakeApprovalQuestion(question) {
  const asksForApproval = /\b(?:approve|confirm|sign[\s-]?off)\b/i.test(question);
  const targetsWholeArtifact = /\b(?:prd|product requirements document|requirements artifact|final(?:ized)? requirements|complete requirements|all requirements|requirements and acceptance criteria|everything)\b/i.test(question);
  return asksForApproval && targetsWholeArtifact;
}

export function determineAcceptanceObligations(taskData, repoContext = {}) {
  const text = [
    taskData.title || '',
    taskData.description || '',
    ...(taskData.acceptanceCriteria || [])
  ].join(' ');

  // 1. Explicit obligations declaration in description or markdown block
  let explicitActualInput = null;
  let explicitRenderedChecks = null;
  let explicitMotionEvidence = null;
  let explicitHumanReview = null;

  const obMatch = text.match(/(?:obligations?|acceptance obligations?):\s*([^\n\r]+)/i);
  if (obMatch) {
    const obList = obMatch[1].toLowerCase();
    if (obList.includes('actual-input') || obList.includes('actualinput') || obList.includes('input')) explicitActualInput = true;
    if (obList.includes('rendered') || obList.includes('renderedchecks') || obList.includes('geometry')) explicitRenderedChecks = true;
    if (obList.includes('motion') || obList.includes('video') || obList.includes('motionevidence') || obList.includes('gameplay')) explicitMotionEvidence = true;
    if (obList.includes('human') || obList.includes('humanreview') || obList.includes('visual-review') || obList.includes('manual')) explicitHumanReview = true;
    if (obList.includes('none') || obList.includes('automated-only') || obList.includes('headless')) {
      explicitActualInput = false;
      explicitRenderedChecks = false;
      explicitMotionEvidence = false;
      explicitHumanReview = false;
    }
  }

  // 2. Semantic evaluation based on task context and criteria
  const gameplayRegex = /\b(gameplay|motion|animation|chase|pursuit|locomotion|walk|jump|dodge|lunge|retreat|attack|velocity|physics|traversal|controller|gamepad|keyboard\s+input|actual[- ]input|flight|patrol|scuttle|frames?|fps|actor|enemy|player|sprite)\b/i;
  const visualUiRegex = /\b(ui|ux|layout|screen|dialog|hud|meter|canvas|render(ed|ing)?|viewport|visual|css|responsive|theme|palette)\b/i;
  const nonVisualRegex = /\b(backend|api|dedup|database|sql|algorithm|headless|parser|cli|documentation|docs|config|setup|script)\b/i;

  const isGameplay = gameplayRegex.test(text);
  const isVisualUi = visualUiRegex.test(text);
  const isPureBackend = nonVisualRegex.test(text) && !isGameplay && !isVisualUi;

  const actualInput = explicitActualInput !== null ? explicitActualInput : (isGameplay ? true : false);
  const renderedChecks = explicitRenderedChecks !== null ? explicitRenderedChecks : (isGameplay || isVisualUi ? true : false);
  const motionEvidence = explicitMotionEvidence !== null ? explicitMotionEvidence : (isGameplay ? true : false);
  const humanReview = explicitHumanReview !== null ? explicitHumanReview : ((isGameplay || isVisualUi) && !isPureBackend ? true : false);

  const criteriaMap = {};
  for (const ac of (taskData.acceptanceCriteria || [])) {
    const acIdMatch = ac.match(/^(AC-\d+)/i);
    const acId = acIdMatch ? acIdMatch[1].toUpperCase() : ac.slice(0, 30);
    const acGameplay = gameplayRegex.test(ac);
    const acVisual = visualUiRegex.test(ac);

    let method = 'component';
    if (ac.toLowerCase().includes('actual-input') || (acGameplay && (ac.toLowerCase().includes('traversal') || ac.toLowerCase().includes('input') || ac.toLowerCase().includes('control')))) {
      method = 'actual-input';
    } else if (ac.toLowerCase().includes('render') || ac.toLowerCase().includes('geometry') || acVisual || ac.toLowerCase().includes('floor') || ac.toLowerCase().includes('contact')) {
      method = 'rendered-measurement';
    } else if (acGameplay) {
      method = 'integrated';
    }

    criteriaMap[acId] = {
      id: acId,
      criterion: ac,
      requiredMethod: method,
      actualInput: explicitActualInput !== null ? explicitActualInput : acGameplay,
      renderedChecks: explicitRenderedChecks !== null ? explicitRenderedChecks : (acGameplay || acVisual),
      motionEvidence: explicitMotionEvidence !== null ? explicitMotionEvidence : acGameplay,
      humanReview: explicitHumanReview !== null ? explicitHumanReview : (acGameplay || acVisual)
    };
  }

  return {
    actualInput,
    renderedChecks,
    motionEvidence,
    humanReview,
    criteriaMap
  };
}

export function validateArtifactReferences(repo, result) {
  const refs = [];
  if (Array.isArray(result.evidence)) {
    for (const e of result.evidence) {
      if (typeof e === 'string') {
        const urlMatch = e.match(/https?:\/\/[^\s"'<>]+/i);
        const pathMatch = e.match(/(?:(?:\.aiteam|\/|\.\/|tests\/|scripts\/|docs\/)[^\s"'<>]+)/i);
        if (urlMatch) refs.push(urlMatch[0]);
        else if (pathMatch) refs.push(pathMatch[0]);
      }
    }
  }
  if (Array.isArray(result.screenshots)) {
    for (const s of result.screenshots) {
      if (s?.path) refs.push(s.path);
    }
  }
  if (result.motionEvidence) {
    if (typeof result.motionEvidence === 'string') {
      refs.push(result.motionEvidence);
    } else if (Array.isArray(result.motionEvidence)) {
      for (const m of result.motionEvidence) {
        if (typeof m === 'string') refs.push(m);
        else if (m?.path || m?.videoPath) refs.push(m.path || m.videoPath);
      }
    } else if (typeof result.motionEvidence === 'object' && result.motionEvidence !== null) {
      if (result.motionEvidence.path || result.motionEvidence.videoPath) {
        refs.push(result.motionEvidence.path || result.motionEvidence.videoPath);
      }
    }
  }

  for (const ref of refs) {
    let checkPath = null;
    if (ref.startsWith('http://') || ref.startsWith('https://')) {
      try {
        const u = new URL(ref);
        if (u.pathname.startsWith('/artifacts/')) {
          checkPath = path.join(repo, '.aiteam', 'docs', decodeURIComponent(u.pathname.slice('/artifacts/'.length)));
        } else if (u.pathname.startsWith('/review-assets/')) {
          checkPath = path.join(repo, '.aiteam', 'reviews', decodeURIComponent(u.pathname.slice('/review-assets/'.length)));
        }
      } catch {}
    } else if (ref.startsWith('/review-assets/')) {
      checkPath = path.join(repo, '.aiteam', 'reviews', decodeURIComponent(ref.slice('/review-assets/'.length)));
    } else if (ref.startsWith('/artifacts/')) {
      checkPath = path.join(repo, '.aiteam', 'docs', decodeURIComponent(ref.slice('/artifacts/'.length)));
    } else if (ref.includes('.') && !ref.includes(' ') && !ref.includes('\n')) {
      checkPath = path.isAbsolute(ref) ? ref : path.resolve(repo, ref);
    }

    if (checkPath && !fs.existsSync(checkPath)) {
      throw new Error(
        `AITEAM_ARTIFACT_REFERENCE_BROKEN: Referenced evidence file or asset does not exist on disk: "${ref}" (resolved: "${checkPath}").`
      );
    }
  }
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

  if (stage === 'critical-review') {
    const findings = Array.isArray(result.findings) ? result.findings : [];
    const severe = findings.filter((f) => f && (f.severity === 'BLOCKER' || f.severity === 'MAJOR'));
    if (outcome === 'PASS' && severe.length > 0) {
      throw new Error(
        `AITEAM_REVIEW_CONFLICT: Cannot PASS "critical-review" when ${severe.length} BLOCKER/MAJOR finding(s) are present. Set outcome="FAIL" and specify repairStage ("architecture", "ui-design", "planning", or "qa-planning").`
      );
    }
    if (outcome === 'FAIL') {
      if (severe.length === 0) {
        throw new Error(
          `AITEAM_CRITICAL_REVIEW_FINDINGS_REQUIRED: Cannot FAIL "critical-review" without at least one BLOCKER or MAJOR finding in findings=[...].`
        );
      }
      const repairStage = result.repairStage || severe[0]?.repairStage;
      if (!['architecture', 'ui-design', 'planning', 'qa-planning'].includes(repairStage)) {
        throw new Error(
          `AITEAM_INVALID_REPAIR_STAGE: Failed "critical-review" must specify repairStage as one of: "architecture", "ui-design", "planning", or "qa-planning".`
        );
      }
      return;
    }
  }

  if (outcome !== 'PASS' && outcome !== 'PASS_WITH_MANUAL_VALIDATION') return;

  if (stage === 'intake') {
    if (!session.intakeClarified) {
      throw new Error(
        `AITEAM_INTAKE_INTERVIEW_REQUIRED: Cannot complete stage "intake" with PASS before asking the user clarifying questions! First inspect the repository, formulate 4-8 concrete multi-dimensional product/UX/scope clarifying questions, and call aiteam_advance with stage="intake", outcome="AWAITING_USER", and questions=[...]. Wait for the user's answers before generating .aiteam/docs/prd.html and completing intake with PASS.`
      );
    }
    const prdPath = path.join(docsDir(repo), 'prd.html');
    if (!fs.existsSync(prdPath) || fs.statSync(prdPath).size === 0) {
      throw new Error(
        `AITEAM_ARTIFACT_MISSING: Cannot complete stage "intake" with PASS because ".aiteam/docs/prd.html" does not exist or is empty. You must generate the PRD HTML document before completing intake.`
      );
    }
  } else if (stage === 'architecture' || stage === 'ui-design' || stage === 'qa-planning' || stage === 'critical-review') {
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
    if (!hasQaTestFiles(repo, taskId)) {
      throw new Error(
        `AITEAM_QA_TEST_MISSING: Cannot PASS stage "qa" for task "${taskId}" because no automated black-box test file matching "${taskId}" exists under "tests/qa/" (e.g. tests/qa/${taskId}.test.*). Per the QA contract, you must author and run dedicated black-box tests for this task before completing QA.`
      );
    }
    const hasChecks = Array.isArray(result.checks) && result.checks.length > 0;
    const hasEvidence = Array.isArray(result.evidence) && result.evidence.length > 0;
    if (!hasChecks && !hasEvidence) {
      throw new Error(
        `AITEAM_EVIDENCE_MISSING: Cannot PASS stage "qa" for task "${taskId}" without reporting executed "checks" or "evidence".`
      );
    }

    const task = (session.taskLedger || []).find((t) => t.id === taskId);
    // Explicit policy for legacy tasks: if obligations missing, infer from requiresManualValidation or manualChecks
    const obligations = task?.acceptanceObligations || {
      humanReview: Boolean(result.requiresManualValidation === true || (Array.isArray(result.manualChecks) && result.manualChecks.length > 0)),
      motionEvidence: false,
      actualInput: false,
      renderedChecks: false
    };

    // 1. Conflict check: pre-established human review / motion evidence vs empty manual checks or requiresManualValidation=false
    if (obligations.humanReview || obligations.motionEvidence) {
      const isManualExplicitlyFalse = result.requiresManualValidation === false;
      const isManualChecksEmpty = !Array.isArray(result.manualChecks) || result.manualChecks.length === 0;
      if (outcome === 'PASS' && (isManualExplicitlyFalse || isManualChecksEmpty)) {
        const reasons = [];
        if (obligations.motionEvidence) reasons.push('native motion evidence');
        if (obligations.actualInput) reasons.push('actual-input traversal');
        if (obligations.renderedChecks) reasons.push('rendered-property measurements');
        if (obligations.humanReview) reasons.push('human visual/gameplay review');
        throw new Error(
          `AITEAM_ACCEPTANCE_OBLIGATION_CONFLICT: Task "${taskId}" has pre-established obligations requiring ${reasons.join(', ')}. QA submission cannot bypass human review with requiresManualValidation=false or empty manualChecks. Provide concrete manual verification checks and required evidence, or set outcome="PASS_WITH_MANUAL_VALIDATION".`
        );
      }
    }

    // 2. Motion evidence check
    if (obligations.motionEvidence) {
      const motionInput = result.motionEvidence || (Array.isArray(result.evidence) ? result.evidence.filter((e) => typeof e === 'string' && (/\.(?:webm|mp4|ogg|json)$/i.test(e) || e.includes('/review-assets/'))) : null);
      const motionCheck = validateMotionEvidence(repo, motionInput);
      if (!motionCheck.valid) {
        throw new Error(
          `AITEAM_MOTION_EVIDENCE_MISSING: Task "${taskId}" requires native motion evidence (video clip or verified frame capture sequence demonstrating requested behavior under actual execution), but: ${motionCheck.errors.join('; ')}`
        );
      }
    }

    // 3. Rendered checks check
    if (obligations.renderedChecks) {
      const checks = Array.isArray(result.checks) ? result.checks : [];
      const hasRendered = checks.some((c) => {
        const name = (c.name || '').toLowerCase();
        const exp = (c.expected || '').toLowerCase();
        const act = (c.actual || '').toLowerCase();
        const method = (c.executionMethod || '').toLowerCase();
        return method === 'rendered-measurement' || /\b(render|geometry|bounds|pixel|px|viewport|layout|meter|coordinate|floor|collision|feet|camera|canvas|dimension|resolution|size|width|height|screen|display|position)\b/i.test(`${name} ${exp} ${act}`);
      });
      if (!hasRendered) {
        throw new Error(
          `AITEAM_RENDERED_CHECKS_MISSING: Task "${taskId}" requires rendered-property or geometry measurements. Recorded checks must verify rendered output rather than only internal flags or configuration.`
        );
      }
    }

    // 4. Artifact reference integrity check
    validateArtifactReferences(repo, result);
  }
}

// Mutates an in-memory session to open a human-approval gate (pendingUserInput).
function openGateOnSession(session, { gate, kind, stage, taskId, doc, questions, screenshots, motionClips, criteriaObligations }) {
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
    screenshots: Array.isArray(screenshots) ? screenshots : (session.pendingUserInput?.screenshots || []),
    motionClips: Array.isArray(motionClips) ? motionClips : (session.pendingUserInput?.motionClips || []),
    criteriaObligations: criteriaObligations || session.pendingUserInput?.criteriaObligations || null,
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
      gate !== 'upgrade' &&
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
    if (approved) {
      if (targetTask.status !== 'qa-auto-passed' && targetTask.status !== 'qa-passed') {
        throw new Error(
          `AITEAM_STAGE_ORDER_VIOLATION: Cannot approve QA gate for task "${taskId}" because its current status is "${targetTask.status}" (must pass automated "qa" stage first).`
        );
      }
      if (targetTask.qaFingerprint && Array.isArray(targetTask.filesChanged) && targetTask.filesChanged.length > 0) {
        const valid = verifyFingerprint(repo, targetTask.filesChanged, targetTask.qaFingerprint);
        if (!valid) {
          throw new Error(
            `AITEAM_EVIDENCE_STALE: Source files (${targetTask.filesChanged.join(', ')}) were modified after QA verification. Approval invalidated; re-verification required.`
          );
        }
      }
    }
  }

  if (!session.approvals) session.approvals = {};
  session.approvals[gateId] = { gate, taskId: taskId ?? null, decision: approved ? 'APPROVED' : 'CHANGES_REQUESTED', response, approvedBy, at: now };

  if (session.pendingUserInput && session.pendingUserInput.gateId === gateId) {
    session.pendingUserInput.response = (approved ? 'APPROVED' : 'CHANGES_REQUESTED') + (response ? `: ${response}` : '');
  }

  const reviewStage = GATE_STAGE_FOR_GATE[gate];
  if (gate === 'upgrade') {
    const upgradeOptions = session.pendingUpgrade?.options || {};
    const resumeStage = session.pendingUserInput?.resumeStage || (session.currentStage === 'upgrade' ? 'intake' : session.currentStage) || 'intake';
    const resumeTaskId = session.pendingUserInput?.resumeTaskId ?? session.currentTaskId ?? null;
    if (approved) {
      const upg = performUpgrade(repo, upgradeOptions);
      session.aiteamVersion = upg.version;
      session.aiteamCommit = upg.commit;
      session.pendingUpgrade = null;
      appendEvent(repo, {
        type: 'aiteam_upgraded',
        version: upg.version,
        commit: upg.commit,
        summary: upg.summary,
        at: now
      });
      writeActiveLog(repo, `⬆️ ${upg.summary}`, 'coordinator');
    } else {
      session.declinedUpgradeCommit = session.pendingUpgrade?.remoteCommit || 'declined';
      session.pendingUpgrade = null;
    }
    session.currentStage = resumeStage;
    session.currentTaskId = resumeTaskId;
  } else if (gate === 'intake') {
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
      t.attemptHistory.push({ stage: 'qa-manual', at: now, outcome: approved ? 'PASS' : 'FAIL', feedback: response });
      if (approved) {
        t.status = 'qa-passed';
        t.completedAt = now;
        if (!session.completedTasks.includes(taskId)) session.completedTasks.push(taskId);
      } else {
        t.status = 'needs-rework';
        t.qaFailure = { ...t.qaFailure, decision: 'CHANGES_REQUESTED', response, at: now };
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

export function offerUpgradeIfAvailable(repo, options = {}) {
  const session = readSession(repo);
  const check = checkForUpgrade(repo, options);
  if (!check.upgradeAvailable) {
    return { upgradeAvailable: false, check, session };
  }
  if (session?.declinedUpgradeCommit && check.remoteCommit && session.declinedUpgradeCommit === check.remoteCommit && !options.forceCheck) {
    return { upgradeAvailable: false, check, session, declined: true };
  }

  if (
    session &&
    (!session.pendingUserInput || session.pendingUserInput.response != null || session.pendingUserInput.gate === 'upgrade')
  ) {
    const resumeStage = session.currentStage === 'upgrade' ? 'intake' : (session.currentStage || 'intake');
    const resumeTaskId = session.pendingUserInput?.gate === 'upgrade'
      ? (session.pendingUserInput.resumeTaskId ?? session.currentTaskId ?? null)
      : (session.currentTaskId ?? null);

    session.pendingUpgrade = {
      ...check,
      options: (options.aiteamRoot || options.remote || options.branch)
        ? { aiteamRoot: options.aiteamRoot, remote: options.remote, branch: options.branch }
        : undefined
    };

    const changelogLines = Array.isArray(check.changelog)
      ? check.changelog.map((c) => `Commit: ${c}`)
      : [];

    openGateOnSession(session, {
      gate: 'upgrade',
      kind: 'upgrade',
      stage: resumeStage,
      taskId: null,
      doc: null,
      screenshots: [],
      motionClips: [],
      questions: [
        check.summary,
        ...changelogLines,
        'Approve to pull the latest AITeam from GitHub and upgrade this project now, or Request Changes / reply "skip" to continue without upgrading.'
      ]
    });
    session.currentTaskId = resumeTaskId;
    session.pendingUserInput.resumeStage = resumeStage;
    session.pendingUserInput.resumeTaskId = resumeTaskId;
    syncActiveRunForSession(session);
    writeSession(repo, session);
    appendEvent(repo, {
      type: 'upgrade_offered',
      fromVersion: check.installedProjectVersion || check.localVersion,
      toVersion: check.remoteVersion,
      remoteCommit: check.remoteCommit
    });
  }

  return { upgradeAvailable: true, check, session };
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

export function checkAndInvalidateStaleTasks(repo, session) {
  if (!session || !Array.isArray(session.taskLedger)) return false;
  let invalidatedAny = false;

  session.taskLedger = session.taskLedger.map((t) => {
    if ((t.status === 'qa-auto-passed' || t.status === 'qa-passed') && t.qaFingerprint && Array.isArray(t.filesChanged) && t.filesChanged.length > 0) {
      const valid = verifyFingerprint(repo, t.filesChanged, t.qaFingerprint);
      if (!valid) {
        invalidatedAny = true;
        const now = new Date().toISOString();
        const reason = `AITEAM_EVIDENCE_STALE: Material source files (${t.filesChanged.join(', ')}) were modified after QA verification. Evidence and approval invalidated. Task routed back to implementation.`;
        t.status = 'needs-rework';
        t.staleReason = reason;
        t.qaFailure = {
          decision: 'EVIDENCE_STALE',
          response: reason,
          at: now
        };
        t.qa = null;
        t.qaFingerprint = null;
        t.review = null;
        t.integration = null;

        if (session.approvals) {
          delete session.approvals[`qa:${t.id}`];
        }
        if (session.completedTasks) {
          session.completedTasks = session.completedTasks.filter((id) => id !== t.id);
        }
        if (session.pendingUserInput?.taskId === t.id) {
          session.pendingUserInput = null;
        }
        if (session.currentTaskId === t.id && (session.currentStage === 'integration' || session.currentStage === 'qa-manual')) {
          session.currentStage = 'implementation';
        }
        appendEvent(repo, {
          type: 'workflow_evidence_invalidated',
          taskId: t.id,
          reason
        });
      }
    }
    return t;
  });

  return invalidatedAny;
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
    intakeRound: 0,
    intakeDiscovery: [],
    lockedCriticalFindings: [],
    criticalReviewFailure: null,
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
        const obligations = updated.acceptanceObligations || {};
        const hasManualChecks = Array.isArray(result.manualChecks) && result.manualChecks.length > 0;
        const requiresManual = Boolean(
          obligations.humanReview ||
          obligations.motionEvidence ||
          outcome === 'PASS_WITH_MANUAL_VALIDATION' ||
          result.requiresManualValidation === true ||
          hasManualChecks
        );

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
          if (!Array.isArray(updated.attemptHistory)) updated.attemptHistory = [];
          updated.attemptHistory.push({ stage: 'qa-automated', at: now, outcome: 'PASS_AWAITING_HUMAN' });
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

  if (outcome === 'PASS' || outcome === 'PASS_WITH_MANUAL_VALIDATION') {
    if (!session.completedStages.includes(stage)) {
      session.completedStages.push(stage);
    }
  } else if (outcome === 'FAIL') {
    session.completedStages = (session.completedStages || []).filter((s) => s !== stage);
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
    session.intakeClarified = false;
    session.intakeRound = (session.intakeRound || 0) + 1;
    if (Array.isArray(result.evidence) && result.evidence.length > 0) {
      session.intakeDiscovery = result.evidence;
    }
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
  } else if (stage === 'critical-review' && outcome === 'FAIL') {
    const severe = (result.findings || []).filter((f) => f && (f.severity === 'BLOCKER' || f.severity === 'MAJOR'));
    const repairStage = result.repairStage || severe[0]?.repairStage || 'planning';
    session.lockedCriticalFindings = severe;
    session.criticalReviewFailure = {
      at: now,
      summary: result.summary || 'Critical review identified design gaps',
      repairStage,
      findings: severe
    };
    const setupOrder = ['architecture', 'ui-design', 'planning', 'qa-planning', 'critical-review'];
    const repairIdx = setupOrder.indexOf(repairStage);
    const stagesToReset = repairIdx !== -1 ? new Set(setupOrder.slice(repairIdx)) : new Set(['critical-review']);
    session.completedStages = (session.completedStages || []).filter((s) => !stagesToReset.has(s));
    session.currentStage = repairStage;
  } else if (stage === 'critical-review' && outcome === 'PASS') {
    session.lockedCriticalFindings = [];
    session.criticalReviewFailure = null;
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
      const motionCheck = validateMotionEvidence(repo, result.motionEvidence || (Array.isArray(result.evidence) ? result.evidence : []));
      openGateOnSession(session, {
        gate: 'qa',
        kind: 'qa-manual',
        taskId,
        questions: qaManualQuestions(taskId, result),
        screenshots: result.screenshots || [],
        motionClips: motionCheck.clips || [],
        criteriaObligations: qt.acceptanceObligations || null
      });
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

export function parseTaskLedgerMarkdown(content, repoContext = {}) {
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

    const taskObj = {
      id,
      title,
      status: 'planned',
      description: block.trim(),
      acceptanceCriteria: bulletMatches.length ? bulletMatches : ['Pass all assigned unit and integration tests.']
    };
    taskObj.acceptanceObligations = determineAcceptanceObligations(taskObj, repoContext);
    tasks.push(taskObj);
  }
  return tasks;
}

export function updateTaskLedger(repo, tasks) {
  const session = readSession(repo);
  if (!session) throw new Error(`No active session found in ${repo}`);
  
  // Immutability: pre-established obligations cannot be downgraded or dropped
  const existingMap = new Map((session.taskLedger || []).map((t) => [t.id, t]));
  const mergedTasks = tasks.map((newTask) => {
    const existing = existingMap.get(newTask.id);
    const taskObj = { ...newTask };
    if (!taskObj.acceptanceObligations) {
      taskObj.acceptanceObligations = determineAcceptanceObligations(taskObj);
    }
    if (existing && existing.acceptanceObligations) {
      const oldOb = existing.acceptanceObligations;
      const newOb = taskObj.acceptanceObligations;
      taskObj.acceptanceObligations = {
        actualInput: Boolean(oldOb.actualInput || newOb.actualInput),
        renderedChecks: Boolean(oldOb.renderedChecks || newOb.renderedChecks),
        motionEvidence: Boolean(oldOb.motionEvidence || newOb.motionEvidence),
        humanReview: Boolean(oldOb.humanReview || newOb.humanReview),
        criteriaMap: {
          ...(oldOb.criteriaMap || {}),
          ...(newOb.criteriaMap || {})
        }
      };
    }
    if (existing) {
      // Preserve status and progress unless planning explicitly resets
      taskObj.status = existing.status || taskObj.status;
      if (existing.filesChanged) taskObj.filesChanged = existing.filesChanged;
      if (existing.qaFingerprint) taskObj.qaFingerprint = existing.qaFingerprint;
      if (existing.attemptHistory) taskObj.attemptHistory = existing.attemptHistory;
    }
    return taskObj;
  });

  session.taskLedger = mergedTasks;
  if (!session.completedStages.includes('planning')) {
    session.completedStages.push('planning');
  }
  writeSession(repo, session);
  appendEvent(repo, { type: 'task_ledger_updated', taskCount: mergedTasks.length });
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
    if (checkAndInvalidateStaleTasks(repo, session)) {
      writeSession(repo, session);
      if (gateId.startsWith('qa:') && gateId === `qa:${taskId}`) {
        throw new Error(`AITEAM_EVIDENCE_STALE: Source files modified while waiting for approval on gate "${gateId}". Verification invalidated.`);
      }
    }
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
const isMain = Boolean(process.argv[1]) && (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
})();
if (isMain) {
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
        let screenshots = null;
        const sRaw = getArg('--screenshots');
        if (sRaw) { try { screenshots = JSON.parse(sRaw); } catch {} }
        const sess = openGate(repo, { gate, taskId, kind, doc, stage, questions, screenshots });
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
