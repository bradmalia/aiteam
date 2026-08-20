import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, appendEvent } from './state.mjs';
import { buildAgentPrompt, getAgent } from './registry.mjs';

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'agent';
}

function outputSchemaPath(repo, runBase) {
  const schemaPath = path.join(ensureStateDir(repo), 'runs', `${runBase}.schema.json`);
  const schema = {
    type: 'object',
    required: ['outcome', 'summary', 'evidence'],
    properties: {
      outcome: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED', 'AWAITING_USER', 'PASS_WITH_MANUAL_VALIDATION'] },
      summary: { type: 'string', minLength: 1 },
      evidence: { type: 'array', items: { type: 'string' } }
    },
    additionalProperties: true
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n');
  return schemaPath;
}

export const activeProcesses = new Map();

export function runAgent({ repo, agentId, task, context = '', timeoutMs = 3600000, model = null, stage = null }) {
  const agent = getAgent(agentId, repo);
  if (!agent) throw new Error(`Unknown AITEAM agent: ${agentId}`);
  const prompt = buildAgentPrompt(agent, task, context);
  const dir = ensureStateDir(repo);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeName(agentId)}`;
  const schemaPath = outputSchemaPath(repo, base);
  const invocation = buildCodexInvocation({ repo, agent, prompt, model, outputSchemaPath: schemaPath });
  const { command, args, childEnv } = invocation;
  const stdoutPath = path.join(dir, 'runs', `${base}.stdout.txt`);
  const stderrPath = path.join(dir, 'runs', `${base}.stderr.txt`);
  const metaPath = path.join(dir, 'runs', `${base}.json`);

  appendEvent(repo, { type: 'agent_started', agentId, stage, task, stdoutPath, stderrPath, schemaPath });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });

    activeProcesses.set(repo, child);

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let timedOut = false;
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), 5000);
      forceKillTimer.unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      activeProcesses.delete(repo);
      clearTimeout(timer);
      if (forceKillTimer && !timedOut) clearTimeout(forceKillTimer);
      fs.writeFileSync(stdoutPath, stdout);
      fs.writeFileSync(stderrPath, stderr);
      const meta = {
        runId: base,
        agentId,
        role: agent.role,
        task,
        command,
        args: args.slice(0, -1).concat(['<prompt omitted>']),
        exitCode: code,
        signal,
        timedOut,
        stdoutPath,
        stderrPath,
        schemaPath,
        completedAt: new Date().toISOString()
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      appendEvent(repo, { type: 'agent_finished', ...meta });
      resolve({ ...meta, stdout, stderr });
    });
  });
}

export function killChildTree(child, signal) {
  if (!child?.pid) return false;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function parseStringArray(name, value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${name} must be a JSON array of strings.`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return parsed;
}

function configString(value) {
  return JSON.stringify(String(value));
}

export function buildCodexInvocation({ repo, agent, prompt, model = null, outputSchemaPath: schemaPath = null, env = process.env }) {
  const command = env.AITEAM_CODEX_BIN || 'codex';
  const prefixArgs = parseStringArray('AITEAM_CODEX_PREFIX_ARGS_JSON', env.AITEAM_CODEX_PREFIX_ARGS_JSON);
  const args = [...prefixArgs, 'exec', '-C', repo, '--sandbox', agent.sandbox || 'read-only'];
  if (agent.sandbox === 'workspace-write') args.push('--add-dir', repo);
  args.push('-c', `approval_policy=${configString(env.AITEAM_CODEX_APPROVAL_POLICY || 'never')}`);

  const provider = env.AITEAM_CODEX_PROVIDER;
  if (provider) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(provider)) {
      throw new Error('AITEAM_CODEX_PROVIDER contains unsupported characters.');
    }
    args.push('-c', `model_provider=${configString(provider)}`);
    if (env.AITEAM_CODEX_PROVIDER_NAME) {
      args.push('-c', `model_providers.${provider}.name=${configString(env.AITEAM_CODEX_PROVIDER_NAME)}`);
    }
    if (env.AITEAM_CODEX_BASE_URL) {
      args.push('-c', `model_providers.${provider}.base_url=${configString(env.AITEAM_CODEX_BASE_URL)}`);
    }
    if (env.AITEAM_CODEX_WIRE_API) {
      args.push('-c', `model_providers.${provider}.wire_api=${configString(env.AITEAM_CODEX_WIRE_API)}`);
    }
    if (env.AITEAM_CODEX_REQUIRES_OPENAI_AUTH) {
      const requiresAuth = env.AITEAM_CODEX_REQUIRES_OPENAI_AUTH === 'true';
      args.push('-c', `model_providers.${provider}.requires_openai_auth=${requiresAuth}`);
    }
  }

  if (env.AITEAM_CODEX_CONTEXT_WINDOW) {
    args.push('-c', `model_context_window=${Number(env.AITEAM_CODEX_CONTEXT_WINDOW)}`);
  }
  if (env.AITEAM_CODEX_AUTO_COMPACT_LIMIT) {
    args.push('-c', `model_auto_compact_token_limit=${Number(env.AITEAM_CODEX_AUTO_COMPACT_LIMIT)}`);
  }

  const selectedModel = model || env.AITEAM_CODEX_MODEL;
  if (selectedModel) args.push('--model', selectedModel);
  if (schemaPath) args.push('--output-schema', schemaPath);
  args.push(prompt);

  const childEnv = { ...env };
  if (env.AITEAM_CODEX_HOME) {
    fs.mkdirSync(env.AITEAM_CODEX_HOME, { recursive: true });
    childEnv.CODEX_HOME = env.AITEAM_CODEX_HOME;
  }
  return { command, args, childEnv };
}
