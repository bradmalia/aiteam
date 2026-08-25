import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { advanceResultText, callTool, getWatchPort, toolDefs } from '../src/server.mjs';

function createRepository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-guidance-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AITEAM Test']);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'aiteam@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
  execFileSync('git', ['-C', repo, 'add', 'README.md']);
  execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'Initial commit']);
  return repo;
}

test('MCP tool descriptions explain coordinator-driven execution', () => {
  const descriptions = Object.fromEntries(toolDefs.map((tool) => [tool.name, tool.description]));
  assert.match(descriptions.aiteam_start, /does not start background workers/i);
  assert.match(descriptions.aiteam_status, /must not be polled/i);
  assert.match(descriptions.aiteam_advance, /server-owned workflow gate/i);
  assert.match(descriptions.aiteam_spawn_agent, /Compatibility alias/i);
  assert.match(descriptions.aiteam_register_specialist, /successful Recruiter stage/i);
});

test('watch ports are deterministic, repository-specific, and validate overrides', () => {
  const first = getWatchPort('/tmp/aiteam-watch-one');
  assert.equal(first, getWatchPort('/tmp/aiteam-watch-one'));
  assert.notEqual(first, getWatchPort('/tmp/aiteam-watch-two'));
  assert.ok(first >= 4320 && first < 24320);

  const previous = process.env.AITEAM_WATCH_PORT;
  try {
    process.env.AITEAM_WATCH_PORT = 'not-a-port';
    assert.throws(() => getWatchPort('/tmp/aiteam-watch-invalid-override'), /integer between 1024 and 65535/);
  } finally {
    if (previous === undefined) delete process.env.AITEAM_WATCH_PORT;
    else process.env.AITEAM_WATCH_PORT = previous;
  }
});

test('awaiting-user results put the exact questions before any next-step guidance', () => {
  const session = {
    status: 'ACTIVE',
    currentStage: 'intake',
    phasePlan: ['intake', 'architecture'],
    pendingUserInput: {
      questions: ['How many points?', 'Show a menu?', 'Show both scores?'],
      response: null
    }
  };
  const text = advanceResultText({
    result: {
      outcome: 'AWAITING_USER',
      summary: 'Need clarification',
      manualChecks: []
    },
    session,
    workflow: {
      active: true,
      phase: 'Intake',
      remainingPhases: ['Architecture']
    },
    assignment: {
      session,
      agentId: 'analyst',
      role: 'Analyst',
      phase: 'Intake'
    }
  });
  assert.match(text, /^STOP CALLING TOOLS!/);
  assert.ok(text.indexOf('How many points?') < text.indexOf('AITEAM | Agent: Analyst (analyst) awaiting user'));
  assert.doesNotMatch(text, /Next enforced assignment:.*Architecture/);
  assert.doesNotMatch(text, /MANDATORY SAME-TURN ACTION/);
});

test('resumable advance results require another advance in the same turn', () => {
  const session = {
    status: 'ACTIVE',
    currentStage: 'planning',
    phasePlan: ['intake', 'architecture', 'planning', 'critical-review'],
    pendingUserInput: null
  };
  const text = advanceResultText({
    result: { outcome: 'PASS', summary: 'Architecture completed.', manualChecks: [] },
    session,
    workflow: { active: true, phase: 'Planning', remainingPhases: ['Critical Review'] },
    assignment: { session, agentId: 'architect', role: 'Architect', phase: 'Architecture' }
  });
  assert.match(text, /MANDATORY SAME-TURN ACTION/);
  assert.match(text, /call aiteam_advance immediately/);
  assert.match(text, /Do not end your turn after this update/);
});

test('start auto-runs the first specialist and status exposes the next gate', async () => {
  const repo = createRepository();
  const started = await callTool('aiteam_start', { repository: repo, request: 'Build Pong', auto_advance: false });
  const startText = started.content[0].text;

  assert.match(startText, /AITEAM is not autonomous/);
  assert.match(startText, /Immediately call aiteam_advance/);
  assert.match(startText, /Do not wait, sleep, repeatedly poll/);
  assert.match(startText, /REQUIRED USER-VISIBLE PHASE REPORTING/);
  assert.match(startText, /AITEAM \| Agent: <role> \(<agent_id>\) \| Phase:/);
  assert.match(startText, /Intake -> PRD Review -> Architecture -> optional UI\/UX Design -> Planning -> QA Test Planning -> Critical Review -> TRD Review -> Implementation -> Code Review -> QA Execution -> Integration/);
  assert.match(startText, /AITEAM advances synchronously/);
  assert.match(startText, /progress update is never a stopping point/i);
  assert.match(startText, /same assistant turn/i);
  assert.doesNotMatch(startText, /git add <files>|patch `aiteam\/agents/);
  assert.equal(started.structuredContent.coordinatorDirective.autonomous, false);
  assert.equal(started.structuredContent.coordinatorDirective.userProgressReporting.required, true);
  assert.match(started.structuredContent.coordinatorDirective.userProgressReporting.beforeEveryAdvance, /Remaining:/);
  assert.match(started.structuredContent.coordinatorDirective.userProgressReporting.afterEveryResult, /finished\|failed/);
  assert.equal(started.structuredContent.coordinatorDirective.requiredNextAction.tool, 'aiteam_advance');
  assert.equal(started.structuredContent.coordinatorDirective.requiredNextAction.recommendedAgentId, 'analyst');

  await assert.rejects(callTool('aiteam_start', { repository: repo, request: 'Bypass existing workflow' }), /already ACTIVE/);

  const status = await callTool('aiteam_status', { repository: repo });
  assert.match(status.content[0].text, /This status snapshot does not advance the workflow/);
  assert.match(status.content[0].text, /Immediately call aiteam_advance/);
  assert.equal(status.structuredContent.coordinatorDirective.autonomous, false);
});

test('coordinator cannot register an unverified specialist', async () => {
  const repo = createRepository();
  await callTool('aiteam_start', { repository: repo, request: 'Build Pong', auto_advance: false });
  await assert.rejects(callTool('aiteam_register_specialist', {
    repository: repo,
    proposal_id: 'invented',
    specialist: {
      id: 'web-game-programmer',
      role: 'Web Game Programmer',
      contract: 'Implement web games with Phaser and TypeScript while inspecting the repository, validating changes, and reporting concrete evidence.'
    }
  }), /no matching unregistered Recruiter proposal/);
});

test('status without a session does not invent an Analyst assignment', async () => {
  const repo = createRepository();
  const status = await callTool('aiteam_status', { repository: repo });
  assert.match(status.content[0].text, /NO ACTIVE AITEAM SESSION/);
  assert.equal(status.structuredContent.session, null);
  assert.equal(status.structuredContent.nextAssignment, null);
  assert.equal(status.structuredContent.coordinatorDirective.requiredNextAction, null);
});

test('MCP initialize returns facilitator instructions tailored to session presence', async () => {
  const { handle } = await import('../src/server.mjs');
  const repo = createRepository();
  const originalCwd = process.cwd();
  try {
    process.chdir(repo);
    const freshInit = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(freshInit.result.instructions);
    assert.match(freshInit.result.instructions, /AITEAM Facilitator Directive/);
    assert.match(freshInit.result.instructions, /aiteam_start/);
    assert.match(freshInit.result.instructions, /DO NOT answer or pass manual checks yourself/);

    // Now start a session and verify initialize returns active session directive
    await callTool('aiteam_start', { repository: repo, request: 'Build a game', auto_advance: false });
    const activeInit = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    assert.match(activeInit.result.instructions, /Active Session In Progress/);
    assert.match(activeInit.result.instructions, /Do NOT call aiteam_start/);
    assert.match(activeInit.result.instructions, /Call aiteam_advance immediately/);
    assert.match(activeInit.result.instructions, /Progress updates are not stopping points/);
    assert.match(activeInit.result.instructions, /same assistant turn/);
  } finally {
    process.chdir(originalCwd);
  }
});
