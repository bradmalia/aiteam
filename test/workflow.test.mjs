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
  return JSON.stringify({ outcome, summary: `${outcome} result`, evidence: outcome === 'PASS' ? ['Observed repository evidence'] : [], ...extra });
}

function queuedRunner(repo, outputs) {
  let index = 0;
  return async ({ agentId }) => {
    const item = outputs[index++];
    if (!item) throw new Error(`Unexpected runner call ${index} for ${agentId}`);
    if (item.write) fs.writeFileSync(path.join(repo, item.write.path), item.write.content);
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

test('server-owned workflow enforces every gate and commits only QA-approved paths', async () => {
  const repo = createRepository();
  newSession(repo, 'Build a small Python feature');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'user work\n');
  execFileSync('git', ['-C', repo, 'add', 'unrelated.txt']);

  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Add feature'], acceptanceCriteria: ['Feature is validated'], questions: [] }) },
    { stdout: result('PASS', { design: ['Use one Python module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement feature', specialistId: 'python', acceptanceCriteria: ['app.py exists'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'compile', status: 'PASS', evidence: 'py_compile passed' }], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Implement validated feature' }) }
  ]);

  for (let i = 0; i < 8; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
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
    { stdout: result('PASS', { tasks: [{ id: 'ui-task', title: 'UI', description: 'Implement UI', specialistId: 'python', acceptanceCriteria: ['UI is responsive'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'responsive', status: 'PASS', evidence: 'validated' }], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Implement responsive UI' }) }
  ]);
  const runner = async (args) => {
    calls.push(args);
    return queued(args);
  };

  for (let index = 0; index < 9; index += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
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
    { stdout: result('PASS', { tasks: [{ id: 'verify-readme', title: 'Verify README', description: 'Verify existing file', specialistId: 'python', acceptanceCriteria: ['README is valid'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['README.md'], validations: [{ command: 'test -s README.md', result: 'passed' }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'README', status: 'PASS', evidence: 'file is non-empty' }], manualChecks: [] }) },
    { stdout: result('PASS', { commitMessage: 'Verify existing README' }) }
  ]);

  for (let index = 0; index < 8; index += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const ready = readSession(repo);
  assert.equal(ready.status, 'READY_TO_COMPLETE');
  assert.equal(ready.taskLedger[0].integration.reason, 'no_changes');
  assert.equal(ready.taskLedger[0].integration.integrated, true);
  assert.equal(completeWorkflow(repo).status, 'COMPLETE');
});

test('review failure routes the same task back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('FAIL', { findings: [{ id: 'F1', severity: 'MAJOR', location: 'app.py', impact: 'Wrong value', recommendation: 'Fix it' }] }) }
  ]);
  for (let i = 0; i < 6; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
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
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(readSession(repo).currentStage, 'recruiting');
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.currentStage, 'planning');
  assert.equal(getAgent('phaser-programmer', repo).provenance, undefined, 'normalized public registry omits storage metadata');
  const raw = JSON.parse(fs.readFileSync(path.join(repo, '.aiteam', 'specialists', 'phaser-programmer.json'), 'utf8'));
  assert.equal(raw.provenance.source, 'recruiter');
  assert.equal(raw.provenance.runId, 'run-3');
});

test('post-QA path changes invalidate approval and route back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { checks: [{ name: 'check', status: 'PASS', evidence: 'observed' }], manualChecks: [] }) }
  ]);
  for (let i = 0; i < 7; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
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
    { stdout: result('PASS', { tasks: [{ id: 'browser-task', title: 'Browser feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Looks correct'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [{ command: 'python -m py_compile app.py', result: 'passed' }] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS_WITH_MANUAL_VALIDATION', { evidence: ['Static checks passed'], checks: [{ name: 'browser', status: 'PASS', evidence: 'Static checks passed' }], manualChecks: ['Open the browser game and verify the canvas renders.'] }) }
  ]);
  for (let i = 0; i < 7; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
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
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['missing.py'], validations: [{ command: 'test -f missing.py', result: 'reported passed' }] }) }
  ]);
  for (let i = 0; i < 4; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await assert.rejects(advanceWorkflow({ repo, runner, timeoutSeconds: 300 }), /did not write files to disk/);
  assert.equal(readSession(repo).currentStage, 'implementation');
});

test('implementation FAIL routes to BLOCKED with retry instructions instead of staying stuck', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], hasUserInterface: false, specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('FAIL', { summary: 'Cannot run the command due to insufficient sandbox permissions.' }) }
  ]);
  for (let i = 0; i < 4; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  const session = readSession(repo);
  assert.equal(session.status, 'BLOCKED');
  assert.match(session.blockedReason, /Implementation specialist returned FAIL/);
  assert.match(session.blockedReason, /NOT a real sandbox restriction/);
});


test('structured stage schemas and timeout bounds are enforced', () => {
  const awaiting = parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need clarification', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['What platform should we target?'], userConfirmed: false }));
  assert.equal(awaiting.outcome, 'AWAITING_USER');
  assert.equal(awaiting.userConfirmed, false);
  assert.throws(() => parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: ['Still unclear'], userConfirmed: false })), /cannot PASS/i);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [] })), /non-empty array/);
  assert.throws(() => parseStageResult('architecture', result('PASS', { design: ['Module'], specialistNeeds: [] })), /hasUserInterface/);
  assert.throws(() => parseStageResult('ui-design', result('PASS', { theme: { palette: [], typography: [], spacing: [] }, screens: [], designTokens: [] })), /must not be empty|non-empty array/);
  assert.throws(() => parseStageResult('implementation', result('PASS', { filesChanged: ['app.py'], validations: [] })), /validations must be a non-empty array/);
  assert.throws(() => parseStageResult('critical-review', result('PASS', { findings: [{ id: 'F1', severity: 'MAJOR', description: 'Material issue', recommendation: 'Repair it' }] })), /cannot PASS/);
  assert.equal(normalizeTimeoutSeconds(1), 300);
  assert.equal(normalizeTimeoutSeconds(9000), 7200);
  assert.equal(normalizeTimeoutSeconds(undefined), 3600);
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
  assert.equal(intake.session.currentStage, 'architecture');
  assert.equal(intake.session.pendingUserInput, null);
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
