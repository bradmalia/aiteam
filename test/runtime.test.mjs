import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCodexInvocation, runAgent } from '../src/runtime.mjs';

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
  assert.equal(invocation.args.at(-1), 'Analyze requirements');
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
  assert.equal(invocation.args.at(-1), 'Implement the assigned task');
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
