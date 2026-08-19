import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { callTool, toolDefs } from '../src/server.mjs';

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

test('start auto-runs the first specialist and status exposes the next gate', async () => {
  const repo = createRepository();
  const started = await callTool('aiteam_start', { repository: repo, request: 'Build Pong', auto_advance: false });
  const startText = started.content[0].text;

  assert.match(startText, /AITEAM is not autonomous/);
  assert.match(startText, /Immediately call aiteam_advance/);
  assert.match(startText, /Do not wait, sleep, repeatedly poll/);
  assert.match(startText, /REQUIRED USER-VISIBLE PHASE REPORTING/);
  assert.match(startText, /AITEAM \| Agent: <role> \(<agent_id>\) \| Phase:/);
  assert.match(startText, /Intake -> Architecture -> Planning -> Critical Review -> Implementation -> Code Review -> QA -> Integration/);
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
