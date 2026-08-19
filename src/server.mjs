#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { newSession, readSession, patchSession, appendEvent } from './state.mjs';
import { loadRegistry, coordinatorContract } from './registry.mjs';
import { runAgent } from './runtime.mjs';
import { gitSnapshot } from './git.mjs';

const VERSION = '0.1.0';

const toolDefs = [
  {
    name: 'aiteam_start',
    description: 'Start an AITEAM request in the current Git repository. Use when the user explicitly says "Using AITEAM".',
    inputSchema: { type: 'object', properties: { request: { type: 'string' }, repository: { type: 'string' } }, required: ['request'] }
  },
  {
    name: 'aiteam_status',
    description: 'Read the current AITEAM session and Git snapshot.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' } } }
  },
  {
    name: 'aiteam_spawn_agent',
    description: 'Delegate focused work to an AITEAM specialist agent using a non-interactive Codex subprocess.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, agent_id: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' }, timeout_seconds: { type: 'integer' }, model: { type: 'string' } }, required: ['agent_id', 'task'] }
  },
  {
    name: 'aiteam_update_session',
    description: 'Mechanically persist Coordinator-owned session state. The runtime does not interpret workflow semantics.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, patch: { type: 'object' } }, required: ['patch'] }
  },
  {
    name: 'aiteam_record_event',
    description: 'Append an auditable event/decision to the AITEAM session log.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, event: { type: 'object' } }, required: ['event'] }
  },
  {
    name: 'aiteam_cancel',
    description: 'Mark the active AITEAM session cancelled. Running subprocess cancellation is a future enhancement.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, reason: { type: 'string' } } }
  }
];

function repoOf(args = {}) {
  return path.resolve(args.repository || process.cwd());
}

function textResult(text, structuredContent = undefined) {
  const result = { content: [{ type: 'text', text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

async function callTool(name, args) {
  const repo = repoOf(args);
  if (name === 'aiteam_start') {
    const git = gitSnapshot(repo);
    const session = newSession(repo, args.request);
    const registry = loadRegistry();
    const text = [
      `AITEAM ${VERSION} session started.`,
      `Repository: ${repo}`,
      `Git: ${git.branch}@${git.head.slice(0, 12)}`,
      '',
      coordinatorContract(),
      '',
      '# Available agents',
      ...registry.agents.map((a) => `- ${a.id}: ${a.role}`),
      '',
      'You are now the AITEAM Coordinator for this request. Delegate focused work with aiteam_spawn_agent and keep the user interaction in the primary Codex conversation.'
    ].join('\n');
    return textResult(text, { session, git, agents: registry.agents });
  }
  if (name === 'aiteam_status') {
    const session = readSession(repo);
    const git = gitSnapshot(repo);
    return textResult(JSON.stringify({ session, git }, null, 2), { session, git });
  }
  if (name === 'aiteam_spawn_agent') {
    const timeoutMs = Math.max(1, Number(args.timeout_seconds || 3600)) * 1000;
    const result = await runAgent({ repo, agentId: args.agent_id, task: args.task, context: args.context || '', timeoutMs, model: args.model || null });
    const summary = [
      `${result.role} completed with exit code ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}.`,
      '',
      result.stdout || '(no stdout)',
      result.stderr ? `\n[stderr]\n${result.stderr}` : ''
    ].join('\n');
    return textResult(summary, result);
  }
  if (name === 'aiteam_update_session') {
    const session = patchSession(repo, args.patch || {});
    appendEvent(repo, { type: 'session_updated', patch: args.patch || {} });
    return textResult(JSON.stringify(session, null, 2), session);
  }
  if (name === 'aiteam_record_event') {
    const event = appendEvent(repo, { type: 'coordinator_event', ...(args.event || {}) });
    return textResult(JSON.stringify(event, null, 2), event);
  }
  if (name === 'aiteam_cancel') {
    const session = patchSession(repo, { status: 'CANCELLED', cancelReason: args.reason || 'Cancelled by user' });
    appendEvent(repo, { type: 'session_cancelled', reason: args.reason || 'Cancelled by user' });
    return textResult(JSON.stringify(session, null, 2), session);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(msg) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aiteam', version: VERSION }
      }
    };
  }
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: toolDefs } };
  }
  if (msg.method === 'tools/call') {
    try {
      const result = await callTool(msg.params?.name, msg.params?.arguments || {});
      return { jsonrpc: '2.0', id: msg.id, result };
    } catch (err) {
      return { jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: String(err?.stack || err) }] } };
    }
  }
  if (msg.id !== undefined) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
  return null;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); }
  catch { continue; }
  const response = await handle(msg);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
}
