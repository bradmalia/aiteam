import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildAgentInvocation, buildAgyInvocation, buildCodexInvocation, buildCopilotInvocation, detectRunner, discoverParentCodexContext, outputSchemaPath, parseCodexSessionContext, redactInvocationArgs, runAgent } from '../src/runtime.mjs';

test('runner detection honors explicit selection and host markers', () => {
  assert.equal(detectRunner({ AITEAM_RUNNER: 'copilot' }), 'copilot');
  assert.equal(detectRunner({ AITEAM_RUNNER: 'agy', CODEX_HOME: '/tmp/codex' }), 'agy');
  assert.equal(detectRunner({ AITEAM_RUNNER: 'codex', ANTIGRAVITY_AGENT: 'present' }), 'codex');
  assert.equal(detectRunner({ COPILOT_CLI: '1' }), 'copilot');
  assert.equal(detectRunner({ COPILOT_AGENT_SESSION_ID: 'session-123' }), 'copilot');
  assert.equal(detectRunner({ ANTIGRAVITY_AGENT: 'present' }), 'agy');
  assert.equal(detectRunner({ ANTIGRAVITY_PROJECT_ID: 'present' }), 'agy');
  assert.equal(detectRunner({ ANTIGRAVITY_LS_ADDRESS: 'present' }), 'agy');
  assert.equal(detectRunner({ AITEAM_CODEX_BIN: 'codex' }), 'codex');
  assert.equal(detectRunner({ CODEX_HOME: '/tmp/codex' }), 'codex');
  assert.equal(detectRunner({ CODEX_THREAD_ID: 'thread-id' }), 'codex');
  assert.throws(() => detectRunner({ AITEAM_RUNNER: 'unknown' }), /must be/);
});

test('an unmarked MCP host defaults to Codex', () => {
  assert.equal(detectRunner({}), 'codex');
});

test('an unmarked Codex invocation inherits the active parent session routing', () => {
  const childHome = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-parent-codex-')), 'codex-home');
  const invocation = buildAgentInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Analyze requirements',
    env: {},
    parentCodexContext: {
      model: 'gpt-current',
      provider: 'openai',
      reasoningEffort: 'high',
      codexHome: childHome
    }
  });

  assert.equal(invocation.command, 'codex');
  assert.ok(invocation.args.includes('model_provider="openai"'));
  assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
  assert.ok(invocation.args.includes('gpt-current'));
  assert.equal(invocation.childEnv.CODEX_HOME, childHome);
});

test('parent Codex context is parsed from the active session descriptor', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-proc-'));
  const pid = 1234;
  const fdDir = path.join(root, String(pid), 'fd');
  const codexHome = path.join(root, 'codex-home');
  const sessionPath = path.join(codexHome, 'sessions', '2026', '08', '25', 'rollout.jsonl');
  fs.mkdirSync(fdDir, { recursive: true });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(path.join(root, String(pid), 'status'), 'Name:\tcodex\nPPid:\t1\n');
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-selected', model_provider_id: 'openai', reasoning_effort: 'high' } } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-selected', effort: 'high', model_context_window: 258400 } })
  ].join('\n'));
  try {
    fs.symlinkSync(sessionPath, path.join(fdDir, '7'));
  } catch (err) {
    if (process.platform === 'win32' && err.code === 'EPERM') {
      t.skip('Windows symlink creation requires elevated permissions or developer mode');
      return;
    }
    throw err;
  }

  assert.deepEqual(discoverParentCodexContext({ pid, procRoot: root }), {
    model: 'gpt-selected',
    provider: 'openai',
    reasoningEffort: 'high',
    contextWindow: 258400,
    codexHome,
    source: 'parent-codex-session'
  });
});

test('malformed session records cannot inject model or provider configuration', () => {
  const context = parseCodexSessionContext([
    '{not json}',
    JSON.stringify({ type: 'event_msg', payload: { thread_settings: { model: 'bad model;override=true', model_provider_id: 'bad.provider' } } })
  ].join('\n'), '/tmp/codex/sessions/run.jsonl');
  assert.equal(context, null);
});

test('Copilot invocations enforce read-only and writable specialist boundaries', () => {
  const readOnly = buildCopilotInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Review the project',
    env: { AITEAM_COPILOT_BIN: 'copilot', AITEAM_COPILOT_MODEL: 'gpt-5.4' }
  });
  assert.equal(readOnly.command, 'copilot');
  assert.ok(readOnly.args.includes('-C'));
  assert.ok(readOnly.args.includes('/tmp/example-repo'));
  assert.ok(readOnly.args.includes('--mode'));
  assert.ok(readOnly.args.includes('plan'));
  assert.ok(readOnly.args.includes('--allow-tool=read'));
  assert.ok(readOnly.args.includes('--no-ask-user'));
  assert.ok(readOnly.args.includes('--silent'));
  assert.ok(readOnly.args.includes('--model'));
  assert.ok(readOnly.args.includes('gpt-5.4'));
  assert.ok(!readOnly.args.includes('-p'));
  assert.equal(readOnly.stdinText, 'Review the project');

  const writable = buildCopilotInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the task',
    env: {
      AITEAM_COPILOT_BIN: 'copilot',
      AITEAM_COPILOT_REASONING_EFFORT: 'high',
      AITEAM_COPILOT_CONTEXT_TIER: 'long_context'
    }
  });
  assert.equal(writable.command, 'copilot');
  assert.ok(writable.args.includes('--allow-all'));
  assert.ok(writable.args.includes('--no-ask-user'));
  assert.ok(!writable.args.includes('--mode'));
  assert.ok(writable.args.includes('--effort'));
  assert.ok(writable.args.includes('high'));
  assert.ok(writable.args.includes('--context'));
  assert.ok(writable.args.includes('long_context'));
  assert.ok(!writable.args.includes('-p'));
  assert.equal(writable.stdinText, 'Implement the task');
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
  assert.deepEqual(readOnly.args.slice(readOnly.args.indexOf('-p'), readOnly.args.indexOf('-p') + 2), ['-p', '-']);
  assert.equal(readOnly.stdinText, 'Review the project');

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
  assert.deepEqual(writable.args.slice(writable.args.indexOf('-p'), writable.args.indexOf('-p') + 2), ['-p', '-']);
  assert.equal(writable.stdinText, 'Implement the task');

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
  assert.deepEqual(reportingRetry.args.slice(reportingRetry.args.indexOf('-p'), reportingRetry.args.indexOf('-p') + 2), ['-p', '-']);
  assert.equal(reportingRetry.stdinText, 'Report the implemented task');
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
  assert.ok(architecture.required.includes('requiredCapabilities'));
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

test('QA Test Planning schema requires per-task covered tests and regression notes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-qa-planning-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const schema = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'qa-planning', 'qa-planning'), 'utf8'));
  assert.ok(schema.required.includes('taskTestPlans'));
  assert.ok(schema.required.includes('regressionStrategy'));
  assert.ok(schema.required.includes('coverageNotes'));
  assert.ok(schema.required.includes('requiredCapabilities'));
  assert.deepEqual(schema.properties.taskTestPlans.items.properties.tests.items.required, ['name', 'covers', 'action', 'expected', 'evidenceMethod']);
});

test('Environment Readiness schema captures verified tools, file operations, and installation handoff', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-environment-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const schema = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'environment-readiness', 'environment-readiness'), 'utf8'));
  for (const field of ['capabilities', 'fileOperations', 'missingTools', 'questions']) assert.ok(schema.required.includes(field));
  assert.deepEqual(schema.properties.capabilities.items.required, ['id', 'requiredBy', 'selectedTool', 'probeCommand', 'status', 'version', 'executablePath', 'evidence']);
  assert.deepEqual(schema.properties.missingTools.items.required, ['tool', 'capability', 'whyNeeded', 'detectedProblem', 'alternativesTried', 'installInstructions', 'verificationCommand', 'requiresHuman']);
});

test('critical-review output schema requires simple repairStage enum for model compatibility', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-critical-schema-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const schema = JSON.parse(fs.readFileSync(outputSchemaPath(repo, 'critical-review', 'critical-review'), 'utf8'));
  assert.ok(schema.required.includes('findings'));
  assert.ok(schema.required.includes('repairStage'));
  assert.equal(schema.properties.repairStage.type, 'string');
  assert.deepEqual(schema.properties.repairStage.enum, ['architecture', 'planning', 'qa-planning', 'none']);
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
    },
    parentCodexContext: null
  }), /must be "true" or "false"/);
});

test('workspace-write specialists receive full process access and JSON schema by default', () => {
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the assigned task',
    outputSchemaPath: '/tmp/example-repo/.aiteam/runs/agent.schema.json',
    env: { AITEAM_CODEX_PREFIX_ARGS_JSON: '[]' }
  });

  assert.deepEqual(invocation.args.slice(0, 5), [
    'exec', '-C', '/tmp/example-repo', '--sandbox', 'danger-full-access'
  ]);
  assert.ok(!invocation.args.includes('--add-dir'));
  assert.ok(invocation.args.includes('--output-schema'));
  assert.ok(invocation.args.includes('/tmp/example-repo/.aiteam/runs/agent.schema.json'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.stdinText, 'Implement the assigned task');
  assert.ok(!invocation.args.includes('Implement the assigned task'));
});

test('writable Codex sandbox can be restricted through configuration', () => {
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the assigned task',
    env: {
      AITEAM_CODEX_PREFIX_ARGS_JSON: '[]',
      AITEAM_CODEX_WRITABLE_SANDBOX: 'workspace-write'
    }
  });

  assert.deepEqual(invocation.args.slice(0, 7), [
    'exec', '-C', '/tmp/example-repo', '--sandbox', 'workspace-write', '--add-dir', '/tmp/example-repo'
  ]);
  assert.throws(() => buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'workspace-write' },
    prompt: 'Implement the assigned task',
    env: { AITEAM_CODEX_WRITABLE_SANDBOX: 'read-only' }
  }), /must be "workspace-write" or "danger-full-access"/);
});

test('read-only Codex specialists remain sandboxed when writable agents have full access', () => {
  const invocation = buildCodexInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt: 'Review the task',
    env: { AITEAM_CODEX_WRITABLE_SANDBOX: 'danger-full-access' }
  });

  assert.deepEqual(invocation.args.slice(0, 5), [
    'exec', '-C', '/tmp/example-repo', '--sandbox', 'read-only'
  ]);
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
  const previousPrefix = process.env.AITEAM_CODEX_PREFIX_ARGS_JSON;
  process.env.AITEAM_RUNNER = 'codex';
  process.env.AITEAM_CODEX_BIN = process.execPath;
  process.env.AITEAM_CODEX_PREFIX_ARGS_JSON = JSON.stringify(['-e', 'process.stdout.write(JSON.stringify({ outcome: "PASS", summary: "ok", evidence: ["fixed"] }))']);
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
    if (previousPrefix === undefined) delete process.env.AITEAM_CODEX_PREFIX_ARGS_JSON;
    else process.env.AITEAM_CODEX_PREFIX_ARGS_JSON = previousPrefix;
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

test('Agy invocations pass prompt via -p argument', () => {
  const prompt = 'Build a pong game';
  const invocation = buildAgyInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt,
    env: { AITEAM_AGY_BIN: 'agy' }
  });

  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('-p'), invocation.args.indexOf('-p') + 2), ['-p', '-']);
  assert.equal(invocation.stdinText, prompt);
});

test('Copilot invocations pass prompt via stdin', () => {
  const prompt = 'Build a pong game';
  const invocation = buildCopilotInvocation({
    repo: '/tmp/example-repo',
    agent: { sandbox: 'read-only' },
    prompt,
    env: { AITEAM_COPILOT_BIN: 'copilot' }
  });

  assert.ok(!invocation.args.includes('-p'));
  assert.equal(invocation.stdinText, prompt);
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
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    "fs.writeFileSync(process.env.AITEAM_TEST_GRANDCHILD_PID, String(child.pid));",
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);

  const saved = {};
  const replacements = {
    AITEAM_RUNNER: 'codex',
    AITEAM_CODEX_BIN: process.execPath,
    AITEAM_CODEX_PREFIX_ARGS_JSON: JSON.stringify([wrapper]),
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

test('successful specialist completion terminates residual child processes', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-process-cleanup-'));
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const wrapper = path.join(repo, 'fake-codex.cjs');
  const pidFile = path.join(repo, 'residual.pid');
  fs.writeFileSync(wrapper, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    "fs.writeFileSync(process.env.AITEAM_TEST_RESIDUAL_PID, String(child.pid));",
    'child.unref();',
    "process.stdout.write(JSON.stringify({ outcome: 'PASS', summary: 'ok', evidence: ['done'] }));"
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);

  const saved = {};
  const replacements = {
    AITEAM_RUNNER: 'codex',
    AITEAM_CODEX_BIN: process.execPath,
    AITEAM_CODEX_PREFIX_ARGS_JSON: JSON.stringify([wrapper]),
    AITEAM_TEST_RESIDUAL_PID: pidFile,
    AITEAM_CODEX_HOME: '',
    AITEAM_CODEX_MODEL: '',
    AITEAM_CODEX_PROVIDER: ''
  };
  for (const [key, value] of Object.entries(replacements)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  let residualPid = null;
  try {
    const result = await runAgent({ repo, agentId: 'analyst', task: 'cleanup test', timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.residualProcessCleanup, true);
    residualPid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try { process.kill(residualPid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') alive = false;
        else throw error;
      }
    }
    assert.equal(alive, false, 'residual child must not survive successful specialist completion');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (residualPid) {
      try { process.kill(residualPid, 'SIGKILL'); } catch {}
    }
  }
});
