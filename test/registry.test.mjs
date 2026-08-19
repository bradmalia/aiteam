import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, getAgent, buildAgentPrompt } from '../src/registry.mjs';

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
