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
  for (const id of ['analyst','architect','planner','qa-planner','critical-reviewer','environment-readiness','recruiter','code-reviewer','qa','maintainer','godot-gdscript','oracle-plsql','sqlserver-tsql']) {
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
  assert.match(prompt, /Do not ask a generic final confirmation/);
  assert.match(prompt, /PRD Review is the sole full-document approval gate/);
  assert.match(prompt, /does not mean the user approved the complete generated requirements document/);
});

test('planner prompt requires implementation-ready task planning discipline', () => {
  const agent = getAgent('planner');
  const prompt = buildAgentPrompt(agent, 'Create implementation task ledger', '{}', 'planning');
  assert.match(prompt, /exact definition of done/);
  assert.match(prompt, /dependencies are explicit and minimal/);
  assert.match(prompt, /risky handoffs/);
  assert.match(prompt, /practical contingency/);
  assert.match(prompt, /QA Test Planning stage owns the black-box and regression test plan/);
  assert.match(prompt, /Do not include `blackBoxTestPlan` in Planner output/);
});

test('QA Test Planner owns pre-implementation coverage without executing tests', () => {
  const agent = getAgent('qa-planner');
  const prompt = buildAgentPrompt(agent, 'Create the QA test plan', '{}', 'qa-planning');
  assert.match(prompt, /Create the pre-implementation black-box test plan/);
  assert.match(prompt, /exactly one `taskTestPlans` entry/);
  assert.match(prompt, /union of `covers`.*every acceptance criterion exactly as written/);
  assert.match(prompt, /Do not run the application, inspect source code, modify files/);
  assert.match(prompt, /requiredCapabilities/);
  assert.match(prompt, /rather than requiring one framework/);
});

test('Environment Readiness verifies capabilities and hands unsafe installation to the human', () => {
  const agent = getAgent('environment-readiness');
  const prompt = buildAgentPrompt(agent, 'Verify approved capabilities', '{"pendingUserInput":{"response":"installed"}}', 'environment-readiness');
  assert.equal(agent.sandbox, 'workspace-write');
  assert.match(prompt, /do not trust the statement as proof/i);
  assert.match(prompt, /actual browser can start and close/i);
  assert.match(prompt, /create, read, syntax-check where applicable, and delete round trip/i);
  assert.match(prompt, /Never run `sudo`/);
  assert.match(prompt, /AWAITING_USER/);
  assert.match(prompt, /FINAL ENVIRONMENT READINESS ORDER/);
  assert.ok(prompt.indexOf('FINAL ENVIRONMENT READINESS ORDER') > prompt.indexOf('Coordinator Context'));
});

test('shared and coordinator contracts preserve orchestration discipline', () => {
  const base = fs.readFileSync(path.join(process.cwd(), 'agents', 'base.md'), 'utf8');
  const coordinator = fs.readFileSync(path.join(process.cwd(), 'agents', 'coordinator.md'), 'utf8');
  assert.match(base, /smallest repository slice needed/);
  assert.match(base, /Preserve auditability/);
  assert.match(base, /security, data integrity, accessibility, and destructive operations/);
  assert.match(base, /If task wording contains an internal conflict/);
  assert.match(base, /prioritize the user-visible acceptance criteria/);
  assert.match(base, /Run an existing runtime test or recorded validation command first/);
  assert.match(base, /pageerror` and console-error listeners/);
  assert.match(base, /QA is NOT required to create or edit a file before testing/);
  assert.match(base, /environmentProfile/);
  assert.match(coordinator, /Coordinate the workflow; do not manage the work/);
  assert.match(coordinator, /Do not diagnose specialist failures from memory or speculation/);
  assert.match(coordinator, /Report only what AITEAM returned/);
  assert.match(coordinator, /Environment Readiness/);
});

test('code reviewer contract requires source review checklist without replacing QA', () => {
  const agent = getAgent('code-reviewer');
  const prompt = buildAgentPrompt(agent, 'Review task', '{}', 'code-review');
  assert.match(prompt, /Correctness: logic satisfies/);
  assert.match(prompt, /Security and data safety/);
  assert.match(prompt, /Performance and reliability/);
  assert.match(prompt, /must not claim black-box user behavior passes/);
  assert.match(prompt, /Prefer fewer, higher-confidence findings/);
  assert.match(prompt, /must be anchored to at least one concrete authority/);
  assert.match(prompt, /Do NOT invent replacement formulas/);
  assert.match(prompt, /prioritize the acceptance criteria/);
  assert.match(prompt, /representative boundary and midpoint inputs/);
  assert.match(prompt, /Apply the same inputs to any proposed replacement/);
  assert.match(prompt, /prior findings as hypotheses/);
});

test('QA contract requires owned local test ports in manual checks', () => {
  const agent = getAgent('qa');
  const prompt = buildAgentPrompt(agent, 'Validate browser task', '{}', 'qa');
  assert.match(prompt, /do not use a hard-coded port/i);
  assert.match(prompt, /system browser instead of switching to fragile Puppeteer cache-path imports/i);
  assert.match(prompt, /Do not write ad hoc browser tests that import `puppeteer-core` from `.npm\/_npx`/);
  assert.match(prompt, /Do not put temporary localhost URLs in `manualChecks`/);
  assert.match(prompt, /server is expected to remain available for the human/);
  assert.match(prompt, /Prior Test Reuse Is Mandatory/);
  assert.match(prompt, /every listed `regressionTests\[\]\.id` is a required regression obligation/);
  assert.match(prompt, /strongest available black-box method/);
  assert.match(prompt, /No particular framework is mandatory/);
  assert.match(prompt, /BLOCKED` is reserved for a concrete external limitation/);
  assert.match(prompt, /run the existing test runners and each applicable command already recorded in `currentTask\.validations`/);
  assert.match(prompt, /failed compound discovery command is not proof that a tool is unavailable/);
  assert.match(prompt, /Do not use `which browser-a browser-b && check-package`/);
  assert.match(prompt, /Never use `pip --break-system-packages`/);
  assert.match(prompt, /do not nest `bash -lc`, `python -c`, base64 generation, long `echo` chains/);
  assert.match(prompt, /After two failed attempts to write or parse a helper/);
  assert.match(prompt, /FINAL QA EXECUTION ORDER/);
  assert.ok(prompt.lastIndexOf('FINAL QA EXECUTION ORDER') > prompt.lastIndexOf('# Coordinator Context'));
  assert.doesNotMatch(prompt, /first try Playwright/);
});

test('programmer specialist contracts include language-specific validation expectations', () => {
  const expectations = [
    ['python', /Python-specific expectations/, /standard-library solutions/, /targeted unit tests/],
    ['java', /Java-specific expectations/, /public method signatures/, /concurrency/],
    ['dotnet-csharp', /\.NET\/C#-specific expectations/, /nullable-reference-type policy/, /async\/await/],
    ['godot-gdscript', /Godot\/GDScript-specific expectations/, /scene tree/, /_physics_process/],
    ['oracle-plsql', /Oracle PL\/SQL-specific expectations/, /package specs/, /commits\/rollbacks/],
    ['sqlserver-tsql', /SQL Server\/T-SQL-specific expectations/, /XACT_ABORT/, /sargability/]
  ];
  for (const [id, heading, first, second] of expectations) {
    const agent = getAgent(id);
    const prompt = buildAgentPrompt(agent, 'Implement assigned task', '{}', 'implementation');
    assert.match(prompt, heading);
    assert.match(prompt, first);
    assert.match(prompt, second);
    assert.match(prompt, /Run relevant tests\/toolchain checks/);
  }
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

test('repo-scoped specialists do not leak through the global specialist registry', () => {
  const previousGlobalDir = process.env.AITEAM_GLOBAL_SPECIALIST_DIR;
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-global-specialists-'));
  process.env.AITEAM_GLOBAL_SPECIALIST_DIR = globalDir;
  try {
    registerScopedSpecialist(null, {
      id: 'global-web-game-programmer',
      role: 'Global Web Game Programmer',
      sandbox: 'workspace-write',
      triggers: ['legacy web game'],
      capabilities: ['TypeScript', 'Phaser'],
      contract: 'Build legacy Phaser games only when explicitly registered for the current workflow and never satisfy unrelated repository-scoped capability gaps.'
    }, { provenance });
    const repo = repository();
    assert.equal(getAgent('global-web-game-programmer', null)?.role, 'Global Web Game Programmer');
    assert.equal(getAgent('global-web-game-programmer', repo), null);
  } finally {
    if (previousGlobalDir === undefined) delete process.env.AITEAM_GLOBAL_SPECIALIST_DIR;
    else process.env.AITEAM_GLOBAL_SPECIALIST_DIR = previousGlobalDir;
  }
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
