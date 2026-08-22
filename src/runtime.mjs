import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, appendEvent } from './state.mjs';
import { buildAgentPrompt, getAgent } from './registry.mjs';

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'agent';
}

function outputSchemaPath(repo, runBase, stage = null) {
  const schemaPath = path.join(ensureStateDir(repo), 'runs', `${runBase}.schema.json`);
  const baseProperties = {
    outcome: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED', 'AWAITING_USER', 'PASS_WITH_MANUAL_VALIDATION'] },
    summary: { type: 'string', minLength: 1 },
    evidence: { type: 'array', items: { type: 'string' } }
  };
  const required = ['outcome', 'summary', 'evidence'];

  if (stage === 'intake') {
    baseProperties.requirements = { type: 'array', items: { type: 'string' } };
    baseProperties.acceptanceCriteria = { type: 'array', items: { type: 'string' } };
    baseProperties.questions = { type: 'array', items: { type: 'string' } };
    baseProperties.userConfirmed = { type: 'boolean' };
  } else if (stage === 'architecture') {
    baseProperties.design = { type: 'array', items: { type: 'string' } };
    baseProperties.specialistNeeds = {
      type: 'array',
      items: {
        type: 'object',
        required: ['capability', 'reason', 'suggestedId'],
        properties: { capability: { type: 'string' }, reason: { type: 'string' }, suggestedId: { type: 'string' } },
        additionalProperties: false
      }
    };
  } else if (stage === 'recruiting') {
    baseProperties.specialist = {
      type: 'object',
      required: ['id', 'role', 'sandbox', 'triggers', 'capabilities', 'contract'],
      properties: {
        id: { type: 'string' },
        role: { type: 'string' },
        sandbox: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
        capabilities: { type: 'array', items: { type: 'string' } },
        contract: { type: 'string' }
      },
      additionalProperties: false
    };
  } else if (stage === 'planning') {
    baseProperties.tasks = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'description', 'specialistId', 'acceptanceCriteria', 'dependencies'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          specialistId: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          dependencies: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
    };
  } else if (stage === 'implementation') {
    baseProperties.filesChanged = { type: 'array', items: { type: 'string' } };
    baseProperties.validations = {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'result'],
        properties: { command: { type: 'string' }, result: { type: 'string' } },
        additionalProperties: false
      }
    };
    required.push('filesChanged', 'validations');
  } else if (stage === 'critical-review') {
    baseProperties.findings = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'description', 'recommendation'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          description: { type: 'string' },
          recommendation: { type: 'string' }
        },
        additionalProperties: false
      }
    };
    baseProperties.repairStage = { type: ['string', 'null'] };
  } else if (stage === 'code-review') {
    baseProperties.findings = {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'severity', 'location', 'impact', 'recommendation'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string' },
          location: { type: 'string' },
          impact: { type: 'string' },
          recommendation: { type: 'string' }
        },
        additionalProperties: false
      }
    };
    baseProperties.repairStage = { type: ['string', 'null'] };
  } else if (stage === 'qa') {
    baseProperties.checks = {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'status', 'evidence'],
        properties: { name: { type: 'string' }, status: { type: 'string' }, evidence: { type: 'string' } },
        additionalProperties: false
      }
    };
    baseProperties.manualChecks = { type: 'array', items: { type: 'string' } };
    required.push('checks', 'manualChecks');
  } else if (stage === 'integration') {
    baseProperties.commitMessage = { type: 'string' };
    required.push('commitMessage');
  }

  const schema = {
    type: 'object',
    required: Object.keys(baseProperties),
    properties: baseProperties,
    additionalProperties: false
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + '\n');
  return schemaPath;
}

export const activeProcesses = new Map();

export function runAgent({ repo, agentId, task, context = '', timeoutMs = 3600000, model = null, stage = null }) {
  const agent = getAgent(agentId, repo);
  if (!agent) throw new Error(`Unknown AITEAM agent: ${agentId}`);
  const prompt = buildAgentPrompt(agent, task, context, stage);
  const dir = ensureStateDir(repo);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeName(agentId)}`;
  const schemaPath = outputSchemaPath(repo, base, stage);
  const invocation = buildCodexInvocation({ repo, agent, prompt, model, outputSchemaPath: schemaPath, stage });
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

    // H1: Stream to disk instead of buffering in memory to prevent OOM
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

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
      stdoutStream.end();
      stderrStream.end();
      reject(err);
    });

    child.on('close', (code, signal) => {
      activeProcesses.delete(repo);
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      stdoutStream.end();
      stderrStream.end();
      // Read back from disk only what we need (bounded by file size)
      const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
      const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
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

export function buildCodexInvocation({ repo, agent, prompt, model = null, outputSchemaPath: schemaPath = null, stage = null, env = process.env }) {
  const command = env.AITEAM_CODEX_BIN || 'codex';
  const prefixArgs = parseStringArray('AITEAM_CODEX_PREFIX_ARGS_JSON', env.AITEAM_CODEX_PREFIX_ARGS_JSON);
  const args = [...prefixArgs, 'exec', '-C', repo, '--sandbox', agent.sandbox || 'read-only'];
  if (agent.sandbox === 'workspace-write') args.push('--add-dir', repo);
  args.push('-c', `approval_policy=${configString(env.AITEAM_CODEX_APPROVAL_POLICY || 'never')}`);
  args.push('-c', 'mcp_servers={}');

  const provider = env.AITEAM_CODEX_PROVIDER || 'v100_ollama';
  if (provider) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(provider)) {
      throw new Error('AITEAM_CODEX_PROVIDER contains unsupported characters.');
    }
    args.push('-c', `model_provider=${configString(provider)}`);
    const providerName = env.AITEAM_CODEX_PROVIDER_NAME || (provider === 'v100_ollama' ? 'V100 Ollama' : null);
    if (providerName) {
      args.push('-c', `model_providers.${provider}.name=${configString(providerName)}`);
    }
    const baseUrl = env.AITEAM_CODEX_BASE_URL || (provider === 'v100_ollama' ? 'http://192.168.122.50:11434/v1/' : null);
    if (baseUrl) {
      args.push('-c', `model_providers.${provider}.base_url=${configString(baseUrl)}`);
    }
    const wireApi = env.AITEAM_CODEX_WIRE_API || (provider === 'v100_ollama' ? 'responses' : null);
    if (wireApi) {
      args.push('-c', `model_providers.${provider}.wire_api=${configString(wireApi)}`);
    }
    const requiresAuth = env.AITEAM_CODEX_REQUIRES_OPENAI_AUTH === 'true';
    args.push('-c', `model_providers.${provider}.requires_openai_auth=${requiresAuth}`);
  }

  const contextWindow = env.AITEAM_CODEX_CONTEXT_WINDOW || 262144;
  args.push('-c', `model_context_window=${Number(contextWindow)}`);

  const autoCompactLimit = env.AITEAM_CODEX_AUTO_COMPACT_LIMIT || 229376;
  args.push('-c', `model_auto_compact_token_limit=${Number(autoCompactLimit)}`);
  args.push('-c', 'model_auto_compact_token_limit_scope="total"');

  const selectedModel = model || env.AITEAM_CODEX_MODEL || 'v100-qwen3.6-codex-256k';
  if (selectedModel) args.push('--model', selectedModel);
  // Skip --output-schema for implementation stages: the schema constraint causes
  // Qwen to bypass the agentic tool-calling loop and emit JSON in a single pass
  // without ever calling exec_command to write files. Without the schema,
  // Qwen enters the normal multi-turn loop, calls tools, then emits a JSON
  // result that parseJson extracts from the final free-form message.
  const effectiveSchema = (stage === 'implementation') ? null : schemaPath;
  if (effectiveSchema) args.push('--output-schema', effectiveSchema);
  args.push(prompt);

  const childEnv = { ...env };
  const codexHome = env.AITEAM_CODEX_HOME || '/home/brad/.aiteam-codex-home';
  fs.mkdirSync(codexHome, { recursive: true });
  childEnv.CODEX_HOME = codexHome;
  return { command, args, childEnv };
}
