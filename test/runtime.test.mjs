import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAgentInvocation, buildAgyInvocation, buildCodexInvocation, detectRunner, outputSchemaPath, redactInvocationArgs, runAgent } from '../src/runtime.mjs';

test('runner detection honors explicit selection and host markers', () => {
  assert.equal(detectRunner({ AITEAM_RUNNER: 'agy', CODEX_HOME: '/tmp/codex' }), 'agy');
  assert.equal(detectRunner({ AITEAM_RUNNER: 'codex', ANTIGRAVITY_AGENT: 'present' }), 'codex');
  assert.equal(detectRunner({ ANTIGRAVITY_AGENT: 'present' }), 'agy');
  assert.equal(detectRunner({ ANTIGRAVITY_PROJECT_ID: 'present' }), 'agy');
  assert.equal(detectRunner({ ANTIGRAVITY_LS_ADDRESS: 'present' }), 'agy');
  assert.equal(detectRunner({ AITEAM_CODEX_BIN: 'codex' }), 'codex');
  assert.equal(detectRunner({ CODEX_HOME: '/tmp/codex' }), 'codex');
  assert.equal(detectRunner({ CODEX_THREAD_ID: 'thread-id' }), 'codex');
  assert.throws(() => detectRunner({ AITEAM_RUNNER: 'unknown' }), /must be either/);
});

test('an unmarked MCP host defaults to Codex', () => {
  assert.equal(detectRunner({}), 'codex');
});

test('the unmarked Codex fallback uses the V100 provider and Qwen defaults', () => {
  const childHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-default-v100-')), 'codex-home');
  const invocation = buildAgentInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: { AITEAM_CODEX_HOME: childHome }
  });

  assert.equal(invocation.command, 'codex');
  assert.ok(invocation.args.includes('model_provider="v100_ollama"'));
  assert.ok(invocation.args.includes('model_providers.v100_ollama.base_url="http://192.168.122.50:11434/v1/"'));
  assert.ok(invocation.args.includes('v100-qwen3.6-codex-256k'));
});

test('Agy invocations enforce read-only and writable specialist boundaries', () => {
  const readOnly = buildAgyInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Review the project',
    outputSchemaPath: '/tmp/result.schema.json',
    stage: 'architecture',
    env: { AITEAM_AGY_BIN: 'agy' }
  });
  assert.ok(readOnly.args.includes('--sandbox'));
  assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('--mode'), readOnly.args.indexOf('--mode') + 2), ['--mode', 'plan']);
  assert.ok(!readOnly.args.includes('--dangerously-skip-permissions'));
  assert.ok(readOnly.args.includes('--output-format'));
  assert.ok(readOnly.args.includes('json'));
  assert.ok(readOnly.args.includes('/tmp/result.schema.json'));

  const writable = buildAgyInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the task',
    outputSchemaPath: '/tmp/result.schema.json',
    stage: 'implementation',
    env: { AITEAM_AGY_BIN: 'agy' }
  });
  assert.ok(writable.args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(writable.args.slice(writable.args.indexOf('--mode'), writable.args.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  assert.ok(!writable.args.includes('--sandbox'));
  assert.ok(!writable.args.includes('--json-schema'));

  const reportingRetry = buildAgyInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Report the implemented task',
    outputSchemaPath: '/tmp/result.schema.json',
    stage: 'implementation',
    enforceSchema: true,
    env: { AITEAM_AGY_BIN: 'agy' }
  });
  assert.ok(reportingRetry.args.includes('--json-schema'));
  assert.ok(reportingRetry.args.includes('/tmp/result.schema.json'));
});

test('run metadata redacts prompts regardless of runner argument ordering', () => {
  const prompt = 'private specialist prompt';
  assert.deepEqual(
    redactInvocationArgs(['--add-dir', '/tmp/repo', `-p=${prompt}`, '--output-format', 'json'], prompt),
    ['--add-dir', '/tmp/repo', '<prompt omitted>', '--output-format', 'json']
  );
  assert.deepEqual(redactInvocationArgs(['exec', prompt], prompt), ['exec', '<prompt omitted>']);
});

test('architecture and UI-design output schemas contain their routing and deliverable fields', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const architecture = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'architecture', 'architecture'), 'utf8'));
  const ui = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'ui-design', 'ui-design'), 'utf8'));
  assert.equal(architecture.properties.hasUserInterface.type, 'boolean');
  assert.ok(architecture.required.includes('hasUserInterface'));
  assert.ok(architecture.required.includes('qualityAttributes'));
  assert.ok(architecture.required.includes('buildingBlocks'));
  assert.ok(architecture.required.includes('runtimeScenarios'));
  assert.ok(architecture.required.includes('architectureDecisions'));
  assert.deepEqual(architecture.properties.qualityAttributes.items.required, ['name', 'scenario', 'measure']);
  assert.deepEqual(architecture.properties.buildingBlocks.items.required, ['name', 'responsibility', 'interfaces']);
  assert.deepEqual(architecture.properties.architectureDecisions.items.required, ['decision', 'optionsConsidered', 'rationale', 'consequences']);
  assert.deepEqual(ui.properties.theme.required, ['palette', 'typography', 'spacing']);
  assert.ok(ui.required.includes('userFlows'));
  assert.ok(ui.required.includes('usabilityRisks'));
  assert.ok(ui.required.includes('accessibilityHeuristics'));
  assert.ok(ui.required.includes('validationHypotheses'));
  assert.deepEqual(ui.properties.userFlows.items.required, ['name', 'actor', 'goal', 'steps']);
  assert.deepEqual(ui.properties.validationHypotheses.items.required, ['hypothesis', 'validationMethod', 'successSignal']);
  assert.ok(ui.required.includes('screens'));
  assert.ok(ui.required.includes('designTokens'));
});

test('recruiting output schema requires gap evaluation fields', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-recruiting-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const recruiting = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'recruiting', 'recruiting'), 'utf8'));
  assert.ok(recruiting.required.includes('gapJustification'));
  assert.ok(recruiting.required.includes('existingSpecialistAssessment'));
  assert.ok(recruiting.required.includes('evaluationCriteria'));
  assert.ok(recruiting.required.includes('specialist'));
});

test('critical-review output schema requires simple repairStage enum for model compatibility', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-critical-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const schema = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'critical-review', 'critical-review'), 'utf8'));
  assert.ok(schema.required.includes('findings'));
  assert.ok(schema.required.includes('repairStage'));
  assert.equal(schema.properties.repairStage.type, 'string');
  assert.deepEqual(schema.properties.repairStage.enum, ['architecture', 'planning', 'none']);
});

test('child Codex invocation uses launcher-selected version, provider, model, and isolated home', () => {
  const childHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-child-')), 'codex-home');
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: {
      PATH: process.env.PATH,
      AITEAM_CODEX_BIN: 'npx',
      AITEAM_CODEX_PREFIX_ARGS_JSON: '["-y","@openai/codex@0.116.0"]',
      AITEAM_CODEX_HOME: childHome,
      AITEAM_CODEX_MODEL: 'v100-qwen3.6-codex-256k',
      AITEAM_CODEX_PROVIDER: 'v100_ollama',
      AITEAM_CODEX_PROVIDER_NAME: 'V100 Ollama',
      AITEAM_CODEX_BASE_URL: 'http://192.168.122.50:11434/v1',
      AITEAM_CODEX_WIRE_API: 'responses',
      AITEAM_CODEX_REQUIRES_OPENAI_AUTH: 'false',
      AITEAM_CODEX_CONTEXT_WINDOW: '262144',
      AITEAM_CODEX_AUTO_COMPACT_LIMIT: '229376'
    }
  });

  assert.equal(invocation.command, 'npx');
  assert.deepEqual(invocation.args.slice(0, 3), ['-y', '@openai/codex@0.116.0', 'exec']);
  assert.ok(invocation.args.includes('model_provider="v100_ollama"'));
  assert.ok(invocation.args.includes('model_providers.v100_ollama.base_url="http://192.168.122.50:11434/v1"'));
  assert.ok(invocation.args.includes('model_providers.v100_ollama.requires_openai_auth=false'));
  assert.ok(invocation.args.includes('v100-qwen3.6-codex-256k'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdinText, 'Analyze requirements');
  assert.ok(!invocation.args.includes('Analyze requirements'));
  assert.equal(invocation.childEnv.CODEX_HOME, childHome);
  assert.ok(fs.existsSync(childHome));
});

test('invalid child prefix arguments fail with a clear configuration error', () => {
  assert.throws(() => buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: { AITEAM_CODEX_PREFIX_ARGS_JSON: 'not-json' }
  }), /must be a JSON array of strings/);
});

test('custom Codex providers do not have authentication disabled implicitly', () => {
  const childHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-custom-provider-')), 'codex-home');
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: {
      AITEAM_CODEX_HOME: childHome,
      AITEAM_CODEX_PROVIDER: 'custom_provider',
      AITEAM_CODEX_MODEL: 'custom-model'
    }
  });
  assert.ok(!invocation.args.some((arg) => arg.includes('requires_openai_auth')));
  assert.throws(() => buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: {
      AITEAM_CODEX_HOME: childHome,
      AITEAM_CODEX_REQUIRES_OPENAI_AUTH: 'sometimes'
    }
  }), /must be "true" or "false"/);
});

test('workspace-write specialists receive an explicit repository write scope and JSON schema', () => {
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the assigned task',
    outputSchemaPath: '/tmp/example-repo/.aiteam/runs/agent.schema.json',
    env: { AITEAM_CODEX_PREFIX_ARGS_JSON: '[]' }
  });

  assert.deepEqual(invocation.args.slice(0, 7), [
    'exec', '-C', '/tmp/example-repo', '--sandbox', 'workspace-write', '--add-dir', '/tmp/example-repo'
  ]);
  assert.ok(invocation.args.includes('--output-schema'));
  assert.ok(invocation.args.includes('/tmp/example-repo/.aiteam/runs/agent.schema.json'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdinText, 'Implement the assigned task');
  assert.ok(!invocation.args.includes('Implement the assigned task'));
});

test('implementation retries can enforce structured output after tool-using work', () => {
  const childHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-implementation-report-')), 'codex-home');
  const initial = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the assigned task',
    outputSchemaPath: '/tmp/result.schema.json',
    stage: 'implementation',
    env: { AITEAM_CODEX_HOME: childHome }
  });
  const reportingRetry = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Report the implemented task',
    outputSchemaPath: '/tmp/result.schema.json',
    stage: 'implementation',
    enforceSchema: true,
    env: { AITEAM_CODEX_HOME: childHome }
  });

  assert.ok(!initial.args.includes('--output-schema'));
  assert.ok(reportingRetry.args.includes('--output-schema'));
  assert.ok(reportingRetry.args.includes('/tmp/result.schema.json'));
  assert.equal(initial.args.at(-1), '-');
  assert.equal(initial.stdinText, 'Implement the assigned task');
  assert.equal(reportingRetry.args.at(-1), '-');
  assert.equal(reportingRetry.stdinText, 'Report the implemented task');
});

test('response-only repair is read-only and receives a minimal formatter prompt', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-response-only-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const previousRunner = process.env.AITEAM_RUNNER;
  const previousBin = process.env.AITEAM_CODEX_BIN;
  process.env.AITEAM_RUNNER = 'codex';
  process.env.AITEAM_CODEX_BIN = 'true';
  try {
    return runAgent({
      repo,
      agentId: 'python',
      stage: 'implementation',
      task: 'Repair formatting only.',
      context: 'Original output.',
      enforceSchema: true,
      responseOnly: true
    }).then((run) => {
      assert.equal(run.responseOnly, true);
      assert.equal(run.enforceSchema, true);
      assert.deepEqual(run.args.slice(run.args.indexOf('--sandbox'), run.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
      assert.ok(run.args.includes('--output-schema'));
      const meta = JSON.parse(fs.readFileSync(run.metaPath, 'utf8'));
      assert.equal(meta.responseOnly, true);
      assert.equal(meta.enforceSchema, true);
    });
  } finally {
    if (previousRunner === undefined) delete process.env.AITEAM_RUNNER;
    else process.env.AITEAM_RUNNER = previousRunner;
    if (previousBin === undefined) delete process.env.AITEAM_CODEX_BIN;
    else process.env.AITEAM_CODEX_BIN = previousBin;
  }
});

test('Codex invocations send prompt over stdin to avoid argv E2BIG', () => {
  const prompt = 'x'.repeat(300000);
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt,
    env: { AITEAM_CODEX_PREFIX_ARGS_JSON: '[]' }
  });

  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdinText, prompt);
  assert.ok(!invocation.args.includes(prompt));
});

test('timeout terminates the full specialist process group', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-process-group-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const wrapper = path.join(repo, 'fake-codex.cjs');
  const pidFile = path.join(repo, 'grandchild.pid');
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.env.AITEAM_TEST_GRANDCHILD_PID, String(child.pid));",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);

  const saved = {};
  const replacements = {
    AITEAM_CODEX_BIN: wrapper,
    AITEAM_CODEX_PREFIX_ARGS_JSON: '[]',
    AITEAM_TEST_GRANDCHILD_PID: pidFile,
    AITEAM_CODEX_HOME: '',
    AITEAM_CODEX_MODEL: '',
    AITEAM_CODEX_PROVIDER: ''
  };
  for (const [key, value] of Object.entries(replacements)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  let grandchildPid = null;
  try {
    const result = await runAgent({ repo, agentId: 'analyst', task: 'timeout test', timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try { process.kill(grandchildPid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') alive = false;
        else throw error;
      }
    }
    assert.equal(alive, false, 'grandchild must not survive the specialist timeout');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (grandchildPid) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch {}
    }
  }
});
