import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, patchSession, readSession, writeSession } from './state.mjs';
import { commitValidatedPaths, fingerprintPaths, gitSnapshot } from './git.mjs';
import { getAgent, loadRegistry, registerScopedSpecialist } from './registry.mjs';
import { runAgent } from './runtime.mjs';

const STAGE_LABELS = {
  intake: 'Intake',
  architecture: 'Architecture',
  recruiting: 'Architecture',
  planning: 'Planning',
  'critical-review': 'Critical Review',
  implementation: 'Implementation',
  'code-review': 'Code Review',
  qa: 'QA',
  integration: 'Integration'
};

const FIXED_AGENTS = {
  intake: 'analyst',
  architecture: 'architect',
  recruiting: 'recruiter',
  planning: 'planner',
  'critical-review': 'critical-reviewer',
  'code-review': 'code-reviewer',
  qa: 'qa',
  integration: 'maintainer'
};

const COMMON_SCHEMA = `
Every response must be one JSON object with no Markdown fence or surrounding prose.
Common fields:
- "outcome": "PASS", "FAIL", or "BLOCKED"
- "summary": non-empty string
- "evidence": non-empty array of concrete strings when outcome is PASS
Do not claim commands, files, or tests that you did not actually observe.`;

const STAGE_SCHEMAS = {
  intake: `${COMMON_SCHEMA}
For Intake, "outcome" may also be "AWAITING_USER". Also return "requirements" (string array), "acceptanceCriteria" (string array), "questions" (string array), and boolean "userConfirmed".
Use AWAITING_USER when clarification is needed: include non-empty questions and set userConfirmed to false. Use PASS only when questions is empty, requirements and acceptanceCriteria are complete, and userConfirmed is true.`,
  architecture: `${COMMON_SCHEMA}
Also return "design" (non-empty string array) and "specialistNeeds" (array of {"capability","reason","suggestedId"}). Use an empty specialistNeeds array when the registry covers the work.`,
  recruiting: `${COMMON_SCHEMA}
Also return "specialist": {"id","role","sandbox","triggers","capabilities","contract"}. The contract must be at least 80 characters of complete inline instructions, never a file path.`,
  planning: `${COMMON_SCHEMA}
Also return "tasks", a non-empty array of {"id","title","description","specialistId","acceptanceCriteria","dependencies"}. IDs must be unique lowercase identifiers; acceptanceCriteria and dependencies are arrays. specialistId must name an available registered implementation specialist.`,
  'critical-review': `${COMMON_SCHEMA}
Also return "findings" as an array of {"id","severity","description","recommendation"}, where severity is BLOCKER, MAJOR, MINOR, or INFO. If any BLOCKER or MAJOR remains, outcome must be FAIL and "repairStage" must be "architecture" or "planning".`,
  implementation: `${COMMON_SCHEMA}
For Implementation, you MUST perform the code edits in the workspace using your tools and return outcome "PASS". Never return outcome "FAIL" for your own implementation task. Also return "filesChanged" (non-empty repository-relative path array on PASS) and "validations" (array of {"command","result"}).`,
  'code-review': `${COMMON_SCHEMA}
Also return "findings" as an array of {"id","severity","location","impact","recommendation"}. If any BLOCKER or MAJOR exists, outcome must be FAIL. Do not modify files.`,
  qa: `${COMMON_SCHEMA}
Outcome may also be "PASS_WITH_MANUAL_VALIDATION". Also return "checks" as a non-empty array of {"name","status","evidence"} and "manualChecks" as a string array. FAIL means an implementation defect or failed machine-verifiable check. Do not modify files.`,
  integration: `${COMMON_SCHEMA}
Also return "commitMessage" as a concise non-empty string. Inspect the validated paths and repository state, but do not stage or commit; the AITEAM server owns Git integration.`
};

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function stringArray(value, name, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }
  if (nonEmpty && value.length === 0) throw new Error(`${name} must not be empty.`);
  return value.map((item) => item.trim());
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('Specialist returned no structured result.');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Specialist result is not valid JSON: ${error.message}`);
  }
}

export function parseStageResult(stage, stdout) {
  const result = parseJson(stdout);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Specialist result must be one JSON object.');
  const allowed = stage === 'qa' ? ['PASS', 'FAIL', 'BLOCKED', 'PASS_WITH_MANUAL_VALIDATION'] : stage === 'intake' ? ['PASS', 'FAIL', 'BLOCKED', 'AWAITING_USER'] : ['PASS', 'FAIL', 'BLOCKED'];
  if (!allowed.includes(result.outcome)) throw new Error(`${stage} outcome must be one of: ${allowed.join(', ')}.`);
  result.summary = nonEmptyString(result.summary, 'summary');
  result.evidence = stringArray(result.evidence || [], 'evidence', { nonEmpty: result.outcome === 'PASS' || result.outcome === 'PASS_WITH_MANUAL_VALIDATION' });

  if (stage === 'intake') {
    result.requirements = stringArray(result.requirements || [], 'requirements', { nonEmpty: result.outcome === 'PASS' });
    result.acceptanceCriteria = stringArray(result.acceptanceCriteria || [], 'acceptanceCriteria', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.questions || [])) throw new Error('questions must be an array.');
    result.questions = (result.questions || []).map((q, index) => {
      if (typeof q === 'string' && q.trim()) return q.trim();
      if (q && typeof q === 'object' && typeof q.question === 'string' && q.question.trim()) {
        return q.question.trim();
      }
      throw new Error(`questions[${index}] must be a non-empty string or question object.`);
    });
    result.userConfirmed = result.userConfirmed === undefined ? result.questions.length === 0 : result.userConfirmed;
    if (typeof result.userConfirmed !== 'boolean') throw new Error('userConfirmed must be a boolean.');
    if (result.outcome === 'AWAITING_USER' && result.questions.length === 0) throw new Error('AWAITING_USER Intake results must include at least one question.');
    if (result.outcome === 'PASS' && (result.questions.length > 0 || !result.userConfirmed)) throw new Error('Intake cannot PASS while questions remain or userConfirmed is false.');
  } else if (stage === 'architecture') {
    result.design = stringArray(result.design || [], 'design', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.specialistNeeds || [])) throw new Error('specialistNeeds must be an array.');
    result.specialistNeeds = (result.specialistNeeds || []).map((gap, index) => ({
      capability: nonEmptyString(gap?.capability, `specialistNeeds[${index}].capability`),
      reason: nonEmptyString(gap?.reason, `specialistNeeds[${index}].reason`),
      suggestedId: nonEmptyString(gap?.suggestedId, `specialistNeeds[${index}].suggestedId`)
    }));
  } else if (stage === 'recruiting') {
    if (result.outcome === 'PASS' && (!result.specialist || typeof result.specialist !== 'object')) throw new Error('Recruiter must return a specialist proposal on PASS.');
  } else if (stage === 'planning') {
    if (!Array.isArray(result.tasks || []) || (result.outcome === 'PASS' && (result.tasks || []).length === 0)) throw new Error('tasks must be a non-empty array on PASS.');
    result.tasks = result.tasks || [];
    const ids = new Set();
    result.tasks = result.tasks.map((task, index) => {
      const id = nonEmptyString(task?.id, `tasks[${index}].id`);
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
      if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
      ids.add(id);
      return {
        id,
        title: nonEmptyString(task?.title, `tasks[${index}].title`),
        description: nonEmptyString(task?.description, `tasks[${index}].description`),
        specialistId: nonEmptyString(task?.specialistId, `tasks[${index}].specialistId`),
        acceptanceCriteria: stringArray(task?.acceptanceCriteria, `tasks[${index}].acceptanceCriteria`, { nonEmpty: true }),
        dependencies: stringArray(task?.dependencies || [], `tasks[${index}].dependencies`)
      };
    });
    for (const task of result.tasks) {
      for (const dependency of task.dependencies) if (!ids.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
    }
    const tasksById = new Map(result.tasks.map((task) => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of tasksById.get(id).dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const task of result.tasks) visit(task.id);
  } else if (stage === 'critical-review' || stage === 'code-review') {
    if (!Array.isArray(result.findings || [])) throw new Error('findings must be an array.');
    result.findings = (result.findings || []).map((finding, index) => {
      if (!['BLOCKER', 'MAJOR', 'MINOR', 'INFO'].includes(finding?.severity)) throw new Error(`findings[${index}].severity is invalid.`);
      const normalized = {
        id: nonEmptyString(finding?.id, `findings[${index}].id`),
        severity: finding.severity,
        recommendation: nonEmptyString(finding?.recommendation, `findings[${index}].recommendation`)
      };
      if (stage === 'critical-review') normalized.description = nonEmptyString(finding?.description, `findings[${index}].description`);
      else {
        normalized.location = nonEmptyString(finding?.location, `findings[${index}].location`);
        normalized.impact = nonEmptyString(finding?.impact, `findings[${index}].impact`);
      }
      return normalized;
    });
    const material = result.findings.some((finding) => ['BLOCKER', 'MAJOR'].includes(finding?.severity));
    if (material && result.outcome === 'PASS') throw new Error('A review with BLOCKER or MAJOR findings cannot PASS.');
    if (stage === 'critical-review' && result.outcome === 'FAIL' && !['architecture', 'planning'].includes(result.repairStage)) {
      throw new Error('Failed critical review must set repairStage to architecture or planning.');
    }
  } else if (stage === 'implementation') {
    result.filesChanged = stringArray(result.filesChanged || [], 'filesChanged', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.validations || [])) throw new Error('validations must be an array.');
    result.validations = (result.validations || []).map((validation, index) => ({
      command: nonEmptyString(validation?.command, `validations[${index}].command`),
      result: nonEmptyString(validation?.result, `validations[${index}].result`)
    }));
  } else if (stage === 'qa') {
    if (!Array.isArray(result.checks || []) || (['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.outcome) && (result.checks || []).length === 0)) {
      throw new Error('QA checks must be a non-empty array on pass.');
    }
    result.checks = (result.checks || []).map((check, index) => ({
      name: nonEmptyString(check?.name, `checks[${index}].name`),
      status: nonEmptyString(check?.status, `checks[${index}].status`),
      evidence: nonEmptyString(check?.evidence, `checks[${index}].evidence`)
    }));
    result.manualChecks = stringArray(result.manualChecks || [], 'manualChecks');
    if (result.outcome === 'PASS_WITH_MANUAL_VALIDATION' && result.manualChecks.length === 0) {
      throw new Error('PASS_WITH_MANUAL_VALIDATION requires at least one manual check.');
    }
  } else if (stage === 'integration' && result.outcome === 'PASS') {
    result.commitMessage = nonEmptyString(result.commitMessage, 'commitMessage');
  }
  return result;
}

function currentTask(session) {
  return session.taskLedger.find((task) => task.id === session.currentTaskId) || null;
}

function nextRunnableTask(session) {
  const done = new Set(session.taskLedger.filter((task) => task.status === 'qa-passed').map((task) => task.id));
  return session.taskLedger.find((task) => ['planned', 'needs-rework'].includes(task.status) && task.dependencies.every((id) => done.has(id))) || null;
}

export function workflowStatus(session, repo = null) {
  if (!session) return { active: false, message: 'No active AITEAM session exists.' };
  const stage = session.currentStage;
  const phase = STAGE_LABELS[stage] || stage;
  const normalized = phase.toLowerCase().replaceAll(' ', '-');
  const index = session.phasePlan.indexOf(normalized);
  const remaining = index >= 0 ? session.phasePlan.slice(index + 1).map((item) => STAGE_LABELS[item] || item) : [];
  let agentId = FIXED_AGENTS[stage] || null;
  if (stage === 'implementation') agentId = currentTask(session)?.specialistId || nextRunnableTask(session)?.specialistId || null;
  const agent = agentId && repo ? getAgent(agentId, repo) : null;
  return {
    active: session.status === 'ACTIVE',
    status: session.status,
    phase,
    stage,
    agentId,
    agentRole: agent?.role || null,
    awaitingUser: Boolean(session.pendingUserInput && session.pendingUserInput.response == null),
    pendingQuestions: session.pendingUserInput?.questions || [],
    remainingPhases: remaining,
    currentTaskId: session.currentTaskId
  };
}

function stageContext(session, repo) {
  const registry = loadRegistry(repo).agents.map(({ id, role, sandbox, capabilities = [] }) => ({ id, role, sandbox, capabilities }));
  return JSON.stringify({
    request: session.request,
    currentStage: session.currentStage,
    requirements: session.stageEvidence.intake?.result || null,
    architecture: session.stageEvidence.architecture?.result || null,
    plan: session.stageEvidence.planning?.result || null,
    lockedCriticalFindings: session.lockedCriticalFindings,
    taskLedger: session.taskLedger,
    interviewHistory: session.interviewHistory || [],
    pendingUserInput: session.pendingUserInput,
    currentTask: currentTask(session),
    recruiterGap: session.recruiterQueue[0] || null,
    availableAgents: registry
  }, null, 2);
}

function assignmentText(stage, session) {
  const details = {
    intake: 'Act as the conversational Intake Analyst. Collect and clarify requirements directly from the user. If information is missing, return AWAITING_USER with precise questions and do not advance the workflow. Incorporate any pending user response. Return PASS only after the user has confirmed complete requirements and acceptance criteria.',
    architecture: 'Design the implementation architecture and identify only genuine specialist capability gaps.',
    recruiting: `Create the specialist required for this verified capability gap: ${JSON.stringify(session.recruiterQueue[0])}`,
    planning: 'Create an ordered, dependency-valid implementation task ledger using available specialist IDs.',
    'critical-review': session.lockedCriticalFindings.length
      ? 'VERIFY_REPAIRS only against the locked critical findings. Do not create unrelated findings.'
      : 'Perform the initial COMPREHENSIVE critical review of requirements, architecture, plan, and QA feasibility.',
    implementation: currentTask(session)?.['code-reviewFailure']
      ? `This is a REWORK assignment for task ${JSON.stringify(currentTask(session))}.\nThe previous review failed with the following findings:\n${JSON.stringify(currentTask(session)['code-reviewFailure'].findings, null, 2)}\n\nYou MUST use your file editing/writing tools to fix these specific issues in the workspace filesystem now, and return outcome "PASS". Do NOT return FAIL.`
      : `You MUST use your file editing/writing tools (e.g. bash, write_file) to write the code into the repository filesystem now. Do NOT just output the schema without writing files.\nImplement only task ${JSON.stringify(currentTask(session))}. Return outcome "PASS". Do not commit.`,
    'code-review': currentTask(session)?.['code-reviewFailure']
      ? `This is a repair verification. The previous review failed with the following findings:\n${JSON.stringify(currentTask(session)['code-reviewFailure'].findings, null, 2)}\n\nReview ONLY the current task and its changed paths to verify these specific findings have been resolved. Do NOT perform a new comprehensive review or report new issues.`
      : `Review only the current task and its changed paths: ${JSON.stringify(currentTask(session))}.`,
    qa: currentTask(session)?.qaFailure
      ? `This is a repair verification. The previous QA validation failed with the following checks:\n${JSON.stringify(currentTask(session).qaFailure.checks, null, 2)}\n\nValidate ONLY that these specific failed checks have been resolved. Do NOT perform a new comprehensive validation or report new issues.`
      : `Validate the current task against its acceptance criteria: ${JSON.stringify(currentTask(session))}.`,
    integration: 'Inspect all QA-approved work for safe integration and propose a commit message. Do not stage or commit.'
  }[stage];
  return `${details}\n\n${STAGE_SCHEMAS[stage]}`;
}

export function getCurrentAssignment(repo, session = readSession(repo)) {
  if (!session) throw new Error('No active AITEAM session exists in this repository.');
  if (session.status === 'READY_TO_COMPLETE') throw new Error('All gates passed. Call aiteam_complete.');
  if (session.status !== 'ACTIVE') throw new Error(`AITEAM session is not active: ${session.status}`);
  if (session.currentStage !== 'intake' && session.stageEvidence.intake?.result?.userConfirmed !== true) {
    throw new Error('Workflow gate rejected: Analyst Intake must produce a user-confirmed requirements artifact before Architecture.');
  }
  if (session.activeRun) {
    const age = Date.now() - Date.parse(session.activeRun.startedAt || 0);
    if (Number.isFinite(age) && age < 3 * 60 * 60 * 1000) {
      throw new Error(`AITEAM specialist ${session.activeRun.agentId} is already running for stage ${session.activeRun.stage}.`);
    }
    const staleRun = session.activeRun;
    session = writeSession(repo, { ...session, activeRun: null, lastFailure: 'Recovered stale active-run lease.' });
    appendEvent(repo, { type: 'stale_active_run_recovered', previous: staleRun });
  }
  let task = currentTask(session);
  if (session.currentStage === 'implementation' && (!task || !['planned', 'needs-rework'].includes(task.status))) {
    task = nextRunnableTask(session);
    if (!task) throw new Error('No dependency-ready implementation task exists.');
    session = writeSession(repo, { ...session, currentTaskId: task.id });
  }
  if (['code-review', 'qa'].includes(session.currentStage) && task?.implementationFingerprint) {
    const currentFingerprint = fingerprintPaths(repo, task.filesChanged);
    if (currentFingerprint !== task.implementationFingerprint) {
      const reason = `Task ${task.id} changed after its implementation evidence was recorded.`;
      const fromStage = session.currentStage;
      session = writeSession(repo, {
        ...session,
        currentStage: 'implementation',
        taskLedger: session.taskLedger.map((item) => item.id === task.id ? { ...item, status: 'needs-rework', integrityFailure: reason } : item),
        lastFailure: reason
      });
      appendEvent(repo, { type: 'validated_paths_changed', taskId: task.id, fromStage });
      throw new Error(`${reason} The server routed it back to Implementation.`);
    }
  }
  if (session.currentStage === 'integration') {
    const changed = session.taskLedger.find((item) => item.qaFingerprint && fingerprintPaths(repo, item.filesChanged) !== item.qaFingerprint);
    if (changed) {
      const reason = `Task ${changed.id} changed after QA approval.`;
      writeSession(repo, {
        ...session,
        currentStage: 'implementation',
        currentTaskId: changed.id,
        taskLedger: session.taskLedger.map((item) => item.id === changed.id ? { ...item, status: 'needs-rework', integrityFailure: reason } : item),
        lastFailure: reason
      });
      appendEvent(repo, { type: 'validated_paths_changed', taskId: changed.id, fromStage: 'integration' });
      throw new Error(`${reason} The server routed it back to Implementation.`);
    }
  }
  const agentId = session.currentStage === 'implementation' ? task.specialistId : FIXED_AGENTS[session.currentStage];
  const agent = getAgent(agentId, repo);
  if (!agent) throw new Error(`Required specialist is not registered: ${agentId}`);
  return {
    stage: session.currentStage,
    phase: STAGE_LABELS[session.currentStage],
    agentId,
    role: agent.role,
    task: assignmentText(session.currentStage, session),
    context: stageContext(session, repo),
    session
  };
}

function stageKey(assignment) {
  return assignment.session.currentTaskId && ['implementation', 'code-review', 'qa'].includes(assignment.stage)
    ? `${assignment.stage}:${assignment.session.currentTaskId}`
    : assignment.stage;
}

function recordEvidence(session, assignment, result, run) {
  return {
    ...session.stageEvidence,
    [stageKey(assignment)]: {
      agentId: assignment.agentId,
      runId: run.runId,
      completedAt: run.completedAt,
      result
    }
  };
}

function normalizeTasks(tasks) {
  return tasks.map((task) => ({ ...task, status: 'planned', filesChanged: [], validations: [], review: null, qa: null }));
}

function proposedSpecialistId(gap) {
  return gap.suggestedId;
}

function hasSpecialist(repo, id) {
  return Boolean(getAgent(id, repo));
}

function proposalId(run, specialist) {
  return crypto.createHash('sha256').update(`${run.runId}\n${JSON.stringify(specialist)}`).digest('hex');
}

function applyResult(repo, session, assignment, result, run) {
  let next = { ...session, activeRun: null, stageEvidence: recordEvidence(session, assignment, result, run) };
  const stage = assignment.stage;
  const passed = result.outcome === 'PASS' || result.outcome === 'PASS_WITH_MANUAL_VALIDATION';

  if (stage === 'intake' && result.outcome === 'AWAITING_USER') {
    const nextHistory = session.pendingUserInput?.response != null
      ? [...(session.interviewHistory || []), session.pendingUserInput]
      : (session.interviewHistory || []);
    const pendingUserInput = {
      stage: 'intake',
      questions: result.questions,
      response: null,
      requestedAt: new Date().toISOString(),
      runId: run.runId
    };
    appendEvent(repo, { type: 'user_input_requested', stage, questions: result.questions, runId: run.runId });
    return writeSession(repo, { ...next, interviewHistory: nextHistory, pendingUserInput });
  }

  if (result.outcome === 'BLOCKED') {
    return writeSession(repo, { ...next, status: 'BLOCKED', blockedReason: result.summary });
  }
  if (!passed) {
    if (stage === 'critical-review') {
      next.lockedCriticalFindings = result.findings;
      next.currentStage = result.repairStage;
    } else if (stage === 'code-review' || stage === 'qa') {
      next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? { ...task, status: 'needs-rework', [`${stage}Failure`]: result } : task);
      next.currentStage = 'implementation';
    }
    return writeSession(repo, next);
  }

  if (stage === 'intake') {
    const nextHistory = next.pendingUserInput?.response != null
      ? [...(next.interviewHistory || []), next.pendingUserInput]
      : (next.interviewHistory || []);
    next.interviewHistory = nextHistory;
    next.completedStages = [...new Set([...next.completedStages, 'intake'])];
    next.currentStage = 'architecture';
    next.pendingUserInput = null;
  } else if (stage === 'architecture') {
    next.completedStages = [...new Set([...next.completedStages, 'architecture'])];
    next.recruiterQueue = result.specialistNeeds.filter((gap) => !hasSpecialist(repo, proposedSpecialistId(gap)));
    if (next.recruiterQueue.length) {
      next.resumeStage = 'planning';
      next.currentStage = 'recruiting';
    } else next.currentStage = 'planning';
  } else if (stage === 'recruiting') {
    const id = proposalId(run, result.specialist);
    const provenance = { source: 'recruiter', runId: run.runId, proposalId: id };
    const specialist = registerScopedSpecialist(repo, result.specialist, { provenance });
    appendEvent(repo, { type: 'specialist_registered', specialistId: specialist.id, provenance });
    next.recruiterQueue = next.recruiterQueue.slice(1);
    next.verifiedRecruiterProposals = [...(next.verifiedRecruiterProposals || []), { id, specialist, runId: run.runId, registered: true }];
    if (!next.recruiterQueue.length) {
      next.currentStage = next.resumeStage || 'planning';
      next.resumeStage = null;
    }
  } else if (stage === 'planning') {
    for (const task of result.tasks) {
      const specialist = getAgent(task.specialistId, repo);
      if (!specialist) throw new Error(`Planner selected an unregistered specialist: ${task.specialistId}`);
      if (specialist.id === 'qa') throw new Error(`Tasks in the task ledger cannot be assigned to QA. QA is executed automatically by the workflow gates.`);
      if (specialist.sandbox !== 'workspace-write') throw new Error(`Planner selected non-implementation specialist ${task.specialistId} for task ${task.id}.`);
    }
    next.completedStages = [...new Set([...next.completedStages, 'planning'])];
    next.taskLedger = normalizeTasks(result.tasks);
    next.currentTaskId = null;
    next.currentStage = 'critical-review';
  } else if (stage === 'critical-review') {
    next.completedStages = [...new Set([...next.completedStages, 'critical-review'])];
    next.lockedCriticalFindings = result.findings;
    next.currentStage = 'implementation';
    next.currentTaskId = null;
  } else if (stage === 'implementation') {
    const missing = result.filesChanged.filter((file) => !fs.existsSync(path.resolve(repo, file)));
    if (missing.length) {
      throw new Error(`Implementation reported files that are not visible in the server workspace: ${missing.join(', ')}`);
    }
    const implementationFingerprint = fingerprintPaths(repo, result.filesChanged);
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? {
      ...task,
      status: 'implemented',
      filesChanged: result.filesChanged,
      validations: result.validations,
      implementationFingerprint,
      implementationRunId: run.runId
    } : task);
    next.currentStage = 'code-review';
  } else if (stage === 'code-review') {
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? { ...task, status: 'review-passed', review: result, 'code-reviewFailure': null } : task);
    next.currentStage = 'qa';
  } else if (stage === 'qa') {
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? {
      ...task,
      status: 'qa-passed',
      qa: result,
      qaFailure: null,
      qaFingerprint: fingerprintPaths(repo, task.filesChanged)
    } : task);
    const unfinished = next.taskLedger.some((task) => task.status !== 'qa-passed');
    next.currentTaskId = null;
    next.currentStage = unfinished ? 'implementation' : 'integration';
    if (!unfinished) next.completedStages = [...new Set([...next.completedStages, 'implementation', 'code-review', 'qa'])];
  } else if (stage === 'integration') {
    const paths = [...new Set(next.taskLedger.flatMap((task) => task.filesChanged))];
    for (const task of next.taskLedger) {
      if (fingerprintPaths(repo, task.filesChanged) !== task.qaFingerprint) throw new Error(`Task ${task.id} changed during integration inspection.`);
    }
    const commit = commitValidatedPaths(repo, paths, result.commitMessage);
    next.integration = { ...commit, runId: run.runId, evidence: result.evidence };
    next.completedStages = [...new Set([...next.completedStages, 'integration'])];
    next.status = 'READY_TO_COMPLETE';
  }
  return writeSession(repo, next);
}

export function normalizeTimeoutSeconds(value) {
  const parsed = Number(value || 3600);
  if (!Number.isFinite(parsed)) throw new Error('timeout_seconds must be a finite number.');
  return Math.min(7200, Math.max(300, Math.floor(parsed)));
}

export async function advanceWorkflow({ repo, timeoutSeconds, model = null, coordinatorContext = '', expectedAgentId = null, runner = runAgent }) {
  const assignment = getCurrentAssignment(repo);
  if (expectedAgentId && expectedAgentId !== assignment.agentId) {
    throw new Error(`Workflow gate rejected ${expectedAgentId}. Phase ${assignment.phase} requires ${assignment.agentId}.`);
  }
  const timeout = normalizeTimeoutSeconds(timeoutSeconds);
  const maxAttempts = runner === runAgent ? 2 : 1;
  let retryContext = coordinatorContext;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const activeRun = { agentId: assignment.agentId, role: assignment.role, stage: assignment.stage, attempt, startedAt: new Date().toISOString() };
    const currentSession = readSession(repo);
    if (!currentSession || currentSession.status !== 'ACTIVE') {
      throw new Error(`Cannot advance ${assignment.stage}: the AITEAM session is no longer active.`);
    }
    if (currentSession.currentStage !== assignment.stage) {
      throw new Error(`Cannot advance ${assignment.stage}: the workflow moved to ${currentSession.currentStage}.`);
    }
    writeSession(repo, { ...currentSession, activeRun });
    appendEvent(repo, { type: 'workflow_stage_started', ...activeRun });
    let run;
    try {
      run = await runner({
        repo,
        agentId: assignment.agentId,
        stage: assignment.stage,
        task: assignment.task,
        context: [assignment.context, retryContext].filter(Boolean).join('\n\n'),
        timeoutMs: timeout * 1000,
        model
      });
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        patchSession(repo, { activeRun: null, lastFailure: String(error?.message || error) });
        appendEvent(repo, { type: 'workflow_stage_retry', stage: assignment.stage, agentId: assignment.agentId, attempt, error: String(error?.message || error) });
        retryContext = `${coordinatorContext}\n\nThe previous specialist attempt failed before producing a valid result. Retry the assignment now and return only the required JSON object.`;
        continue;
      }
      patchSession(repo, { activeRun: null, lastFailure: String(error?.message || error) });
      appendEvent(repo, { type: 'workflow_stage_failed', stage: assignment.stage, agentId: assignment.agentId, error: String(error?.message || error) });
      throw error;
    }
    if (run.exitCode !== 0 || run.timedOut) {
      lastError = new Error(`Specialist ${assignment.agentId} failed with exit code ${run.exitCode}${run.timedOut ? ' after timeout' : ''}.`);
      if (attempt < maxAttempts) {
        patchSession(repo, { activeRun: null, lastFailure: lastError.message });
        appendEvent(repo, { type: 'workflow_stage_retry', stage: assignment.stage, agentId: assignment.agentId, attempt, error: lastError.message });
        retryContext = `${coordinatorContext}\n\nThe previous specialist attempt exited without a valid result. Retry now and return only the required JSON object.`;
        continue;
      }
      patchSession(repo, { activeRun: null, lastFailure: lastError.message });
      throw new Error(`${lastError.message} The workflow did not advance.`);
    }
    try {
      const result = parseStageResult(assignment.stage, run.stdout);
      const session = applyResult(repo, readSession(repo), assignment, result, run);
      appendEvent(repo, { type: 'workflow_stage_result', stage: assignment.stage, agentId: assignment.agentId, outcome: result.outcome, runId: run.runId, attempt });
      return { assignment, result, run, session, workflow: workflowStatus(session, repo) };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        patchSession(repo, { activeRun: null, lastFailure: String(error?.message || error) });
        appendEvent(repo, { type: 'workflow_stage_retry', stage: assignment.stage, agentId: assignment.agentId, attempt, error: String(error?.message || error), runId: run.runId });
        retryContext = `${coordinatorContext}\n\nThe previous specialist response was rejected: ${error.message}\nReturn ONLY one valid JSON object matching the assignment schema. Do not use Markdown, prose, or code fences.`;
        continue;
      }
      patchSession(repo, { activeRun: null, lastFailure: String(error?.message || error) });
      appendEvent(repo, { type: 'workflow_stage_rejected', stage: assignment.stage, agentId: assignment.agentId, error: String(error?.message || error), runId: run.runId, attempt });
      throw new Error(`Structured ${assignment.stage} result rejected: ${error.message}. The workflow did not advance.`);
    }
  }
  throw lastError || new Error(`Specialist ${assignment.agentId} did not advance the workflow.`);
}

export function completeWorkflow(repo) {
  const session = readSession(repo);
  if (!session) throw new Error('No active AITEAM session exists in this repository.');
  if (session.status !== 'READY_TO_COMPLETE') throw new Error(`Cannot complete AITEAM session while status is ${session.status}.`);
  if (!session.taskLedger.length || session.taskLedger.some((task) => task.status !== 'qa-passed')) {
    throw new Error('Cannot complete: every task must pass Code Review and QA.');
  }
  if (!session.integration?.head) throw new Error('Cannot complete: server-controlled Git integration has not succeeded.');
  const git = gitSnapshot(repo);
  if (git.head !== session.integration.head) throw new Error('Cannot complete: repository HEAD changed after AITEAM integration.');
  for (const task of session.taskLedger) {
    if (fingerprintPaths(repo, task.filesChanged) !== task.qaFingerprint) {
      throw new Error(`Cannot complete: task ${task.id} changed after QA approval.`);
    }
  }
  const completed = writeSession(repo, { ...session, status: 'COMPLETE', completedAt: new Date().toISOString(), currentStage: 'complete', activeRun: null });
  appendEvent(repo, { type: 'session_completed', sessionId: completed.id, head: completed.integration.head });
  return completed;
}
