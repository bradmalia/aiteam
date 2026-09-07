import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advanceWorkflow, completeWorkflow, getCurrentAssignment, normalizeTimeoutSeconds, parseStageResult, processExists } from '../src/workflow.mjs';
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
  const hasStageEvidence = Object.hasOwn(extra, 'filesChanged') || Object.hasOwn(extra, 'findings') || Object.hasOwn(extra, 'checks') || Object.hasOwn(extra, 'commitMessage');
  const sourceTruthEvidence = hasStageEvidence
    ? ['Checked approved PRD and TRD source-of-truth material against this task.']
    : [];
  const providedEvidence = Object.hasOwn(extra, 'evidence') ? extra.evidence : undefined;
  const evidence = providedEvidence
    ? (outcome === 'PASS' || outcome === 'PASS_WITH_MANUAL_VALIDATION' ? [...sourceTruthEvidence, ...providedEvidence] : providedEvidence)
    : (outcome === 'PASS' || outcome === 'PASS_WITH_MANUAL_VALIDATION' ? ['Observed repository evidence', ...sourceTruthEvidence] : []);
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
        risks: ['No material architectural risks identified.'],
        requiredCapabilities: [{ id: 'project-runtime', purpose: 'Run and validate the delivered behavior.', acceptableTools: ['repository runtime', 'equivalent compatible runtime'], verification: 'Execute the public entry point and observe a successful result.' }]
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
  const qaPlanningDefaults = Object.hasOwn(extra, 'taskTestPlans')
    ? { requiredCapabilities: [{ id: 'black-box-runner', purpose: 'Execute the planned public-interface checks.', acceptableTools: ['existing project test runner', 'equivalent public-interface harness'], verification: 'Run one planned test through the public interface and capture its observable result.' }] }
    : {};
  return JSON.stringify({ outcome, summary: `${outcome} result`, ...intakeDefaults, ...architectureDefaults, ...uiDefaults, ...recruitingDefaults, ...qaPlanningDefaults, ...extra, evidence });
}

function queuedRunner(repo, outputs) {
  let index = 0;
  return async ({ agentId, context }) => {
    if (agentId === 'qa-planner' && outputs[index]?.agentId !== 'qa-planner') {
      const parsedContext = JSON.parse(context);
      const tasks = parsedContext.plan?.tasks || parsedContext.taskLedger || [];
      const taskTestPlans = tasks.map((task) => ({
        taskId: task.id,
        tests: (task.blackBoxTestPlan?.length ? task.blackBoxTestPlan : [{
          name: `${task.title} acceptance`,
          action: 'Exercise the task through its public interface.',
          expected: 'Every task acceptance criterion is observable as passing.',
          evidenceMethod: 'Runtime or public-interface test output.'
        }]).map((plannedTest) => ({ ...plannedTest, covers: task.acceptanceCriteria }))
      }));
      return {
        runId: `run-qa-planning-${index}`,
        agentId,
        role: agentId,
        exitCode: 0,
        timedOut: false,
        completedAt: new Date().toISOString(),
        stdout: result('PASS', {
          taskTestPlans,
          regressionStrategy: ['Retain each approved test name as a later execution and regression obligation.'],
          coverageNotes: ['Every exact task acceptance criterion is covered by the QA-authored plan.']
        }),
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        metaPath: ''
      };
    }
    if (agentId === 'environment-readiness' && outputs[index]?.agentId !== 'environment-readiness') {
      const parsedContext = JSON.parse(context);
      const planned = [
        ...(parsedContext.requiredCapabilities?.architecture || []).map((capability) => ({ ...capability, requiredBy: ['architecture'] })),
        ...(parsedContext.requiredCapabilities?.qa || []).map((capability) => ({ ...capability, requiredBy: ['qa-planning'] }))
      ];
      const merged = [...planned.reduce((byId, capability) => {
        const existing = byId.get(capability.id);
        byId.set(capability.id, existing
          ? { ...existing, requiredBy: [...new Set([...existing.requiredBy, ...capability.requiredBy])] }
          : capability);
        return byId;
      }, new Map()).values()];
      return {
        runId: `run-environment-readiness-${index}`,
        agentId,
        role: agentId,
        exitCode: 0,
        timedOut: false,
        completedAt: new Date().toISOString(),
        stdout: result('PASS', {
          capabilities: merged.map((capability) => ({
            id: capability.id,
            requiredBy: capability.requiredBy,
            selectedTool: capability.acceptableTools[0],
            probeCommand: capability.verification,
            status: 'VERIFIED',
            version: 'test-version',
            executablePath: '/test/tool',
            evidence: 'Functional readiness probe passed.'
          })),
          fileOperations: {
            workspaceWriteVerified: true,
            tempDirectory: '.aiteam-readiness-probe',
            writeMethod: 'literal quoted heredoc',
            syntaxCheckVerified: true,
            syntaxCheckCommand: 'test syntax check',
            evidence: 'Create, read, syntax-check, and delete round trip passed.'
          },
          missingTools: [],
          questions: []
        }),
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        metaPath: ''
      };
    }
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

function readEvents(repo) {
  const file = path.join(repo, '.aiteam', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function latestAdvisory(repo) {
  return readEvents(repo).filter((event) => event.type === 'workflow_quality_advisory').at(-1);
}

async function advanceWithHumanApprovals(args) {
  let result = await advanceWorkflow(args);
  if (result.session.currentStage === 'qa-planning') result = await advanceWorkflow(args);
  let session = readSession(args.repo);
  if (['prd-review', 'trd-review'].includes(session?.pendingUserInput?.kind) && session.pendingUserInput.response == null) {
    await callTool('aiteam_update_session', { repository: args.repo, patch: { pendingUserInput: 'approved' } });
    session = readSession(args.repo);
  }
  if (session?.currentStage === 'environment-readiness' && !session.pendingUserInput) {
    result = await advanceWorkflow(args);
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
    { stdout: result('PASS', { checks: [{ name: 'black-box smoke', status: 'PASS', expected: 'Python module compiles successfully.', actual: 'Python module compiled successfully.', evidence: 'py_compile passed' }], automationAttempts: [], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Implement validated feature' }) }
  ]);

  for (let i = 0; i < 8; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  assert.equal(ready.status, 'READY_TO_COMPLETE');
  assert.equal(ready.taskLedger[0].status, 'qa-passed');
  assert.equal(ready.integration.committed, true);
  assert.equal(ready.stageEvidence['implementation:feature-task'].result.pruned, true);
  assert.equal(ready.stageEvidence['code-review:feature-task'].result.pruned, true);
  assert.equal(ready.stageEvidence['qa:feature-task'].result.pruned, true);
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
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }, { command: 'playwright browser-startup smoke', result: 'Headless browser opened the UI page; pageerror and console error listeners reported zero errors; startup verified and passed.' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'black-box smoke', status: 'PASS', expected: 'The UI responds correctly in the tested viewport.', actual: 'The headless browser observed the responsive UI behavior.', evidence: 'Playwright loaded the page with pageerror and console error listeners; zero errors; responsive UI validated' }], automationAttempts: [{ command: 'playwright --version && node visual-check.mjs', result: 'Headless browser loaded page; pageerror and console error listeners reported zero errors; validated responsive UI; all checks passed', covers: ['black-box smoke'], fallbackReason: '' }], manualChecks: [] }) },
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
    { stdout: result('PASS', { checks: [{ name: 'black-box smoke', status: 'PASS', expected: 'README is present and non-empty.', actual: 'README was present and non-empty.', evidence: 'file is non-empty' }], automationAttempts: [], manualChecks: [] }) },
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
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement final revised plan', specialistId: 'python', acceptanceCriteria: ['Works after final revision'], dependencies: [], blackBoxTestPlan: [{ name: 'final revised runtime behavior', action: 'Run the final revised feature through the public interface.', expected: 'The final revised expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }] }) },
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
  assert.match(prdHtml, /Reply with exactly <strong>approved<\/strong>/);
  assert.doesNotMatch(prdHtml, /high school/i);

  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Please add a clearer approval criterion.' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'intake');
  assert.equal(session.pendingUserInput.kind, 'prd-review');
  assert.match(session.pendingUserInput.response, /clearer approval/);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Approved' } });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'trd-review');
  assert.ok(session.completedStages.includes('qa-planning'));
  assert.equal(session.stageEvidence['qa-planning'].agentId, 'qa-planner');
  assert.deepEqual(session.taskLedger[0].blackBoxTestPlan[0].covers, ['Works']);
  assert.equal(session.pendingUserInput.kind, 'trd-review');
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'looks good' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'planning');
  assert.equal(session.taskLedger.length, 0);
  assert.equal(session.pendingUserInput.kind, 'trd-review');
  assert.match(session.lastFailure, /TRD changes requested/);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'critical-review');
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'trd-review');
  assert.match(session.pendingUserInput.artifact.url, /\/artifacts\/trd\.html$/);
  assert.match(session.pendingUserInput.artifact.fileUrl, /^file:\/\/.*\/trd\.html$/);
  assert.match(session.pendingUserInput.questions.join('\n'), /local file instead: file:\/\//);
  const trdHtml = fs.readFileSync(session.pendingUserInput.artifact.path, 'utf8');
  assert.match(trdHtml, /Testing Plan/);
  assert.match(trdHtml, /QA Test Plan Ownership/);
  assert.match(trdHtml, /QA Test Planner created this black-box plan/);
  assert.match(trdHtml, /QA-authored black-box test plan/);
  assert.match(trdHtml, /Regression Strategy/);
  assert.match(trdHtml, /Coverage Notes/);
  assert.match(trdHtml, /revised runtime behavior/);
  assert.match(trdHtml, /Run the revised feature through the public interface/);
  assert.match(trdHtml, /The revised expected behavior is observable/);
  assert.match(trdHtml, /Runtime test output/);
  assert.match(trdHtml, /<dt>Covers<\/dt>/);
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
  assert.match(trdHtml, /Reply with exactly <strong>approved<\/strong>/);
  assert.doesNotMatch(trdHtml, /high school/i);

  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'approved, but add another regression test.' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'planning');
  assert.equal(session.taskLedger.length, 0);
  assert.equal(session.pendingUserInput.kind, 'trd-review');
  assert.match(session.lastFailure, /add another regression test/);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'critical-review');
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'trd-review');
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'approved' } });
  assert.equal(readSession(repo).currentStage, 'environment-readiness');
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  session = readSession(repo);
  assert.equal(session.currentStage, 'implementation');
  assert.ok(session.completedStages.includes('environment-readiness'));
  assert.equal(session.environmentProfile.capabilities[0].status, 'VERIFIED');
});

test('Environment Readiness pauses for human installation and re-verifies before implementation', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build a browser utility');
  const architectureCapability = { id: 'project-runtime', purpose: 'Run the product.', acceptableTools: ['node'], verification: 'Run the public entry point.' };
  const qaCapability = { id: 'browser-black-box', purpose: 'Exercise browser behavior.', acceptableTools: ['Playwright', 'equivalent browser runner'], verification: 'Launch a browser, load a page, and close without errors.' };
  writeSession(repo, {
    ...session,
    currentStage: 'environment-readiness',
    completedStages: ['intake', 'prd-review', 'architecture', 'planning', 'qa-planning', 'critical-review', 'trd-review'],
    stageEvidence: {
      intake: { result: { userConfirmed: true } },
      architecture: { result: { requiredCapabilities: [architectureCapability] } },
      'qa-planning': { result: { requiredCapabilities: [qaCapability] } }
    },
    taskLedger: [{ id: 'feature-task', title: 'Feature', description: 'Implement feature', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [], status: 'planned', filesChanged: [], validations: [] }]
  });
  const falseFileOperations = {
    workspaceWriteVerified: false,
    tempDirectory: '.aiteam-readiness-probe',
    writeMethod: 'literal quoted heredoc',
    syntaxCheckVerified: false,
    syntaxCheckCommand: 'python -m py_compile probe.py',
    evidence: 'Write probe was deferred until the required runtime is available.'
  };
  const verifiedFileOperations = {
    workspaceWriteVerified: true,
    tempDirectory: '.aiteam-readiness-probe',
    writeMethod: 'literal quoted heredoc',
    syntaxCheckVerified: true,
    syntaxCheckCommand: 'python -m py_compile probe.py',
    evidence: 'Create, read, syntax-check, and delete round trip passed.'
  };
  const runner = queuedRunner(repo, [
    {
      agentId: 'environment-readiness',
      stdout: result('AWAITING_USER', {
        capabilities: [],
        fileOperations: falseFileOperations,
        missingTools: [{
          tool: 'Playwright or equivalent browser runner',
          capability: 'browser-black-box',
          whyNeeded: 'The approved QA plan requires browser startup and interaction.',
          detectedProblem: 'Direct browser-runner probes found no working automation interface.',
          alternativesTried: ['Python Playwright import failed', 'No compatible existing browser runner passed startup'],
          installInstructions: ['Install a supported browser automation package using the host-approved package manager'],
          verificationCommand: 'python3 -c "from playwright.sync_api import sync_playwright; print(sync_playwright)"',
          requiresHuman: true
        }],
        questions: ['Install a browser automation tool and reply when complete.']
      })
    },
    {
      agentId: 'environment-readiness',
      stdout: result('PASS', {
        capabilities: [
          { id: 'project-runtime', requiredBy: ['architecture'], selectedTool: 'node', probeCommand: 'node --version', status: 'VERIFIED', version: '22.0.0', executablePath: '/usr/bin/node', evidence: 'Runtime probe passed.' },
          { id: 'browser-black-box', requiredBy: ['qa-planning'], selectedTool: 'Playwright with system Chrome', probeCommand: 'python3 browser_probe.py', status: 'VERIFIED', version: '1.60.0', executablePath: '/usr/bin/google-chrome', evidence: 'Browser launched, loaded a page, and closed without errors.' }
        ],
        fileOperations: verifiedFileOperations,
        missingTools: [],
        questions: []
      })
    }
  ]);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  let pending = readSession(repo);
  assert.equal(pending.currentStage, 'environment-readiness');
  assert.equal(pending.pendingUserInput.kind, 'environment-install');
  assert.match(pending.pendingUserInput.questions[0], /Why it is needed:/);
  assert.match(pending.pendingUserInput.questions[0], /AITEAM will verify with:/);

  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'Installed Playwright for Python.' } });
  pending = readSession(repo);
  assert.equal(pending.currentStage, 'environment-readiness');
  assert.match(pending.pendingUserInput.response, /Installed Playwright/);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  assert.equal(ready.currentStage, 'implementation');
  assert.ok(ready.completedStages.includes('environment-readiness'));
  assert.equal(ready.environmentProfile.capabilities[1].selectedTool, 'Playwright with system Chrome');
  const implementationContext = JSON.parse(getCurrentAssignment(repo).context);
  assert.equal(implementationContext.environmentProfile.capabilities[1].status, 'VERIFIED');
});

test('Environment Readiness cannot pass while omitting an approved capability', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build a browser utility');
  writeSession(repo, {
    ...session,
    currentStage: 'environment-readiness',
    stageEvidence: {
      intake: { result: { userConfirmed: true } },
      architecture: { result: { requiredCapabilities: [{ id: 'project-runtime' }] } },
      'qa-planning': { result: { requiredCapabilities: [{ id: 'browser-black-box' }] } }
    }
  });
  const runner = queuedRunner(repo, [{
    agentId: 'environment-readiness',
    stdout: result('PASS', {
      capabilities: [{ id: 'project-runtime', requiredBy: ['architecture'], selectedTool: 'node', probeCommand: 'node --version', status: 'VERIFIED', version: '22', executablePath: '/usr/bin/node', evidence: 'Passed.' }],
      fileOperations: { workspaceWriteVerified: true, tempDirectory: '.aiteam-readiness-probe', writeMethod: 'heredoc', syntaxCheckVerified: true, syntaxCheckCommand: 'node --check probe.js', evidence: 'Round trip passed.' },
      missingTools: [],
      questions: []
    })
  }]);
  await assert.rejects(
    advanceWorkflow({ repo, runner, timeoutSeconds: 300 }),
    /missing approved capability verification for: browser-black-box/
  );
  assert.equal(readSession(repo).currentStage, 'environment-readiness');
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
    { stdout: result('FAIL', { findings: [{ id: 'F1', severity: 'MAJOR', location: 'app.py:1', impact: 'Acceptance criterion "Works" is violated: deterministic test command showed the wrong value is returned.', recommendation: 'Fix the current-task behavior so the acceptance criteria pass under the same test command.' }] }) }
  ]);
  for (let i = 0; i < 6; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.currentStage, 'implementation');
  assert.equal(session.currentTaskId, 'feature-task');
  assert.equal(session.taskLedger[0].status, 'needs-rework');
});

test('code review records advisory for unsupported material formula findings', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build pong physics');
  fs.writeFileSync(path.join(repo, 'index.html'), '<script>const physics = true;</script>\n');
  writeSession(repo, {
    ...session,
    currentStage: 'code-review',
    currentTaskId: 'physics-engine',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'physics-engine',
      title: 'Physics engine',
      description: 'Implement Pong deflection physics.',
      specialistId: 'python',
      acceptanceCriteria: ['Edge hits near +/-60 degrees from horizontal', 'Center hits reverse direction near 180 degrees'],
      dependencies: [],
      status: 'implemented',
      filesChanged: ['index.html'],
      validations: [{ command: 'playwright browser-startup smoke', result: 'Headless browser opened the page; pageerror and console error listeners reported zero errors; startup verified and passed.' }],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'Edge hit deflection', action: 'Hit the paddle edge.', expected: 'Ball deflects near 60 degrees.', evidenceMethod: 'Browser runtime observation.' }]
    }]
  });

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('FAIL', {
        findings: [{
          id: 'formula-divisor',
          severity: 'MAJOR',
          location: 'index.html:42',
          impact: 'The formula is wrong because it uses paddle height instead of ball diameter.',
          recommendation: 'Replace the divisor with two times the ball radius.'
        }]
      }) }
    ])
  });

  const after = readSession(repo);
  assert.equal(after.currentStage, 'implementation');
  assert.equal(after.taskLedger[0].status, 'needs-rework');
  assert.match(latestAdvisory(repo).warning, /material findings must cite concrete authority|speculative formula/);

  const reworkAssignment = getCurrentAssignment(repo);
  assert.match(reworkAssignment.task, /Treat each previous finding as a hypothesis/);
  assert.match(reworkAssignment.task, /substitute representative boundary and midpoint inputs/);
  assert.match(reworkAssignment.task, /preserve the working code/);
  assert.match(reworkAssignment.task, /does not require a content change/);
  assert.match(reworkAssignment.task, /Do NOT make a token\/no-op edit/);

  writeSession(repo, {
    ...after,
    currentStage: 'code-review',
    taskLedger: after.taskLedger.map((task) => task.id === 'physics-engine'
      ? { ...task, status: 'implemented' }
      : task)
  });
  const repairReviewAssignment = getCurrentAssignment(repo);
  assert.match(repairReviewAssignment.task, /prior findings are hypotheses, not authoritative facts/);
  assert.match(repairReviewAssignment.task, /representative boundary and midpoint inputs/);
  assert.match(repairReviewAssignment.task, /Apply the same inputs to the proposed replacement/);
});

test('code review rejects procedural or tool-denial claims', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build test feature');
  fs.writeFileSync(path.join(repo, 'index.html'), '<script>console.log("ok");</script>\n');
  writeSession(repo, {
    ...session,
    currentStage: 'code-review',
    currentTaskId: 'task-1',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'task-1',
      title: 'Task 1',
      description: 'Implement task 1',
      specialistId: 'python',
      acceptanceCriteria: ['Feature works'],
      dependencies: [],
      status: 'implemented',
      filesChanged: ['index.html'],
      validations: [{ command: 'npm test', result: 'All passed' }],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'Smoke', action: 'Load page', expected: 'OK', evidenceMethod: 'Console' }]
    }]
  });

  await assert.rejects(
    advanceWorkflow({
      repo,
      timeoutSeconds: 300,
      runner: queuedRunner(repo, [
        { stdout: result('FAIL', {
          summary: 'Cannot complete review: all exec_command calls were denied by harness as "Exec denied: tool execution was stopped"',
          findings: [{
            id: 'CR-PROC-001',
            severity: 'BLOCKER',
            location: 'Review process (no file/line available)',
            impact: 'Zero file contents observed because exec was denied.',
            recommendation: 'Re-run in environment where exec_command is permitted.'
          }]
        }) }
      ])
    }),
    /Code Review cannot FAIL on procedural limits, tool denial claims, or inspection completeness/
  );
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
    { stdout: result('PASS', { checks: [{ name: 'black-box smoke', status: 'PASS', expected: 'Feature behavior works.', actual: 'Feature behavior was observed working.', evidence: 'observed' }], automationAttempts: [], manualChecks: [] }) }
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
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }, { command: 'playwright browser-startup smoke', result: 'Headless browser opened the browser feature; pageerror and console error listeners reported zero errors; startup verified and passed.' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS_WITH_MANUAL_VALIDATION', { evidence: ['Headless runtime checks passed; subjective visual polish remains'], checks: [{ name: 'black-box smoke', status: 'PASS', expected: 'The browser page loads and exposes the expected canvas.', actual: 'Playwright opened the page and confirmed the canvas exists.', evidence: 'Playwright opened the page with pageerror and console error listeners; zero errors; canvas exists' }], automationAttempts: [{ command: 'playwright --version && node browser-smoke.mjs', result: 'Headless browser loaded the page; pageerror and console error listeners reported zero errors; found canvas element; all checks passed', covers: ['black-box smoke'], fallbackReason: 'Final visual aesthetics still require human judgment' }], manualChecks: ['Human-only because final subjective visual confirmation remains: open the browser game and verify the canvas looks correct.'] }) }
  ]);
  for (let i = 0; i < 7; i += 1) await advanceWithHumanApprovals({ repo, runner, timeoutSeconds: 300 });
  let session = readSession(repo);
  assert.equal(session.currentStage, 'qa');
  assert.equal(session.taskLedger[0].status, 'qa-awaiting-manual');
  assert.equal(session.pendingUserInput.kind, 'qa-manual');
  await callTool('aiteam_update_session', { repository: repo, patch: { pendingUserInput: 'PASS' } });
  session = readSession(repo);
  assert.equal(session.currentStage, 'integration');
  assert.equal(session.taskLedger[0].status, 'qa-passed');
  assert.equal(session.taskLedger[0].qa.manualValidationResponse, 'PASS');
  assert.equal(session.pendingUserInput, null);
  assert.equal(session.manualQaHistory.length, 1);
  assert.equal(session.manualQaHistory[0].response, 'PASS');
});

test('manual QA non-PASS responses are triaged before routing', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser feature');
  const baseTask = {
    id: 'game-loop',
    title: 'Game loop',
    description: 'Implement score tracking and victory flow.',
    specialistId: 'python',
    acceptanceCriteria: ['Score display updates live', 'Victory screen appears at 11 points'],
    dependencies: [],
    status: 'qa-awaiting-manual',
    filesChanged: ['index.html'],
    validations: [],
    review: null,
    qa: { outcome: 'PASS_WITH_MANUAL_VALIDATION', manualChecks: ['Check score and victory flow.'] },
    blackBoxTestPlan: [{ name: 'Victory flow', action: 'Reach 11 points.', expected: 'Victory appears.', evidenceMethod: 'Browser observation.' }]
  };
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'game-loop',
    pendingUserInput: {
      kind: 'qa-manual',
      stage: 'qa',
      taskId: 'game-loop',
      questions: ['Check score and victory flow.'],
      response: null,
      requestedAt: new Date(Date.now() - 60_000).toISOString()
    },
    taskLedger: [
      baseTask,
      {
        id: 'input-controls',
        title: 'Full-window paddle input controls',
        description: 'Implement mouse tracking across the full browser window and clamp paddle at top and bottom edges.',
        specialistId: 'python',
        acceptanceCriteria: ['Mouse anywhere in the browser window moves the paddle', 'Paddle clamps smoothly at top and bottom edges'],
        dependencies: ['game-loop'],
        status: 'planned',
        filesChanged: [],
        validations: [],
        review: null,
        qa: null,
        blackBoxTestPlan: [{ name: 'Window paddle tracking', action: 'Move mouse around the browser window.', expected: 'Paddle follows and clamps.', evidenceMethod: 'Browser observation.' }]
      }
    ]
  });

  await callTool('aiteam_update_session', {
    repository: repo,
    patch: { pendingUserInput: 'PASS - full window paddle tracking and top/bottom edge behavior is for task 2, not task 1.' }
  });
  let next = readSession(repo);
  assert.equal(next.currentStage, 'integration');
  assert.equal(next.taskLedger[0].status, 'qa-passed');
  assert.equal(next.deferredManualQaObservations.length, 1);
  assert.equal(next.deferredManualQaObservations[0].observations[0].matchedTaskId, 'input-controls');

  writeSession(repo, {
    ...next,
    currentStage: 'qa',
    currentTaskId: 'game-loop',
    pendingUserInput: {
      kind: 'qa-manual',
      stage: 'qa',
      taskId: 'game-loop',
      questions: ['Check score and victory flow.'],
      response: null,
      requestedAt: new Date(Date.now() - 60_000).toISOString()
    },
    taskLedger: next.taskLedger.map((task) => task.id === 'game-loop' ? { ...task, status: 'qa-awaiting-manual', completedAt: null } : task)
  });
  await callTool('aiteam_update_session', {
    repository: repo,
    patch: { pendingUserInput: 'current task failure: Victory screen does not appear at 11 points.' }
  });
  next = readSession(repo);
  assert.equal(next.currentStage, 'implementation');
  assert.equal(next.taskLedger[0].status, 'needs-rework');
  assert.match(next.taskLedger[0].qaFailure.summary, /Victory screen/);
});

test('manual QA vague responses request clarification instead of approving', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser feature');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'browser-task',
    pendingUserInput: {
      kind: 'qa-manual',
      stage: 'qa',
      taskId: 'browser-task',
      questions: ['Check browser behavior.'],
      response: null,
      requestedAt: new Date(Date.now() - 60_000).toISOString()
    },
    taskLedger: [{
      id: 'browser-task',
      title: 'Browser task',
      description: 'Implement browser behavior.',
      specialistId: 'python',
      acceptanceCriteria: ['Browser behavior works'],
      dependencies: [],
      status: 'qa-awaiting-manual',
      filesChanged: ['index.html'],
      validations: [],
      review: null,
      qa: { outcome: 'PASS_WITH_MANUAL_VALIDATION', manualChecks: ['Check browser behavior.'] },
      blackBoxTestPlan: [{ name: 'Browser behavior', action: 'Use browser.', expected: 'Behavior works.', evidenceMethod: 'Browser observation.' }]
    }]
  });

  await callTool('aiteam_update_session', {
    repository: repo,
    patch: { pendingUserInput: 'looks good' }
  });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'qa');
  assert.equal(next.taskLedger[0].status, 'qa-awaiting-manual');
  assert.equal(next.pendingUserInput.kind, 'qa-manual-triage');
  assert.match(next.pendingUserInput.questions.join('\n'), /Reply with "current task failure/);
});

test('QA manual validation automation coverage guidance is advisory, not structural', () => {
  const advisoryOnlyQa = parseStageResult('qa', result('PASS_WITH_MANUAL_VALIDATION', {
    evidence: ['Runtime smoke passed; visual check remains.'],
    checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }],
    automationAttempts: [{ command: 'playwright smoke', result: 'passed', covers: ['runtime smoke'], fallbackReason: '' }],
    manualChecks: ['Open the app and verify the animation looks good.']
  }));
  assert.match(advisoryOnlyQa.manualChecks[0], /verify the animation/);

  const qa = parseStageResult('qa', result('PASS_WITH_MANUAL_VALIDATION', {
    evidence: ['Runtime smoke passed; visual check remains.'],
    checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }],
    automationAttempts: [{ command: 'playwright smoke', result: 'passed', covers: ['runtime smoke'], fallbackReason: '' }],
    manualChecks: ['Human-only because animation smoothness is subjective: open the app and verify the animation looks good.']
  }));
  assert.match(qa.manualChecks[0], /Human-only because/);
});

test('QA manual validation cannot ask human to validate future task scope', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser feature');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'game-loop',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [
      {
        id: 'game-loop',
        title: 'Game loop',
        description: 'Implement score tracking and victory flow.',
        specialistId: 'python',
        acceptanceCriteria: ['Score display updates live', 'Victory screen appears at 11 points'],
        dependencies: [],
        status: 'review-passed',
        filesChanged: ['index.html'],
        validations: [],
        review: null,
        qa: null,
        blackBoxTestPlan: [{ name: 'Victory flow', action: 'Reach 11 points.', expected: 'Victory appears.', evidenceMethod: 'Browser observation.' }]
      },
      {
        id: 'input-controls',
        title: 'Full-window paddle input controls',
        description: 'Implement mouse tracking across the full browser window and clamp paddle at top and bottom edges.',
        specialistId: 'python',
        acceptanceCriteria: ['Mouse anywhere in the browser window moves the paddle', 'Paddle clamps smoothly at top and bottom edges'],
        dependencies: ['game-loop'],
        status: 'planned',
        filesChanged: [],
        validations: [],
        review: null,
        qa: null,
        blackBoxTestPlan: [{ name: 'Window paddle tracking', action: 'Move mouse around the browser window.', expected: 'Paddle follows and clamps.', evidenceMethod: 'Browser observation.' }]
      }
    ]
  });

  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS_WITH_MANUAL_VALIDATION', {
        evidence: ['Runtime tests passed; Human-only because playfeel requires human judgment.'],
        checks: [{ name: 'Victory flow', status: 'PASS', expected: 'Victory appears.', actual: 'Victory appeared.', evidence: 'Runtime smoke passed.' }],
        automationAttempts: [{ command: 'playwright victory smoke', result: 'Headless browser loaded the page; pageerror and console error listeners reported zero errors; startup verified and passed; victory flow passed.', covers: ['Victory flow'], fallbackReason: '' }],
        manualChecks: ['Human-only because playfeel requires human judgment: verify full-window paddle tracking and top/bottom edge clamp behavior for task 2.']
      }) }
    ])
  }), /manualChecks must not target future-task/);
});

test('browser implementation must include runtime startup evidence', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser UI');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'browser-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'browser-task',
      title: 'Browser task',
      description: 'Implement browser UI',
      specialistId: 'python',
      acceptanceCriteria: ['Browser UI renders'],
      dependencies: [],
      status: 'planned',
      filesChanged: [],
      validations: [],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'Browser startup smoke', action: 'Open the app in a browser.', expected: 'The app starts with no console errors.', evidenceMethod: 'Browser runtime output.' }]
    }]
  });

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } }
    ])
  });
  let current = readSession(repo);
  assert.equal(current.currentStage, 'code-review');
  assert.equal(current.taskLedger[0].status, 'implemented');
  assert.match(latestAdvisory(repo).warning, /Browser\/UI implementation PASS requires concrete runtime startup evidence/);

  writeSession(repo, { ...current, currentStage: 'implementation', taskLedger: current.taskLedger.map((task) => ({ ...task, status: 'planned', filesChanged: [], validations: [] })) });
  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', {
        filesChanged: ['app.py'],
        validations: [{ command: 'playwright chromium smoke', result: 'Playwright Chromium launch failed: sandbox host permission denied.' }]
      }), write: { path: 'app.py', content: 'VALUE = 1\n' } }
    ])
  });
  current = readSession(repo);
  assert.equal(current.currentStage, 'code-review');
  assert.match(latestAdvisory(repo).warning, /cannot rely only on failed browser launch evidence.*system browser/s);
});

test('code review records advisory when implementation lacks startup evidence', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser UI');
  fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
  writeSession(repo, {
    ...session,
    currentStage: 'code-review',
    currentTaskId: 'browser-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'browser-task',
      title: 'Browser task',
      description: 'Implement browser UI',
      specialistId: 'python',
      acceptanceCriteria: ['Browser UI renders'],
      dependencies: [],
      status: 'implemented',
      filesChanged: ['app.py'],
      validations: [{ command: 'python -m py_compile app.py', result: 'passed' }],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'Browser startup smoke', action: 'Open the app in a browser.', expected: 'The app starts with no console errors.', evidenceMethod: 'Browser runtime output.' }]
    }]
  });

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { findings: [] }) }
    ])
  });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'qa');
  assert.equal(next.taskLedger[0].status, 'review-passed');
  assert.match(latestAdvisory(repo).warning, /Code Review cannot PASS browser\/UI work/);
});

test('QA must cover current planned tests and browser startup errors', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build browser UI');
  fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
  const baseTask = {
    id: 'browser-task',
    title: 'Browser task',
    description: 'Implement browser UI',
    specialistId: 'python',
    acceptanceCriteria: ['Browser UI renders'],
    dependencies: [],
    status: 'review-passed',
    filesChanged: ['app.py'],
    validations: [{ command: 'playwright browser-startup smoke', result: 'Headless browser opened the page; pageerror and console error listeners reported zero errors; startup verified and passed.' }],
    review: null,
    qa: null,
    blackBoxTestPlan: [{ name: 'Browser startup smoke', action: 'Open the app in a browser.', expected: 'The app starts with no console errors.', evidenceMethod: 'Browser runtime output.' }]
  };
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'browser-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [baseTask]
  });

  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { checks: [{ name: 'Other check', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Playwright loaded page with zero errors.' }], automationAttempts: [{ command: 'playwright smoke', result: 'pageerror and console error listeners reported zero errors; all checks passed', covers: ['Other check'], fallbackReason: '' }], manualChecks: [] }) }
    ])
  }), /QA planned test coverage missing/);

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { checks: [{ name: 'Browser startup smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Playwright loaded page.' }], automationAttempts: [{ command: 'playwright smoke', result: 'loaded page; all checks passed', covers: ['Browser startup smoke'], fallbackReason: '' }], manualChecks: [] }) }
    ])
  });
  let next = readSession(repo);
  assert.equal(next.currentStage, 'integration');
  assert.equal(next.taskLedger[0].status, 'qa-passed');
  assert.match(latestAdvisory(repo).warning, /QA PASS for browser\/UI work requires concrete browser startup evidence/);

  writeSession(repo, { ...next, currentStage: 'qa', taskLedger: [baseTask] });
  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { checks: [{ name: 'Browser startup smoke', status: 'PASS', expected: 'The app starts.', actual: 'Browser automation failed to launch.', evidence: 'Playwright Chromium launch failed: sandbox host permission denied.' }], automationAttempts: [{ command: 'playwright smoke', result: 'Playwright Chromium launch failed: sandbox host permission denied.', covers: ['Browser startup smoke'], fallbackReason: '' }], manualChecks: [] }) }
    ])
  });
  next = readSession(repo);
  assert.equal(next.currentStage, 'integration');
  assert.match(latestAdvisory(repo).warning, /cannot rely only on failed browser launch evidence.*system browser/s);
});

test('post-review PASS records advisory when PRD and TRD source-of-truth evidence is missing', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature');
  const prdArtifact = { path: path.join(repo, '.aiteam/docs/prd.html'), fileUrl: 'file:///prd.html', url: 'http://127.0.0.1/artifacts/prd.html' };
  const trdArtifact = { path: path.join(repo, '.aiteam/docs/trd.html'), fileUrl: 'file:///trd.html', url: 'http://127.0.0.1/artifacts/trd.html' };
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'prd-review', 'architecture', 'planning', 'critical-review', 'trd-review'],
    humanReviewHistory: [
      { kind: 'prd-review', approved: true, artifact: prdArtifact },
      { kind: 'trd-review', approved: true, artifact: trdArtifact }
    ],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'feature-task',
      title: 'Feature task',
      description: 'Implement a CLI feature',
      specialistId: 'python',
      acceptanceCriteria: ['CLI feature works'],
      dependencies: [],
      status: 'planned',
      filesChanged: [],
      validations: [],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run the CLI.', expected: 'The CLI exits successfully.', evidenceMethod: 'Command output.' }]
    }]
  });

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: JSON.stringify({ outcome: 'PASS', summary: 'Implemented feature', evidence: ['Implemented and tested the CLI.'], filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } }
    ])
  });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'code-review');
  assert.equal(next.taskLedger[0].status, 'implemented');
  assert.match(latestAdvisory(repo).warning, /PASS requires evidence that approved PRD and TRD source-of-truth material was checked/);
});

test('QA must cover previous QA checks as regression obligations', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature in stages');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'second-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: {
      ...session.stageEvidence,
      intake: { result: { userConfirmed: true } }
    },
    taskLedger: [
      {
        id: 'first-task',
        title: 'First task',
        description: 'First completed task',
        specialistId: 'python',
        acceptanceCriteria: ['First behavior works'],
        dependencies: [],
        status: 'qa-passed',
        filesChanged: ['app.py'],
        qa: {
          outcome: 'PASS',
          checks: [{ name: 'First behavior smoke', status: 'PASS', expected: 'First behavior works.', actual: 'First behavior worked.', evidence: 'Runtime smoke passed.' }]
        }
      },
      {
        id: 'second-task',
        title: 'Second task',
        description: 'Second task',
        specialistId: 'python',
        acceptanceCriteria: ['Second behavior works'],
        dependencies: ['first-task'],
        status: 'review-passed',
        filesChanged: ['app.py'],
        validations: []
      }
    ]
  });

  const assignment = getCurrentAssignment(repo);
  assert.match(assignment.context, /first-task#first-behavior-smoke/);

  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { checks: [{ name: 'Second behavior', status: 'PASS', expected: 'Second behavior works.', actual: 'Second behavior worked.', evidence: 'Runtime smoke passed.' }], automationAttempts: [], manualChecks: [] }) }
    ])
  }), /QA regression coverage missing/);

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', { checks: [{ name: 'Regression first-task#first-behavior-smoke', status: 'PASS', expected: 'First behavior still works.', actual: 'First behavior still worked.', evidence: 'Runtime regression smoke passed.' }, { name: 'Second behavior', status: 'PASS', expected: 'Second behavior works.', actual: 'Second behavior worked.', evidence: 'Runtime smoke passed.' }], automationAttempts: [], manualChecks: [] }) }
    ])
  });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'integration');
  assert.equal(next.taskLedger[1].status, 'qa-passed');
});

test('QA regression IDs remain canonical across multiple completed tasks', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature in stages');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'third-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: {
      ...session.stageEvidence,
      intake: { result: { userConfirmed: true } }
    },
    taskLedger: [
      {
        id: 'first-task',
        title: 'First task',
        description: 'First completed task',
        specialistId: 'python',
        acceptanceCriteria: ['First behavior works'],
        dependencies: [],
        status: 'qa-passed',
        filesChanged: ['app.py'],
        qa: {
          outcome: 'PASS',
          checks: [{ name: 'First behavior smoke', status: 'PASS', expected: 'First behavior works.', actual: 'Worked.', evidence: 'Runtime evidence.' }]
        }
      },
      {
        id: 'second-task',
        title: 'Second task',
        description: 'Second completed task',
        specialistId: 'python',
        acceptanceCriteria: ['Second behavior works'],
        dependencies: ['first-task'],
        status: 'qa-passed',
        filesChanged: ['app.py'],
        qa: {
          outcome: 'PASS',
          checks: [
            { name: 'Second behavior smoke', status: 'PASS', expected: 'Second behavior works.', actual: 'Worked.', evidence: 'Runtime evidence.' },
            { name: 'first-task#first-behavior-smoke', status: 'PASS', expected: 'First behavior still works.', actual: 'Worked.', evidence: 'Regression evidence.' }
          ]
        }
      },
      {
        id: 'third-task',
        title: 'Third task',
        description: 'Current task',
        specialistId: 'python',
        acceptanceCriteria: ['Third behavior works'],
        dependencies: ['second-task'],
        status: 'review-passed',
        filesChanged: ['app.py'],
        validations: []
      }
    ]
  });

  const assignment = getCurrentAssignment(repo);
  const context = JSON.parse(assignment.context);
  const regressionIds = context.completedPriorTasks.flatMap((task) => task.regressionTests.map((item) => item.id));
  assert.deepEqual(regressionIds.sort(), [
    'first-task#first-behavior-smoke',
    'second-task#second-behavior-smoke'
  ]);
  assert.doesNotMatch(assignment.context, /second-task#first-task-first-behavior-smoke/);

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('PASS', {
        checks: [
          { name: 'first-task#first-behavior-smoke', status: 'PASS', expected: 'First behavior still works.', actual: 'Worked.', evidence: 'Runtime regression passed.' },
          { name: 'second-task#second-behavior-smoke', status: 'PASS', expected: 'Second behavior still works.', actual: 'Worked.', evidence: 'Runtime regression passed.' },
          { name: 'Third behavior smoke', status: 'PASS', expected: 'Third behavior works.', actual: 'Worked.', evidence: 'Runtime smoke passed.' }
        ],
        automationAttempts: [],
        manualChecks: []
      }) }
    ])
  });
  assert.equal(readSession(repo).currentStage, 'integration');
});

test('browser QA guidance uses HTTP for module-capable static applications', () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build a browser application');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'browser-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: {
      ...session.stageEvidence,
      intake: { result: { userConfirmed: true } }
    },
    taskLedger: [{
      id: 'browser-task',
      title: 'Browser task',
      description: 'Render a canvas game in the browser.',
      specialistId: 'python',
      acceptanceCriteria: ['The browser app starts.'],
      dependencies: [],
      blackBoxTestPlan: [{ name: 'Browser startup', action: 'Open the app.', expected: 'The app starts.', evidenceMethod: 'Browser runtime output.' }],
      status: 'review-passed',
      filesChanged: ['index.html'],
      validations: []
    }]
  });

  const assignment = getCurrentAssignment(repo);
  assert.match(assignment.task, /do not default to file:\/\//i);
  assert.match(assignment.task, /temporary HTTP server/i);
  assert.match(assignment.task, /stop the owned server before returning/i);
});

test('QA false BLOCKED result without executed attempts retries in QA', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Validate CLI feature');
  fs.writeFileSync(path.join(repo, 'app.py'), 'print("ok")\n');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'cli-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'cli-task',
      title: 'CLI task',
      description: 'Provide observable CLI output.',
      specialistId: 'python',
      acceptanceCriteria: ['CLI prints ok'],
      dependencies: [],
      status: 'review-passed',
      filesChanged: ['app.py'],
      validations: [{ command: 'python app.py', result: 'ok' }],
      review: { outcome: 'PASS' },
      qa: null,
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run the CLI.', expected: 'CLI prints ok.', evidenceMethod: 'Command output.' }]
    }]
  });
  const calls = [];
  const stagesSeen = [];
  const runner = async (args) => {
    calls.push(args);
    stagesSeen.push(readSession(repo).currentStage);
    if (calls.length === 1) {
      return {
        runId: 'false-blocker', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stderr: '', stdoutPath: '', stderrPath: '', metaPath: '',
        stdout: result('BLOCKED', {
          summary: 'Cannot automate the CLI in this environment.',
          checks: [{ name: 'CLI smoke', status: 'INFO', expected: 'CLI prints ok.', actual: 'Not tested.', evidence: 'No command was run.' }],
          automationAttempts: [],
          manualChecks: []
        })
      };
    }
    assert.match(args.context, /QA RESULT REJECTED/);
    assert.match(args.context, /no specific framework is mandatory/i);
    return {
      runId: 'qa-retry', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stderr: '', stdoutPath: '', stderrPath: '', metaPath: '',
      stdout: result('PASS', {
        checks: [{ name: 'CLI smoke', status: 'PASS', expected: 'CLI prints ok.', actual: 'CLI printed ok.', evidence: 'python app.py exited 0 and printed ok.' }],
        automationAttempts: [{ command: 'python app.py', result: 'Exited 0 and printed ok.', covers: ['CLI smoke'], fallbackReason: '' }],
        manualChecks: []
      })
    };
  };
  runner.maxAttempts = 2;

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.deepEqual(stagesSeen, ['qa', 'qa']);
  assert.equal(next.currentStage, 'integration');
  assert.equal(next.taskLedger[0].status, 'qa-passed');
  assert.match(readEvents(repo).find((event) => event.type === 'workflow_stage_retry').error, /concrete executed black-box attempts/);
});

test('QA accepts a genuine tool-neutral BLOCKED result with complete coverage', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Validate external CLI service');
  fs.writeFileSync(path.join(repo, 'client.py'), 'print("client")\n');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'external-cli-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'external-cli-task', title: 'External CLI task', description: 'Call an external service through a CLI.', specialistId: 'python',
      acceptanceCriteria: ['CLI reports service status'], dependencies: [], status: 'review-passed', filesChanged: ['client.py'], validations: [], review: { outcome: 'PASS' }, qa: null,
      blackBoxTestPlan: [{ name: 'External CLI smoke', action: 'Run the CLI against the service.', expected: 'Service status is returned.', evidenceMethod: 'CLI output.' }]
    }]
  });

  await advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [{
      stdout: result('BLOCKED', {
        summary: 'External service is unavailable.',
        checks: [{ name: 'External CLI smoke', status: 'INFO', expected: 'Service status is returned.', actual: 'Connection was refused.', evidence: 'CLI exited with connection error.' }],
        automationAttempts: [{ command: 'python client.py --status', result: 'Exited 1: connection refused.', covers: ['External CLI smoke'], fallbackReason: 'External service unavailable; the CLI has no alternate public endpoint.' }],
        manualChecks: []
      })
    }])
  });
  const next = readSession(repo);
  assert.equal(next.status, 'BLOCKED');
  assert.equal(next.currentStage, 'qa');
  assert.match(next.blockedReason, /External service is unavailable/);
});

test('QA BLOCKED attempts must cover prior regression obligations', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Validate staged CLI feature');
  fs.writeFileSync(path.join(repo, 'app.py'), 'print("ok")\n');
  writeSession(repo, {
    ...session,
    currentStage: 'qa',
    currentTaskId: 'current-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [
      {
        id: 'prior-task', title: 'Prior task', description: 'Prior behavior.', specialistId: 'python', acceptanceCriteria: ['Prior behavior works'], dependencies: [],
        status: 'qa-passed', filesChanged: ['app.py'], qa: { outcome: 'PASS', checks: [{ name: 'Prior smoke', status: 'PASS', expected: 'Prior behavior works.', actual: 'Prior behavior worked.', evidence: 'Runtime passed.' }] }
      },
      {
        id: 'current-task', title: 'Current task', description: 'Current CLI behavior.', specialistId: 'python', acceptanceCriteria: ['Current behavior works'], dependencies: ['prior-task'],
        status: 'review-passed', filesChanged: ['app.py'], validations: [], review: { outcome: 'PASS' }, qa: null,
        blackBoxTestPlan: [{ name: 'Current CLI smoke', action: 'Run CLI.', expected: 'Current behavior works.', evidenceMethod: 'CLI output.' }]
      }
    ]
  });

  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [{
      stdout: result('BLOCKED', {
        summary: 'External dependency is unavailable.',
        checks: [{ name: 'Current CLI smoke', status: 'INFO', expected: 'Current behavior works.', actual: 'Dependency unavailable.', evidence: 'Command failed.' }],
        automationAttempts: [{ command: 'python app.py', result: 'Exited 1: dependency unavailable.', covers: ['Current CLI smoke'], fallbackReason: 'External dependency unavailable.' }],
        manualChecks: []
      })
    }])
  }), /prior-task#prior-smoke/);
  assert.equal(readSession(repo).currentStage, 'qa');
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

test('implementation prose success can be recovered when declared files exist', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Repair feature');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: {
      ...session.stageEvidence,
      intake: { result: { userConfirmed: true } }
    },
    taskLedger: [{
      id: 'feature-task',
      title: 'Feature',
      description: 'Implement feature',
      specialistId: 'python',
      acceptanceCriteria: ['Works'],
      dependencies: [],
      status: 'needs-rework',
      filesChanged: ['app.py'],
      validations: [],
      qaFailure: { outcome: 'FAIL', summary: 'app.py was missing' }
    }]
  });
  const runner = queuedRunner(repo, [
    {
      stdout: 'All validations pass. Acceptance criteria verified. File: app.py',
      write: { path: 'app.py', content: 'VALUE = 1\n' }
    }
  ]);

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'code-review');
  assert.equal(next.taskLedger[0].status, 'implemented');
  assert.equal(next.taskLedger[0].filesChanged[0], 'app.py');
  assert.match(next.taskLedger[0].validations[0].result, /exists on disk/);
});

test('malformed implementation output uses grounded format-only repair without rerunning work', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Repair feature');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'feature-task',
      title: 'Feature',
      description: 'Implement feature',
      specialistId: 'python',
      acceptanceCriteria: ['Works'],
      dependencies: [],
      status: 'needs-rework',
      filesChanged: [],
      validations: [],
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run CLI.', expected: 'CLI succeeds.', evidenceMethod: 'Command output.' }]
    }]
  });
  const calls = [];
  const source = [
    'Implementation complete.',
    'Checked approved PRD and TRD source-of-truth material against this task.',
    'app.py',
    'python -m py_compile app.py',
    'passed'
  ].join('\n');
  const runner = async (args) => {
    calls.push(args);
    if (!args.responseOnly) {
      fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
      return { runId: 'implementation-run', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stdout: source, stderr: '', stdoutPath: '', stderrPath: '', metaPath: '' };
    }
    return {
      runId: 'format-repair-run',
      agentId: args.agentId,
      exitCode: 0,
      timedOut: false,
      completedAt: new Date().toISOString(),
      stdout: JSON.stringify({
        outcome: 'PASS',
        summary: 'Implementation complete.',
        evidence: ['Checked approved PRD and TRD source-of-truth material against this task.'],
        filesChanged: ['app.py'],
        validations: [{ command: 'python -m py_compile app.py', result: 'passed' }]
      }),
      stderr: '',
      stdoutPath: '',
      stderrPath: '',
      metaPath: ''
    };
  };
  runner.maxAttempts = 2;

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].responseOnly, undefined);
  assert.equal(calls[1].responseOnly, true);
  assert.equal(calls[1].enforceSchema, true);
  assert.match(calls[1].task, /Do not redo implementation or validation/);
  assert.equal(next.currentStage, 'code-review');
  assert.equal(next.taskLedger[0].implementationRunId, 'implementation-run');
  assert.equal(readEvents(repo).filter((event) => event.type === 'workflow_stage_format_repaired').length, 1);
});

test('format-only repair cannot add evidence absent from the completed run', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Repair feature');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'feature-task', title: 'Feature', description: 'Implement feature', specialistId: 'python',
      acceptanceCriteria: ['Works'], dependencies: [], status: 'needs-rework', filesChanged: [], validations: [],
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run CLI.', expected: 'CLI succeeds.', evidenceMethod: 'Command output.' }]
    }]
  });
  const calls = [];
  const runner = async (args) => {
    calls.push(args);
    if (calls.length === 1) {
      fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
      return { runId: 'bad-json-run', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stdout: 'Implementation complete. app.py', stderr: '', stdoutPath: '', stderrPath: '', metaPath: '' };
    }
    if (args.responseOnly) {
      return { runId: 'inventing-repair', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stdout: JSON.stringify({ outcome: 'PASS', summary: 'Implementation complete.', evidence: ['Invented validation passed.'], filesChanged: ['app.py'], validations: [{ command: 'invented command', result: 'invented result' }] }), stderr: '', stdoutPath: '', stderrPath: '', metaPath: '' };
    }
    return { runId: 'full-retry', agentId: args.agentId, exitCode: 0, timedOut: false, completedAt: new Date().toISOString(), stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'test -f app.py', result: 'passed' }] }), stderr: '', stdoutPath: '', stderrPath: '', metaPath: '' };
  };
  runner.maxAttempts = 2;

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].responseOnly, true);
  assert.equal(calls[2].responseOnly, undefined);
  assert.equal(next.taskLedger[0].implementationRunId, 'full-retry');
  assert.match(readEvents(repo).find((event) => event.type === 'workflow_stage_format_repair_failed').error, /added or paraphrased claims/);
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
  assert.equal(session.taskLedger[0].attemptHistory.length, 1);
  assert.equal(session.taskLedger[0].attemptHistory[0].outcome, 'FAIL');
});

test('implementation rejects inspect-only deferrals and sends attempt history in retry context', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature');
  fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'prd-review', 'architecture', 'planning', 'critical-review', 'trd-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'feature-task',
      title: 'Feature task',
      description: 'Implement CLI behavior.',
      specialistId: 'python',
      acceptanceCriteria: ['CLI behavior works'],
      dependencies: [],
      status: 'planned',
      filesChanged: ['app.py'],
      validations: [],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run CLI.', expected: 'CLI succeeds.', evidenceMethod: 'Command output.' }]
    }]
  });
  const seenContexts = [];
  const runner = async ({ context }) => {
    seenContexts.push(context);
    if (seenContexts.length === 1) {
      return {
        runId: 'run-1',
        agentId: 'python',
        role: 'python',
        exitCode: 0,
        timedOut: false,
        completedAt: new Date().toISOString(),
        stdout: result('BLOCKED', { summary: 'Need to inspect current repo state before proceeding with implementation.' }),
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        metaPath: ''
      };
    }
    return {
      runId: 'run-2',
      agentId: 'python',
      role: 'python',
      exitCode: 0,
      timedOut: false,
      completedAt: new Date().toISOString(),
      stdout: result('PASS', { evidence: ['Checked approved PRD and TRD source-of-truth material against this task.'], filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }),
      stderr: '',
      stdoutPath: '',
      stderrPath: '',
      metaPath: ''
    };
  };
  runner.maxAttempts = 2;

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'code-review');
  assert.equal(next.taskLedger[0].status, 'implemented');
  assert.match(seenContexts[1], /IMPLEMENTATION RETRY CHECKLIST/);
  assert.match(seenContexts[1], /Implementation cannot return FAIL\/BLOCKED just to inspect/);
  assert.match(seenContexts[1], /Recent task attempt history/);
  assert.equal(next.taskLedger[0].attemptHistory.at(-1).outcome, 'PASS');
});

test('implementation rejects false write-access blockers and retries', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build CLI feature');
  fs.writeFileSync(path.join(repo, 'app.py'), 'VALUE = 1\n');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'feature-task',
    completedStages: ['intake', 'architecture', 'planning', 'critical-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [{
      id: 'feature-task',
      title: 'Feature task',
      description: 'Implement CLI behavior.',
      specialistId: 'python',
      acceptanceCriteria: ['CLI behavior works'],
      dependencies: [],
      status: 'planned',
      filesChanged: ['app.py'],
      validations: [],
      review: null,
      qa: null,
      blackBoxTestPlan: [{ name: 'CLI smoke', action: 'Run CLI.', expected: 'CLI succeeds.', evidenceMethod: 'Command output.' }]
    }]
  });
  const seenContexts = [];
  const runner = async ({ context }) => {
    seenContexts.push(context);
    if (seenContexts.length === 1) {
      return {
        runId: 'run-1',
        agentId: 'python',
        role: 'python',
        exitCode: 0,
        timedOut: false,
        completedAt: new Date().toISOString(),
        stdout: result('FAIL', {
          summary: 'Cannot implement because no write access is available and exec_command is unavailable.',
          evidence: ['Tried to use exec_command but tool access was not available.']
        }),
        stderr: '',
        stdoutPath: '',
        stderrPath: '',
        metaPath: ''
      };
    }
    return {
      runId: 'run-2',
      agentId: 'python',
      role: 'python',
      exitCode: 0,
      timedOut: false,
      completedAt: new Date().toISOString(),
      stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }),
      stderr: '',
      stdoutPath: '',
      stderrPath: '',
      metaPath: ''
    };
  };
  runner.maxAttempts = 2;

  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const next = readSession(repo);
  assert.equal(next.currentStage, 'code-review');
  assert.equal(next.taskLedger[0].status, 'implemented');
  assert.match(seenContexts[1], /Do not return FAIL or BLOCKED claiming missing write\/tool access/);
  assert.equal(next.taskLedger[0].attemptHistory[0].outcome, 'REJECTED');
  assert.equal(next.taskLedger[0].attemptHistory.at(-1).outcome, 'PASS');
});

test('implementation context includes completed dependency files and rejects false empty-repo blockers', async () => {
  const repo = createRepository();
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><canvas id="game"></canvas>\n');
  const session = newSession(repo, 'Build game in stages');
  writeSession(repo, {
    ...session,
    currentStage: 'implementation',
    currentTaskId: 'physics-task',
    completedStages: ['intake', 'prd-review', 'architecture', 'planning', 'critical-review', 'trd-review'],
    stageEvidence: { ...session.stageEvidence, intake: { result: { userConfirmed: true } } },
    taskLedger: [
      {
        id: 'game-loop-task',
        title: 'Game loop',
        description: 'Build the game loop.',
        specialistId: 'python',
        acceptanceCriteria: ['Game loop exists'],
        dependencies: [],
        status: 'qa-passed',
        filesChanged: ['index.html'],
        validations: [{ command: 'test -f index.html', result: 'passed' }],
        review: { outcome: 'PASS' },
        qa: { outcome: 'PASS', checks: [{ name: 'Game loop smoke', status: 'PASS', expected: 'Game loop exists.', actual: 'Game loop existed.', evidence: 'Runtime smoke passed.' }] },
        blackBoxTestPlan: [{ name: 'Game loop smoke', action: 'Open app.', expected: 'Game loop runs.', evidenceMethod: 'Runtime output.' }],
        implementationRunId: 'run-game-loop',
        integration: { integrated: true }
      },
      {
        id: 'physics-task',
        title: 'Physics',
        description: 'Implement ball physics.',
        specialistId: 'python',
        acceptanceCriteria: ['Physics works'],
        dependencies: ['game-loop-task'],
        status: 'planned',
        filesChanged: [],
        validations: [],
        review: null,
        qa: null,
        blackBoxTestPlan: [{ name: 'Physics smoke', action: 'Run physics.', expected: 'Physics works.', evidenceMethod: 'Runtime output.' }]
      }
    ]
  });

  const assignment = getCurrentAssignment(repo);
  const context = JSON.parse(assignment.context);
  assert.equal(context.completedDependencyTasks[0].id, 'game-loop-task');
  assert.deepEqual(context.completedDependencyTasks[0].existingFiles, ['index.html']);

  await assert.rejects(advanceWorkflow({
    repo,
    timeoutSeconds: 300,
    runner: queuedRunner(repo, [
      { stdout: result('BLOCKED', { summary: 'Repository is empty — no source code exists yet. The dependency has not been built.' }) }
    ])
  }), /completed dependency files on disk: index\.html/);
});

test('processExists correctly identifies current and non-existent processes', () => {
  assert.equal(processExists(process.pid), true);
  assert.equal(processExists(0), false);
  assert.equal(processExists(-1), false);
  assert.equal(processExists(9999999), false);
});

test('concurrent advanceWorkflow calls join the single in-flight execution', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature');
  writeSession(repo, {
    ...session,
    currentStage: 'intake',
    stageEvidence: session.stageEvidence
  });

  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    await new Promise((r) => setTimeout(r, 100));
    return {
      runId: 'in-flight-run',
      agentId: 'analyst',
      role: 'analyst',
      exitCode: 0,
      timedOut: false,
      completedAt: new Date().toISOString(),
      stdout: result('PASS', { requirements: ['Feature requirement'], acceptanceCriteria: ['Requirement works'], questions: [], userConfirmed: true }),
      stderr: '',
      stdoutPath: '',
      stderrPath: '',
      metaPath: ''
    };
  };

  const [res1, res2] = await Promise.all([
    advanceWorkflow({ repo, runner, timeoutSeconds: 300 }),
    advanceWorkflow({ repo, runner, timeoutSeconds: 300 })
  ]);

  assert.equal(runnerCalls, 1);
  assert.equal(res1.result.outcome, 'PASS');
  assert.equal(res2.result.outcome, 'PASS');
  assert.equal(res1.run.runId, 'in-flight-run');
  assert.equal(res2.run.runId, 'in-flight-run');
  const finalSession = readSession(repo);
  assert.equal(finalSession.currentStage, 'prd-review');
  assert.equal(finalSession.activeRun, null);
});

test('orphaned activeRun lease from current process is recovered automatically', () => {
  const repo = createRepository();
  const session = newSession(repo, 'Build feature');
  writeSession(repo, {
    ...session,
    currentStage: 'intake',
    activeRun: {
      agentId: 'analyst',
      role: 'analyst',
      stage: 'intake',
      attempt: 1,
      ownerPid: process.pid,
      startedAt: new Date().toISOString()
    }
  });

  const assignment = getCurrentAssignment(repo);
  assert.equal(assignment.agentId, 'analyst');
  assert.equal(assignment.stage, 'intake');
  const recoveredSession = readSession(repo);
  assert.equal(recoveredSession.activeRun, null);
  assert.match(recoveredSession.lastFailure, /Recovered orphaned active-run lease/);
});

test('advanceWorkflow returns inProgress status cleanly when exceeding bounded maxWaitSeconds', async () => {
  const repo = createRepository();
  const session = newSession(repo, 'Long-running analysis');
  writeSession(repo, {
    ...session,
    currentStage: 'intake',
    stageEvidence: session.stageEvidence
  });

  let resolveRunner;
  const runnerPromise = new Promise((resolve) => {
    resolveRunner = resolve;
  });

  const runner = async () => {
    return await runnerPromise;
  };

  // First advance with 0.1s max wait -> should return inProgress: true
  const firstCall = await advanceWorkflow({
    repo,
    runner,
    maxWaitSeconds: 0.1,
    timeoutSeconds: 300
  });

  assert.equal(firstCall.inProgress, true);
  assert.equal(firstCall.assignment.stage, 'intake');
  assert.equal(firstCall.assignment.agentId, 'analyst');
  assert.equal(typeof firstCall.elapsedSeconds, 'number');

  // Verify the activeRun is still recorded on disk
  const midSession = readSession(repo);
  assert.notEqual(midSession.activeRun, null);
  assert.equal(midSession.activeRun.stage, 'intake');

  // Complete the underlying runner
  resolveRunner({
    runId: 'long-run-1',
    agentId: 'analyst',
    role: 'analyst',
    exitCode: 0,
    timedOut: false,
    completedAt: new Date().toISOString(),
    stdout: result('PASS', { requirements: ['Req 1'], acceptanceCriteria: ['Works'], questions: [], userConfirmed: true }),
    stderr: '',
    stdoutPath: '',
    stderrPath: '',
    metaPath: ''
  });

  // Second advance with normal wait -> attaches and receives final completed result
  const secondCall = await advanceWorkflow({
    repo,
    runner,
    maxWaitSeconds: 2,
    timeoutSeconds: 300
  });

  assert.equal(secondCall.inProgress, undefined);
  assert.equal(secondCall.result.outcome, 'PASS');
  assert.equal(secondCall.run.runId, 'long-run-1');
  const finalSession = readSession(repo);
  assert.equal(finalSession.currentStage, 'prd-review');
  assert.equal(finalSession.activeRun, null);
});




test('structured stage schemas and timeout bounds are enforced', () => {
  const awaiting = parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need clarification', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['What platform should we target?'], userConfirmed: false }));
  assert.equal(awaiting.outcome, 'AWAITING_USER');
  assert.equal(awaiting.userConfirmed, false);
  assert.throws(() => parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need final confirmation', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['Do you confirm that these finalized requirements and acceptance criteria are complete and correct?'], userConfirmed: false })), /PRD Review owns explicit full-document approval/);
  const concreteConfirmation = parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need target platform', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['Can you confirm the target platform: browser or desktop?'], userConfirmed: false }));
  assert.equal(concreteConfirmation.questions[0], 'Can you confirm the target platform: browser or desktop?');
  assert.throws(() => parseStageResult('intake', JSON.stringify({ outcome: 'PASS', summary: 'Incomplete intake', evidence: ['User asked for a feature'], requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [], userConfirmed: true })), /goals/);
  const intake = parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [], userConfirmed: true }));
  assert.equal(intake.goals[0], 'Deliver the requested user-visible outcome.');
  assert.equal(intake.successMetrics[0], 'Acceptance criteria pass through observable behavior.');
  assert.throws(() => parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: ['Still unclear'], userConfirmed: false })), /cannot PASS/i);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [] })), /non-empty array/);
  const plannerOwnedScope = parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }));
  assert.deepEqual(plannerOwnedScope.tasks[0].blackBoxTestPlan, []);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'source check', action: 'grep src/audio.js line 49', expected: 'Function should call toggleMute.', evidenceMethod: 'Source inspection.' }] }] })), /black-box test plan only/);
  const planned = parseStageResult('planning', result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [], blackBoxTestPlan: [{ name: 'runtime behavior', action: 'Run the feature through the public interface.', expected: 'The expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }] }));
  assert.equal(planned.tasks[0].blackBoxTestPlan[0].action, 'Run the feature through the public interface.');
  const qaPlanned = parseStageResult('qa-planning', result('PASS', { taskTestPlans: [{ taskId: 'feature-task', tests: [{ name: 'runtime behavior', covers: ['Works'], action: 'Run the feature through the public interface.', expected: 'The expected behavior is observable.', evidenceMethod: 'Runtime test output.' }] }], regressionStrategy: ['Retain the test for regression.'], coverageNotes: ['The task acceptance criterion is covered.'] }));
  assert.deepEqual(qaPlanned.taskTestPlans[0].tests[0].covers, ['Works']);
  assert.throws(() => parseStageResult('qa-planning', result('PASS', { taskTestPlans: [{ taskId: 'feature-task', tests: [{ name: 'runtime behavior', covers: [], action: 'Run it.', expected: 'It works.', evidenceMethod: 'Runtime output.' }] }], regressionStrategy: ['Retain it.'], coverageNotes: ['Covered.'] })), /covers must not be empty/);
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
  const failedQaPlanReview = parseStageResult('critical-review', result('FAIL', { findings: [{ id: 'F1', severity: 'MAJOR', description: 'Test coverage issue', recommendation: 'Repair the QA plan' }], repairStage: 'qa-planning' }));
  assert.equal(failedQaPlanReview.repairStage, 'qa-planning');
  const passedCritical = parseStageResult('critical-review', result('PASS', { findings: [], repairStage: 'none' }));
  assert.equal(passedCritical.repairStage, 'none');
  assert.throws(() => parseStageResult('critical-review', result('PASS', { findings: [], repairStage: 'planning' })), /repairStage to none/);
  const qa = parseStageResult('qa', result('PASS', { checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }], automationAttempts: [], manualChecks: [] }));
  assert.equal(qa.checks[0].expected, 'The app starts.');
  assert.throws(() => parseStageResult('qa', result('PASS', { checks: [{ name: 'runtime smoke', status: 'PASS', evidence: 'Runtime command exited 0.' }], automationAttempts: [], manualChecks: [] })), /expected/);
  const advisoryOnlyLocalhostQa = parseStageResult('qa', result('PASS_WITH_MANUAL_VALIDATION', { evidence: ['Runtime smoke passed; visual check remains.'], checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }], automationAttempts: [{ command: 'playwright smoke', result: 'passed', covers: ['runtime smoke'], fallbackReason: '' }], manualChecks: ['Human-only because final visual inspection is subjective: open http://127.0.0.1:8765/ and inspect the game.'] }));
  assert.match(advisoryOnlyLocalhostQa.manualChecks[0], /127\.0\.0\.1/);
  const localhostQa = parseStageResult('qa', result('PASS_WITH_MANUAL_VALIDATION', { evidence: ['Runtime smoke passed; visual check remains.'], checks: [{ name: 'runtime smoke', status: 'PASS', expected: 'The app starts.', actual: 'The app started.', evidence: 'Runtime command exited 0.' }], automationAttempts: [{ command: 'start server with port 0, then playwright smoke', result: 'Server selected an available port; served page identity verified by title and content; server is still running and available for the human.', covers: ['runtime smoke'], fallbackReason: '' }], manualChecks: ['Human-only because final visual inspection is subjective: open http://127.0.0.1:43210/ and inspect the game.'] }));
  assert.match(localhostQa.manualChecks[0], /127\.0\.0\.1/);
  assert.throws(() => parseStageResult('qa', result('FAIL', { evidence: ['Runtime assertion failed.'], checks: [{ name: 'audio toggle', status: 'FAIL', expected: 'Audio should mute after clicking the toggle.', actual: 'src/audio.js line 49 should call toggleMute().', evidence: 'Source inspection found missing call.' }], automationAttempts: [], manualChecks: [] })), /black-box behavior only/);
  assert.equal(normalizeTimeoutSeconds(1), 28800);
  assert.equal(normalizeTimeoutSeconds(300), 28800);
  assert.equal(normalizeTimeoutSeconds(9000), 28800);
  assert.equal(normalizeTimeoutSeconds(undefined), 28800);
  assert.throws(() => normalizeTimeoutSeconds('not-a-number'), /finite number/);
});

test('Analyst Intake completes after clarifications and leaves full approval to PRD Review', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a game');
  const calls = [];
  const queued = queuedRunner(repo, [
    { stdout: JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need platform decision', evidence: ['User requirements are incomplete'], requirements: [], acceptanceCriteria: [], questions: ['Should this be browser-based?'], userConfirmed: false }) },
    { stdout: result('PASS', { requirements: ['Browser game'], acceptanceCriteria: ['Runs in a browser'], questions: [], userConfirmed: true }) },
    { stdout: result('PASS', { design: ['Use a browser game architecture'], hasUserInterface: false, specialistNeeds: [] }) }
  ]);
  const runner = async (args) => {
    calls.push(args);
    return queued(args);
  };

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
  assert.match(calls[1].task, /Do not ask for generic final confirmation/);
  assert.match(calls[1].task, /PRD Review is the sole full-document approval gate/);
  assert.doesNotMatch(calls[1].task, /EXPLICITLY confirmed complete requirements/);
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
  assert.ok(prompt.includes("<<'AITEAM_EOF'"), 'prompt must require a literal quoted AITEAM_EOF heredoc marker');
  assert.ok(prompt.includes('>>'), 'prompt must include append (>>) mode for subsequent chunks');
  assert.ok(prompt.includes('wc -l'), 'prompt must instruct verification with wc -l after chunked write');
  assert.match(prompt, /language syntax checker\/compiler/);
  assert.match(prompt, /Do not search for unavailable editing tools/);
  assert.match(prompt, /nested `bash -lc`, `python -c`, base64, long echo chains/);
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

test('parseStageResult unwraps agy envelope with structured_output or response', () => {
  const agyStructured = JSON.stringify({
    conversation_id: 'test-conv-id',
    status: 'COMPLETED',
    response: 'Here is the result',
    structured_output: {
      outcome: 'PASS',
      summary: 'Intake parsed successfully from agy envelope',
      evidence: ['Verified from agy schema output'],
      goals: ['Test goal'],
      targetUsers: ['Test users'],
      userStories: ['As a user, I want tests'],
      requirements: ['Must support agy envelopes'],
      acceptanceCriteria: ['Passes parseStageResult'],
      mvpScope: ['Unwrap structured_output'],
      outOfScope: [],
      assumptions: [],
      constraints: [],
      nonFunctionalRequirements: [],
      successMetrics: ['100% test pass'],
      risks: [],
      questions: [],
      userConfirmed: true
    }
  });

  const parsed = parseStageResult('intake', agyStructured);
  assert.equal(parsed.outcome, 'PASS');
  assert.equal(parsed.summary, 'Intake parsed successfully from agy envelope');
  assert.deepEqual(parsed.goals, ['Test goal']);
});

test('parseStageResult normalizes single strings to string arrays for array fields', () => {
  const readinessOutput = JSON.stringify({
    outcome: 'AWAITING_USER',
    summary: 'Need human assistance for missing credentials',
    evidence: ['Observed tool probe failures.'],
    capabilities: [{
      id: 'oracle-db',
      requiredBy: 'architecture',
      selectedTool: 'sqlplus',
      probeCommand: 'sqlplus /nolog',
      status: 'VERIFIED',
      version: '19.3',
      executablePath: 'C:\\bin\\sqlplus.exe',
      evidence: 'SQLPlus started.'
    }],
    fileOperations: {
      workspaceWriteVerified: true,
      tempDirectory: '.aiteam-probe',
      writeMethod: 'fs write',
      syntaxCheckVerified: true,
      syntaxCheckCommand: 'node -c',
      evidence: 'Write/read round trip verified.'
    },
    missingTools: [{
      tool: 'Oracle DEV access',
      capability: 'Database validation',
      whyNeeded: 'Run PL/SQL tests',
      detectedProblem: 'ORA-01017',
      alternativesTried: 'Direct connection',
      installInstructions: 'Grant user access',
      verificationCommand: 'sqlplus user/pass@dev',
      requiresHuman: true
    }],
    questions: 'Please grant user access to DEV database.'
  });

  const parsed = parseStageResult('environment-readiness', readinessOutput);
  assert.equal(parsed.outcome, 'AWAITING_USER');
  assert.deepEqual(parsed.capabilities[0].requiredBy, ['architecture']);
  assert.deepEqual(parsed.missingTools[0].alternativesTried, ['Direct connection']);
  assert.deepEqual(parsed.missingTools[0].installInstructions, ['Grant user access']);
  assert.deepEqual(parsed.questions, ['Please grant user access to DEV database.']);
});


