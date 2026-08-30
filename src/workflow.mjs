import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendEvent, patchSession, readSession, writeSession } from './state.mjs';
import { commitValidatedPaths, fingerprintPaths, gitSnapshot } from './git.mjs';
import { getAgent, loadRegistry, registerScopedSpecialist } from './registry.mjs';
import { runAgent } from './runtime.mjs';

const STAGE_LABELS = {
  intake: 'Intake',
  'prd-review': 'PRD Review',
  architecture: 'Architecture',
  'ui-design': 'UI/UX Design',
  recruiting: 'Architecture',
  planning: 'Planning',
  'qa-planning': 'QA Test Planning',
  'critical-review': 'Critical Review',
  'trd-review': 'TRD Review',
  'environment-readiness': 'Environment Readiness',
  implementation: 'Implementation',
  'code-review': 'Code Review',
  qa: 'QA',
  integration: 'Integration'
};

const FIXED_AGENTS = {
  intake: 'analyst',
  architecture: 'architect',
  'ui-design': 'ui-designer',
  recruiting: 'recruiter',
  planning: 'planner',
  'qa-planning': 'qa-planner',
  'critical-review': 'critical-reviewer',
  'environment-readiness': 'environment-readiness',
  'code-review': 'code-reviewer',
  qa: 'qa',
  integration: 'maintainer'
};

const COMMON_SCHEMA = `
Every response must be one JSON object with no Markdown fence or surrounding prose.
Common fields:
- "outcome": "PASS", "FAIL", or "BLOCKED"
- "summary": non-empty string
- "evidence": REQUIRED non-empty array of concrete strings when outcome is PASS. You MUST list how you verified the changes. Do not leave this empty or omit it, or the server will reject your response!
Do not claim commands, files, or tests that you did not actually observe.
For stages that do not explicitly require file changes, do not write temporary files to validate your JSON. Return the JSON object directly; the AITEAM server validates it after you respond.`;

const STAGE_SCHEMAS = {
  intake: `${COMMON_SCHEMA}
For Intake, "outcome" may also be "AWAITING_USER". Also return "goals", "targetUsers", "userStories", "requirements", "acceptanceCriteria", "mvpScope", "outOfScope", "assumptions", "constraints", "nonFunctionalRequirements", "successMetrics", "risks", and "questions" as string arrays, plus boolean "userConfirmed".
Use AWAITING_USER only while a concrete material clarification remains unresolved: include non-empty questions and set userConfirmed to false. For compatibility, userConfirmed true means the requirements are grounded in the original request or direct user answers and no material question remains; it does not mean the user approved the complete document. After all pending questions are answered, incorporate the answers and use PASS unless an answer creates a new material ambiguity. Do not ask for generic final confirmation of the requirements; the subsequent PRD Review is the sole full-document approval gate. Use PASS only when questions is empty, requirements are complete, and userConfirmed is true. On PASS, goals, targetUsers, userStories, requirements, acceptanceCriteria, mvpScope, and successMetrics must be non-empty. Capture unknowns as assumptions/risks instead of silently dropping them.`,
  architecture: `${COMMON_SCHEMA}
Also return "design", "context", "constraints", "solutionStrategy", "deploymentView", "crossCuttingConcepts", and "risks" as non-empty string arrays; "qualityAttributes" as non-empty array of {"name","scenario","measure"}; "buildingBlocks" as non-empty array of {"name","responsibility","interfaces"}; "runtimeScenarios" as non-empty array of {"name","trigger","flow"}; "architectureDecisions" as non-empty array of {"decision","optionsConsidered","rationale","consequences"}; "hasUserInterface" (boolean: true if the project has user-facing visual frontend/UI/screens, false if purely headless backend/API/CLI); "specialistNeeds" (array of {"capability","reason","suggestedId"}); and non-empty "requiredCapabilities" (array of {"id","purpose","acceptableTools","verification"}). Use an empty specialistNeeds array when the registry covers the work. Capability IDs must be stable lowercase identifiers, acceptableTools must offer reasonable alternatives when possible, and verification must describe a functional probe. Derive technology choices from Intake, repository reality, constraints, quality attributes, and tradeoffs; do not choose technology first and backfill rationale.`,
  'ui-design': `${COMMON_SCHEMA}
Also return "userFlows" (array of {"name","actor","goal","steps"}), "usabilityRisks" (string array), "accessibilityHeuristics" (string array), "validationHypotheses" (array of {"hypothesis","validationMethod","successSignal"}), "theme" ({"palette": string array, "typography": string array, "spacing": string array}), "screens" (array of {"name": string, "layout": string, "components": string array, "interactionStates": string array}), and "designTokens" (string array). All collections must be non-empty on PASS. Produce UX analysis plus concrete visual specifications aligned with the chosen architecture.`,
  recruiting: `${COMMON_SCHEMA}
Also return "gapJustification", "existingSpecialistAssessment", and "evaluationCriteria" as non-empty string arrays, plus "specialist": {"id","role","sandbox","triggers","capabilities","contract"}. The contract must be at least 80 characters of complete inline instructions, never a file path. Explain why existing specialists are insufficient and how the new specialist should be evaluated.`,
  planning: `${COMMON_SCHEMA}
Also return "tasks", a non-empty array of {"id","title","description","specialistId","acceptanceCriteria","dependencies"}. IDs must be unique lowercase identifiers; acceptanceCriteria and dependencies are arrays. specialistId must name an available registered implementation specialist. Each task MUST be strictly isolated and narrow. Do not create the test plan; the next QA Test Planning stage owns black-box and regression test design.`,
  'qa-planning': `${COMMON_SCHEMA}
For QA Test Planning, design tests only; do not execute tests, inspect implementation source, modify files, or provide fix guidance. Return "taskTestPlans", a non-empty array containing exactly one {"taskId","tests"} entry per planned implementation task. Each tests array must be non-empty and contain {"name","covers","action","expected","evidenceMethod"}; covers is a non-empty string array and must collectively include every exact acceptance criterion for that task. Also return non-empty string arrays "regressionStrategy" and "coverageNotes", plus non-empty "requiredCapabilities" as {"id","purpose","acceptableTools","verification"}. Capabilities describe observable interfaces and acceptable alternatives, not a mandatory favorite framework. Include relevant PRD requirements, architecture scenarios/quality measures, and UI/UX flows, accessibility rules, and validation hypotheses in covers when applicable.`,
  'critical-review': `${COMMON_SCHEMA}
Also return "findings" as an array of {"id","severity","description","recommendation"}, where severity is BLOCKER, MAJOR, MINOR, or INFO. Always return "repairStage". If any BLOCKER or MAJOR remains, outcome must be FAIL and repairStage must be "architecture", "planning", or "qa-planning". Route test-plan-only repairs to "qa-planning". If outcome is PASS, repairStage must be "none".`,
  'environment-readiness': `${COMMON_SCHEMA}
For Environment Readiness, "outcome" may also be "AWAITING_USER". Return "capabilities" as an array of {"id","requiredBy","selectedTool","probeCommand","status","version","executablePath","evidence"}; "fileOperations" as {"workspaceWriteVerified","tempDirectory","writeMethod","syntaxCheckVerified","syntaxCheckCommand","evidence"}; "missingTools" as an array of {"tool","capability","whyNeeded","detectedProblem","alternativesTried","installInstructions","verificationCommand","requiresHuman"}; and "questions" as a string array. On PASS, capabilities must be non-empty and all have status VERIFIED, fileOperations verification booleans must be true, and missingTools/questions must be empty. Use AWAITING_USER only when a required capability cannot be prepared safely without human installation; missingTools and questions must then be non-empty. Never modify product source, product manifests, or lockfiles.`,
  implementation: `${COMMON_SCHEMA}
For Implementation, you MUST return outcome "PASS" with a NON-EMPTY "filesChanged" array. Never return outcome "FAIL" for your own implementation task.

YOUR FINAL RESPONSE MUST BE ONLY THE RAW JSON OBJECT. DO NOT EMIT CONVERSATIONAL TEXT (e.g. "Here is my summary:", "All checks pass").
Example required format:
{
  "outcome": "PASS",
  "summary": "Implemented task acceptance criteria and verified in runtime.",
  "evidence": ["PRD and TRD checked", "Verified acceptance criteria via automated testing."],
  "filesChanged": ["index.html"],
  "validations": [{"command": "python3 tests/test.py", "result": "all tests passed"}]
}

ALREADY IMPLEMENTED / VERIFICATION SCENARIOS:
If the acceptance criteria for this task are already satisfied by existing code in the repository:
1. Run inspection or test commands using your tools to verify the criteria.
2. In "filesChanged", you MUST list the repository-relative paths containing the implementation that satisfies this task (e.g. ["src/game/game.js", "src/ui/screens.js"]). DO NOT return an empty array [] or the workflow gate will reject your response!
3. In "evidence", provide the verified command outputs and line numbers confirming the acceptance criteria.

CRITICAL SCOPE BOUNDARY: Implement ONLY the exact acceptanceCriteria specified for this task. Do NOT implement future features, sound effects, game physics, or unrelated modules if they are not in your task's acceptanceCriteria. Overachieving or implementing unassigned features is a boundary violation. Also return "filesChanged" (non-empty repository-relative path array on PASS) and "validations" (array of {"command","result"}).`,
  'code-review': `${COMMON_SCHEMA}
Outcome must be "PASS" or "FAIL". Do not return outcome "BLOCKED". Inspect the modified files on disk and return "findings" as an array of {"id","severity","location","impact","recommendation"}, where severity is BLOCKER, MAJOR, MINOR, or INFO. If any BLOCKER or MAJOR exists, outcome must be FAIL. Do not modify files.`,
  qa: `${COMMON_SCHEMA}
Outcome may also be "PASS_WITH_MANUAL_VALIDATION". Also return "checks" as a non-empty array of {"name","status","expected","actual","evidence"}, "automationAttempts" as an array of {"command","result","covers","fallbackReason"}, and "manualChecks" as a string array.
CRITICAL SCOPE BOUNDARY: Generate black-box functional checks for the specific acceptanceCriteria of the current task AND regression checks for completedPriorTasks. Do NOT validate unbuilt future features or unassigned subsystems. FAIL means observable behavior failed for this task or regression. Do not inspect source code, do not modify files, and do not tell the programmer how to fix defects.`,
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

function normalizeRequiredCapabilities(value, name, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${nonEmpty ? 'a non-empty' : 'an'} array.`);
  }
  const ids = new Set();
  return value.map((capability, index) => {
    const id = nonEmptyString(capability?.id, `${name}[${index}].id`);
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new Error(`${name}[${index}].id must be a lowercase capability identifier.`);
    if (ids.has(id)) throw new Error(`Duplicate capability id in ${name}: ${id}`);
    ids.add(id);
    return {
      id,
      purpose: nonEmptyString(capability?.purpose, `${name}[${index}].purpose`),
      acceptableTools: stringArray(capability?.acceptableTools, `${name}[${index}].acceptableTools`, { nonEmpty: true }),
      verification: nonEmptyString(capability?.verification, `${name}[${index}].verification`)
    };
  });
}

function unwrapSpecialistOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.structured_output && typeof parsed.structured_output === 'object') {
    return parsed.structured_output;
  }
  if (typeof parsed.response === 'string' && !parsed.outcome) {
    try {
      const nested = parseJson(parsed.response);
      if (nested && typeof nested === 'object' && nested.outcome) return nested;
    } catch { /* continue */ }
  }
  return parsed;
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('Specialist returned no structured result.');

  // 1. Entire output is a JSON object (--output-schema mode or agy CLI envelope)
  try {
    const parsed = unwrapSpecialistOutput(JSON.parse(text));
    if (parsed && typeof parsed === 'object' && parsed.outcome) return parsed;
    if (parsed && typeof parsed === 'object') {
      // If parsed has no outcome, store as initial candidate but fall through to check fences
      var rootParsed = parsed;
    }
  } catch { /* fall through */ }

  // 2. Fenced code block — prefer the LAST fenced block (LLMs often show
  //    examples before emitting their final answer)
  const fencedAll = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fencedAll.length - 1; i >= 0; i--) {
    try {
      const parsed = unwrapSpecialistOutput(JSON.parse(fencedAll[i][1].trim()));
      if (parsed && typeof parsed === 'object' && parsed.outcome) return parsed;
    } catch { /* continue searching */ }
  }
  // If any fenced block parsed at all (even without outcome), use the last one
  for (let i = fencedAll.length - 1; i >= 0; i--) {
    try { return unwrapSpecialistOutput(JSON.parse(fencedAll[i][1].trim())); } catch { /* continue */ }
  }

  // 3. Brace-balanced extraction: find all top-level JSON objects in the text
  //    by scanning for '{' and tracking brace depth. This correctly handles
  //    nested objects unlike the previous non-greedy regex approach.
  const candidates = extractBalancedObjects(text);
  // Prefer the last candidate with an "outcome" field
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = unwrapSpecialistOutput(JSON.parse(candidates[i]));
      if (parsed && typeof parsed === 'object' && parsed.outcome) return parsed;
    } catch { /* continue searching */ }
  }
  // Fall back to the last parseable candidate
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return unwrapSpecialistOutput(JSON.parse(candidates[i])); } catch { /* continue */ }
  }

  if (typeof rootParsed !== 'undefined') return rootParsed;

  throw new Error(`Specialist result is not valid JSON. Output was: ${text.slice(0, 300)}`);
}

/** Extract all brace-balanced substrings from text (handles nested objects). */
function extractBalancedObjects(text) {
  const results = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          results.push(text.slice(i, j + 1));
          i = j; // skip past this object for the outer loop
          break;
        }
      }
    }
  }
  return results;
}

function isRedundantIntakeApprovalQuestion(question) {
  const asksForApproval = /\b(?:approve|confirm|sign[\s-]?off)\b/i.test(question);
  const targetsWholeArtifact = /\b(?:prd|product requirements document|requirements artifact|final(?:ized)? requirements|complete requirements|all requirements|requirements and acceptance criteria|everything)\b/i.test(question);
  const asksWhetherComplete = /\b(?:complete|correct|final(?:ized)?|entire|all)\b/i.test(question);
  return asksForApproval && (targetsWholeArtifact || asksWhetherComplete && /\brequirements?\b/i.test(question));
}


export function parseStageResult(stage, stdout) {
  const result = parseJson(stdout);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Specialist result must be one JSON object.');
  const allowed = stage === 'qa'
    ? ['PASS', 'FAIL', 'BLOCKED', 'PASS_WITH_MANUAL_VALIDATION']
    : ['intake', 'environment-readiness'].includes(stage)
      ? ['PASS', 'FAIL', 'BLOCKED', 'AWAITING_USER']
      : ['PASS', 'FAIL', 'BLOCKED'];
  if (!allowed.includes(result.outcome)) throw new Error(`${stage} outcome must be one of: ${allowed.join(', ')}.`);
  result.summary = nonEmptyString(result.summary, 'summary');
  if (stage === 'implementation' && (!result.evidence || !Array.isArray(result.evidence) || result.evidence.length === 0) && Array.isArray(result.validations) && result.validations.length > 0) {
    result.evidence = result.validations.map((v) => `${v.command || 'validation'}: ${v.result || 'success'}`);
  }
  result.evidence = stringArray(result.evidence || [], 'evidence', { nonEmpty: result.outcome === 'PASS' || result.outcome === 'PASS_WITH_MANUAL_VALIDATION' });

  if (stage === 'intake') {
    result.goals = stringArray(result.goals || [], 'goals', { nonEmpty: result.outcome === 'PASS' });
    result.targetUsers = stringArray(result.targetUsers || [], 'targetUsers', { nonEmpty: result.outcome === 'PASS' });
    result.userStories = stringArray(result.userStories || [], 'userStories', { nonEmpty: result.outcome === 'PASS' });
    result.requirements = stringArray(result.requirements || [], 'requirements', { nonEmpty: result.outcome === 'PASS' });
    result.acceptanceCriteria = stringArray(result.acceptanceCriteria || [], 'acceptanceCriteria', { nonEmpty: result.outcome === 'PASS' });
    result.mvpScope = stringArray(result.mvpScope || [], 'mvpScope', { nonEmpty: result.outcome === 'PASS' });
    result.outOfScope = stringArray(result.outOfScope || [], 'outOfScope');
    result.assumptions = stringArray(result.assumptions || [], 'assumptions');
    result.constraints = stringArray(result.constraints || [], 'constraints');
    result.nonFunctionalRequirements = stringArray(result.nonFunctionalRequirements || [], 'nonFunctionalRequirements');
    result.successMetrics = stringArray(result.successMetrics || [], 'successMetrics', { nonEmpty: result.outcome === 'PASS' });
    result.risks = stringArray(result.risks || [], 'risks');
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
    if (result.outcome === 'AWAITING_USER' && result.questions.some(isRedundantIntakeApprovalQuestion)) {
      throw new Error('Intake must not request generic final document approval; PRD Review owns explicit full-document approval. Ask only concrete unresolved material questions, or return PASS when none remain.');
    }
    if (result.outcome === 'PASS' && (result.questions.length > 0 || !result.userConfirmed)) throw new Error('Intake cannot PASS while questions remain or userConfirmed is false.');
  } else if (stage === 'architecture') {
    result.design = stringArray(result.design || [], 'design', { nonEmpty: result.outcome === 'PASS' });
    result.context = stringArray(result.context || [], 'context', { nonEmpty: result.outcome === 'PASS' });
    result.constraints = stringArray(result.constraints || [], 'constraints', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.qualityAttributes || []) || (result.outcome === 'PASS' && result.qualityAttributes.length === 0)) throw new Error('qualityAttributes must be a non-empty array on PASS.');
    result.qualityAttributes = (result.qualityAttributes || []).map((attribute, index) => ({
      name: nonEmptyString(attribute?.name, `qualityAttributes[${index}].name`),
      scenario: nonEmptyString(attribute?.scenario, `qualityAttributes[${index}].scenario`),
      measure: nonEmptyString(attribute?.measure, `qualityAttributes[${index}].measure`)
    }));
    result.solutionStrategy = stringArray(result.solutionStrategy || [], 'solutionStrategy', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.buildingBlocks || []) || (result.outcome === 'PASS' && result.buildingBlocks.length === 0)) throw new Error('buildingBlocks must be a non-empty array on PASS.');
    result.buildingBlocks = (result.buildingBlocks || []).map((block, index) => ({
      name: nonEmptyString(block?.name, `buildingBlocks[${index}].name`),
      responsibility: nonEmptyString(block?.responsibility, `buildingBlocks[${index}].responsibility`),
      interfaces: stringArray(block?.interfaces || [], `buildingBlocks[${index}].interfaces`, { nonEmpty: result.outcome === 'PASS' })
    }));
    if (!Array.isArray(result.runtimeScenarios || []) || (result.outcome === 'PASS' && result.runtimeScenarios.length === 0)) throw new Error('runtimeScenarios must be a non-empty array on PASS.');
    result.runtimeScenarios = (result.runtimeScenarios || []).map((scenario, index) => ({
      name: nonEmptyString(scenario?.name, `runtimeScenarios[${index}].name`),
      trigger: nonEmptyString(scenario?.trigger, `runtimeScenarios[${index}].trigger`),
      flow: stringArray(scenario?.flow || [], `runtimeScenarios[${index}].flow`, { nonEmpty: result.outcome === 'PASS' })
    }));
    result.deploymentView = stringArray(result.deploymentView || [], 'deploymentView', { nonEmpty: result.outcome === 'PASS' });
    result.crossCuttingConcepts = stringArray(result.crossCuttingConcepts || [], 'crossCuttingConcepts', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.architectureDecisions || []) || (result.outcome === 'PASS' && result.architectureDecisions.length === 0)) throw new Error('architectureDecisions must be a non-empty array on PASS.');
    result.architectureDecisions = (result.architectureDecisions || []).map((decision, index) => ({
      decision: nonEmptyString(decision?.decision, `architectureDecisions[${index}].decision`),
      optionsConsidered: stringArray(decision?.optionsConsidered || [], `architectureDecisions[${index}].optionsConsidered`, { nonEmpty: result.outcome === 'PASS' }),
      rationale: nonEmptyString(decision?.rationale, `architectureDecisions[${index}].rationale`),
      consequences: stringArray(decision?.consequences || [], `architectureDecisions[${index}].consequences`, { nonEmpty: result.outcome === 'PASS' })
    }));
    result.risks = stringArray(result.risks || [], 'risks', { nonEmpty: result.outcome === 'PASS' });
    if (result.outcome === 'PASS' && typeof result.hasUserInterface !== 'boolean') throw new Error('hasUserInterface must be a boolean on PASS.');
    if (result.hasUserInterface !== undefined && typeof result.hasUserInterface !== 'boolean') throw new Error('hasUserInterface must be a boolean.');
    result.hasUserInterface = result.hasUserInterface === true;
    if (!Array.isArray(result.specialistNeeds || [])) throw new Error('specialistNeeds must be an array.');
    result.specialistNeeds = (result.specialistNeeds || []).map((gap, index) => ({
      capability: nonEmptyString(gap?.capability, `specialistNeeds[${index}].capability`),
      reason: nonEmptyString(gap?.reason, `specialistNeeds[${index}].reason`),
      suggestedId: nonEmptyString(gap?.suggestedId, `specialistNeeds[${index}].suggestedId`)
    }));
    result.requiredCapabilities = normalizeRequiredCapabilities(result.requiredCapabilities || [], 'requiredCapabilities', { nonEmpty: result.outcome === 'PASS' });
  } else if (stage === 'ui-design') {
    if (!Array.isArray(result.userFlows || []) || (result.outcome === 'PASS' && (result.userFlows || []).length === 0)) throw new Error('userFlows must be a non-empty array on PASS.');
    result.userFlows = (result.userFlows || []).map((flow, index) => ({
      name: nonEmptyString(flow?.name, `userFlows[${index}].name`),
      actor: nonEmptyString(flow?.actor, `userFlows[${index}].actor`),
      goal: nonEmptyString(flow?.goal, `userFlows[${index}].goal`),
      steps: stringArray(flow?.steps || [], `userFlows[${index}].steps`, { nonEmpty: result.outcome === 'PASS' })
    }));
    result.usabilityRisks = stringArray(result.usabilityRisks || [], 'usabilityRisks', { nonEmpty: result.outcome === 'PASS' });
    result.accessibilityHeuristics = stringArray(result.accessibilityHeuristics || [], 'accessibilityHeuristics', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.validationHypotheses || []) || (result.outcome === 'PASS' && (result.validationHypotheses || []).length === 0)) throw new Error('validationHypotheses must be a non-empty array on PASS.');
    result.validationHypotheses = (result.validationHypotheses || []).map((hypothesis, index) => ({
      hypothesis: nonEmptyString(hypothesis?.hypothesis, `validationHypotheses[${index}].hypothesis`),
      validationMethod: nonEmptyString(hypothesis?.validationMethod, `validationHypotheses[${index}].validationMethod`),
      successSignal: nonEmptyString(hypothesis?.successSignal, `validationHypotheses[${index}].successSignal`)
    }));
    if (result.outcome === 'PASS' && (!result.theme || typeof result.theme !== 'object' || Array.isArray(result.theme))) throw new Error('theme must be an object on PASS.');
    if (result.theme !== undefined && (!result.theme || typeof result.theme !== 'object' || Array.isArray(result.theme))) throw new Error('theme must be an object.');
    const theme = result.theme || {};
    result.theme = {
      palette: stringArray(theme.palette || [], 'theme.palette', { nonEmpty: result.outcome === 'PASS' }),
      typography: stringArray(theme.typography || [], 'theme.typography', { nonEmpty: result.outcome === 'PASS' }),
      spacing: stringArray(theme.spacing || [], 'theme.spacing', { nonEmpty: result.outcome === 'PASS' })
    };
    if (!Array.isArray(result.screens || []) || (result.outcome === 'PASS' && result.screens.length === 0)) throw new Error('screens must be a non-empty array on PASS.');
    result.screens = (result.screens || []).map((screen, index) => ({
      name: nonEmptyString(screen?.name, `screens[${index}].name`),
      layout: nonEmptyString(screen?.layout, `screens[${index}].layout`),
      components: stringArray(screen?.components || [], `screens[${index}].components`, { nonEmpty: result.outcome === 'PASS' }),
      interactionStates: stringArray(screen?.interactionStates || [], `screens[${index}].interactionStates`, { nonEmpty: result.outcome === 'PASS' })
    }));
    result.designTokens = stringArray(result.designTokens || [], 'designTokens', { nonEmpty: result.outcome === 'PASS' });
  } else if (stage === 'recruiting') {
    result.gapJustification = stringArray(result.gapJustification || [], 'gapJustification', { nonEmpty: result.outcome === 'PASS' });
    result.existingSpecialistAssessment = stringArray(result.existingSpecialistAssessment || [], 'existingSpecialistAssessment', { nonEmpty: result.outcome === 'PASS' });
    result.evaluationCriteria = stringArray(result.evaluationCriteria || [], 'evaluationCriteria', { nonEmpty: result.outcome === 'PASS' });
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
        dependencies: stringArray(task?.dependencies || [], `tasks[${index}].dependencies`),
        blackBoxTestPlan: task?.blackBoxTestPlan
          ? normalizeBlackBoxTestPlan(task.blackBoxTestPlan, `tasks[${index}].blackBoxTestPlan`)
          : []
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
  } else if (stage === 'qa-planning') {
    if (!Array.isArray(result.taskTestPlans || []) || (result.outcome === 'PASS' && result.taskTestPlans.length === 0)) {
      throw new Error('taskTestPlans must be a non-empty array on PASS.');
    }
    const taskIds = new Set();
    result.taskTestPlans = (result.taskTestPlans || []).map((taskPlan, planIndex) => {
      const taskId = nonEmptyString(taskPlan?.taskId, `taskTestPlans[${planIndex}].taskId`);
      if (taskIds.has(taskId)) throw new Error(`Duplicate QA task test plan: ${taskId}`);
      taskIds.add(taskId);
      if (!Array.isArray(taskPlan?.tests) || taskPlan.tests.length === 0) {
        throw new Error(`taskTestPlans[${planIndex}].tests must be a non-empty array.`);
      }
      const testNames = new Set();
      const tests = taskPlan.tests.map((test, testIndex) => {
        const name = `taskTestPlans[${planIndex}].tests[${testIndex}]`;
        const normalized = {
          name: nonEmptyString(test?.name, `${name}.name`),
          covers: stringArray(test?.covers, `${name}.covers`, { nonEmpty: true }),
          action: nonEmptyString(test?.action, `${name}.action`),
          expected: nonEmptyString(test?.expected, `${name}.expected`),
          evidenceMethod: nonEmptyString(test?.evidenceMethod, `${name}.evidenceMethod`)
        };
        if (testNames.has(normalized.name)) throw new Error(`Duplicate QA test name for ${taskId}: ${normalized.name}`);
        testNames.add(normalized.name);
        rejectBlackBoxTestPlanImplementationGuidance(normalized, name);
        return normalized;
      });
      return { taskId, tests };
    });
    result.regressionStrategy = stringArray(result.regressionStrategy || [], 'regressionStrategy', { nonEmpty: result.outcome === 'PASS' });
    result.coverageNotes = stringArray(result.coverageNotes || [], 'coverageNotes', { nonEmpty: result.outcome === 'PASS' });
    result.requiredCapabilities = normalizeRequiredCapabilities(result.requiredCapabilities || [], 'requiredCapabilities', { nonEmpty: result.outcome === 'PASS' });
  } else if (stage === 'environment-readiness') {
    if (!Array.isArray(result.capabilities || []) || (result.outcome === 'PASS' && result.capabilities.length === 0)) {
      throw new Error('Environment Readiness capabilities must be a non-empty array on PASS.');
    }
    const capabilityIds = new Set();
    result.capabilities = (result.capabilities || []).map((capability, index) => {
      const normalized = {
        id: nonEmptyString(capability?.id, `capabilities[${index}].id`),
        requiredBy: stringArray(capability?.requiredBy || [], `capabilities[${index}].requiredBy`, { nonEmpty: true }),
        selectedTool: nonEmptyString(capability?.selectedTool, `capabilities[${index}].selectedTool`),
        probeCommand: nonEmptyString(capability?.probeCommand, `capabilities[${index}].probeCommand`),
        status: nonEmptyString(capability?.status, `capabilities[${index}].status`).toUpperCase(),
        version: typeof capability?.version === 'string' ? capability.version.trim() : '',
        executablePath: typeof capability?.executablePath === 'string' ? capability.executablePath.trim() : '',
        evidence: nonEmptyString(capability?.evidence, `capabilities[${index}].evidence`)
      };
      if (capabilityIds.has(normalized.id)) throw new Error(`Duplicate Environment Readiness capability: ${normalized.id}.`);
      capabilityIds.add(normalized.id);
      return normalized;
    });
    if (result.outcome === 'PASS' && result.capabilities.some((capability) => capability.status !== 'VERIFIED')) {
      throw new Error('Every Environment Readiness capability must have status VERIFIED on PASS.');
    }
    const operations = result.fileOperations || {};
    result.fileOperations = {
      workspaceWriteVerified: operations.workspaceWriteVerified === true,
      tempDirectory: nonEmptyString(operations.tempDirectory, 'fileOperations.tempDirectory'),
      writeMethod: nonEmptyString(operations.writeMethod, 'fileOperations.writeMethod'),
      syntaxCheckVerified: operations.syntaxCheckVerified === true,
      syntaxCheckCommand: nonEmptyString(operations.syntaxCheckCommand, 'fileOperations.syntaxCheckCommand'),
      evidence: nonEmptyString(operations.evidence, 'fileOperations.evidence')
    };
    if (result.outcome === 'PASS' && (!result.fileOperations.workspaceWriteVerified || !result.fileOperations.syntaxCheckVerified)) {
      throw new Error('Environment Readiness PASS requires verified workspace writing and syntax checking.');
    }
    if (!Array.isArray(result.missingTools || [])) throw new Error('missingTools must be an array.');
    result.missingTools = (result.missingTools || []).map((tool, index) => ({
      tool: nonEmptyString(tool?.tool, `missingTools[${index}].tool`),
      capability: nonEmptyString(tool?.capability, `missingTools[${index}].capability`),
      whyNeeded: nonEmptyString(tool?.whyNeeded, `missingTools[${index}].whyNeeded`),
      detectedProblem: nonEmptyString(tool?.detectedProblem, `missingTools[${index}].detectedProblem`),
      alternativesTried: stringArray(tool?.alternativesTried || [], `missingTools[${index}].alternativesTried`, { nonEmpty: true }),
      installInstructions: stringArray(tool?.installInstructions || [], `missingTools[${index}].installInstructions`, { nonEmpty: true }),
      verificationCommand: nonEmptyString(tool?.verificationCommand, `missingTools[${index}].verificationCommand`),
      requiresHuman: tool?.requiresHuman === true
    }));
    result.questions = stringArray(result.questions || [], 'questions');
    if (result.outcome === 'AWAITING_USER' && (!result.missingTools.length || !result.questions.length)) {
      throw new Error('Environment Readiness AWAITING_USER requires non-empty missingTools and questions.');
    }
    if (result.outcome === 'AWAITING_USER' && result.missingTools.some((tool) => !tool.requiresHuman)) {
      throw new Error('Environment Readiness may ask the human only for missing tools marked requiresHuman.');
    }
    if (result.outcome === 'PASS' && (result.missingTools.length || result.questions.length)) {
      throw new Error('Environment Readiness PASS cannot contain missingTools or questions.');
    }
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
    if (material && result.outcome === 'PASS') {
      throw new Error(`${stage} cannot PASS while BLOCKER or MAJOR findings exist.`);
    }
    if (stage === 'critical-review' && result.outcome !== 'FAIL' && !result.repairStage) result.repairStage = 'none';
    if (stage === 'critical-review' && result.outcome === 'FAIL' && !['architecture', 'planning', 'qa-planning'].includes(result.repairStage)) {
      throw new Error('Failed critical review must set repairStage to architecture, planning, or qa-planning.');
    }
    if (stage === 'critical-review' && result.outcome !== 'FAIL' && result.repairStage !== 'none') {
      throw new Error('Passing critical review must set repairStage to none.');
    }
  } else if (stage === 'implementation') {
    result.filesChanged = stringArray(result.filesChanged || [], 'filesChanged', { nonEmpty: result.outcome === 'PASS' });
    if (!Array.isArray(result.validations || []) || (result.outcome === 'PASS' && result.validations.length === 0)) throw new Error('validations must be a non-empty array on PASS.');
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
      expected: nonEmptyString(check?.expected, `checks[${index}].expected`),
      actual: nonEmptyString(check?.actual, `checks[${index}].actual`),
      evidence: nonEmptyString(check?.evidence, `checks[${index}].evidence`)
    }));
    if (!Array.isArray(result.automationAttempts || [])) throw new Error('automationAttempts must be an array.');
    result.automationAttempts = (result.automationAttempts || []).map((attempt, index) => ({
      command: nonEmptyString(attempt?.command, `automationAttempts[${index}].command`),
      result: nonEmptyString(attempt?.result, `automationAttempts[${index}].result`),
      covers: stringArray(attempt?.covers || [], `automationAttempts[${index}].covers`),
      fallbackReason: typeof attempt?.fallbackReason === 'string' ? attempt.fallbackReason : ''
    }));
    result.manualChecks = stringArray(result.manualChecks || [], 'manualChecks');
    if (result.outcome === 'PASS_WITH_MANUAL_VALIDATION' && result.manualChecks.length === 0) {
      throw new Error('PASS_WITH_MANUAL_VALIDATION requires at least one manual check.');
    }
    if (result.outcome === 'PASS_WITH_MANUAL_VALIDATION' && result.automationAttempts.length === 0) {
      throw new Error('PASS_WITH_MANUAL_VALIDATION requires at least one documented automation attempt before asking the human.');
    }
    rejectQaImplementationGuidance(result);
  } else if (stage === 'integration' && result.outcome === 'PASS') {
    result.commitMessage = nonEmptyString(result.commitMessage, 'commitMessage');
  }
  return result;
}

function normalizeBlackBoxTestPlan(plan, name) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error(`${name} must be a non-empty array.`);
  return plan.map((test, index) => {
    const normalized = {
      name: nonEmptyString(test?.name, `${name}[${index}].name`),
      ...(Array.isArray(test?.covers) ? { covers: stringArray(test.covers, `${name}[${index}].covers`, { nonEmpty: true }) } : {}),
      action: nonEmptyString(test?.action, `${name}[${index}].action`),
      expected: nonEmptyString(test?.expected, `${name}[${index}].expected`),
      evidenceMethod: nonEmptyString(test?.evidenceMethod, `${name}[${index}].evidenceMethod`)
    };
    rejectBlackBoxTestPlanImplementationGuidance(normalized, `${name}[${index}]`);
    return normalized;
  });
}

function rejectBlackBoxTestPlanImplementationGuidance(test, name) {
  const text = Object.values(test).join('\n');
  const forbidden = /\b(?:src|lib|app|components|scripts)\/[^\s:]+:\d+|(?:^|\s)line\s+\d+\b|root cause|replacement lines?|code snippet|copy-paste|should\s+(?:call|use|create|set|replace|import|export)\b|must\s+(?:call|use|create|set|replace|import|export)\b|\b(?:grep|cat)\b/i;
  if (forbidden.test(text)) {
    throw new Error(`${name} must be a black-box test plan only: runtime action, expected observable result, and evidence method. Do not include source-line evidence, root-cause analysis, or fix instructions.`);
  }
}

function rejectQaImplementationGuidance(result) {
  const text = [
    result.summary,
    ...(result.evidence || []),
    ...(result.checks || []).flatMap((check) => [check.name, check.expected, check.actual, check.evidence])
  ].filter(Boolean).join('\n');
  const forbidden = /\b(?:src|lib|app|components|scripts)\/[^\s:]+:\d+|(?:^|\s)line\s+\d+\b|root cause|replacement lines?|code snippet|copy-paste|should\s+(?:call|use|create|set|replace|import|export)\b|must\s+(?:call|use|create|set|replace|import|export)\b|\b(?:grep|cat)\b/i;
  if (forbidden.test(text)) {
    throw new Error('QA results must report black-box behavior only: test performed, expected result, actual result, and runtime evidence. Do not include source-line evidence, root-cause analysis, or fix instructions.');
  }
}

function isBrowserRuntimeTask(task) {
  const text = `${task?.id || ''} ${task?.title || ''} ${JSON.stringify(task?.acceptanceCriteria || [])} ${JSON.stringify(task?.description || '')} ${JSON.stringify(task?.blackBoxTestPlan || [])}`;
  return /\b(?:ui|canvas|browser|visual|layout|gameplay|game|audio|sound|controls?|render|dom|html|css|screen|viewport)\b/i.test(text);
}

function hasBrowserStartupEvidenceText(text) {
  return /(?:playwright|puppeteer|chromium|chrome|firefox|browser|headless|page\.|locator\()/i.test(text) &&
    /(?:pageerror|page error)/i.test(text) &&
    /console(?:\s+error)?/i.test(text) &&
    /(?:zero errors|0 errors|no errors|reported zero errors|reported 0 errors|without errors|startup.*(?:passed|verified|succeeded)|passed.*startup)/i.test(text);
}

function browserRuntimeFallbackGuidance() {
  return 'If Playwright is installed but bundled Chromium fails to launch because of sandbox, host permission, or missing browser dependencies, keep using Playwright with a system browser instead of improvised Puppeteer cache-path imports. Preferred fallback: Python Playwright sync_playwright().chromium.launch(channel="chrome", args=["--no-sandbox", "--disable-dev-shm-usage"]); if channel lookup fails, detect google-chrome/chromium/chromium-browser with which and pass it as executable_path. Use the repository-defined browser startup command when one exists. For a static browser app without one, do not default to file:// because ES modules, fetch, workers, and origin-dependent APIs can be blocked; start a temporary HTTP server on a verified free ephemeral loopback port, verify the served page identity, navigate to its http://127.0.0.1 URL, and stop the owned server before returning. Attach page.on("pageerror", ...), collect console messages whose type is "error", assert the primary UI root exists, and report that both listeners observed zero errors. Direct file navigation is acceptable only when the delivered runtime is intentionally self-contained for file:// and the browser reports no origin, CORS, module, or resource errors. Report the failed bundled-browser attempt separately from the successful system-browser startup check.';
}

function hasOnlyFailedBrowserStartupEvidence(text) {
  return /(?:playwright|puppeteer|chromium|chrome|firefox|browser|headless)/i.test(text) &&
    /\b(?:failed|cannot|can't|could not|unable|unavailable|error|exception|sandbox|permission denied|module not found|ERR_MODULE_NOT_FOUND)\b/i.test(text) &&
    !hasBrowserStartupEvidenceText(text);
}

function validateImplementationBrowserRuntimeEvidence(task, result) {
  if (result.outcome !== 'PASS' || !isBrowserRuntimeTask(task)) return;
  const evidenceText = [
    ...(result.evidence || []),
    ...(result.validations || []).flatMap((validation) => [validation.command, validation.result])
  ].filter(Boolean).join('\n');
  if (hasOnlyFailedBrowserStartupEvidence(evidenceText)) {
    throw new Error(`Browser/UI implementation PASS cannot rely only on failed browser launch evidence. ${browserRuntimeFallbackGuidance()}`);
  }
  if (!hasBrowserStartupEvidenceText(evidenceText)) {
    throw new Error(`Browser/UI implementation PASS requires concrete runtime startup evidence: load the app in Playwright/Puppeteer/headless browser or an equivalent browser runner, monitor pageerror and console errors, and report the command/result in validations. ${browserRuntimeFallbackGuidance()}`);
  }
}

function validateCodeReviewBrowserRuntimeEvidence(task, result) {
  if (result.outcome !== 'PASS' || !isBrowserRuntimeTask(task)) return;
  const implementationEvidence = [
    ...(task?.validations || []).flatMap((validation) => [validation.command, validation.result]),
    ...(task?.evidence || [])
  ].filter(Boolean).join('\n');
  if (!hasBrowserStartupEvidenceText(implementationEvidence)) {
    throw new Error('Code Review cannot PASS browser/UI work when Implementation lacks concrete browser startup evidence with console/pageerror monitoring. Return a MAJOR finding requiring runtime startup validation.');
  }
}

function materialFindingText(finding) {
  return [
    finding?.id,
    finding?.location,
    finding?.impact,
    finding?.recommendation,
    finding?.description
  ].filter(Boolean).join('\n');
}

function hasMaterialFindingAuthority(text) {
  return /\b(?:acceptance criterion|acceptance criteria|acceptanceCriteria|prd|product requirements document|trd|technical requirements document|source[- ]of[- ]truth|approved requirement|runtime|test|command|validation|pageerror|console error|syntax|crash|security|scope creep|regression)\b/i.test(text);
}

function isSpeculativeAlgorithmFinding(text) {
  return /\b(?:formula|algorithm|calculation|normaliz(?:e|ed|ation)|divisor|multiplier|mapping|clamp|angle|velocity|speed|physics|collision)\b/i.test(text) &&
    /\b(?:should|must|instead|replace|use|wrong|incorrect|inverted)\b/i.test(text);
}

function validateCodeReviewMaterialFindings(result) {
  if (result.outcome !== 'FAIL') return;
  for (const finding of result.findings || []) {
    if (!['BLOCKER', 'MAJOR'].includes(finding?.severity)) continue;
    const text = materialFindingText(finding);
    if (!hasMaterialFindingAuthority(text)) {
      throw new Error(
        'Code Review material findings must cite concrete authority: exact acceptance criteria, approved PRD/TRD source-of-truth requirements, deterministic command/test/runtime evidence, or a directly observed syntax/security/scope defect.'
      );
    }
    if (isSpeculativeAlgorithmFinding(text) && !/\b(?:acceptance criterion|acceptance criteria|acceptanceCriteria|prd|trd|source[- ]of[- ]truth|runtime|test|command|validation)\b/i.test(text)) {
      throw new Error(
        'Code Review cannot route implementation rework for speculative formula/algorithm preferences unless the finding proves a violation using acceptance criteria, approved PRD/TRD source-of-truth material, or deterministic test/runtime evidence.'
      );
    }
  }
}

function recordWorkflowAdvisory(repo, stage, result, check) {
  try {
    check();
  } catch (error) {
    appendEvent(repo, {
      type: 'workflow_quality_advisory',
      stage,
      outcome: result?.outcome,
      warning: String(error?.message || error)
    });
  }
}

function recordPostReviewAdvisories(repo, session, stage, result) {
  recordWorkflowAdvisory(repo, stage, result, () => validateSourceOfTruthEvidence(session, stage, result));
  if (stage === 'implementation') {
    recordWorkflowAdvisory(repo, stage, result, () => validateImplementationBrowserRuntimeEvidence(currentTask(session), result));
  } else if (stage === 'code-review') {
    recordWorkflowAdvisory(repo, stage, result, () => validateCodeReviewBrowserRuntimeEvidence(currentTask(session), result));
  } else if (stage === 'qa') {
    const task = currentTask(session);
    recordWorkflowAdvisory(repo, stage, result, () => {
      if (isBrowserRuntimeTask(task)) {
        const attemptedRuntime = result.automationAttempts.some((attempt) => /playwright|puppeteer|chromium|chrome|firefox|browser|headless|page\.|locator\(/i.test(`${attempt.command} ${attempt.result}`));
        if (!attemptedRuntime) {
          throw new Error('QA for UI/game/browser/runtime criteria should document a Playwright/headless-browser/live runtime test attempt in automationAttempts.');
        }
      }
    });
    recordWorkflowAdvisory(repo, stage, result, () => validateQaBrowserRuntimeEvidence(task, result));
    recordWorkflowAdvisory(repo, stage, result, () => validateQaManualCheckAutomation(result));
  }
}

function validateQaBrowserRuntimeEvidence(task, result) {
  if (!['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.outcome) || !isBrowserRuntimeTask(task)) return;
  const automationText = (result.automationAttempts || []).flatMap((attempt) => [attempt.command, attempt.result, ...(attempt.covers || [])]).join('\n');
  if (hasOnlyFailedBrowserStartupEvidence(automationText)) {
    throw new Error(`QA PASS for browser/UI work cannot rely only on failed browser launch evidence. ${browserRuntimeFallbackGuidance()}`);
  }
  if (!hasBrowserStartupEvidenceText(automationText)) {
    throw new Error(`QA PASS for browser/UI work requires concrete browser startup evidence: automation must load the page, monitor pageerror and console errors, and report that startup had no page or console errors. ${browserRuntimeFallbackGuidance()}`);
  }
}

function hasReviewArtifacts(session) {
  const artifacts = reviewArtifactsPromptView(session);
  return Boolean(artifacts.prd || artifacts.trd);
}

function resultEvidenceText(result) {
  return [
    result.summary,
    ...(result.evidence || []),
    ...(result.validations || []).flatMap((validation) => [validation.command, validation.result]),
    ...(result.findings || []).flatMap((finding) => [finding.id, finding.severity, finding.location, finding.impact, finding.recommendation, finding.description]),
    ...(result.checks || []).flatMap((check) => [check.name, check.status, check.expected, check.actual, check.evidence]),
    ...(result.automationAttempts || []).flatMap((attempt) => [attempt.command, attempt.result, ...(attempt.covers || [])]),
    ...(result.manualChecks || []),
    result.commitMessage
  ].filter(Boolean).join('\n');
}

function validateSourceOfTruthEvidence(session, stage, result) {
  if (!['implementation', 'code-review', 'qa', 'integration'].includes(stage)) return;
  if (!['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.outcome)) return;
  if (!hasReviewArtifacts(session)) return;
  const text = resultEvidenceText(result);
  const mentionsPrd = /\b(?:prd|product requirements document|reviewArtifacts\.prd|\.aiteam\/docs\/prd\.html|prd\.html)\b/i.test(text);
  const mentionsTrd = /\b(?:trd|technical requirements document|reviewArtifacts\.trd|\.aiteam\/docs\/trd\.html|trd\.html)\b/i.test(text);
  const mentionsSourceOfTruth = /\bsource[- ]of[- ]truth\b/i.test(text) || /\bapproved (?:prd|trd|product requirements|technical requirements)\b/i.test(text);
  if (!(mentionsPrd && mentionsTrd && mentionsSourceOfTruth)) {
    throw new Error(`${stage} PASS requires evidence that approved PRD and TRD source-of-truth material was checked for this task.`);
  }
}

function slugForRegressionId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'check';
}

function validateQaPlannedTestCoverage(session, result) {
  if (!['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.outcome)) return;
  const task = currentTask(session);
  const obligations = (task?.blackBoxTestPlan || []).map((test) => test.name).filter(Boolean);
  if (!obligations.length) return;

  const resultText = [
    result.summary,
    ...(result.evidence || []),
    ...(result.checks || []).flatMap((check) => [check.name, check.status, check.expected, check.actual, check.evidence]),
    ...(result.automationAttempts || []).flatMap((attempt) => [attempt.command, attempt.result, ...(attempt.covers || [])]),
    ...(result.manualChecks || [])
  ].filter(Boolean).join('\n');

  const missing = obligations.filter((name) => {
    if (!resultText.includes(name)) return true;
    const matchingCheck = (result.checks || []).find((check) => Object.values(check).some((value) => String(value || '').includes(name)));
    if (!matchingCheck) return false;
    if (/\b(?:obsolete|no longer valid|not valid anymore|superseded)\b/i.test(Object.values(matchingCheck).join('\n'))) {
      return !/\b(?:because|reason|replaced by|superseded by|no longer applies)\b/i.test(Object.values(matchingCheck).join('\n'));
    }
    return false;
  });
  if (missing.length) {
    throw new Error(`QA planned test coverage missing for current task tests: ${missing.join(', ')}. Run each planned black-box test or mark it obsolete/no longer valid with a reason.`);
  }
}

function priorRegressionObligations(session, currentTaskId) {
  const eligibleTasks = (session.taskLedger || [])
    .filter((task) => task.id !== currentTaskId && ['qa-passed', 'integrated', 'completed'].includes(task.status));
  const tasksById = new Map(eligibleTasks.map((task) => [task.id, task]));
  const obligationsById = new Map();

  for (const task of eligibleTasks) {
    if (Array.isArray(task.blackBoxTestPlan) && task.blackBoxTestPlan.length > 0) {
      for (const test of task.blackBoxTestPlan) {
        const cleanName = String(test.name || '').trim();
        if (!cleanName) continue;
        const id = `${task.id}#${slugForRegressionId(cleanName)}`;
        if (obligationsById.has(id)) continue;
        obligationsById.set(id, {
          id,
          taskId: task.id,
          taskTitle: task.title,
          name: cleanName,
          expected: test.expected,
          previousStatus: 'PASS'
        });
      }
    } else {
      for (const [index, check] of (task.qa?.checks || []).entries()) {
        if (/^fail$/i.test(check.status || '')) continue;
        const rawName = String(check.name || `check-${index + 1}`).trim();
        let originTaskId = task.id;
        let cleanName = rawName;

        for (const candidate of eligibleTasks) {
          if (rawName.includes(candidate.id)) {
            originTaskId = candidate.id;
            break;
          }
        }
        for (const candidate of eligibleTasks) {
          cleanName = cleanName.replace(new RegExp(candidate.id, 'gi'), '');
        }
        cleanName = cleanName.replace(/regression/gi, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').trim();
        if (!cleanName) cleanName = `check-${index + 1}`;

        const id = `${originTaskId}#${slugForRegressionId(cleanName)}`;
        if (obligationsById.has(id)) continue;
        obligationsById.set(id, {
          id,
          taskId: originTaskId,
          taskTitle: tasksById.get(originTaskId)?.title || task.title,
          name: cleanName,
          expected: check.expected,
          previousStatus: check.status
        });
      }
    }
  }

  return [...obligationsById.values()];
}

function validateQaRegressionCoverage(session, result) {
  if (!['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.outcome)) return;
  const obligations = priorRegressionObligations(session, session.currentTaskId);
  if (!obligations.length) return;

  const resultText = [
    result.summary,
    ...(result.evidence || []),
    ...(result.checks || []).flatMap((check) => [check.name, check.status, check.expected, check.actual, check.evidence]),
    ...(result.automationAttempts || []).flatMap((attempt) => [attempt.command, attempt.result, ...(attempt.covers || [])]),
    ...(result.manualChecks || [])
  ].filter(Boolean).join('\n');

  const missing = obligations.filter((obligation) => {
    if (!resultText.includes(obligation.id)) return true;
    const matchingCheck = (result.checks || []).find((check) => Object.values(check).some((value) => String(value || '').includes(obligation.id)));
    if (!matchingCheck) return false;
    if (/\b(?:obsolete|no longer valid|not valid anymore|superseded)\b/i.test(Object.values(matchingCheck).join('\n'))) {
      return !/\b(?:because|reason|replaced by|superseded by|no longer applies)\b/i.test(Object.values(matchingCheck).join('\n'));
    }
    return false;
  });
  if (missing.length) {
    throw new Error(`QA regression coverage missing for previous test IDs: ${missing.map((item) => item.id).join(', ')}. Re-run each prior QA test or mark it obsolete/no longer valid with a reason.`);
  }
}

function validateQaBlockedEvidence(session, result) {
  if (result.outcome !== 'BLOCKED') return;
  const attempts = result.automationAttempts || [];
  if (!attempts.length) {
    throw new Error('QA cannot return BLOCKED without concrete executed black-box attempts in automationAttempts. Choose a suitable runtime, browser, CLI, API, HTTP, public-interface harness, or other observable method and record the command and actual result.');
  }

  for (const [index, attempt] of attempts.entries()) {
    if (!(attempt.covers || []).length) {
      throw new Error(`QA BLOCKED automationAttempts[${index}].covers must identify the planned tests or regression obligations attempted.`);
    }
    if (!String(attempt.fallbackReason || '').trim()) {
      throw new Error(`QA BLOCKED automationAttempts[${index}].fallbackReason must explain why that method could not complete the required black-box coverage or why another method was tried.`);
    }
    if (/^(?:attempted|try|tried|would|could|should|requires?|unable|cannot|can't)\b/i.test(attempt.command.trim())) {
      throw new Error(`QA BLOCKED automationAttempts[${index}].command must be the concrete command actually executed, not a narrative or hypothetical attempt.`);
    }
    if (/\b(?:not attempted|not run|would require|needs? to be run|could not test without trying)\b/i.test(attempt.result)) {
      throw new Error(`QA BLOCKED automationAttempts[${index}].result must contain actual command output or an observed execution failure, not a hypothetical limitation.`);
    }
  }

  const task = currentTask(session);
  const obligations = [
    ...(task?.blackBoxTestPlan || []).map((test) => test.name).filter(Boolean),
    ...priorRegressionObligations(session, session.currentTaskId).map((item) => item.id)
  ];
  const covered = new Set(attempts.flatMap((attempt) => attempt.covers || []));
  const missing = obligations.filter((obligation) => !covered.has(obligation));
  if (missing.length) {
    throw new Error(`QA BLOCKED automation coverage missing for required planned tests or regressions: ${missing.join(', ')}. Record each exact obligation in automationAttempts[].covers; no specific testing framework is required.`);
  }

  const observedFailures = attempts.map((attempt) => `${attempt.result}\n${attempt.fallbackReason}`).join('\n');
  if (!/\b(?:failed|failure|error|not found|unavailable|timed out|timeout|permission denied|connection refused|missing|unsupported|cannot|can't|unable|blocked)\b/i.test(observedFailures)) {
    throw new Error('QA BLOCKED requires concrete observed external failure evidence in automationAttempts results/fallbackReason. If the executed black-box checks succeeded, return PASS, FAIL, or PASS_WITH_MANUAL_VALIDATION as appropriate.');
  }
}

function normalizeCoverageText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasHumanOnlyManualReason(check) {
  return /\bhuman[- ]only\b/i.test(check) &&
    /\b(?:because|requires|needs|subjective|visual|judgment|feel|perception|aesthetic|smoothness|playfeel|audio quality)\b/i.test(check);
}

function validateQaManualCheckAutomation(result) {
  if (result.outcome !== 'PASS_WITH_MANUAL_VALIDATION') return;
  const covers = (result.automationAttempts || [])
    .flatMap((attempt) => attempt.covers || [])
    .map(normalizeCoverageText)
    .filter(Boolean);
  const missing = (result.manualChecks || []).filter((check) => {
    if (hasHumanOnlyManualReason(check)) return false;
    const normalizedCheck = normalizeCoverageText(check);
    return !covers.some((cover) => normalizedCheck.includes(cover) || cover.includes(normalizedCheck));
  });
  if (missing.length) {
    throw new Error(`PASS_WITH_MANUAL_VALIDATION manual checks must be covered by automationAttempts[].covers or explicitly marked human-only with a reason: ${missing.join(' | ')}`);
  }
}

function validateQaManualCheckScope(session, result) {
  if (result.outcome !== 'PASS_WITH_MANUAL_VALIDATION') return;
  const task = currentTask(session);
  const taskIndex = session.taskLedger.findIndex((item) => item.id === task?.id);
  if (!task || taskIndex < 0) return;
  const currentTaskNumber = taskIndex + 1;
  const currentWords = wordsForScope(taskScopeText(task));
  const futureTasks = session.taskLedger
    .map((item, index) => ({ ...item, taskNumber: index + 1, scopeWords: wordsForScope(taskScopeText(item)) }))
    .filter((item, index) => index > taskIndex && !['qa-passed', 'integrated', 'completed'].includes(item.status));
  const futureScoped = (result.manualChecks || []).map((check) => {
    const fragmentWords = wordsForScope(check);
    const referencedNumber = taskNumberReferenced(check);
    const explicitFuture = /\bfuture task\b|\bfuture-task\b|\blater task\b|\blater\b|\bout(?:side)? of scope\b|\bnot (?:for )?(?:this|current) task\b/i.test(check)
      || (referencedNumber != null && referencedNumber !== currentTaskNumber);
    const futureScores = futureTasks
      .map((futureTask) => ({ taskId: futureTask.id, taskTitle: futureTask.title, taskNumber: futureTask.taskNumber, score: overlapCount(fragmentWords, futureTask.scopeWords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const bestFuture = futureScores[0] || null;
    const currentScore = overlapCount(fragmentWords, currentWords);
    if (explicitFuture || (bestFuture && bestFuture.score > currentScore + 1)) {
      return { check, matchedTask: bestFuture };
    }
    return null;
  }).filter(Boolean);
  if (futureScoped.length) {
    throw new Error(`QA manualChecks must not target future-task or out-of-scope behavior: ${futureScoped.map((item) => item.check).join(' | ')}`);
  }
}

function currentTask(session) {
  return session.taskLedger.find((task) => task.id === session.currentTaskId) || null;
}

function nextRunnableTask(session) {
  const done = new Set(session.taskLedger.filter((task) => task.status === 'qa-passed').map((task) => task.id));
  return session.taskLedger.find((task) => ['planned', 'needs-rework'].includes(task.status) && task.dependencies.every((id) => done.has(id))) || null;
}

function integrationSucceeded(task) {
  return Boolean(task?.integration?.committed || task?.integration?.reason === 'no_changes' || task?.integration?.integrated);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function phasePlanWithUiDesign(phasePlan, enabled) {
  const withoutUi = (phasePlan || []).filter((stage) => stage !== 'ui-design');
  if (!enabled) return withoutUi;
  const architectureIndex = withoutUi.indexOf('architecture');
  if (architectureIndex < 0) return ['ui-design', ...withoutUi];
  return [...withoutUi.slice(0, architectureIndex + 1), 'ui-design', ...withoutUi.slice(architectureIndex + 1)];
}

function phasePlanWithQaPlanning(phasePlan) {
  const withoutQaPlanning = (phasePlan || []).filter((stage) => stage !== 'qa-planning');
  const planningIndex = withoutQaPlanning.indexOf('planning');
  if (planningIndex < 0) return [...withoutQaPlanning, 'qa-planning'];
  return [...withoutQaPlanning.slice(0, planningIndex + 1), 'qa-planning', ...withoutQaPlanning.slice(planningIndex + 1)];
}

function phasePlanWithEnvironmentReadiness(phasePlan) {
  const withoutReadiness = (phasePlan || []).filter((stage) => stage !== 'environment-readiness');
  const trdIndex = withoutReadiness.indexOf('trd-review');
  if (trdIndex < 0) return [...withoutReadiness, 'environment-readiness'];
  return [...withoutReadiness.slice(0, trdIndex + 1), 'environment-readiness', ...withoutReadiness.slice(trdIndex + 1)];
}

export function workflowStatus(session, repo = null) {
  if (!session) return { active: false, message: 'No active AITEAM session exists.' };
  const stage = session.currentStage;
  const phase = STAGE_LABELS[stage] || stage;
  const index = session.phasePlan.indexOf(stage);
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

function currentTaskPromptView(task) {
  if (!task) return null;
  const {
    id,
    title,
    description,
    specialistId,
    acceptanceCriteria,
    blackBoxTestPlan,
    dependencies,
    status,
    filesChanged,
    validations
  } = task;
  return {
    id,
    title,
    description,
    specialistId,
    acceptanceCriteria,
    blackBoxTestPlan,
    dependencies,
    status,
    filesChanged: filesChanged || [],
    validations: validations || []
  };
}

function completedDependencyTasksPromptView(session, task, repo) {
  if (!task?.dependencies?.length) return [];
  const dependencyIds = new Set(task.dependencies);
  return (session.taskLedger || [])
    .filter((item) => dependencyIds.has(item.id) && ['qa-passed', 'integrated', 'completed'].includes(item.status))
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      acceptanceCriteria: item.acceptanceCriteria || [],
      filesChanged: item.filesChanged || [],
      existingFiles: (item.filesChanged || []).filter((file) => fs.existsSync(path.resolve(repo, file))),
      implementationRunId: item.implementationRunId || null,
      integration: item.integration || null
    }));
}

function currentTaskAttemptHistoryPromptView(task) {
  return (task?.attemptHistory || []).slice(-3).map((entry) => ({
    at: entry.at,
    stage: entry.stage,
    agentId: entry.agentId,
    runId: entry.runId,
    outcome: entry.outcome,
    summary: entry.summary,
    rejection: entry.rejection,
    filesChanged: entry.filesChanged || [],
    validationCount: entry.validationCount || 0
  }));
}

function appendTaskAttemptHistory(session, taskId, entry) {
  if (!taskId || !['implementation', 'code-review', 'qa'].includes(entry.stage)) return session;
  return {
    ...session,
    taskLedger: (session.taskLedger || []).map((task) => {
      if (task.id !== taskId) return task;
      const attemptHistory = [...(task.attemptHistory || []), entry].slice(-12);
      return { ...task, attemptHistory };
    })
  };
}

function architecturePromptView(arch) {
  if (!arch) return null;
  return {
    design: arch.design || [],
    context: arch.context || [],
    constraints: arch.constraints || [],
    qualityAttributes: arch.qualityAttributes || [],
    solutionStrategy: arch.solutionStrategy || [],
    buildingBlocks: arch.buildingBlocks || [],
    runtimeScenarios: arch.runtimeScenarios || [],
    deploymentView: arch.deploymentView || [],
    crossCuttingConcepts: arch.crossCuttingConcepts || [],
    architectureDecisions: arch.architectureDecisions || [],
    risks: arch.risks || [],
    hasUserInterface: arch.hasUserInterface === true,
    specialistNeeds: arch.specialistNeeds || [],
    requiredCapabilities: arch.requiredCapabilities || []
  };
}

function reviewArtifactsPromptView(session) {
  const reviews = session.humanReviewHistory || [];
  const latest = (kind) => [...reviews].reverse().find((item) => item.kind === kind && item.approved && item.artifact)?.artifact
    || (session.pendingUserInput?.kind === kind ? session.pendingUserInput.artifact : null);
  return {
    prd: latest('prd-review'),
    trd: latest('trd-review'),
    sourceOfTruth: 'Use the approved PRD for product intent and the approved TRD for architecture, implementation plan, and testing plan. If task details conflict with PRD/TRD, stop and report the conflict instead of guessing.'
  };
}

const TEST_FILE_PATTERN = /^(test[-_.]|.*[-_.]test\.|smoke[-_.]|.*[-_.]smoke\.|spec[-_.]|.*[-_.]spec\.)/i;
const TEST_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|py|sh|bash|cs|java|go|rs|rb|php|gd|cpp|c|cc|cxx|lua|swift|kt|sql|ps1)$/i;
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'qa', 'testing', 'e2e', 'it', 'integration-tests']);

function findExistingTestFiles(repo) {
  if (!repo || !fs.existsSync(repo)) return [];
  try {
    const entries = fs.readdirSync(repo, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && (TEST_FILE_PATTERN.test(entry.name) || entry.name === 'Makefile') && (TEST_EXTENSIONS.test(entry.name) || entry.name === 'Makefile')) {
        files.push(entry.name);
      }
      if (entry.isDirectory() && TEST_DIR_NAMES.has(entry.name.toLowerCase())) {
        try {
          const subEntries = fs.readdirSync(path.join(repo, entry.name), { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && (TEST_EXTENSIONS.test(sub.name) || TEST_FILE_PATTERN.test(sub.name))) {
              files.push(path.join(entry.name, sub.name));
            }
          }
        } catch {}
      }
    }
    return files.slice(0, 35);
  } catch {
    return [];
  }
}

function stageContext(session, repo) {
  const stage = session.currentStage;
  const task = currentTask(session);

  // Implementation, code-review, and QA only need the current task + essential summaries.
  // We explicitly DO NOT leak the global session.request to implementation agents to prevent scope creep / overachieving.
  if (['implementation', 'code-review', 'qa'].includes(stage)) {
    const arch = session.stageEvidence.architecture?.result;
    const regressionObligations = stage === 'qa'
      ? priorRegressionObligations(session, task?.id)
      : [];
    const completedPriorTasks = stage === 'qa'
      ? session.taskLedger
          .filter((t) => t.id !== task?.id && ['qa-passed', 'integrated', 'completed'].includes(t.status))
          .map((t) => ({
            id: t.id,
            title: t.title,
            acceptanceCriteria: t.acceptanceCriteria,
            filesChanged: t.filesChanged || [],
            regressionTests: regressionObligations
              .filter((obligation) => obligation.taskId === t.id)
              .map(({ id, name, expected, previousStatus }) => ({ id, name, expected, previousStatus }))
          }))
      : undefined;
    const existingTestScripts = stage === 'qa' ? findExistingTestFiles(repo) : undefined;

    return JSON.stringify({
      currentStage: stage,
      currentTask: currentTaskPromptView(task),
      currentTaskAttemptHistory: currentTaskAttemptHistoryPromptView(task),
      availableTestScripts: existingTestScripts?.length ? existingTestScripts : undefined,
      completedDependencyTasks: stage === 'implementation' ? completedDependencyTasksPromptView(session, task, repo) : undefined,
      completedPriorTasks: completedPriorTasks?.length ? completedPriorTasks : undefined,
      architectureDesignOverview: arch ? arch.design : null,
      architectureOverview: architecturePromptView(arch),
      uiDesign: session.stageEvidence['ui-design']?.result || null,
      environmentProfile: session.environmentProfile || null,
      reviewArtifacts: reviewArtifactsPromptView(session),
      pendingUserInput: session.pendingUserInput
    }, null, 2);
  }

  // Planning, QA test planning, and critical-review need the task ledger but not agent details.
  if (['planning', 'qa-planning', 'critical-review'].includes(stage)) {
    const registry = loadRegistry(repo).agents.map(({ id, role, sandbox, capabilities = [] }) => ({ id, role, sandbox, capabilities }));
    return JSON.stringify({
      request: session.request,
      currentStage: stage,
      requirements: session.stageEvidence.intake?.result || null,
      architecture: architecturePromptView(session.stageEvidence.architecture?.result),
      uiDesign: session.stageEvidence['ui-design']?.result || null,
      qaTestPlan: session.stageEvidence['qa-planning']?.result || null,
      environmentProfile: session.environmentProfile || null,
      reviewArtifacts: reviewArtifactsPromptView(session),
      plan: session.taskLedger?.length ? undefined : (session.stageEvidence.planning?.result || null),
      lockedCriticalFindings: session.lockedCriticalFindings,
      pendingUserInput: session.pendingUserInput,
      taskLedger: session.taskLedger,
      availableAgents: registry
    }, null, 2);
  }

  // Integration needs the task ledger, current task, and architecture/review summary.
  if (stage === 'integration') {
    return JSON.stringify({
      currentStage: stage,
      currentTask: currentTaskPromptView(task),
      taskLedger: session.taskLedger.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        specialistId: t.specialistId,
        filesChanged: t.filesChanged || [],
        qa: t.qa ? { outcome: t.qa.outcome, summary: t.qa.summary } : null
      })),
      reviewArtifacts: reviewArtifactsPromptView(session),
      completedTasks: session.completedTasks || []
    }, null, 2);
  }

  // All other stages (intake, architecture, recruiting) get the full context.
  const registry = loadRegistry(repo).agents.map(({ id, role, sandbox, capabilities = [] }) => ({ id, role, sandbox, capabilities }));
  return JSON.stringify({
    request: session.request,
    currentStage: stage,
    requirements: session.stageEvidence.intake?.result || null,
    architecture: architecturePromptView(session.stageEvidence.architecture?.result),
    uiDesign: session.stageEvidence['ui-design']?.result || null,
    qaTestPlan: session.stageEvidence['qa-planning']?.result || null,
    requiredCapabilities: {
      architecture: session.stageEvidence.architecture?.result?.requiredCapabilities || [],
      qa: session.stageEvidence['qa-planning']?.result?.requiredCapabilities || []
    },
    environmentProfile: session.environmentProfile || null,
    reviewArtifacts: reviewArtifactsPromptView(session),
    plan: session.taskLedger?.length ? undefined : (session.stageEvidence.planning?.result || null),
    lockedCriticalFindings: session.lockedCriticalFindings,
    taskLedger: session.taskLedger,
    interviewHistory: session.interviewHistory || [],
    pendingUserInput: session.pendingUserInput,
    currentTask: task,
    recruiterGap: session.recruiterQueue[0] || null,
    availableAgents: registry
  }, null, 2);
}


function assignmentText(stage, session) {
  const task = currentTask(session);
  const taskJson = JSON.stringify(currentTaskPromptView(task));
  const qaRuntimeSafety =
    'When serving browser apps for automation, do not use hard-coded ports; bind to a free ephemeral port or prove the selected port is free, and verify the page identity before assertions. Do not put localhost URLs in manualChecks unless automationAttempts document that QA owns a persistent server, chose/proved a free port, verified the served page identity, and expects the server to remain available for the human.';
  const browserFallbackRule = browserRuntimeFallbackGuidance();
  const qaRegressionRule =
    'If completedPriorTasks includes regressionTests, every regressionTests[].id is mandatory. Include each exact ID in checks or automationAttempts[].covers. Re-run that prior test unless it is no longer valid; if obsolete, include a check with that exact ID, status INFO, and a clear reason it is obsolete/no-longer-applicable.';
  const qaPlannedTestRule =
    'Every currentTask.blackBoxTestPlan[].name is mandatory. Include each exact planned test name in checks or automationAttempts[].covers. Re-run that planned black-box test unless it is no longer valid; if obsolete, include a check with that exact name, status INFO, and a clear reason it is obsolete/no-longer-applicable.';
  const qaStartupRule =
    'For browser/UI/game/canvas work, attach pageerror and console-error listeners before navigation/startup. Any page error, JavaScript console error, failed navigation, or missing primary UI root is a FAIL. PASS requires concrete automation evidence that startup had no page or console errors.';
  const qaManualValidationRule =
    'Before returning PASS_WITH_MANUAL_VALIDATION, every manualChecks[] item must either be listed exactly or by a clear short label in automationAttempts[].covers, or be explicitly marked "Human-only because ..." with the reason it cannot be automated. Manual checks must target only the current task or completed-prior-task regression scope; never ask the human to validate future planned tasks.';
  const qaMethodSelectionRule =
    'Choose the strongest available black-box method for each observable interface. Browser automation, system browsers, CLI execution, HTTP/API requests, simulated user input, public-interface harnesses, and existing project test runners are examples; no specific framework or fixed tool order is mandatory. Every claimed command must be recorded in automationAttempts with its actual result and covered test names. BLOCKED requires at least one concrete executed attempt, non-empty covers/fallbackReason on every attempt, and exact coverage of all planned-test names and prior regression IDs.';
  const codeReviewProofRule =
    'For any proposed BLOCKER or MAJOR finding involving formulas, normalization, geometry, boundaries, signs, units, state transitions, or algorithms, substitute representative boundary and midpoint inputs into the ACTUAL current code and show intermediate/final values. Apply the same inputs to the proposed replacement. Do not emit a material finding unless this proves that current behavior violates an exact acceptance criterion or approved PRD/TRD requirement and that the correction direction satisfies it. An alternative implementation preference is not a defect.';
  const details = {
    intake: 'Act as the conversational Intake Analyst. Collect and clarify requirements directly from the user. Return AWAITING_USER only for concrete unresolved material questions. Once the user answers every pending question, incorporate those answers and return PASS if the artifact is complete unless an answer creates a new material ambiguity. userConfirmed true means requirements are grounded in the original request or direct answers and no material question remains; it does not mean document approval. Do not ask for generic final confirmation. The subsequent PRD Review is the sole full-document approval gate.',
    architecture: 'Produce a structured implementation architecture: context, constraints, quality attribute scenarios, solution strategy, building blocks, runtime scenarios, deployment view, cross-cutting concepts, decisions/tradeoffs, risks, UI routing, and only genuine specialist capability gaps.',
    'ui-design': 'Translate the user requirements and the Architect’s structured architecture artifact into concrete visual tokens, layout hierarchies, interaction states, and responsive styling.',
    recruiting: `Create the specialist required for this verified capability gap: ${JSON.stringify(session.recruiterQueue[0])}`,
    planning: 'Create an ordered, dependency-valid implementation task ledger using available specialist IDs, incorporating architectural and UI/UX design specifications.',
    'qa-planning': 'Create the authoritative pre-implementation black-box and regression test plan for every planned task. Cover every exact task acceptance criterion plus relevant PRD, Architecture, and UI/UX obligations. Design tests only; do not execute them, inspect source, modify files, or provide repair instructions.',
    'environment-readiness': 'Verify every approved architecture and QA capability in the actual workspace before implementation. Prefer existing tools and equivalent alternatives. Prove browser startup when browser capability is required and prove a harmless write/read/syntax-check/delete round trip. Do not modify product source, manifests, or lockfiles. If a required tool needs unsafe or system-level installation, return AWAITING_USER with exact need, observed failure, alternatives tried, installation instructions, and verification command. If the user reported installation, re-run the probes rather than trusting the report.',
    'critical-review': session.lockedCriticalFindings.length
      ? 'VERIFY_REPAIRS only against the locked critical findings. Do not create unrelated findings.'
      : 'Perform the initial COMPREHENSIVE critical review of requirements, architecture, UI/UX design (if present), plan, and QA feasibility.',
    implementation: task?.['code-reviewFailure']
      ? `This is a REWORK assignment for task ${taskJson}.\nThe previous review failed with the following findings:\n${JSON.stringify(task['code-reviewFailure'].findings, null, 2)}\n\nTreat each previous finding as a hypothesis, not an instruction that must be applied blindly. Use execution tools to inspect the ACTUAL current files and verify every finding against the current task acceptanceCriteria and approved PRD/TRD source-of-truth material. For formulas, normalization, geometry, boundaries, signs, units, state transitions, or algorithms, substitute representative boundary and midpoint inputs into both the current logic and the proposed replacement.\n\nFix only findings that this verification confirms. If a finding is stale, contradicted by the current code, or would make compliant behavior worse, preserve the working code and provide deterministic evidence explaining why the finding is invalid. A rework PASS does not require a content change when all material findings are disproven: list the existing implementation paths in filesChanged and provide non-empty validations proving the acceptance criteria. Do NOT make a token/no-op edit solely to satisfy rework. Do NOT return FAIL.`
      : task?.qaFailure
      ? `This is a REWORK assignment for task ${taskJson}.\nQA validation failed with the following issue:\n${JSON.stringify(task.qaFailure, null, 2)}\n\n` +
        `FAILING QA TEST COMMANDS TO REPRODUCE & FIX:\n` +
        `${(task.qaFailure.automationAttempts || []).map((a, i) => `[Test ${i + 1}] Command: ${a.command}\nResult: ${a.result}\nCovers: ${(a.covers || []).join(', ')}`).join('\n\n') || 'Inspect the failed checks above.'}\n\n` +
        `You MUST use execution tools to run the failing test scripts / commands above to reproduce the issue, edit the files on disk to fix the bugs, and re-run the tests until they pass with zero errors. Only after the files are written and verified passing on disk may you emit outcome "PASS". Do NOT return FAIL.`
      : `Implement or verify task ${taskJson}.\n\n` +
        `If the code for this task is not yet written, you MUST execute your tools (e.g. node, python, or shell scripts) to physically write the necessary files to disk NOW.\n` +
        `If the acceptance criteria are already satisfied by pre-existing code, verify the criteria using test/inspection commands and list those source files in "filesChanged".\n\n` +
        `CRITICAL SCOPE BOUNDARY:\nImplement ONLY the acceptanceCriteria of THIS task.\nDo NOT implement features or subsystems belonging to other tasks. Focus strictly on fulfilling the criteria of THIS task.\n\n` +
        `Return outcome "PASS" with "filesChanged" containing the non-empty repository-relative paths containing the implementation. Do not commit.`,
    'code-review': task?.['code-reviewFailure']
      ? `This is a REPAIR VERIFICATION for task ${taskJson}.\nThe previous review failed with the following findings:\n${JSON.stringify(task['code-reviewFailure'].findings, null, 2)}\n\nYou MUST perform a FULL review of the entire task and all its changed paths: verify that the previous findings are resolved AND that all acceptanceCriteria are still completely met without regressions or scope creep. Use file inspection tools to read the files directly from disk. Re-derive each prior finding from the current code; prior findings are hypotheses, not authoritative facts. If deterministic implementation evidence disproves a prior finding, do not repeat it.\n\n${codeReviewProofRule}`
      : `Review only the current task and its changed paths: ${taskJson}.\n\nYou MUST use file inspection tools to read and inspect the code files directly from disk before returning your review findings.\n\n${codeReviewProofRule}`,
    qa: task?.qaFailure
      ? `This is a REPAIR VERIFICATION for task ${taskJson}.\nThe previous QA validation failed with:\n${JSON.stringify(task.qaFailure, null, 2)}\n\nYou MUST execute a FULL black-box regression test suite covering ALL acceptanceCriteria of this task. Verify specifically that the previously failed observable behavior is resolved AND that all previously passing acceptance criteria still pass without regressions. Also verify that no completed prior tasks were broken. Return a verified check in "checks" for every acceptance criterion. Each check must report test performed, expected result, actual result, and runtime evidence. Do NOT inspect source code and DO NOT tell the programmer how to fix defects.\n\n${qaMethodSelectionRule}\n\n${browserFallbackRule}\n\n${qaPlannedTestRule}\n\n${qaRegressionRule}\n\n${qaStartupRule}\n\n${qaManualValidationRule}\n\n${qaRuntimeSafety}`
      : `Validate the current task against its acceptance criteria: ${taskJson}.\n\n` +
        (session.taskLedger.some((t) => t.id !== task?.id && ['qa-passed', 'integrated', 'completed'].includes(t.status))
          ? `CROSS-TASK REGRESSION: You must also verify that this task's changes did not break any previously passing completed tasks listed in your context (completedPriorTasks).\n\n`
          : '') +
        `CRITICAL SCOPE BOUNDARY: Generate black-box functional checks strictly for the acceptance criteria of THIS current task and regression on completed prior tasks. Do NOT include manual verification steps for unbuilt future features or audio if not in this task's criteria.\n\nYou MUST execute real validation commands using your tools (e.g. bash/exec to run smoke test scripts, browser automation, API requests, CLI commands, or headless tests) on disk before returning your structured result. Do NOT inspect source code and DO NOT tell the programmer how to fix defects. Each check must report test performed, expected result, actual result, and runtime evidence.\n\n${qaMethodSelectionRule}\n\n${browserFallbackRule}\n\n${qaPlannedTestRule}\n\n${qaRegressionRule}\n\n${qaStartupRule}\n\n${qaManualValidationRule}\n\n${qaRuntimeSafety}`,
    integration: task
      ? `Inspect QA-approved work for task ${taskJson} and propose a conventional commit message. Do not stage or commit.`
      : 'Inspect all QA-approved work for safe integration and propose a commit message. Do not stage or commit.'
  }[stage];
  return `${details}\n\n${STAGE_SCHEMAS[stage]}`;
}

export function getCurrentAssignment(repo, session = readSession(repo)) {
  if (!session) throw new Error('No active AITEAM session exists in this repository.');
  if (session.status === 'READY_TO_COMPLETE') throw new Error('All gates passed. Call aiteam_complete.');
  if (session.status === 'BLOCKED') {
    session = writeSession(repo, { ...session, status: 'ACTIVE', blockedReason: null });
  }
  if (session.status !== 'ACTIVE') throw new Error(`AITEAM session is not active: ${session.status}`);
  if (session.currentStage === 'critical-review' && session.taskLedger?.length && !session.stageEvidence['qa-planning']?.result) {
    const reason = 'Migrated the in-flight workflow through mandatory QA Test Planning before Critical Review.';
    session = writeSession(repo, {
      ...session,
      currentStage: 'qa-planning',
      phasePlan: phasePlanWithQaPlanning(session.phasePlan),
      completedStages: (session.completedStages || []).filter((stage) => !['qa-planning', 'critical-review', 'trd-review'].includes(stage)),
      lastFailure: reason
    });
    appendEvent(repo, { type: 'qa_test_planning_migration', reason });
  }
  if (['prd-review', 'trd-review'].includes(session.currentStage)) {
    throw new Error(`${STAGE_LABELS[session.currentStage]} is awaiting human approval. Open the linked HTML document, wait for the user response, then call aiteam_update_session.`);
  }
  if (session.currentStage !== 'intake' && session.stageEvidence.intake?.result?.userConfirmed !== true) {
    throw new Error('Workflow gate rejected: Analyst Intake must produce a resolved, user-grounded requirements artifact before Architecture.');
  }
  if (session.activeRun) {
    const age = Date.now() - Date.parse(session.activeRun.startedAt || 0);
    const staleRunMs = Number(process.env.AITEAM_STALE_RUN_MS) || 3 * 60 * 60 * 1000;
    const ownerGone = Number.isInteger(session.activeRun.ownerPid) && !processExists(session.activeRun.ownerPid);
    if (!ownerGone && Number.isFinite(age) && age < staleRunMs) {
      throw new Error(`AITEAM specialist ${session.activeRun.agentId} is already running for stage ${session.activeRun.stage}.`);
    }
    const staleRun = session.activeRun;
    const recoveryReason = ownerGone
      ? `Recovered active-run lease after owner process ${staleRun.ownerPid} exited.`
      : 'Recovered stale active-run lease after its timeout window elapsed.';
    session = writeSession(repo, { ...session, activeRun: null, lastFailure: recoveryReason });
    appendEvent(repo, { type: 'stale_active_run_recovered', reason: recoveryReason, previous: staleRun });
  }
  if (['planning', 'qa-planning', 'critical-review'].includes(session.currentStage)) {
    const missingGaps = unresolvedArchitectureGaps(session, repo);
    if (missingGaps.length) {
      const queuedIds = new Set((session.recruiterQueue || []).map((gap) => proposedSpecialistId(gap)));
      const queue = [
        ...(session.recruiterQueue || []),
        ...missingGaps.filter((gap) => !queuedIds.has(proposedSpecialistId(gap)))
      ];
      const reason = `Recovered unresolved architecture specialist gaps before Planning: ${missingGaps.map((gap) => proposedSpecialistId(gap)).join(', ')}.`;
      session = writeSession(repo, {
        ...session,
        currentStage: 'recruiting',
        resumeStage: 'planning',
        recruiterQueue: queue,
        completedStages: (session.completedStages || []).filter((stage) => !['planning', 'qa-planning', 'critical-review'].includes(stage)),
        lastFailure: reason
      });
      appendEvent(repo, { type: 'unresolved_specialist_gaps_recovered', reason, gaps: missingGaps });
    }
  }
  let task = currentTask(session);
  if (session.currentStage === 'implementation' && (!task || !['planned', 'needs-rework'].includes(task.status))) {
    task = nextRunnableTask(session);
    if (!task) throw new Error('No dependency-ready implementation task exists.');
    session = writeSession(repo, {
      ...session,
      currentTaskId: task.id,
      taskLedger: session.taskLedger.map((t) => t.id === task.id ? { ...t, startedAt: t.startedAt || new Date().toISOString() } : t)
    });
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
    const changed = session.taskLedger.find((item) => item.qaFingerprint && !integrationSucceeded(item) && fingerprintPaths(repo, item.filesChanged) !== item.qaFingerprint);
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

function unresolvedArchitectureGaps(session, repo) {
  const gaps = session.stageEvidence.architecture?.result?.specialistNeeds || [];
  const seen = new Set();
  return gaps.filter((gap) => {
    const id = proposedSpecialistId(gap);
    if (!id || seen.has(id) || hasSpecialist(repo, id)) return false;
    seen.add(id);
    return true;
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function listItems(items) {
  const values = Array.isArray(items) ? items : [];
  return values.length
    ? `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p class="muted">None specified.</p>';
}

function svgFlow(title, steps) {
  const values = (steps || []).filter(Boolean).slice(0, 6);
  const width = 980;
  const boxWidth = Math.max(120, Math.floor((width - 80) / Math.max(values.length, 1)) - 18);
  const boxes = values.map((step, index) => {
    const x = 40 + index * (boxWidth + 18);
    const arrow = index < values.length - 1
      ? `<path d="M ${x + boxWidth} 84 L ${x + boxWidth + 14} 84" stroke="#28666e" stroke-width="3" marker-end="url(#arrow)" />`
      : '';
    return `${arrow}<rect x="${x}" y="44" width="${boxWidth}" height="80" rx="16" fill="#e7f5f1" stroke="#28666e" stroke-width="2" />
      <text x="${x + boxWidth / 2}" y="78" text-anchor="middle" font-size="14" font-family="Georgia, serif" fill="#143f46">${escapeHtml(step).slice(0, 28)}</text>
      <text x="${x + boxWidth / 2}" y="99" text-anchor="middle" font-size="12" font-family="Georgia, serif" fill="#4b6267">${escapeHtml(step).slice(28, 56)}</text>`;
  }).join('');
  return `<figure class="diagram"><figcaption>${escapeHtml(title)}</figcaption><svg viewBox="0 0 ${width} 160" role="img" aria-label="${escapeHtml(title)}">
    <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#28666e" /></marker></defs>
    ${boxes}
  </svg></figure>`;
}

function screenMockups(uiDesign) {
  const screens = (uiDesign?.screens || []).slice(0, 4);
  if (!screens.length) return '<p class="muted">No UI mockups yet. UI/UX Design has not run or the product is headless.</p>';
  return `<div class="mockups">${screens.map((screen) => {
    const name = String(screen.name || '').toLowerCase();
    const kind = /victory|win|result/.test(name) || (/game\s*over/.test(name) && !/start|menu/.test(name)) ? 'victory'
      : /menu|start|difficulty|select|pause/.test(name) ? 'menu'
      : /game|hud|court|play|arena/.test(name) ? 'gameplay'
      : 'generic';
    return `
      <article class="mockup">
        <div class="mockup-top">${escapeHtml(screen.name)}</div>
        <div class="wireframe wireframe-${kind}">
          ${wireframeBody(kind, screen)}
        </div>
        <p class="mockup-layout">${escapeHtml(screen.layout)}</p>
        ${screen.interactionStates?.length ? `<p class="mini-label">States</p>${tagList(screen.interactionStates.slice(0, 5))}` : ''}
      </article>`;
  }).join('')}</div>`;
}

function wireframeBody(kind, screen) {
  if (kind === 'gameplay') {
    return `
      <div class="scorebar"><span>PLAYER 0</span><span>AI 0</span></div>
      <div class="court">
        <span class="center-line"></span>
        <span class="paddle player"></span>
        <span class="paddle ai"></span>
        <span class="ball"></span>
        <span class="trail t1"></span>
        <span class="trail t2"></span>
        <span class="hud-chip">MOUSE</span>
      </div>
      <button class="sound-dot" aria-label="Sound toggle">♪</button>`;
  }
  if (kind === 'victory') {
    return `
      <div class="court dimmed"><span class="center-line"></span><span class="paddle player"></span><span class="paddle ai"></span></div>
      <div class="modal">
        <strong>Winner</strong>
        <span>Final score</span>
        <button>Play Again</button>
        <button>Change Difficulty</button>
      </div>`;
  }
  if (kind === 'menu') {
    const isStart = /start|difficulty/i.test(screen.name || '');
    const menuButtons = isStart
      ? ['Easy', 'Medium', 'Hard', 'Start Game']
      : ['Resume Game', 'Change Difficulty', 'Sound: On', 'Restart'];
    return `
      <div class="screen-title">${escapeHtml(shortLabel(screen.name || 'Menu'))}</div>
      <div class="button-stack">
        ${menuButtons.map((btn) => `<button>${escapeHtml(btn)}</button>`).join('')}
      </div>
      <button class="sound-dot" aria-label="Sound toggle">♪</button>`;
  }
  return `
    <div class="screen-title">${escapeHtml(screen.name || 'Screen')}</div>
    <div class="wire-list">${(screen.components || []).filter(Boolean).slice(0, 6).map((component) => `<span>${escapeHtml(shortLabel(component))}</span>`).join('')}</div>`;
}

function shortLabel(value) {
  return String(value || '').replace(/[—–].*$/, '').replace(/:.*/, '').trim().slice(0, 34) || 'Component';
}

function tagList(items) {
  return `<div class="tags">${(items || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function runtimeScenarioCards(scenarios) {
  const values = scenarios || [];
  if (!values.length) return '<p class="muted">No runtime scenarios specified.</p>';
  return `<div class="flow-cards">${values.map((scenario) => `
    <article class="flow-card">
      <h3>${escapeHtml(scenario.name)}</h3>
      ${scenario.trigger ? `<p class="muted">${escapeHtml(scenario.trigger)}</p>` : ''}
      <ol>${(scenario.flow || []).map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    </article>`).join('')}</div>`;
}

function taskCards(tasks) {
  if (!tasks.length) return '<p class="muted">No implementation tasks specified.</p>';
  return `<div class="task-list">${tasks.map((task, index) => `
    <article class="task-card">
      <div class="task-head"><span class="step-badge">${index + 1}</span><div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.id)} · ${escapeHtml(task.specialistId)}</p></div></div>
      <p>${escapeHtml(task.description)}</p>
      <div class="task-columns">
        <section><h4>Done When</h4>${listItems(task.acceptanceCriteria)}</section>
        <section><h4>Depends On</h4>${task.dependencies?.length ? tagList(task.dependencies) : '<p class="muted">No dependencies.</p>'}</section>
      </div>
    </article>`).join('')}</div>`;
}

function testingCards(tasks) {
  if (!tasks.length) return '<p class="muted">No testing plan specified.</p>';
  return `<div class="test-groups">${tasks.map((task) => `
    <article class="test-group">
      <h3>${escapeHtml(task.title)}</h3>
      <p class="muted">${escapeHtml(task.id)}</p>
      <div class="test-list">${(task.blackBoxTestPlan || []).map((test) => `
        <section class="test-card">
          <h4>${escapeHtml(test.name)}</h4>
          <dl>
            ${test.covers?.length ? `<dt>Covers</dt><dd>${escapeHtml(test.covers.join(' | '))}</dd>` : ''}
            <dt>Action</dt><dd>${escapeHtml(test.action)}</dd>
            <dt>Expected</dt><dd>${escapeHtml(test.expected)}</dd>
            <dt>Evidence</dt><dd>${escapeHtml(test.evidenceMethod)}</dd>
          </dl>
        </section>`).join('')}</div>
    </article>`).join('')}</div>`;
}

function documentShell({ title, subtitle, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --ink:#17252a; --muted:#587077; --paper:#fffaf0; --line:#d8c7a3; --accent:#28666e; --soft:#e7f5f1; }
    body { margin:0; background:linear-gradient(135deg,#f8ecd0,#e4f3ee 55%,#f8f4e8); color:var(--ink); font-family: Georgia, "Times New Roman", serif; }
    main { max-width:1080px; margin:0 auto; padding:48px 24px 72px; }
    header { border:2px solid var(--line); border-radius:28px; padding:34px; background:rgba(255,250,240,.86); box-shadow:0 24px 80px rgba(40,102,110,.16); }
    h1 { margin:0; font-size:clamp(36px,6vw,72px); letter-spacing:-.04em; line-height:.92; }
    h2 { margin-top:34px; padding-top:18px; border-top:1px solid var(--line); font-size:28px; }
    h3 { margin-bottom:8px; color:var(--accent); }
    h4 { margin:14px 0 8px; color:var(--ink); }
    p, li { font-size:17px; line-height:1.55; }
    p { max-width:78ch; }
    .subtitle, .muted { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:18px; }
    .wide-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:18px; }
    .card, table, .diagram, .mockup, .flow-card, .task-card, .test-group { background:rgba(255,255,255,.65); border:1px solid var(--line); border-radius:20px; padding:18px; }
    table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; }
    th, td { text-align:left; vertical-align:top; padding:12px; border-bottom:1px solid var(--line); }
    th { color:var(--accent); }
    figcaption { font-weight:700; margin-bottom:10px; color:var(--accent); }
    .mockups { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:22px; align-items:start; }
    .mockup-top { background:var(--accent); color:white; border-radius:14px 14px 0 0; padding:10px 14px; font-weight:700; }
    .mockup-layout { font-size:14px; color:var(--muted); }
    .wireframe { position:relative; min-height:260px; border:2px solid var(--accent); border-top:0; border-radius:0 0 14px 14px; padding:18px; background:#09131a; color:#eafff8; overflow:hidden; box-shadow:inset 0 0 50px rgba(0,255,136,.08); }
    .wireframe::before { content:""; position:absolute; inset:0; background:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px); background-size:28px 28px; opacity:.45; pointer-events:none; }
    .screen-title { position:relative; z-index:1; margin:26px auto 22px; text-align:center; font-weight:900; letter-spacing:.16em; font-size:26px; text-shadow:0 0 12px rgba(0,255,136,.7); }
    .button-stack { position:relative; z-index:1; display:grid; gap:12px; max-width:190px; margin:0 auto; }
    .button-stack button, .modal button { border:1px solid #80ffd6; border-radius:999px; background:rgba(255,255,255,.08); color:#eafff8; padding:10px 14px; font-weight:700; }
    .scorebar { position:relative; z-index:1; display:flex; justify-content:space-between; font-size:13px; letter-spacing:.08em; margin-bottom:12px; }
    .court { position:relative; z-index:1; height:190px; border:1px solid rgba(234,255,248,.45); border-radius:10px; background:radial-gradient(circle at center,#142338,#080d16); }
    .center-line { position:absolute; top:8%; bottom:8%; left:50%; border-left:2px dashed rgba(234,255,248,.45); }
    .paddle { position:absolute; top:35%; width:8px; height:54px; border-radius:999px; box-shadow:0 0 16px currentColor; }
    .paddle.player { left:18px; background:#00ff88; color:#00ff88; }
    .paddle.ai { right:18px; background:#ff4466; color:#ff4466; }
    .ball { position:absolute; left:58%; top:45%; width:14px; height:14px; border-radius:50%; background:white; box-shadow:0 0 14px white; }
    .trail { position:absolute; border-radius:50%; background:#00ff88; opacity:.45; }
    .trail.t1 { left:52%; top:47%; width:10px; height:10px; }
    .trail.t2 { left:47%; top:49%; width:7px; height:7px; opacity:.25; }
    .hud-chip { position:absolute; right:8px; bottom:8px; border:1px solid rgba(234,255,248,.4); border-radius:999px; padding:4px 8px; font-size:11px; }
    .sound-dot { position:absolute; z-index:2; right:14px; top:14px; width:38px; height:38px; border-radius:50%; border:1px solid #80ffd6; background:rgba(255,255,255,.08); color:#eafff8; }
    .dimmed { opacity:.45; }
    .modal { position:absolute; z-index:2; inset:54px 42px auto; display:grid; gap:8px; justify-items:center; padding:18px; border:1px solid rgba(234,255,248,.55); border-radius:16px; background:rgba(5,9,15,.88); box-shadow:0 18px 50px rgba(0,0,0,.35); }
    .wire-list { position:relative; z-index:1; display:grid; gap:10px; margin-top:20px; }
    .wire-list span, .tags span { display:inline-block; border:1px solid #9ac2bd; border-radius:999px; padding:7px 10px; background:white; color:var(--ink); margin:4px 6px 4px 0; font-size:13px; }
    .mini-label { margin:12px 0 4px; color:var(--accent); font-weight:700; font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
    .flow-cards, .task-list, .test-groups { display:grid; gap:18px; }
    .flow-card ol { display:grid; gap:8px; padding-left:26px; }
    .task-head { display:flex; gap:14px; align-items:center; }
    .task-head h3 { margin:0; }
    .task-head p { margin:2px 0 0; color:var(--muted); font-size:14px; }
    .step-badge { display:grid; place-items:center; flex:0 0 38px; width:38px; height:38px; border-radius:50%; background:var(--accent); color:white; font-weight:800; }
    .task-columns { display:grid; grid-template-columns:minmax(0,2fr) minmax(180px,1fr); gap:18px; }
    .test-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
    .test-card { border:1px solid var(--line); border-radius:16px; padding:14px; background:rgba(255,250,240,.7); }
    .test-card h4 { margin-top:0; }
    dt { margin-top:8px; font-weight:800; color:var(--accent); }
    dd { margin:2px 0 0; line-height:1.45; }
    .table-wrap { overflow-x:auto; border-radius:20px; }
    code { background:#efe3c8; padding:2px 6px; border-radius:6px; }
    @media (max-width:720px) { main { padding:28px 14px 48px; } .task-columns { grid-template-columns:1fr; } .mockups { grid-template-columns:1fr; } }
  </style>
</head>
<body><main><header><p class="subtitle">AITEAM Review Artifact</p><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></header>${body}</main></body></html>`;
}

function artifactUrl(session, filename) {
  const port = session.watchPort || process.env.AITEAM_WATCH_PORT || 4317;
  return `http://127.0.0.1:${port}/artifacts/${encodeURIComponent(filename)}`;
}

function writeReviewArtifact(repo, session, filename, html) {
  const dir = path.join(repo, '.aiteam', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, html);
  return { path: filePath, url: artifactUrl(session, filename), fileUrl: pathToFileURL(filePath).href };
}

function generatePrd(repo, session) {
  const intake = session.stageEvidence.intake?.result || {};
  const flowSteps = ['User request', 'Confirmed goals', 'MVP scope', 'Acceptance criteria', 'Human PRD approval'];
  const requirements = intake.requirements || [];
  const criteria = intake.acceptanceCriteria || [];
  const html = documentShell({
    title: 'Product Requirements Document',
    subtitle: `Session ${session.id} · ${new Date().toLocaleString()}`,
    body: `
      <section class="card"><h2>How To Read This</h2><p>This PRD explains what the product should do, who it is for, and how we will know it is finished. Please review the goals, requirements, and acceptance criteria. If anything is missing or wrong, describe the change you want before approving.</p></section>
      <h2>Document Basics</h2><table><tbody>
        <tr><th>Status</th><td>Ready for human review</td></tr>
        <tr><th>Owner</th><td>Analyst</td></tr>
        <tr><th>Source Request</th><td>${escapeHtml(session.request)}</td></tr>
        <tr><th>Last Updated</th><td>${escapeHtml(new Date().toLocaleString())}</td></tr>
      </tbody></table>
      ${svgFlow('Product Definition Flow', flowSteps)}
      <h2>Problem To Solve</h2><p>${escapeHtml((intake.goals || [session.request])[0])}</p>
      <h2>Goals And Success</h2><div class="grid">
        <section class="card"><h3>Goals</h3>${listItems(intake.goals)}</section>
        <section class="card"><h3>Success Metrics</h3>${listItems(intake.successMetrics)}</section>
      </div>
      <div class="grid">
        <section class="card"><h3>Target Users</h3>${listItems(intake.targetUsers)}</section>
        <section class="card"><h3>User Stories</h3>${listItems(intake.userStories)}</section>
      </div>
      <h2>Functional Requirements</h2><table><thead><tr><th>ID</th><th>Requirement</th></tr></thead><tbody>${requirements.map((item, index) => `<tr><td>PRD-R${index + 1}</td><td>${escapeHtml(item)}</td></tr>`).join('')}</tbody></table>
      <h2>Acceptance Criteria</h2><table><thead><tr><th>ID</th><th>Criterion</th></tr></thead><tbody>${criteria.map((item, index) => `<tr><td>PRD-A${index + 1}</td><td>${escapeHtml(item)}</td></tr>`).join('')}</tbody></table>
      <div class="grid">
        <section class="card"><h3>MVP Scope</h3>${listItems(intake.mvpScope)}</section>
        <section class="card"><h3>Out Of Scope</h3>${listItems(intake.outOfScope)}</section>
        <section class="card"><h3>Assumptions</h3>${listItems(intake.assumptions)}</section>
        <section class="card"><h3>Constraints</h3>${listItems(intake.constraints)}</section>
      </div>
      <h2>Non-Functional Requirements</h2>${listItems(intake.nonFunctionalRequirements)}
      <h2>Risks</h2>${listItems(intake.risks)}
      <h2>Open Questions</h2>${listItems(intake.questions)}
      <h2>Change Notes</h2><p>This PRD should be updated if the user changes product intent, scope, acceptance criteria, or success metrics.</p>
      <h2>Approval</h2><p>Reply with exactly <strong>approved</strong> to continue to Architecture. Any other response is treated as requested PRD feedback.</p>`
  });
  return writeReviewArtifact(repo, session, 'prd.html', html);
}

export function generateTrd(repo, session) {
  const arch = architecturePromptView(session.stageEvidence.architecture?.result) || {};
  const ui = session.stageEvidence['ui-design']?.result || null;
  const plan = session.stageEvidence.planning?.result || {};
  const qaPlan = session.stageEvidence['qa-planning']?.result || {};
  const review = session.stageEvidence['critical-review']?.result || {};
  const intake = session.stageEvidence.intake?.result || {};
  const tasks = session.taskLedger?.length ? session.taskLedger : (plan.tasks || []);
  const reqs = intake.requirements || [];
  const capabilityRows = [
    ...(arch.requiredCapabilities || []).map((capability) => ({ ...capability, owner: 'Architecture' })),
    ...(qaPlan.requiredCapabilities || []).map((capability) => ({ ...capability, owner: 'QA Test Planning' }))
  ];
  const traceRows = tasks.flatMap((task) => (task.acceptanceCriteria || []).map((criterion) => ({ task, criterion })));
  const html = documentShell({
    title: 'Technical Requirements Document',
    subtitle: `Session ${session.id} · Implementation readiness review`,
    body: `
      <section class="card"><h2>How To Read This</h2><p>This TRD explains how the team plans to build and test the approved product. Please review the architecture, implementation plan, and testing plan. If the plan does not match what you approved in the PRD, describe the change you want instead of approving.</p></section>
      <h2>Document Basics</h2><div class="table-wrap"><table><tbody>
        <tr><th>Status</th><td>Ready for human review</td></tr>
        <tr><th>Owners</th><td>Architect, UI/UX Analyst and Designer, Planner, QA Test Planner, Critical Reviewer</td></tr>
        <tr><th>Last Updated</th><td>${escapeHtml(new Date().toLocaleString())}</td></tr>
        <tr><th>Implementation Starts After</th><td>Human approval of this TRD and successful Environment Readiness verification</td></tr>
      </tbody></table></div>
      ${svgFlow('Technical Delivery Flow', ['Architecture', 'Task and QA plan', 'Human TRD approval', 'Environment readiness', 'Implementation', 'Review and QA'])}
      <h2>Product Requirements Covered</h2><div class="table-wrap"><table><thead><tr><th>PRD ID</th><th>Requirement</th></tr></thead><tbody>${reqs.map((req, index) => `<tr><td>PRD-R${index + 1}</td><td>${escapeHtml(req)}</td></tr>`).join('')}</tbody></table></div>
      <h2>Architecture Overview</h2>${listItems(arch.design)}
      <div class="wide-grid">
        <section class="card"><h3>Constraints</h3>${listItems(arch.constraints)}</section>
        <section class="card"><h3>Solution Strategy</h3>${listItems(arch.solutionStrategy)}</section>
        <section class="card"><h3>Deployment View</h3>${listItems(arch.deploymentView)}</section>
        <section class="card"><h3>Cross-Cutting Concepts</h3>${listItems(arch.crossCuttingConcepts)}</section>
      </div>
      <h2>System Boundary And Runtime Flows</h2><div class="wide-grid">
        <section class="card"><h3>System Boundary</h3>${listItems(arch.context)}</section>
        <section><h3>Runtime Scenarios</h3>${runtimeScenarioCards(arch.runtimeScenarios || [])}</section>
      </div>
      <h2>Building Blocks</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Responsibility</th><th>Interfaces</th></tr></thead><tbody>${(arch.buildingBlocks || []).map((block) => `<tr><td>${escapeHtml(block.name)}</td><td>${escapeHtml(block.responsibility)}</td><td>${escapeHtml((block.interfaces || []).join(', '))}</td></tr>`).join('')}</tbody></table></div>
      <h2>Quality Attributes</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Scenario</th><th>Measure</th></tr></thead><tbody>${(arch.qualityAttributes || []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.measure)}</td></tr>`).join('')}</tbody></table></div>
      <h2>Data, Interfaces, And Dependencies</h2><div class="grid">
        <section class="card"><h3>Data Or State</h3>${listItems((arch.crossCuttingConcepts || []).filter((item) => /data|state|store|persist|config/i.test(item)))}</section>
        <section class="card"><h3>Interfaces</h3>${listItems((arch.buildingBlocks || []).flatMap((block) => block.interfaces || []))}</section>
        <section class="card"><h3>Dependencies</h3>${listItems((arch.architectureDecisions || []).map((item) => item.decision))}</section>
      </div>
      <h2>Security, Privacy, And Operations</h2><div class="grid">
        <section class="card"><h3>Security And Privacy</h3>${listItems((arch.crossCuttingConcepts || []).filter((item) => /security|privacy|auth|permission|safe/i.test(item)))}</section>
        <section class="card"><h3>Run, Deploy, And Back Out</h3>${listItems([...(arch.deploymentView || []), 'If implementation creates a serious problem, stop and route the task back to Implementation instead of shipping the change.'])}</section>
      </div>
      <h2>Screen Mockups</h2>${screenMockups(ui)}
      <h2>Implementation Plan</h2>${taskCards(tasks)}
      <h2>Requirements-To-Work Traceability</h2><div class="table-wrap"><table><thead><tr><th>Task</th><th>Acceptance Criterion</th><th>Likely PRD Link</th></tr></thead><tbody>${traceRows.map(({ task, criterion }, index) => `<tr><td>${escapeHtml(task.id)}</td><td>${escapeHtml(criterion)}</td><td>${escapeHtml(reqs[index % Math.max(reqs.length, 1)] ? `PRD-R${(index % reqs.length) + 1}` : 'PRD requirement not mapped')}</td></tr>`).join('')}</tbody></table></div>
      <h2>QA Test Plan Ownership</h2><div class="wide-grid">
        <section class="card"><h3>Owner And Purpose</h3><p>The QA Test Planner created this black-box plan before implementation. Execution QA must use it as the approved starting point and retain its test names as coverage obligations.</p></section>
        <section class="card"><h3>Coverage Notes</h3>${listItems(qaPlan.coverageNotes)}</section>
        <section class="card"><h3>Regression Strategy</h3>${listItems(qaPlan.regressionStrategy)}</section>
      </div>
      <h2>Testing Plan</h2><p>This is the QA-authored black-box test plan. Each test identifies the approved behavior it covers, the action QA should perform, the expected observable result, and the evidence to collect.</p>${testingCards(tasks)}
      <h2>Required Tools And Environment Capabilities</h2><p>These are capabilities the team must prove before implementation. The listed tools are acceptable options, not automatic requirements; Environment Readiness may select any equivalent tool that passes the functional verification.</p><div class="table-wrap"><table><thead><tr><th>Owner</th><th>Capability</th><th>Purpose</th><th>Acceptable Tools</th><th>Readiness Check</th></tr></thead><tbody>${capabilityRows.map((capability) => `<tr><td>${escapeHtml(capability.owner)}</td><td>${escapeHtml(capability.id)}</td><td>${escapeHtml(capability.purpose)}</td><td>${escapeHtml((capability.acceptableTools || []).join(', '))}</td><td>${escapeHtml(capability.verification)}</td></tr>`).join('')}</tbody></table></div>
      <h2>Critical Review</h2>${listItems((review.findings || []).map((finding) => `${finding.severity}: ${finding.description || finding.id}`))}
      <h2>Risks And Open Questions</h2><div class="grid">
        <section class="card"><h3>Technical Risks</h3>${listItems(arch.risks)}</section>
        <section class="card"><h3>Open Questions</h3>${listItems((review.findings || []).filter((finding) => finding.severity === 'INFO').map((finding) => finding.description || finding.id))}</section>
      </div>
      <h2>Approval</h2><p>Reply with exactly <strong>approved</strong> to approve the technical and testing plan and begin Environment Readiness verification. Implementation starts only after the approved capabilities are verified. Any other response is treated as requested TRD/testing-plan feedback and returns the work to Planning.</p>`
  });
  return writeReviewArtifact(repo, session, 'trd.html', html);
}

function proposalId(run, specialist) {
  return crypto.createHash('sha256').update(`${run.runId}\n${JSON.stringify(specialist)}`).digest('hex');
}

function missingChangedFiles(repo, task) {
  if (!task || !Array.isArray(task.filesChanged) || task.filesChanged.length === 0) return [];
  return task.filesChanged.filter((file) => !fs.existsSync(path.resolve(repo, file)));
}

function recoverImplementationProseResult(repo, session, assignment, stdout) {
  if (assignment.stage !== 'implementation') return null;
  const task = currentTask(session);
  const text = String(stdout || '');

  const reportsSuccess = (
    /all (?:qa |black-box )?(?:validations|acceptance criteria|criteria|checks|tests|fixes|changes|issues)\s*(?:are|have been)?\s*(?:implemented|fixed|verified|pass|passed|satisfied)/i.test(text) ||
    /(?:verified|passed) all (?:criteria|checks|tests|fixes|validations)/i.test(text) ||
    /acceptance criteria verified/i.test(text) ||
    /checks verified passing/i.test(text) ||
    /(?:validation results|test results):/i.test(text) && /\d+\/\d+\s*(?:passed|pass|ok|✅)/i.test(text) ||
    /all \d+ (?:checks|tests|validations) pass/i.test(text)
  );
  if (!reportsSuccess) return null;

  const extractedFiles = [];
  const filesMatch = text.match(/\*\*(?:Files modified|Files changed):\*\*\s*([^\n]+)/i);
  if (filesMatch) {
    const rawFiles = filesMatch[1].match(/`([^`]+)`/g);
    if (rawFiles) {
      for (const rf of rawFiles) {
        const clean = rf.replace(/`/g, '').trim();
        if (clean && fs.existsSync(path.resolve(repo, clean))) {
          extractedFiles.push(clean);
        }
      }
    }
  }

  let filesChanged = extractedFiles.length
    ? extractedFiles
    : Array.isArray(task?.filesChanged) ? task.filesChanged.filter((f) => fs.existsSync(path.resolve(repo, f))) : [];
  if (!filesChanged.length && fs.existsSync(path.resolve(repo, 'index.html'))) {
    filesChanged = ['index.html'];
  }
  if (!filesChanged.length) return null;

  const validations = filesChanged.map((file) => {
    const absolute = path.resolve(repo, file);
    const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : { size: 0 };
    return {
      command: `server verified ${file} exists after implementation prose result`,
      result: `${file} exists on disk (${stat.size} bytes)`
    };
  });
  return {
    outcome: 'PASS',
    summary: `Implementation result recovered from prose after verifying declared changed files on disk: ${filesChanged.join(', ')}.`,
    evidence: [
      'Implementation specialist emitted prose instead of JSON, but explicitly reported that validations or acceptance criteria passed.',
      ...validations.map((validation) => `${validation.command}: ${validation.result}`)
    ],
    filesChanged,
    validations
  };
}

const FORMAT_REPAIR_SOURCE_LIMIT = 96000;

function boundedFormatRepairText(value) {
  const text = String(value || '');
  if (text.length <= FORMAT_REPAIR_SOURCE_LIMIT) return text;
  return `[earlier output omitted]\n${text.slice(-FORMAT_REPAIR_SOURCE_LIMIT)}`;
}

function formatRepairSource(run) {
  return [
    '--- ORIGINAL STDOUT ---',
    boundedFormatRepairText(run?.stdout),
    '--- ORIGINAL STDERR / TOOL TRANSCRIPT ---',
    boundedFormatRepairText(run?.stderr)
  ].join('\n');
}

function isStructuredFormattingError(error) {
  return /not valid JSON|no structured result|must be one JSON object/i.test(String(error?.message || error));
}

function collectRepairStrings(value, pathParts = [], output = []) {
  if (typeof value === 'string') {
    if (pathParts.at(-1) !== 'outcome') output.push({ path: pathParts.join('.'), value });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRepairStrings(item, [...pathParts, String(index)], output));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => collectRepairStrings(item, [...pathParts, key], output));
  }
  return output;
}

function validateFormatRepairGrounding(result, source) {
  if (result.outcome === 'BLOCKED') return;
  const sourceLower = source.toLowerCase();
  const unsupported = collectRepairStrings(result).filter(({ path, value }) => {
    if (!value || typeof value !== 'string') return false;
    if (path.includes('filesChanged') || path.includes('command')) return !source.includes(value);
    const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) return false;
    const matchCount = words.filter((w) => sourceLower.includes(w)).length;
    return matchCount / words.length < 0.25;
  });
  if (unsupported.length) {
    const fields = unsupported.slice(0, 5).map(({ path }) => path).join(', ');
    throw new Error(`Format-only repair added or paraphrased claims not present verbatim in the original run: ${fields}.`);
  }
}

async function tryFormatOnlyRepair({ repo, assignment, run, runner, timeoutMs, model }) {
  const source = formatRepairSource(run);
  const repairTask = [
    `Repair only the final structured response for the completed ${assignment.stage} run.`,
    'Do not redo implementation or validation.',
    'Every summary, evidence, file path, finding, check, command, and result string must be copied verbatim from the source output.',
    'Choose PASS only when the source explicitly reports completed successful work and contains every required field. Otherwise choose BLOCKED.'
  ].join(' ');
  let repairRun;
  try {
    repairRun = await runner({
      repo,
      agentId: assignment.agentId,
      stage: assignment.stage,
      task: repairTask,
      context: source,
      timeoutMs: Math.min(timeoutMs, 180000),
      model,
      enforceSchema: true,
      responseOnly: true
    });
    if (repairRun.exitCode !== 0 || repairRun.timedOut) {
      throw new Error(`format-only repair exited with code ${repairRun.exitCode}${repairRun.timedOut ? ' after timeout' : ''}`);
    }
    const result = parseStageResult(assignment.stage, repairRun.stdout);
    if (result.outcome === 'BLOCKED') {
      throw new Error('format-only repair reported that required source information was missing');
    }
    validateFormatRepairGrounding(result, source);
    appendEvent(repo, {
      type: 'workflow_stage_format_repaired',
      stage: assignment.stage,
      agentId: assignment.agentId,
      originalRunId: run.runId,
      repairRunId: repairRun.runId
    });
    return { result, repairRun };
  } catch (error) {
    appendEvent(repo, {
      type: 'workflow_stage_format_repair_failed',
      stage: assignment.stage,
      agentId: assignment.agentId,
      originalRunId: run.runId,
      repairRunId: repairRun?.runId || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

function dependencyExistingFiles(session, task, repo) {
  return completedDependencyTasksPromptView(session, task, repo)
    .flatMap((dependency) => dependency.existingFiles || [])
    .filter(Boolean);
}

function rejectFalseImplementationBlocked(repo, session, result) {
  const task = currentTask(session);
  if (!task || result.outcome !== 'BLOCKED') return;
  const dependencyFiles = [...new Set(dependencyExistingFiles(session, task, repo))];
  if (!dependencyFiles.length) return;
  const text = `${result.summary}\n${(result.evidence || []).join('\n')}`;
  const claimsMissingCode = /\b(?:repo(?:sitory)? is empty|no source files?|no implementation files?|source code (?:does not|doesn't) exist|dependency .* (?:does not|doesn't) exist|hasn't been built|has not been built)\b/i.test(text);
  if (claimsMissingCode) {
    throw new Error(`Implementation BLOCKED is inconsistent with completed dependency files on disk: ${dependencyFiles.join(', ')}. Inspect these dependency files and either implement/verify the current task or return a concrete blocker that is not a false repository-empty/dependency-missing claim.`);
  }
}

function rejectImplementationInspectionDeferral(result) {
  const text = `${result.summary}\n${(result.evidence || []).join('\n')}`;
  if (/\bneed to inspect\b|\bmust inspect\b|\binspect (?:the )?(?:repo|repository|codebase|files?)\b|\bbefore (?:proceeding|determining|deciding)\b/i.test(text)) {
    throw new Error('Implementation cannot return FAIL/BLOCKED just to inspect repository state. It has workspace-write tool access and must inspect files during the run, then return PASS with filesChanged/validations or a concrete external blocker.');
  }
}

function rejectImplementationFalseAccessDeferral(result) {
  const text = `${result.summary}\n${(result.evidence || []).join('\n')}`;
  if (/\b(?:no|without|missing|lack(?:ing)?|unavailable|not available)\s+(?:write access|workspace-write|tool access|exec_command|bash|shell|execution tools?)\b|\b(?:cannot|can't|could not|unable to)\s+(?:write|edit|modify|create files?|use exec_command|use bash|access tools?)\b|\bsandbox restrictions?\b/i.test(text)) {
    throw new Error('Implementation cannot return FAIL/BLOCKED claiming missing write/tool access. Implementation specialists run with workspace-write and execution tools; they must use available shell/node/python commands to inspect, write, and validate files, or report a concrete external blocker with command evidence.');
  }
}

function environmentInstallQuestions(result) {
  return result.missingTools.map((tool) => [
    `Required tool: ${tool.tool}`,
    `Capability: ${tool.capability}`,
    `Why it is needed: ${tool.whyNeeded}`,
    `Detected problem: ${tool.detectedProblem}`,
    `Alternatives tried: ${tool.alternativesTried.join('; ')}`,
    `Install: ${tool.installInstructions.join(' ; ')}`,
    `AITEAM will verify with: ${tool.verificationCommand}`,
    'After installation, reply with what you installed. AITEAM will re-run verification before continuing.'
  ].join('\n'));
}

function validateEnvironmentCapabilityCoverage(session, result) {
  if (result.outcome !== 'PASS') return;
  const required = new Set([
    ...(session.stageEvidence.architecture?.result?.requiredCapabilities || []).map((capability) => capability.id),
    ...(session.stageEvidence['qa-planning']?.result?.requiredCapabilities || []).map((capability) => capability.id)
  ]);
  const verified = new Set(result.capabilities
    .filter((capability) => capability.status === 'VERIFIED')
    .map((capability) => capability.id));
  const missing = [...required].filter((id) => !verified.has(id));
  if (missing.length) {
    throw new Error(`Environment Readiness PASS is missing approved capability verification for: ${missing.join(', ')}.`);
  }
}

function validateEnvironmentInstallRequest(session, result) {
  const required = new Set([
    ...(session.stageEvidence.architecture?.result?.requiredCapabilities || []).map((capability) => capability.id),
    ...(session.stageEvidence['qa-planning']?.result?.requiredCapabilities || []).map((capability) => capability.id)
  ]);
  const invalid = result.missingTools.filter((tool) => !required.has(tool.capability));
  if (invalid.length) {
    throw new Error(`Environment Readiness may request human installation only for approved capabilities: ${invalid.map((tool) => tool.capability).join(', ')}.`);
  }
}

function applyResult(repo, session, assignment, result, run) {
  let next = { ...session, activeRun: null, stageEvidence: recordEvidence(session, assignment, result, run) };
  const stage = assignment.stage;
  const passed = result.outcome === 'PASS' || result.outcome === 'PASS_WITH_MANUAL_VALIDATION';
  next = appendTaskAttemptHistory(next, assignment.session.currentTaskId, {
    at: run.completedAt || new Date().toISOString(),
    stage,
    agentId: assignment.agentId,
    runId: run.runId,
    outcome: result.outcome,
    summary: result.summary,
    filesChanged: result.filesChanged || [],
    validationCount: (result.validations || result.checks || []).length
  });

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

  if (stage === 'environment-readiness' && result.outcome === 'AWAITING_USER') {
    validateEnvironmentInstallRequest(next, result);
    const pendingUserInput = {
      kind: 'environment-install',
      stage,
      questions: environmentInstallQuestions(result),
      response: null,
      requestedAt: new Date().toISOString(),
      runId: run.runId,
      missingTools: result.missingTools
    };
    appendEvent(repo, { type: 'environment_install_requested', stage, missingTools: result.missingTools, runId: run.runId });
    return writeSession(repo, { ...next, pendingUserInput, lastFailure: result.summary });
  }

  if (result.outcome === 'BLOCKED' && ['code-review', 'qa'].includes(stage)) {
    const task = currentTask(next);
    const missing = missingChangedFiles(repo, task);
    if (missing.length) {
      const failure = {
        ...result,
        outcome: 'FAIL',
        summary: `${stage} blocked because required implemented files are missing from disk: ${missing.join(', ')}. Route back to Implementation.`
      };
      next.taskLedger = next.taskLedger.map((item) => item.id === next.currentTaskId
        ? stage === 'code-review'
          ? { ...item, status: 'needs-rework', review: null, 'code-reviewFailure': failure, qa: null, qaFailure: null, qaFingerprint: null, completedAt: null, integration: null }
          : { ...item, status: 'needs-rework', qa: null, qaFailure: failure, qaFingerprint: null, completedAt: null, integration: null }
        : item);
      next.currentStage = 'implementation';
      next.lastFailure = failure.summary;
      appendEvent(repo, { type: 'validated_paths_missing', stage, taskId: task?.id, missing, runId: run.runId });
      return writeSession(repo, next);
    }
  }

  if (stage === 'qa' && result.outcome === 'BLOCKED') {
    validateQaBlockedEvidence(next, result);
  }

  if (stage === 'implementation' && result.outcome === 'BLOCKED') {
    rejectImplementationInspectionDeferral(result);
    rejectImplementationFalseAccessDeferral(result);
    rejectFalseImplementationBlocked(repo, next, result);
  }

  if (result.outcome === 'BLOCKED') {
    return writeSession(repo, { ...next, status: 'BLOCKED', blockedReason: result.summary });
  }
  if (!passed) {
    if (stage === 'critical-review') {
      next.lockedCriticalFindings = result.findings;
      next.currentStage = result.repairStage;
    } else if (stage === 'qa-planning') {
      next.currentStage = 'planning';
      next.completedStages = next.completedStages.filter((item) => !['planning', 'qa-planning', 'critical-review'].includes(item));
      next.taskLedger = [];
      next.lastFailure = `QA Test Planning requires task-plan clarification: ${result.summary}`;
    } else if (stage === 'code-review' || stage === 'qa') {
      if (stage === 'code-review') {
        recordWorkflowAdvisory(repo, stage, result, () => validateCodeReviewMaterialFindings(result));
      }
      next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId
        ? stage === 'code-review'
          ? { ...task, status: 'needs-rework', review: null, 'code-reviewFailure': result, qa: null, qaFailure: null, qaFingerprint: null, completedAt: null, integration: null }
          : { ...task, status: 'needs-rework', qa: null, qaFailure: result, qaFingerprint: null, completedAt: null, integration: null }
        : task);
      next.currentStage = 'implementation';
    } else if (stage === 'implementation') {
      rejectImplementationInspectionDeferral(result);
      rejectImplementationFalseAccessDeferral(result);
      // Implementation specialists are forbidden from returning FAIL — they must write files and return PASS.
      // A FAIL outcome here almost always means the specialist hallucinated a sandbox restriction
      // instead of calling exec_command/bash. Treat as a retry: set BLOCKED so the coordinator
      // calls aiteam_advance again, which will re-spawn the specialist with the correct write access.
      const retryReason =
        `Implementation specialist returned FAIL instead of writing files to disk. ` +
        `Specialist summary: "${result.summary}". ` +
        `This is NOT a real sandbox restriction — the specialist has full workspace-write access. ` +
        `Call aiteam_advance to retry; the specialist must use exec_command/bash to write files before emitting PASS.`;
      return writeSession(repo, { ...next, status: 'BLOCKED', blockedReason: retryReason });
    }
    return writeSession(repo, next);
  }

  if (stage === 'intake') {
    const nextHistory = next.pendingUserInput?.response != null
      ? [...(next.interviewHistory || []), next.pendingUserInput]
      : (next.interviewHistory || []);
    next.interviewHistory = nextHistory;
    next.completedStages = [...new Set([...next.completedStages, 'intake'])];
    next.currentStage = 'prd-review';
    next.pendingUserInput = null;
    const artifact = generatePrd(repo, next);
    next.pendingUserInput = {
      kind: 'prd-review',
      stage: 'prd-review',
      questions: [
        `Open the Product Requirements Document: ${artifact.url}`,
        `If the localhost link does not open, use the local file instead: ${artifact.fileUrl}`,
        'Reply exactly "approved" to approve the PRD and continue to Architecture. Any other response will be treated as required PRD feedback.'
      ],
      artifact,
      response: null,
      requestedAt: new Date().toISOString(),
      runId: run.runId
    };
    appendEvent(repo, { type: 'human_review_requested', stage: 'prd-review', artifact });
  } else if (stage === 'architecture') {
    next.completedStages = [...new Set([...next.completedStages, 'architecture'])];
    next.recruiterQueue = result.specialistNeeds.filter((gap) => !hasSpecialist(repo, proposedSpecialistId(gap)));
    next.phasePlan = phasePlanWithUiDesign(next.phasePlan, result.hasUserInterface);
    const nextStageAfterRecruiting = result.hasUserInterface ? 'ui-design' : 'planning';
    if (next.recruiterQueue.length) {
      next.resumeStage = nextStageAfterRecruiting;
      next.currentStage = 'recruiting';
    } else {
      next.currentStage = nextStageAfterRecruiting;
    }
  } else if (stage === 'ui-design') {
    next.completedStages = [...new Set([...next.completedStages, 'ui-design'])];
    next.currentStage = 'planning';
  } else if (stage === 'recruiting') {
    const expectedId = proposedSpecialistId(next.recruiterQueue[0] || {});
    if (expectedId && result.specialist.id !== expectedId) {
      throw new Error(`Recruiter proposed ${result.specialist.id} but current architecture gap requires ${expectedId}.`);
    }
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
    next.completedStages = [...new Set(next.completedStages.filter((item) => !['qa-planning', 'critical-review'].includes(item)).concat('planning'))];
    next.taskLedger = normalizeTasks(result.tasks);
    next.currentTaskId = null;
    next.phasePlan = phasePlanWithQaPlanning(next.phasePlan);
    next.currentStage = 'qa-planning';
  } else if (stage === 'qa-planning') {
    const tasksById = new Map(next.taskLedger.map((task) => [task.id, task]));
    const plansById = new Map(result.taskTestPlans.map((taskPlan) => [taskPlan.taskId, taskPlan.tests]));
    const unknown = [...plansById.keys()].filter((taskId) => !tasksById.has(taskId));
    const missing = [...tasksById.keys()].filter((taskId) => !plansById.has(taskId));
    if (unknown.length || missing.length) {
      throw new Error(`QA Test Planning task coverage mismatch. Unknown task IDs: ${unknown.join(', ') || 'none'}. Missing task IDs: ${missing.join(', ') || 'none'}.`);
    }

    function normalizeCriterion(text) {
      return String(text || '')
        .replace(/\s*\([A-Za-z0-9_ -]+\)\s*$/g, '')
        .replace(/^\s*(?:AC-?\d+|Criterion\s*\d+|[\d.-]+)\s*[:.)-]?\s*/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    }

    for (const task of next.taskLedger) {
      const coveredList = (plansById.get(task.id) || []).flatMap((test) => test.covers || []);
      const coveredSet = new Set(coveredList);
      const normalizedCovered = coveredList.map(normalizeCriterion).filter(Boolean);
      const uncovered = task.acceptanceCriteria.filter((criterion) => {
        if (coveredSet.has(criterion)) return false;
        const norm = normalizeCriterion(criterion);
        return !normalizedCovered.some((c) => c === norm || c.includes(norm) || norm.includes(c));
      });
      if (uncovered.length) {
        throw new Error(`QA Test Planning must cover every exact acceptance criterion for ${task.id}. Missing: ${uncovered.join(' | ')}`);
      }
    }
    next.taskLedger = next.taskLedger.map((task) => ({ ...task, blackBoxTestPlan: plansById.get(task.id) }));
    if (next.stageEvidence.planning?.result?.tasks) {
      next.stageEvidence.planning.result.tasks = next.stageEvidence.planning.result.tasks.map((task) => ({
        ...task,
        blackBoxTestPlan: plansById.get(task.id)
      }));
    }
    next.completedStages = [...new Set([...next.completedStages, 'qa-planning'])];
    next.currentStage = 'critical-review';
  } else if (stage === 'critical-review') {
    next.completedStages = [...new Set([...next.completedStages, 'critical-review'])];
    next.lockedCriticalFindings = result.findings;
    next.currentStage = 'trd-review';
    next.currentTaskId = null;
    const artifact = generateTrd(repo, next);
    next.pendingUserInput = {
      kind: 'trd-review',
      stage: 'trd-review',
      questions: [
        `Open the Technical Requirements Document: ${artifact.url}`,
        `If the localhost link does not open, use the local file instead: ${artifact.fileUrl}`,
        'Review the architecture, implementation plan, testing plan, and required environment capabilities. Reply exactly "approved" to begin Environment Readiness verification. Any other response will be treated as required TRD/testing-plan feedback.'
      ],
      artifact,
      response: null,
      requestedAt: new Date().toISOString(),
      runId: run.runId
    };
    appendEvent(repo, { type: 'human_review_requested', stage: 'trd-review', artifact });
  } else if (stage === 'environment-readiness') {
    validateEnvironmentCapabilityCoverage(next, result);
    next.completedStages = [...new Set([...next.completedStages, 'environment-readiness'])];
    next.environmentProfile = {
      verifiedAt: run.completedAt || new Date().toISOString(),
      runId: run.runId,
      capabilities: result.capabilities,
      fileOperations: result.fileOperations,
      evidence: result.evidence
    };
    next.pendingUserInput = null;
    next.currentStage = 'implementation';
    next.lastFailure = null;
    appendEvent(repo, { type: 'environment_readiness_verified', runId: run.runId, capabilities: result.capabilities.map((capability) => capability.id) });
  } else if (stage === 'implementation') {
    const missing = result.filesChanged.filter((file) => !fs.existsSync(path.resolve(repo, file)));
    if (missing.length) {
      throw new Error(
        `Implementation specialist did not write files to disk (missing: ${missing.join(', ')}). ` +
        `This is NOT a sandbox restriction — the specialist has full workspace-write access. ` +
        `The specialist must call exec_command or bash to write files before emitting PASS. ` +
        `Call aiteam_advance to retry so the specialist writes the files.`
      );
    }
    recordPostReviewAdvisories(repo, next, stage, result);
    const implementationFingerprint = fingerprintPaths(repo, result.filesChanged);
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? {
      ...task,
      status: 'implemented',
      filesChanged: result.filesChanged,
      validations: result.validations,
      implementationFingerprint,
      implementationRunId: run.runId,
      review: null,
      'code-reviewFailure': null,
      qa: null,
      qaFailure: null,
      qaFingerprint: null,
      completedAt: null,
      integration: null,
      integrityFailure: null
    } : task);
    next.currentStage = 'code-review';
  } else if (stage === 'code-review') {
    recordPostReviewAdvisories(repo, next, stage, result);
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? { ...task, status: 'review-passed', review: result, 'code-reviewFailure': null } : task);
    next.currentStage = 'qa';
  } else if (stage === 'qa') {
    const task = currentTask(next);
    validateQaPlannedTestCoverage(next, result);
    validateQaRegressionCoverage(next, result);
    recordPostReviewAdvisories(repo, next, stage, result);
    validateQaManualCheckScope(next, result);
    const manual = result.outcome === 'PASS_WITH_MANUAL_VALIDATION';
    next.taskLedger = next.taskLedger.map((task) => task.id === next.currentTaskId ? {
      ...task,
      status: manual ? 'qa-awaiting-manual' : 'qa-passed',
      qa: result,
      qaFailure: null,
      qaFingerprint: fingerprintPaths(repo, task.filesChanged),
      completedAt: manual ? task.completedAt : new Date().toISOString()
    } : task);
    if (manual) {
      next.pendingUserInput = {
        kind: 'qa-manual',
        stage: 'qa',
        taskId: next.currentTaskId,
        questions: result.manualChecks,
        response: null,
        requestedAt: new Date().toISOString()
      };
      next.currentStage = 'qa';
    } else {
      next.currentStage = 'integration';
    }
  } else if (stage === 'integration') {
    validateSourceOfTruthEvidence(next, stage, result);
    const task = currentTask(session) || next.taskLedger.find((t) => t.id === next.currentTaskId);
    const paths = task ? task.filesChanged : [...new Set(next.taskLedger.flatMap((t) => t.filesChanged))];
    if (task && task.qaFingerprint && fingerprintPaths(repo, task.filesChanged) !== task.qaFingerprint) {
      throw new Error(`Task ${task.id} changed during integration inspection.`);
    }
    const commit = commitValidatedPaths(repo, paths, result.commitMessage);
    if (task) {
      task.integration = { ...commit, integrated: commit.committed || commit.reason === 'no_changes', runId: run.runId, evidence: result.evidence };
      if (!task.completedAt) task.completedAt = new Date().toISOString();
    }
    next.integration = { ...commit, integrated: commit.committed || commit.reason === 'no_changes', runId: run.runId, evidence: result.evidence };
    const unfinished = next.taskLedger.some((t) => t.status !== 'qa-passed' || !integrationSucceeded(t));
    next.currentTaskId = null;
    if (unfinished) {
      next.currentStage = 'implementation';
    } else {
      next.completedStages = [...new Set([...next.completedStages, 'implementation', 'code-review', 'qa', 'integration'])];
      next.status = 'READY_TO_COMPLETE';
    }
  }
  return writeSession(repo, next);
}

const TRIAGE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'i', 'if', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'out', 'pass', 'that', 'the',
  'this', 'to', 'with', 'task', 'tasks', 'test', 'tests', 'two', 'four', 'only', 'feel',
  'resolved', 'should', 'would', 'could', 'current', 'future'
]);

function wordsForScope(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])]
    .filter((word) => !TRIAGE_STOP_WORDS.has(word));
}

function taskScopeText(task) {
  return [
    task?.id,
    task?.title,
    task?.description,
    ...(task?.acceptanceCriteria || []),
    ...(task?.blackBoxTestPlan || []).flatMap((test) => [test.name, test.action, test.expected])
  ].filter(Boolean).join(' ');
}

function overlapCount(aWords, bWords) {
  const b = new Set(bWords);
  return aWords.filter((word) => b.has(word)).length;
}

function manualQaFragments(response) {
  return String(response || '')
    .split(/\n|[.;]|\bbut\b|\bhowever\b/i)
    .map((fragment) => fragment.trim().replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .filter((fragment) => !/^pass$/i.test(fragment));
}

function taskNumberReferenced(fragment) {
  const match = String(fragment || '').match(/\btask\s*#?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function hasManualQaFailureIntent(response) {
  return /\b(fail|failed|broken|bug|error|issue|problem|fix|incorrect|not working|does not|doesn't|cannot|can't|unresolved|remaining|only\s+\w+\s+out\s+of)\b/i.test(response);
}

function triageManualQaResponse(session, task, response) {
  const taskIndex = session.taskLedger.findIndex((item) => item.id === task.id);
  const currentTaskNumber = taskIndex >= 0 ? taskIndex + 1 : null;
  const futureTasks = session.taskLedger
    .map((item, index) => ({ ...item, taskNumber: index + 1, scopeWords: wordsForScope(taskScopeText(item)) }))
    .filter((item, index) => index > taskIndex && !['qa-passed', 'integrated', 'completed'].includes(item.status));
  const currentWords = wordsForScope(taskScopeText(task));
  const fragments = manualQaFragments(response);
  const currentFailures = [];
  const futureObservations = [];
  const ambiguous = [];

  for (const fragment of fragments) {
    const fragmentWords = wordsForScope(fragment);
    if (!fragmentWords.length && !hasManualQaFailureIntent(fragment)) continue;

    const referencedNumber = taskNumberReferenced(fragment);
    const explicitFuture = /\bfuture task\b|\bfuture-task\b|\blater task\b|\blater\b|\bout(?:side)? of scope\b|\bnot (?:for )?(?:this|current) task\b/i.test(fragment)
      || (referencedNumber != null && referencedNumber !== currentTaskNumber);
    const explicitCurrent = /\bcurrent task\b|\bthis task\b|\bin scope\b/i.test(fragment)
      || (referencedNumber != null && referencedNumber === currentTaskNumber);
    const futureScores = futureTasks
      .map((futureTask) => ({ taskId: futureTask.id, taskTitle: futureTask.title, taskNumber: futureTask.taskNumber, score: overlapCount(fragmentWords, futureTask.scopeWords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const bestFuture = futureScores[0] || null;
    const currentScore = overlapCount(fragmentWords, currentWords);

    if (explicitFuture && !explicitCurrent) {
      futureObservations.push({ text: fragment, matchedTaskId: bestFuture?.taskId || null, matchedTaskTitle: bestFuture?.taskTitle || null, reason: bestFuture ? `Matched future task ${bestFuture.taskNumber}` : 'User identified this as future or out-of-scope work.' });
    } else if (explicitCurrent || currentScore > (bestFuture?.score || 0) + 1) {
      currentFailures.push({ text: fragment, reason: explicitCurrent ? 'User identified this as current-task feedback.' : 'Matched current task acceptance criteria more strongly than future tasks.' });
    } else if (bestFuture && bestFuture.score > currentScore + 1) {
      futureObservations.push({ text: fragment, matchedTaskId: bestFuture.taskId, matchedTaskTitle: bestFuture.taskTitle, reason: `Matched future task ${bestFuture.taskNumber} more strongly than current task.` });
    } else if (hasManualQaFailureIntent(fragment)) {
      ambiguous.push({ text: fragment, reason: 'Could not confidently match this feedback to current or future task scope.' });
    }
  }

  if (!currentFailures.length && !futureObservations.length && !ambiguous.length && hasManualQaFailureIntent(response)) {
    ambiguous.push({ text: response.trim(), reason: 'Manual QA response indicates a problem but no scope match was found.' });
  }

  const decision = ambiguous.length
    ? 'clarify'
    : currentFailures.length
    ? 'rework'
    : futureObservations.length
    ? 'defer'
    : 'clarify';
  return { decision, currentFailures, futureObservations, ambiguous };
}

export function confirmManualQa(repo, response) {
  const session = readSession(repo);
  const pending = session?.pendingUserInput;
  if (!session || !['qa-manual', 'qa-manual-triage'].includes(pending?.kind) || pending.response != null) {
    throw new Error('No QA manual validation is awaiting user confirmation.');
  }
  const task = session.taskLedger.find((item) => item.id === pending.taskId);
  if (!task || task.status !== 'qa-awaiting-manual') throw new Error('The QA manual validation task is no longer active.');

  const trimmedResponse = response.trim();
  const answeredAt = new Date().toISOString();
  const answeredManualQa = { ...pending, response: trimmedResponse, answeredAt };
  const manualQaHistory = [...(session.manualQaHistory || []), answeredManualQa];

  if (/^pass$/i.test(trimmedResponse)) {
    const next = {
      ...session,
      pendingUserInput: null,
      manualQaHistory,
      currentStage: 'integration',
      taskLedger: session.taskLedger.map((item) => item.id === task.id
        ? {
          ...item,
          status: 'qa-passed',
          qa: { ...item.qa, manualValidationResponse: trimmedResponse },
          qaFailure: null,
          completedAt: new Date().toISOString()
        }
        : item)
    };
    return writeSession(repo, next);
  }

  const triageInput = pending.kind === 'qa-manual-triage'
    ? `${pending.originalResponse || ''}\nClarification: ${trimmedResponse}`
    : trimmedResponse;
  const triage = triageManualQaResponse(session, task, triageInput);

  if (triage.decision === 'clarify') {
    return writeSession(repo, {
      ...session,
      manualQaHistory,
      pendingUserInput: {
        kind: 'qa-manual-triage',
        stage: 'qa',
        taskId: task.id,
        questions: [
          `I could not determine whether your manual QA feedback is a current-task failure or future-task observation.`,
          `Current task: ${task.title}. Current acceptance criteria: ${(task.acceptanceCriteria || []).join('; ')}`,
          `Reply with "current task failure: <issue>" to send it back to implementation, "future task observation: <issue>" to defer it, or exact "PASS" if the current task is acceptable.`
        ],
        response: null,
        requestedAt: new Date().toISOString(),
        originalResponse: triageInput,
        triage
      },
      currentStage: 'qa'
    });
  }

  const deferredObservations = triage.futureObservations.length
    ? [...(session.deferredManualQaObservations || []), {
      taskId: task.id,
      response: triageInput,
      observations: triage.futureObservations,
      createdAt: answeredAt
    }]
    : (session.deferredManualQaObservations || []);

  const hasCurrentFailures = triage.currentFailures.length > 0;
  const qaFailure = hasCurrentFailures
    ? {
      outcome: 'FAIL',
      summary: `Manual QA failed for current task: ${triage.currentFailures.map((item) => item.text).join(' | ')}`,
      deferredObservations: triage.futureObservations
    }
    : null;

  const next = {
    ...session,
    pendingUserInput: null,
    manualQaHistory,
    deferredManualQaObservations: deferredObservations,
    currentStage: hasCurrentFailures ? 'implementation' : 'integration',
    taskLedger: session.taskLedger.map((item) => item.id === task.id
      ? {
        ...item,
        status: hasCurrentFailures ? 'needs-rework' : 'qa-passed',
        qa: {
          ...item.qa,
          manualValidationResponse: trimmedResponse,
          manualValidationTriage: triage
        },
        qaFailure,
        completedAt: hasCurrentFailures ? null : new Date().toISOString()
      }
      : item)
  };
  return writeSession(repo, next);
}

export function confirmHumanReview(repo, response) {
  const session = readSession(repo);
  const pending = session?.pendingUserInput;
  if (!session || !['prd-review', 'trd-review'].includes(pending?.kind) || pending.response != null) {
    throw new Error('No PRD/TRD human review is awaiting user confirmation.');
  }
  const trimmedResponse = response.trim();
  const approved = /^approved$/i.test(trimmedResponse);
  const answeredAt = new Date().toISOString();
  const answeredReview = { ...pending, response: trimmedResponse, answeredAt, approved };
  const reviewHistory = [...(session.humanReviewHistory || []), answeredReview];

  if (pending.kind === 'prd-review') {
    return writeSession(repo, {
      ...session,
      pendingUserInput: approved ? null : answeredReview,
      humanReviewHistory: reviewHistory,
      completedStages: approved ? [...new Set([...session.completedStages, 'prd-review'])] : session.completedStages,
      currentStage: approved ? 'architecture' : 'intake',
      lastFailure: approved ? null : `PRD changes requested by user: ${trimmedResponse}`
    });
  }

  if (approved && session.taskLedger?.length && !session.stageEvidence['qa-planning']?.result) {
    const reason = 'The legacy TRD did not contain a QA-authored test plan. QA Test Planning and a new TRD review are required before implementation.';
    appendEvent(repo, { type: 'qa_test_planning_migration', reason });
    return writeSession(repo, {
      ...session,
      pendingUserInput: null,
      humanReviewHistory: reviewHistory,
      completedStages: (session.completedStages || []).filter((stage) => !['qa-planning', 'critical-review', 'trd-review'].includes(stage)),
      currentStage: 'qa-planning',
      phasePlan: phasePlanWithQaPlanning(session.phasePlan),
      currentTaskId: null,
      lastFailure: reason
    });
  }

  return writeSession(repo, {
    ...session,
    pendingUserInput: approved ? null : answeredReview,
    humanReviewHistory: reviewHistory,
    completedStages: approved ? [...new Set([...session.completedStages, 'trd-review'])] : session.completedStages,
    currentStage: approved ? 'environment-readiness' : 'planning',
    phasePlan: approved ? phasePlanWithEnvironmentReadiness(session.phasePlan) : session.phasePlan,
    currentTaskId: null,
    taskLedger: approved ? session.taskLedger : [],
    lastFailure: approved ? null : `TRD changes requested by user: ${trimmedResponse}`
  });
}

export const SPECIALIST_TIMEOUT_SECONDS = 60 * 60;

export function normalizeTimeoutSeconds(value) {
  if (value !== undefined && !Number.isFinite(Number(value))) {
    throw new Error('timeout_seconds must be a finite number.');
  }
  return SPECIALIST_TIMEOUT_SECONDS;
}

function implementationRetryContext(repo, session, assignment, errorMessage) {
  const task = currentTask(session);
  const dependencyFiles = [...new Set(dependencyExistingFiles(session, task, repo))];
  const knownFiles = [...new Set([...(task?.filesChanged || []), ...dependencyFiles])].filter(Boolean);
  const knownFilesText = knownFiles.length ? knownFiles.join(', ') : '(none recorded yet)';
  const history = currentTaskAttemptHistoryPromptView(task)
    .map((entry, index) => `${index + 1}. ${entry.stage}/${entry.agentId} ${entry.outcome || 'REJECTED'}: ${entry.rejection || entry.summary || 'no summary'}`)
    .join('\n') || 'No prior task attempts recorded.';
  return [
    'IMPLEMENTATION RETRY CHECKLIST - FOLLOW EXACTLY',
    `Previous response was rejected: ${errorMessage}`,
    `Known implementation/dependency files to inspect first: ${knownFilesText}`,
    'Do not return FAIL or BLOCKED just to inspect files. Inspect them with tools during this run.',
    'Do not return FAIL or BLOCKED claiming missing write/tool access. You have workspace-write access; use shell/node/python commands to inspect, write, and validate files.',
    'If the task is already implemented, verify it and return PASS with the existing file path in filesChanged.',
    'Required PASS gates:',
    '- Return exactly one JSON object, no Markdown, no prose.',
    '- outcome must be "PASS".',
    `- filesChanged must include the implementation file(s), usually: ${knownFilesText}`,
    '- validations must be a non-empty array.',
    '- evidence must explicitly say approved PRD and TRD source-of-truth material was checked.',
    '- For browser/UI/canvas/gameplay work, validations must include a browser startup smoke test using Playwright/Puppeteer/Chrome/Firefox/headless browser, with pageerror and console-error monitoring and zero/no errors reported.',
    `- Browser fallback rule: ${browserRuntimeFallbackGuidance()}`,
    'Recent task attempt history:',
    history,
    'Minimal JSON shape:',
    '{"outcome":"PASS","summary":"...","evidence":["Checked approved PRD and TRD source-of-truth material against this task.","..."],"filesChanged":["index.html"],"validations":[{"command":"...","result":"... pageerror and console error listeners reported zero errors ..."}]}'
  ].join('\n');
}

export async function advanceWorkflow({ repo, timeoutSeconds, model = null, coordinatorContext = '', expectedAgentId = null, runner = runAgent }) {
  const currentSession = readSession(repo);
  if (currentSession && currentSession.pendingUserInput && currentSession.pendingUserInput.response == null) {
    throw new Error('Workflow is blocked awaiting user input. You MUST wait for the user to reply in chat, then call aiteam_update_session with their response before advancing.');
  }
  const assignment = getCurrentAssignment(repo);
  if (expectedAgentId && expectedAgentId !== assignment.agentId) {
    throw new Error(`Workflow gate rejected ${expectedAgentId}. Phase ${assignment.phase} requires ${assignment.agentId}.`);
  }
  const timeout = normalizeTimeoutSeconds(timeoutSeconds);
  const maxAttempts = Number.isInteger(runner.maxAttempts) ? runner.maxAttempts : runner === runAgent ? 2 : 1;
  let retryContext = coordinatorContext;
  let lastError = null;
  let enforceImplementationSchema = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let currentSession = readSession(repo);
    if (!currentSession || (currentSession.status !== 'ACTIVE' && currentSession.status !== 'BLOCKED')) {
      throw new Error(`Cannot advance ${assignment.stage}: the AITEAM session is no longer active.`);
    }
    if (currentSession.status === 'BLOCKED') {
      currentSession = writeSession(repo, { ...currentSession, status: 'ACTIVE', blockedReason: null });
    }
    const activeRun = { agentId: assignment.agentId, role: assignment.role, stage: assignment.stage, attempt, ownerPid: process.pid, startedAt: new Date().toISOString() };
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
        model,
        enforceSchema: enforceImplementationSchema
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
      let result;
      try {
        result = parseStageResult(assignment.stage, run.stdout);
      } catch (error) {
        const recovered = recoverImplementationProseResult(repo, readSession(repo), assignment, run.stdout);
        if (recovered) {
          result = recovered;
          appendEvent(repo, { type: 'implementation_result_recovered', stage: assignment.stage, agentId: assignment.agentId, runId: run.runId });
        } else if (isStructuredFormattingError(error)) {
          const repaired = await tryFormatOnlyRepair({
            repo,
            assignment,
            run,
            runner,
            timeoutMs: timeout * 1000,
            model
          });
          if (!repaired) throw error;
          result = repaired.result;
        } else {
          throw error;
        }
      }
      const session = applyResult(repo, readSession(repo), assignment, result, run);
      appendEvent(repo, {
        type: 'workflow_stage_result',
        stage: assignment.stage,
        agentId: assignment.agentId,
        outcome: result.outcome,
        summary: result.summary,
        evidence: result.evidence || [],
        runId: run.runId,
        attempt
      });
      return { assignment, result, run, session, workflow: workflowStatus(session, repo) };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        let retrySession = readSession(repo);
        retrySession = appendTaskAttemptHistory(retrySession, assignment.session.currentTaskId, {
          at: new Date().toISOString(),
          stage: assignment.stage,
          agentId: assignment.agentId,
          runId: run.runId,
          outcome: 'REJECTED',
          summary: '',
          rejection: String(error?.message || error)
        });
        writeSession(repo, { ...retrySession, activeRun: null, lastFailure: String(error?.message || error) });
        appendEvent(repo, { type: 'workflow_stage_retry', stage: assignment.stage, agentId: assignment.agentId, attempt, error: String(error?.message || error), runId: run.runId });
        if (assignment.stage === 'implementation') enforceImplementationSchema = true;
        retryContext = assignment.stage === 'implementation'
          ? `${coordinatorContext}\n\n${implementationRetryContext(repo, retrySession, assignment, error.message)}`
          : assignment.stage === 'qa'
          ? `${coordinatorContext}\n\nQA RESULT REJECTED: ${error.message}\nExecute suitable black-box commands now. You decide the tools based on the observable interface; no specific framework is mandatory. Record every executed command and actual result in automationAttempts. Do not claim attempts only in prose. Return ONLY one valid JSON object matching the assignment schema.`
          : assignment.stage === 'intake'
          ? `${coordinatorContext}\n\nINTAKE RESULT REJECTED: ${error.message}\nAsk only concrete unresolved material clarification questions. If the user's pending answers resolve every material question, incorporate them and return PASS with userConfirmed true. Do not ask for generic confirmation of the complete requirements; PRD Review owns explicit document approval. Return ONLY one valid JSON object matching the assignment schema.`
          : `${coordinatorContext}\n\nThe previous specialist response was rejected: ${error.message}\nReturn ONLY one valid JSON object matching the assignment schema. Do not use Markdown, prose, or code fences.`;
        continue;
      }
      let rejectedSession = readSession(repo);
      rejectedSession = appendTaskAttemptHistory(rejectedSession, assignment.session.currentTaskId, {
        at: new Date().toISOString(),
        stage: assignment.stage,
        agentId: assignment.agentId,
        runId: run.runId,
        outcome: 'REJECTED',
        summary: '',
        rejection: String(error?.message || error)
      });
      writeSession(repo, { ...rejectedSession, activeRun: null, lastFailure: String(error?.message || error) });
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
    if (!integrationSucceeded(task) && fingerprintPaths(repo, task.filesChanged) !== task.qaFingerprint) {
      throw new Error(`Cannot complete: task ${task.id} changed after QA approval.`);
    }
  }
  const completed = writeSession(repo, { ...session, status: 'COMPLETE', completedAt: new Date().toISOString(), currentStage: 'complete', activeRun: null });
  appendEvent(repo, { type: 'session_completed', sessionId: completed.id, head: completed.integration.head });
  return completed;
}
