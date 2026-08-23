import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRegistry, getAgent, buildAgentPrompt, registerScopedSpecialist } from '../src/registry.mjs';

function repository() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-specialist-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  return repo;
}

const provenance = { source: 'recruiter', runId: 'run-1', proposalId: 'proposal-1' };

test('registry includes core roles and specialists', () => {
  const registry = loadRegistry();
  const ids = new Set(registry.agents.map((a) => a.id));
  for (const id of ['analyst','architect','planner','critical-reviewer','recruiter','code-reviewer','qa','maintainer','godot-gdscript','oracle-plsql','sqlserver-tsql']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
});

test('agent prompt combines base and role contract', () => {
  const agent = getAgent('qa');
  const prompt = buildAgentPrompt(agent, 'Validate T3', 'Only current task');
  assert.match(prompt, /AITEAM Base Agent Contract/);
  assert.match(prompt, /# QA/);
  assert.match(prompt, /Validate T3/);
});

test('read-only prompts forbid temporary JSON file validation', () => {
  const agent = getAgent('analyst');
  const prompt = buildAgentPrompt(agent, 'Collect intake requirements', '{}', 'intake');
  assert.match(prompt, /must not write files anywhere, including `\/tmp`/);
  assert.match(prompt, /Do not create temporary JSON files/);
  assert.match(prompt, /Return the required JSON object directly/);
  assert.match(prompt, /Return the final structured JSON object directly/);
});

test('workflow-scoped specialists can be registered, resolved, and prompted', () => {
  const repo = repository();
  const specialist = registerScopedSpecialist(repo, {
    id: 'web-game-programmer',
    role: 'Web Game Programmer',
    sandbox: 'workspace-write',
    triggers: ['phaser', 'html5 game'],
    capabilities: ['TypeScript', 'Phaser'],
    contract: '# Web Game Programmer\n\nBuild browser games with TypeScript and Phaser. Inspect the repository, implement only assigned tasks, run focused validation, and report evidence.'
  }, { provenance });

  assert.equal(specialist.workflowScoped, true);
  assert.ok(fs.existsSync(path.join(repo, '.aiteam', 'specialists', 'web-game-programmer.json')));
  assert.ok(loadRegistry(repo).agents.some((agent) => agent.id === 'web-game-programmer'));
  const resolved = getAgent('web-game-programmer', repo);
  assert.equal(resolved.role, 'Web Game Programmer');
  assert.match(buildAgentPrompt(resolved, 'Build Pong'), /Build browser games with TypeScript and Phaser/);
});

test('workflow-scoped specialists cannot replace built-in agents', () => {
  const repo = repository();
  assert.throws(() => registerScopedSpecialist(repo, {
    id: 'analyst',
    role: 'Replacement Analyst',
    contract: 'Replace the built-in analyst with a workflow specialist that performs requirement analysis and reports evidence.'
  }, { provenance }), /Cannot replace built-in/);
});

test('workflow-scoped specialists require recruiter provenance and inline contracts', () => {
  const repo = repository();
  assert.throws(() => registerScopedSpecialist(repo, {
    id: 'web-game-programmer',
    role: 'Web Game Programmer',
    contract: 'Build web games with enough detail to otherwise pass the contract length validation requirement for this test.'
  }), /verified Recruiter proposal/);
  assert.throws(() => registerScopedSpecialist(repo, {
    id: 'web-game-programmer',
    role: 'Web Game Programmer',
    contract: 'agents/programmers/python.md'
  }, { provenance }), /at least 80 characters|not a file path/);
});
