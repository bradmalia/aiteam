import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advanceWorkflow, completeWorkflow, getCurrentAssignment, normalizeTimeoutSeconds, parseStageResult } from '../src/workflow.mjs';
import { newSession, readSession, writeSession } from '../src/state.mjs';
import { callTool } from '../src/server.mjs';
import { getAgent } from '../src/registry.mjs';

function createRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-workflow-'));
  const testGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-global-specialists-'));
  process.env.AITEAM_GLOBAL_SPECIALIST_DIR = testGlobalDir;
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AITEAM Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'aiteam@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'Initial commit']);
  return repo;
}

function result(outcome, extra = {}) {
  const intakeDefaults = Object.hasOwn(extra, 'requirements') || Object.hasOwn(extra, 'acceptanceCriteria')
    ? {
        goals: ['Deliver the requested user-visible outcome.'],
        targetUsers: ['Primary user described by the request.'],
        userStories: ['As a user, I want the requested behavior so that I can accomplish the stated goal.'],
        mvpScope: ['Deliver the minimum useful version of the requested behavior.'],
        outOfScope: ['No additional features beyond the confirmed request.'],
        assumptions: ['Use sensible defaults where the user did not specify details.'],
        constraints: ['No additional constraints identified.'],
        nonFunctionalRequirements: ['Keep the result reliable and usable for the target user.'],
        successMetrics: ['Acceptance criteria pass through observable behavior.'],
        risks: ['No material risks identified.']
      }
    : {};
  const architectureDefaults = Object.hasOwn(extra, 'design') || Object.hasOwn(extra, 'hasUserInterface') || Object.hasOwn(extra, 'specialistNeeds')
    ? {
        context: ['System boundary and primary actors are identified.'],
        constraints: ['No additional architecture constraints identified.'],
        qualityAttributes: [{ name: 'Usability', scenario: 'A target user completes the primary flow.', measure: 'Primary acceptance criteria pass.' }],
        solutionStrategy: ['Use a minimal architecture aligned with the confirmed scope.'],
        buildingBlocks: [{ name: 'Application module', responsibility: 'Deliver the requested behavior.', interfaces: ['Public user-facing or runtime interface.'] }],
        runtimeScenarios: [{ name: 'Primary flow', trigger: 'User or caller invokes the requested behavior.', flow: ['Receive input', 'Process request', 'Return observable output'] }],
        deploymentView: ['Run in the repository-supported local/runtime environment.'],
        crossCuttingConcepts: ['Use existing project conventions for error handling, validation, and tests.'],
        architectureDecisions: [{ decision: 'Use existing project conventions.', optionsConsidered: ['Existing conventions', 'Introduce new architecture'], rationale: 'Minimizes scope and risk.', consequences: ['Implementation remains narrow and compatible.'] }],
        risks: ['No material architectural risks identified.']
      }
    : {};
  const uiDefaults = Object.hasOwn(extra, 'theme') || Object.hasOwn(extra, 'screens') || Object.hasOwn(extra, 'designTokens')
    ? {
        userFlows: [{ name: 'Primary flow', actor: 'Target user', goal: 'Complete the requested UI task.', steps: ['Open the interface', 'Use the primary control', 'Observe the expected result'] }],
        usabilityRisks: ['Primary controls may be hard to discover without clear hierarchy.'],
        accessibilityHeuristics: ['Keyboard focus must be visible and follow the primary task order.'],
        validationHypotheses: [{ hypothesis: 'A target user can complete the primary UI flow.', validationMethod: 'Run a browser or human-observed task flow check.', successSignal: 'The expected UI result is observable without confusion.' }]
      }
    : {};
  const recruitingDefaults = Object.hasOwn(extra, 'specialist')
    ? {
        gapJustification: ['The architecture identified a concrete capability not covered by existing specialists.'],
        existingSpecialistAssessment: ['Built-in specialists do not provide sufficient coverage for the requested framework.'],
        evaluationCriteria: ['The specialist must preserve scope, use authoritative documentation, and run relevant validation.']
      }
    : {};
  return JSON.stringify({ outcome, summary: `${outcome} result`, evidence: outcome === 'PASS' ? ['Observed repository evidence'] : [], ...intakeDefaults, ...architectureDefaults, ...uiDefaults, ...recruitingDefaults, ...extra });
}

function queuedRunner(repo, outputs) {
  let index = 0;
  return async ({ agentId }) => {
    const item = outputs[index++];
    if (!item) throw new Error(`Unexpected runner call ${index} for ${agentId}`);
    if (item.write) fs.writeFileSync(path.join(repo, item.write.path), item.write.content);
    if (item.remove) fs.rmSync(path.join(repo, item.remove), { force: true, recursive: true });
    return {
      runId: `run-${index}`,
      agentId,
      role: agentId,
      exitCode: item.exitCode ?? 0,
      timedOut: item.timedOut ?? false,
      completedAt: new Date().toISOString(),
      stdout: item.stdout,
      stderr: '',
      stdoutPath: '',
      stderrPath: '',
      metaPath: ''
    };
  };
}

async function advanceWithHumanApprovals(args) {
  const result = await advanceWorkflow(args);
  const session = readSession(args.repo);
  if (['prd-review', 'trd-review'].includes(session?.pendingUserInput?.kind) && session.pendingUserInput.response == null) {
    await callTool('aiteam_update_session', { repository: args.repo, patch: { pendingUserInput: 'approved' } });
  }
  return result;
}

test('server-owned workflow enforces every gate and commits only QA-approved paths', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a small Python feature');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user work\n');
  execFileSync('git', ['-C', repo, 'add', 'unrelated.txt']);

  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Add feature'], acceptanceCriteria: ['Feature is validated'], questions: [] }) },
    { stdout: result('PASS', { design: ['Use one Python module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement feature', specialistId: 'python', acceptanceCriteria: ['app.py exists'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'compile', status: 'PASS', expected: 'Python module compiles successfully.', actual: 'Python module compiled successfully.', evidence: 'py_compile passed' }], automationAttempts: [], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Implement validated feature' }) }
  ]);

  for (let i = 0; i < 8; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  assert.equal(ready.status, 'READY_TO_COMPLETE');
  assert.equal(ready.taskLedger[0].status, 'qa-passed');
  assert.equal(ready.integration.committed, true);
  assert.match(execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }), /app\.py/);
  assert.doesNotMatch(execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }), /unrelated\.txt/);
  assert.match(execFileSync('git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' }), /^A  unrelated\.txt$/m);
  assert.doesNotMatch(execFileSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8' }), /^\.aiteam/m);

  const completed = completeWorkflow(repo);
  assert.equal(completed.status, 'COMPLETE');
});

test('UI projects run a validated UI-design stage and propagate its result to Planning', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a browser UI');
  const calls = [];
  const queued = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Browser UI'], acceptanceCriteria: ['UI is responsive'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { design: ['Browser architecture'], hasUserInterface: true, specialistNeeds: [] }) },
    { stdout: result('PASS', {
      theme: { palette: ['background #111111'], typography: ['body 16px sans-serif'], spacing: ['base 8px'] },
      screens: [{ name: 'Game', layout: 'Responsive single-column layout', components: ['Canvas', 'Score'], interactionStates: ['focused', 'paused'] }],
      designTokens: ['color-background: #111111']
    }) },
    { stdout: result('PASS', { tasks: [{ id: 'ui-task', title: 'UI', description: 'Implement UI', specialistId: 'python', acceptanceCriteria: ['UI is responsive'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'responsive', status: 'PASS', expected: 'The UI responds correctly in the tested viewport.', actual: 'The headless browser observed the responsive UI behavior.', evidence: 'validated' }], automationAttempts: [{ command: 'playwright --version && node visual-check.mjs', result: 'Headless browser validated responsive UI', covers: ['responsive UI'], fallbackReason: '' }], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Implement responsive UI' }) }
  ]);
  const runner = async (args) => {
    calls.push(args);
    return queued(args);
  };

  for (let index = 0; index < 9; index += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  const planningCall = calls.find((call) => call.stage === 'planning');
  assert.equal(ready.status, 'READY_TO_COMPLETE');
  assert.ok(ready.phasePlan.includes('ui-design'));
  assert.ok(ready.completedStages.includes('ui-design'));
  assert.equal(ready.stageEvidence['ui-design'].result.designTokens[0], 'color-background: #111111');
  assert.match(planningCall.context, /color-background: #111111/);
});

test('already-implemented tasks complete successfully when Integration has no Git changes', async () => {
  const repo = createRepository();
  newSession(repo, 'Verify the existing README');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['README exists'], acceptanceCriteria: ['README is valid'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { design: ['Existing documentation'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'verify-readme', title: 'Verify README', description: 'Verify existing file', specialistId: 'python', acceptanceCriteria: ['README is valid'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['README.md'], validations: [{ command: 'test -s README.md', result: 'passed' }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'README', status: 'PASS', expected: 'README is present and non-empty.', actual: 'README was present and non-empty.', evidence: 'file is non-empty' }], automationAttempts: [], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Verify existing README' }) }
  ]);

  for (let index = 0; index < 8; index += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  assert.equal(ready.status, 'READY_TO_COMPLETE');
  assert.equal(ready.taskLedger[0].integration.reason, 'no_changes');
  assert.equal(ready.taskLedger[0].integration.integrated, true);
  assert.equal(completeWorkflow(repo).status, 'COMPLETE');
});

test('PRD and TRD human review gates generate HTML artifacts and route feedback', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a reviewed feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Reviewed feature'], acceptanceCriteria: ['Feature is approved'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { requirements: ['Reviewed feature v2'], acceptanceCriteria: ['Revised feature is approved'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: true, specialistNeeds: [] }) },
    { stdout: result('PASS', {
      theme: { palette: ['green'], typography: ['mono'], spacing: ['8px'] },
      screens: [
        { name: 'Gameplay HUD', layout: 'Canvas court with player and AI paddles, score bar, ball tracer, and sound toggle.', components: ['Score bar', 'Player paddle', 'AI paddle', 'Ball tracer', 'Sound toggle'], interactionStates: ['mouse control', 'keyboard control'] },
        { name: 'Victory Screen', layout: 'Centered overlay over dimmed game court.', components: ['Winner title', 'Final score', 'Play Again button', 'Change Difficulty button'], interactionStates: ['focused', 'hover'] }
      ],
      designTokens: ['color-accent: green']
    }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'runtime behavior', action: 'Run the feature through the public interface.', expected: 'The expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement revised plan', specialistId: 'python', acceptanceCriteria: ['Works after revision'], dependencies: [], blackBoxTestPlan: [{ name: 'revised runtime behavior', action: 'Run the revised feature through the public interface.', expected: 'The revised expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) }
  ]);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  let session = readSession(repo);
  assert.equal(session.currentStage, 'prd-review');
  assert.equal(session.pendingUserInput.kind, 'prd-review');
  assert.match(session.pendingUserInput.artifact.url, /\/artifacts\/prd\.html$/);
  assert.match(session.pendingUserInput.artifact.fileUrl, /^file:\/\/.*\/prd\.html$/);
  assert.match(session.pendingUserInput.questions.join('\n'), /local file instead: file:\/\//);
  const prdHtml = fs.readFileSync(session.pendingUserInput.artifact.path, 'utf8');
  assert.match(prdHtml, /Product Requirements Document/);
  assert.match(prdHtml, /Problem To Solve/);
  assert.match(prdHtml, /PRD-R1/);
  assert.match(prdHtml, /Open Questions/);
  assert.match(prdHtml, /If anything is missing or wrong, describe the change you want before approving/);
  assert.doesNotMatch(prdHtml, /high school/i);

  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Please add a clearer approval criterion.' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'intake');
  assert.equal(session.pendingUserInput.kind, 'prd-review');
  assert.match(session.pendingUserInput.response, /clearer approval/);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'approved' } });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'trd-review');
  assert.equal(session.pendingUserInput.kind, 'trd-review');
  assert.match(session.pendingUserInput.artifact.url, /\/artifacts\/trd\.html$/);
  assert.match(session.pendingUserInput.artifact.fileUrl, /^file:\/\/.*\/trd\.html$/);
  assert.match(session.pendingUserInput.questions.join('\n'), /local file instead: file:\/\//);
  const trdHtml = fs.readFileSync(session.pendingUserInput.artifact.path, 'utf8');
  assert.match(trdHtml, /Testing Plan/);
  assert.match(trdHtml, /System Boundary And Runtime Flows/);
  assert.match(trdHtml, /Data, Interfaces, And Dependencies/);
  assert.match(trdHtml, /Security, Privacy, And Operations/);
  assert.match(trdHtml, /Requirements-To-Work Traceability/);
  assert.match(trdHtml, /wireframe-gameplay/);
  assert.match(trdHtml, /wireframe-victory/);
  assert.match(trdHtml, /class="task-card"/);
  assert.match(trdHtml, /class="test-group"/);
  assert.match(trdHtml, /class="flow-card"/);
  assert.doesNotMatch(trdHtml, /<h2>Implementation Plan<\/h2><table/);
  assert.doesNotMatch(trdHtml, /<h2>Testing Plan<\/h2><table/);
  assert.match(trdHtml, /If the plan does not match what you approved in the PRD/);
  assert.doesNotMatch(trdHtml, /high school/i);

  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Please revise the testing plan.' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'planning');
  assert.equal(session.taskLedger.length, 0);
  assert.equal(session.pendingUserInput.kind, 'trd-review');

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'critical-review');
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'trd-review');
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'approved' } });
  assert.equal(readSession(repo).currentStage, 'implementation');
});

test('review failure routes the same task back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('FAIL', { findings: [{ id: 'F1', severity: 'MAJOR', location: 'app.py', impact: 'Wrong value', recommendation: 'Fix it' }] }) }
  ]);
  for (let i = 0; i < 6; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.currentStage, 'implementation');
  assert.equal(session.currentTaskId, 'feature-task');
  assert.equal(session.taskLedger[0].status, 'needs-rework');
});

test('architecture capability gaps must pass through Recruiter provenance before use', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a Phaser game');
  const contract = 'Implement Phaser browser games using TypeScript. Inspect existing project conventions, limit edits to assigned tasks, run available validation, and return concrete evidence without committing.';
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Browser game'], acceptanceCriteria: ['Runs'], questions: [] }) },
    { stdout: result('PASS', { design: ['Phaser architecture'], hasUserInterface: false, specialistNeeds: [{ capability: 'Phaser', reason: 'No built-in web specialist', suggestedId: 'phaser-programmer' }] }) },
    { stdout: result('PASS', { specialist: { id: 'phaser-programmer', role: 'Phaser Programmer', sandbox: 'workspace-write', triggers: ['phaser'], capabilities: ['TypeScript', 'Phaser'], contract } }) }
  ]);
  await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'recruiting');
  await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.currentStage, 'planning');
  assert.equal(getAgent('phaser-programmer', repo).provenance, undefined, 'normalized public registry omits storage metadata');
  const raw = JSON.parse(fs.readFileSync(path.join(repo, '.aiteam', 'specialists', 'phaser-programmer.json'), 'utf8'));
  assert.equal(raw.provenance.source, 'recruiter');
  assert.equal(raw.provenance.runId, 'run-3');
});

test('planning recovers unresolved architecture specialist gaps before retrying planner', () => {
  const repo = createRepository();
  newSession(repo, 'Build a canvas game');
  const session = readSession(repo);
  writeSession(repo, {
    ...session,
    currentStage: 'planning',
    completedStages: ['intake', 'prd-review', 'architecture', 'ui-design', 'planning'],
    stageEvidence: {
      intake: { result: parseStageResult('intake', result('PASS', { requirements: ['Canvas game'], acceptanceCriteria: ['Runs'], questions: [], userConfirmed: true })) },
      architecture: { result: parseStageResult('architecture', result('PASS', {
        design: ['Use a browser canvas architecture'],
        hasUserInterface: true,
        specialistNeeds: [
          { capability: 'Canvas rendering and game loop', reason: 'No built-in browser game specialist exists.', suggestedId: 'web-game-programmer' }
        ]
      })) }
    },
    recruiterQueue: [],
    taskLedger: []
  });

  const assignment = getCurrentAssignment(repo);
  const recovered = readSession(repo);
  assert.equal(assignment.stage, 'recruiting');
  assert.equal(assignment.agentId, 'recruiter');
  assert.equal(recovered.currentStage, 'recruiting');
  assert.equal(recovered.resumeStage, 'planning');
  assert.equal(recovered.recruiterQueue[0].suggestedId, 'web-game-programmer');
  assert.ok(!recovered.completedStages.includes('planning'));
  assert.match(recovered.lastFailure, /Recovered unresolved architecture specialist gaps/);
});

test('recruiter must register the specialist id requested by the current architecture gap', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a canvas game');
  const session = readSession(repo);
  writeSession(repo, {
    ...session,
    currentStage: 'recruiting',
    resumeStage: 'planning',
    completedStages: ['intake', 'prd-review', 'architecture'],
    stageEvidence: {
      intake: { result: parseStageResult('intake', result('PASS', { requirements: ['Canvas game'], acceptanceCriteria: ['Runs'], questions: [], userConfirmed: true })) },
      architecture: { result: parseStageResult('architecture', result('PASS', {
        design: ['Use a browser canvas architecture'],
        hasUserInterface: true,
        specialistNeeds: [
          { capability: 'Canvas rendering and game loop', reason: 'No built-in browser game specialist exists.', suggestedId: 'web-game-programmer' }
        ]
      })) }
    },
    recruiterQueue: [
      { capability: 'Canvas rendering and game loop', reason: 'No built-in browser game specialist exists.', suggestedId: 'web-game-programmer' }
    ]
  });
  const contract = 'Implement only audio work for this workflow. This intentionally mismatched specialist contract is long enough for schema validation.';
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { specialist: { id: 'web-audio-programmer', role: 'Web Audio Programmer', sandbox: 'workspace-write', triggers: ['audio'], capabilities: ['Web Audio API'], contract } }) }
  ]);

  await assert.rejects(
    () => advanceWorkflow({ repo, runner, timeoutSeconds: 300 }),
    /proposed web-audio-programmer but current architecture gap requires web-game-programmer/
  );
});

test('post-QA path changes invalidate approval and route back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'check', status: 'PASS', expected: 'Feature behavior works.', actual: 'Feature behavior was observed working.', evidence: 'observed' }], automationAttempts: [], manualChecks: [] }) }
  ]);
  for (let i = 0; i < 7; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'integration');
  fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 2\n');
  await assert.rejects(advanceWorkflow({ repo, runner, timeoutSeconds: 300 }), /changed after QA approval/);
  const session = readSession(repo);
  assert.equal(session.currentStage, 'implementation');
  assert.equal(session.taskLedger[0].status, 'needs-rework');
});

test('QA manual validation pauses the workflow until the user confirms it', async () => {
  const repo = createRepository();
  newSession(repo, 'Build browser feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Browser feature'], acceptanceCriteria: ['Looks correct'], questions: [] }) },
    { stdout: result('PASS', { design: ['Browser module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'browser-task', title: 'Browser feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Looks correct'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS_WITH_MANUAL_VALIDATION', { evidence: ['Headless runtime checks passed; subjective visual polish remains'], checks: [{ name: 'browser', status: 'PASS', expected: 'The browser page loads and exposes the expected canvas.', actual: 'Playwright opened the page and confirmed the canvas exists.', evidence: 'Playwright opened the page and confirmed the canvas exists' }], automationAttempts: [{ command: 'playwright --version && node browser-smoke.mjs', result: 'Headless browser loaded the page and found canvas element', covers: ['Looks correct'], fallbackReason: 'Final visual aesthetics still require human judgment' }], manualChecks: ['Open the browser game and verify the canvas renders.'] }) }
  ]);
  for (let i = 0; i < 7; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  let session = readSession(repo);
  assert.equal(session.currentStage, 'qa');
  assert.equal(session.taskLedger[0].status, 'qa-awaiting-manual');
  assert.equal(session.pendingUserInput.kind, 'qa-manual');
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Confirmed: the browser game renders correctly.' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'integration');
  assert.equal(session.taskLedger[0].status, 'qa-passed');
  assert.match(session.taskLedger[0].qa.manualValidationResponse, /renders correctly/);
  assert.equal(session.pendingUserInput, null);
  assert.equal(session.manualQaHistory.length, 1);
  assert.match(session.manualQaHistory[0].response, /renders correctly/);
});

test('specialist prompts exclude stale downstream QA history after rework', () => {
  const repo = createRepository();
  const session = newSession(repo, 'Repair browser feature');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: {
      ...session.stageEvidence,
      intake: { result: { userConfirmed: true } }
    },
    currentTaskId: 'browser-task',
    taskLedger: [{
      id: 'browser-task',
      title: 'Browser feature',
      description: 'Repair the browser feature',
      specialistId: 'python',
      acceptanceCriteria: ['Current source renders correctly'],
      dependencies: [],
      status: 'review-passed',
      filesChanged: ['app.py'],
      validations: [{ command: 'python -m py_compile app.py', result: 'passed' }],
      review: { outcome: 'PASS', summary: 'Current review passed' },
      qa: { outcome: 'PASS_WITH_MANUAL_VALIDATION', manualValidationResponse: 'STALE_MANUAL_FAILURE' },
      qaFailure: null
    }]
  });

  const assignment = getCurrentAssignment(repo);
  assert.equal(assignment.stage, 'qa');
  assert.match(assignment.task, /Current source renders correctly/);
  assert.doesNotMatch(assignment.task, /STALE_MANUAL_FAILURE/);
  assert.doesNotMatch(assignment.context, /STALE_MANUAL_FAILURE/);
  assert.doesNotMatch(assignment.context, /manualValidationResponse/);
});

test('invalid structured output and out-of-order agents cannot advance workflow', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  assert.throws(() => completeWorkflow(repo), /Cannot complete/);
  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [{ stdout: 'I analyzed it successfully.' }])
  }), /not valid JSON/);
  assert.equal(readSession(repo).currentStage, 'intake');

  await assert.rejects(callTool('aiteam_spawn_agent', {
    repository: repo,
    agent_id: 'python',
    task: 'Skip analysis and implement now'
  }), /requires analyst/);
  assert.equal(readSession(repo).currentStage, 'intake');

  await assert.rejects(callTool('aiteam_update_session', {
    repository: repo,
    patch: { currentStage: 'implementation' }
  }), /Server-owned session fields/);
});

test('implementation cannot pass when reported files are absent from the server workspace', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['missing.py'], validations: [{ command: 'test -f missing.py', result: 'reported passed' }] }) }
  ]);
  for (let i = 0; i < 4; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  await assert.rejects(advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 }), /did not write files to disk/);
  assert.equal(readSession(repo).currentStage, 'implementation');
});

test('missing implemented files reported by validation route directly back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'test -f app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('BLOCKED', { summary: 'Cannot complete code review because app.py was not found on disk.' }), remove: 'app.py' }
  ]);
  for (let i = 0; i < 5; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.status, 'ACTIVE');
  assert.equal(session.currentStage, 'implementation');
  assert.equal(session.taskLedger[0].status, 'needs-rework');
  assert.match(session.taskLedger[0]['code-reviewFailure'].summary, /required implemented files are missing/);
});

test('implementation FAIL routes to BLOCKED with retry instructions instead of staying stuck', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'black-box smoke', action: 'Run the delivered behavior through its public interface.', expected: 'The planned acceptance criteria are observable as passing.', evidenceMethod: 'Runtime or public-interface test output.' }] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('FAIL', { summary: 'Cannot run the command due to insufficient sandbox permissions.' }) }
  ]);
  for (let i = 0; i < 4; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.status, 'BLOCKED');
  assert.match(session.blockedReason, /Implementation specialist returned FAIL/);
  assert.match(session.blockedReason, /NOT a real sandbox restriction/);
});


test('structured stage schemas and timeout bounds are enforced', () => {
  const awaiting = parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need clarification', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['What platform should we target?'], userConfirmed: false }));
  assert.equal(awaiting.outcome, 'AWAITING_USER');
  assert.equal(awaiting.userConfirmed, false);
  assert.throws(() => parseStageResult('intake', JSON.stringify({ outcome: 'PASS', summary: 'Incomplete intake', evidence: ['User asked for a feature'], requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [], userConfirmed: true })), /goals/);
  const intake = parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [], userConfirmed: true }));
  assert.equal(intake.goals[0], 'Deliver the requested user-visible outcome.');
  assert.equal(intake.successMetrics[0], 'Acceptance criteria pass through observable behavior.');
  assert.throws(() => parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: ['Still unclear'], userConfirmed: false })), /cannot PASS/i);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [] })), /non-empty array/);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] })), /blackBoxTestPlan/);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'source check', action: 'grep src/audio.js line 49', expected: 'Function should call toggleMute.', evidenceMethod: 'Source inspection.' }] }] })), /black-box test plan only/);
  const planned = parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'runtime behavior', action: 'Run the feature through the public interface.', expected: 'The expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }] }));
  assert.equal(planned.tasks[0].blackBoxTestPlan[0].action, 'Run the feature through the public interface.');
  assert.throws(() => parseStageResult('architecture', JSON.stringify({ outcome: 'PASS', summary: 'Old architecture', evidence: ['Observed repository evidence'], design: ['Module'], hasUserInterface: false, specialistNeeds: [] })), /context/);
  assert.throws(() => parseStageResult('architecture', result('PASS', { design: ['Module'], specialistNeeds: [] })), /hasUserInterface/);
  const architecture = parseStageResult('architecture', result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }));
  assert.equal(architecture.qualityAttributes[0].name, 'Usability');
  assert.equal(architecture.buildingBlocks[0].interfaces[0], 'Public user-facing or runtime interface.');
  assert.throws(() => parseStageResult('ui-design', JSON.stringify({ outcome: 'PASS', summary: 'Old UI design', evidence: ['Observed repository evidence'], theme: { palette: ['black'], typography: ['body'], spacing: ['8px'] }, screens: [{ name: 'Main', layout: 'One column', components: ['Button'], interactionStates: ['focused'] }], designTokens: ['color: black'] })), /userFlows/);
  assert.throws(() => parseStageResult('ui-design', result('PASS', { theme: { palette: [], typography: [], spacing: [] }, screens: [], designTokens: [] })), /must not be empty|non-empty array/);
  const uiDesign = parseStageResult('ui-design', result('PASS', { theme: { palette: ['black'], typography: ['body'], spacing: ['8px'] }, screens: [{ name: 'Main', layout: 'One column', components: ['Button'], interactionStates: ['focused'] }], designTokens: ['color: black'] }));
  assert.equal(uiDesign.userFlows[0].actor, 'Target user');
  assert.equal(uiDesign.validationHypotheses[0].successSignal, 'The expected UI result is observable without confusion.');
  assert.throws(() => parseStageResult('recruiting', JSON.stringify({ outcome: 'PASS', summary: 'Old recruiter', evidence: ['Observed repository evidence'], specialist: { id: 'x-programmer', role: 'X Programmer', sandbox: 'workspace-write', triggers: ['x'], capabilities: ['X'], contract: 'Implement X with enough detail to pass the minimum contract length and validation requirements.' } })), /gapJustification/);
  const recruited = parseStageResult('recruiting', result('PASS', { specialist: { id: 'x-programmer', role: 'X Programmer', sandbox: 'workspace-write', triggers: ['x'], capabilities: ['X'], contract: 'Implement X with enough detail to pass the minimum contract length and validation requirements.' } }));
  assert.match(recruited.evaluationCriteria[0], /specialist/);
  assert.throws(() => parseStageResult('implementation', result('PASS', { filesChanged: ['app.py'], validations: [] })), /validations must be a non-empty array/);
  assert.throws(() => parseStageResult('critical-review', result('PASS', { findings: [{ id: 'F1', severity: 'MAJOR', description: 'Material issue', recommendation: 'Repair it' }] })), /cannot PASS/);
  const failedCritical = parseStageResult('critical-review', result('FAIL', { findings: [{ id: 'F1', severity: 'MAJOR', description: 'Material issue', recommendation: 'Repair it' }], repairStage: 'planning' }));
  assert.equal(failedCritical.repairStage, 'planning');
  const passedCritical = parseStageResult('critical-review', result('PASS', { findings: [], repairStage: 'none' }));
  assert.equal(passedCritical.repairStage, 'none');
  assert.throws(() => parseStageResult('critical-review', result('PASS', { findings: [], repairStage: 'planning' })), /repairStage to none/);
  const qa = parseStageResult('qa', result('PASS', { checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }], automationAttempts: [], manualChecks: [] }));
  assert.equal(qa.checks[0].expected, 'The app starts.');
  assert.throws(() => parseStageResult('qa', result('PASS', { checks: [{ name: 'runtime smoke', status: 'PASS', evidence: 'Runtime command exited 0.' }], automationAttempts: [], manualChecks: [] })), /expected/);
  assert.throws(() => parseStageResult('qa', result('FAIL', { evidence: ['Runtime assertion failed.'], checks: [{ name: 'audio toggle', status: 'FAIL', expected: 'Audio should mute after clicking the toggle.', actual: 'src/audio.js line 49 should call toggleMute().', evidence: 'Source inspection found missing call.' }], automationAttempts: [], manualChecks: [] })), /black-box behavior only/);
  assert.equal(normalizeTimeoutSeconds(1), 3600);
  assert.equal(normalizeTimeoutSeconds(300), 3600);
  assert.equal(normalizeTimeoutSeconds(9000), 3600);
  assert.equal(normalizeTimeoutSeconds(undefined), 3600);
  assert.throws(() => normalizeTimeoutSeconds('not-a-number'), /finite number/);
});

test('Analyst Intake pauses for user answers and blocks Architecture until confirmation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a game');
  const runner = queuedRunner(repo, [
    { stdout: JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need platform decision', evidence: ['User requirements are incomplete'], requirements: [], acceptanceCriteria: [], questions: ['Should this be browser-based?'], userConfirmed: false }) },
    { stdout: result('PASS', { requirements: ['Browser game'], acceptanceCriteria: ['Runs in a browser'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { design: ['Use a browser game architecture'], hasUserInterface: false, specialistNeeds: [] }) }
  ]);

  const awaiting = await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(awaiting.session.status, 'ACTIVE');
  assert.equal(awaiting.session.currentStage, 'intake');
  assert.deepEqual(awaiting.session.pendingUserInput.questions, ['Should this be browser-based?']);
  await assert.rejects(callTool('aiteam_update_session', {
    repository: repo,
    patch: { currentStage: 'architecture' }
  }), /Server-owned session fields/);
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Yes, make it browser-based.' } });
  const intake = await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(intake.session.currentStage, 'prd-review');
  assert.equal(intake.session.pendingUserInput.kind, 'prd-review');
  assert.match(intake.session.pendingUserInput.artifact.url, /\/artifacts\/prd\.html$/);
  assert.match(intake.session.pendingUserInput.artifact.fileUrl, /^file:\/\/.*\/prd\.html$/);
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'approved' } });
  assert.equal(readSession(repo).currentStage, 'architecture');
  const architecture = await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(architecture.session.currentStage, 'planning');
});

test('aiteam_start auto-initializes git repository in fresh uninitialized directory', async () => {
  const uninitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-uninit-'));
  const runner = queuedRunner(uninitRepo, [
    { stdout: result('PASS', { requirements: ['Fresh repo feature'], acceptanceCriteria: ['Validated'], questions: [], userConfirmed: true }) }
  ]);
  const started = await callTool('aiteam_start', {
    repository: uninitRepo,
    request: 'Build feature in fresh directory',
    runner
  });
  assert.ok(fs.existsSync(path.join(uninitRepo, '.git')));
  assert.ok(started.content[0].text.includes('AITEAM'));
});


import { buildAgentPrompt } from '../src/registry.mjs';

test('implementation specialist prompt contains chunked-write instructions (heredoc truncation regression)', () => {
  // Regression: specialist tried to write a large file in one heredoc, hitting
  // the exec_command output token limit and silently truncating the file.
  // These assertions ensure the chunking instructions are present in the
  // specialist prompt without mutating the target repository's AGENTS.md.

  const repo = createRepository();
  const agent = getAgent('python', repo); // any workspace-write specialist
  const task = 'Implement feature X';
  const context = JSON.stringify({ request: 'test', currentTask: { id: 't1' } });
  const prompt = buildAgentPrompt(agent, task, context, 'implementation');

  // Must instruct chunked writing with append (>>) mode
  assert.ok(prompt.includes('AITEAM_EOF'), 'prompt must reference AITEAM_EOF heredoc marker');
  assert.ok(prompt.includes('>>'), 'prompt must include append (>>) mode for subsequent chunks');
  assert.ok(prompt.includes('wc -l'), 'prompt must instruct verification with wc -l after chunked write');
  assert.match(prompt, /reviewArtifacts\.prd/);
  assert.match(prompt, /reviewArtifacts\.trd/);
  assert.match(prompt, /source-of-truth/);

  // Must not allow single-heredoc writes for large files
  assert.ok(
    prompt.includes('chunk') || prompt.includes('truncat'),
    'prompt must warn about truncation or instruct chunking'
  );
});

test('aiteam_start does not create or modify repository AGENTS.md', async () => {
  const repo = createRepository();
  const agentsMdPath = path.join(repo, 'AGENTS.md');
  fs.writeFileSync(agentsMdPath, '# Project-specific instructions\n');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['R1'], acceptanceCriteria: ['AC1'], questions: [], userConfirmed: true }) }
  ]);
  await callTool('aiteam_start', { repository: repo, request: 'test', runner });

  assert.equal(fs.readFileSync(agentsMdPath, 'utf8'), '# Project-specific instructions\n');
});

test('an active-run lease is recovered immediately when its owner process exited', () => {
  const repo = createRepository();
  const session = newSession(repo, 'Recover interrupted work');
  writeSession(repo, {
    ...session,
    activeRun: {
      agentId: 'analyst',
      role: 'Analyst',
      stage: 'intake',
      attempt: 1,
      ownerPid: 2147483647,
      startedAt: new Date().toISOString()
    }
  });

  const assignment = getCurrentAssignment(repo);
  const recovered = readSession(repo);
  assert.equal(assignment.stage, 'intake');
  assert.equal(recovered.activeRun, null);
  assert.match(recovered.lastFailure, /owner process .* exited/);
});
