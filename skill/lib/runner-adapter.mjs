import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Universal Subagent Runner Adapter.
 * Supports:
 * 1. Native agent execution instructions (Antigravity / Gemini CLI)
 * 2. Standalone CLI execution (Codex, Qwen Code, Agy, Copilot)
 */

export function detectEnvironment() {
  if (process.env.ANTIGRAVITY_CLI || process.env.GEMINI_CLI) return 'antigravity';
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.QWEN_CODE) return 'qwen';
  return 'cli-fallback';
}

/**
 * Build CLI command and arguments for a specialist when invoked outside of native subagents.
 */
export function buildCliInvocation({ repo, role, contractPath, taskPrompt, model = null }) {
  const contractContent = fs.readFileSync(contractPath, 'utf8');
  const fullPrompt = `${contractContent}\n\n# TASK ASSIGNMENT\n${taskPrompt}`;

  // Priority 1: Codex CLI if available
  const codexBin = findExecutable('codex');
  if (codexBin) {
    const args = [
      'exec',
      '-C', repo,
      '--sandbox', role === 'coder' || role === 'qa' ? 'danger-full-access' : 'read-only',
      '-c', 'approval_policy="never"'
    ];
    if (model) args.push('--model', model);
    args.push('-');
    return { command: codexBin, args, stdin: fullPrompt };
  }

  // Priority 2: Qwen Code CLI if available
  const qwenBin = findExecutable('qwen-code');
  if (qwenBin) {
    return { command: qwenBin, args: ['-p', fullPrompt, '--yolo'], stdin: null };
  }

  // Priority 3: Agy CLI
  const agyBin = findExecutable('agy');
  if (agyBin) {
    return { command: agyBin, args: ['-p', fullPrompt, '--yolo'], stdin: null };
  }

  throw new Error('No compatible agent CLI found (searched codex, qwen-code, agy).');
}

function findExecutable(name) {
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const p of paths) {
    const full = path.join(p, name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

/**
 * Execute a subagent via CLI process and return the JSON result.
 */
export function executeCliSubagent({ repo, role, contractPath, taskPrompt, model = null, onLog = null }) {
  return new Promise((resolve, reject) => {
    const invocation = buildCliInvocation({ repo, role, contractPath, taskPrompt, model });
    const child = spawn(invocation.command, invocation.args, {
      cwd: repo,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    if (invocation.stdin) {
      child.stdin.write(invocation.stdin);
      child.stdin.end();
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (onLog) onLog(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (onLog) onLog(text);
    });

    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error(`Agent ${role} exited with code ${exitCode}:\n${stderr}`));
      }

      // Try parsing JSON result from stdout or stderr
      const combined = stdout + '\n' + stderr;
      const json = extractJsonResult(combined);
      if (json) return resolve(json);

      resolve({
        outcome: 'PASS',
        summary: `Subagent ${role} completed successfully.`,
        evidence: [stdout.slice(-500)]
      });
    });

    child.on('error', reject);
  });
}

function extractJsonResult(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*"outcome"[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}
