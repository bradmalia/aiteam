import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advanceWorkflow, completeWorkflow, normalizeTimeoutSeconds, parseStageResult } from '../src/workflow.mjs';
import { newSession, readSession } from '../src/state.mjs';
import { callTool } from '../src/server.mjs';
import { getAgent } from '../src/registry.mjs';

function createRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-workflow-'));
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
    { stdout: result('PASS', { design: ['Use one Python module'], specialistNeeds: [] }) },
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

test('review failure routes the same task back to implementation', async () => {
  const repo = createRepository();
  newSession(repo, 'Build feature');
  const runner = queuedRunner(repo, [
    { stdout: result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: [] }) },
    { stdout: result('PASS', { design: ['Module'], specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
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
    { stdout: result('PASS', { design: ['Phaser architecture'], specialistNeeds: [{ capability: 'Phaser', reason: 'No built-in web specialist', suggestedId: 'phaser-programmer' }] }) },
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
    { stdout: result('PASS', { design: ['Module'], specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['app.py'], validations: [] }), write: { path: 'app.py', content: 'VALUE = 1\n' } },
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
    { stdout: result('PASS', { design: ['Module'], specialistNeeds: [] }) },
    { stdout: result('PASS', { tasks: [{ id: 'feature-task', title: 'Feature', description: 'Implement', specialistId: 'python', acceptanceCriteria: ['Works'], dependencies: [] }] }) },
    { stdout: result('PASS', { findings: [] }) },
    { stdout: result('PASS', { filesChanged: ['missing.py'], validations: [] }) }
  ]);
  for (let i = 0; i < 4; i += 1) await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  await assert.rejects(advanceWorkflow({ repo, runner, timeoutSeconds: 300 }), /not visible in the server workspace/);
  assert.equal(readSession(repo).currentStage, 'implementation');
});

test('structured stage schemas and timeout bounds are enforced', () => {
  const awaiting = parseStageResult('intake', JSON.stringify({ outcome: 'AWAITING_USER', summary: 'Need clarification', evidence: [], requirements: [], acceptanceCriteria: [], questions: ['What platform should we target?'], userConfirmed: false }));
  assert.equal(awaiting.outcome, 'AWAITING_USER');
  assert.equal(awaiting.userConfirmed, false);
  assert.throws(() => parseStageResult('intake', result('PASS', { requirements: ['Feature'], acceptanceCriteria: ['Works'], questions: ['Still unclear'], userConfirmed: false })), /cannot PASS/i);
  assert.throws(() => parseStageResult('planning', result('PASS', { tasks: [] })), /non-empty array/);
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
    { stdout: result('PASS', { design: ['Use a browser game architecture'], specialistNeeds: [] }) }
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

test('a structured BLOCKED result stops the session without requiring pass-only fields', async () => {
  const repo = createRepository();
  newSession(repo, 'Ambiguous request');
  const runner = queuedRunner(repo, [{ stdout: JSON.stringify({ outcome: 'BLOCKED', summary: 'User decision required', evidence: [] }) }]);
  const advanced = await advanceWorkflow({ repo, runner, timeoutSeconds: 300 });
  assert.equal(advanced.session.status, 'BLOCKED');
  assert.equal(advanced.session.currentStage, 'intake');
  assert.equal(advanced.session.blockedReason, 'User decision required');
});
