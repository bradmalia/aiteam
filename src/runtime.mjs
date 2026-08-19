import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, appendEvent } from './state.mjs';
import { buildAgentPrompt, getAgent } from './registry.mjs';

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'agent';
}

export function runAgent({ repo, agentId, task, context = '', timeoutMs = 3600000, model = null }) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`Unknown AITEAM agent: ${agentId}`);
  const prompt = buildAgentPrompt(agent, task, context);
  const command = process.env.AITEAM_CODEX_BIN || 'codex';
  const args = ['exec', '-C', repo, '--sandbox', agent.sandbox || 'read-only'];
  if (model) args.push('--model', model);
  args.push(prompt);

  const dir = ensureStateDir(repo);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${stamp}-${safeName(agentId)}`;
  const stdoutPath = path.join(dir, 'runs', `${base}.stdout.txt`);
  const stderrPath = path.join(dir, 'runs', `${base}.stderr.txt`);
  const metaPath = path.join(dir, 'runs', `${base}.json`);

  appendEvent(repo, { type: 'agent_started', agentId, task, stdoutPath, stderrPath });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(stdoutPath, stdout);
      fs.writeFileSync(stderrPath, stderr);
      const meta = {
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
        completedAt: new Date().toISOString()
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
      appendEvent(repo, { type: 'agent_finished', ...meta });
      resolve({ ...meta, stdout, stderr });
    });
  });
}
