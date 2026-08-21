#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { newSession, readSession, patchSession, appendEvent } from './state.mjs';
import { loadRegistry, coordinatorContract, registerScopedSpecialist } from './registry.mjs';
import { activeProcesses, killChildTree } from './runtime.mjs';
import { gitSnapshot, ensureGitRepo } from './git.mjs';
import { coordinatorDirective, coordinatorDirectiveText } from './coordinator-guidance.mjs';
import { advanceWorkflow, completeWorkflow, confirmManualQa, getCurrentAssignment, workflowStatus } from './workflow.mjs';

const VERSION = '0.2.0';

export const toolDefs = [
  {
    name: 'aiteam_start',
    description: 'Initialize a server-governed AITEAM request (auto-initializing Git if needed) in the repository directory and synchronously run the first required specialist stage. This does not start background workers. Do NOT run git init or file commands in the coordinator session. After success, report the returned agent/phase line and call aiteam_advance for each remaining assignment.',
    inputSchema: { type: 'object', properties: { request: { type: 'string' }, repository: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 300, maximum: 7200 }, model: { type: 'string' }, auto_advance: { type: 'boolean', description: 'Testing/compatibility escape hatch; defaults to true.' } }, required: ['request'] }
  },
  {
    name: 'aiteam_status',
    description: 'Read one AITEAM session, enforced workflow gate, active agent, current phase, and remaining phases. This never advances work and must not be polled.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' } } }
  },
  {
    name: 'aiteam_advance',
    description: 'Run exactly the specialist required by the server-owned workflow gate, validate its structured result, update the task ledger, and advance or route rework. The Coordinator cannot select or skip phases.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, context: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 300, maximum: 7200 }, model: { type: 'string' } } }
  },
  {
    name: 'aiteam_spawn_agent',
    description: 'Compatibility alias for aiteam_advance. The requested agent_id must equal the server-required agent for the current phase; arbitrary or out-of-order delegation is rejected.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, agent_id: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' }, timeout_seconds: { type: 'integer' }, model: { type: 'string' } }, required: ['agent_id', 'task'] }
  },
  {
    name: 'aiteam_register_specialist',
    description: 'Register only a specialist proposal whose proposal_id was produced by a successful Recruiter stage. Direct coordinator-authored specialists and file-path contracts are rejected. Normal aiteam_advance operation registers verified proposals automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string' },
        proposal_id: { type: 'string' },
        specialist: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            contract: { type: 'string' },
            sandbox: { type: 'string', enum: ['read-only', 'workspace-write'] },
            triggers: { type: 'array', items: { type: 'string' } },
            capabilities: { type: 'array', items: { type: 'string' } }
          },
          required: ['id', 'role', 'contract']
        }
      },
      required: ['proposal_id', 'specialist']
    }
  },
  {
    name: 'aiteam_update_session',
    description: 'Persist coordinator notes or pending user input only. Workflow status, stage, task ledger, evidence, and gates are server-owned and cannot be patched.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, patch: { type: 'object' } }, required: ['patch'] }
  },
  {
    name: 'aiteam_complete',
    description: 'Mark the session complete only after every planned task passed Code Review and QA and server-controlled Git integration succeeded.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' } } }
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

function phaseLine(workflow, suffix = '') {
  if (!workflow?.active && workflow?.status !== 'READY_TO_COMPLETE') return `AITEAM | Status: ${workflow?.status || 'NO_SESSION'}`;
  const remaining = workflow.remainingPhases?.length ? workflow.remainingPhases.join(' -> ') : 'none';
  const identity = workflow.agentId ? `${workflow.agentRole || workflow.agentId} (${workflow.agentId})` : 'none';
  return `AITEAM | Agent: ${identity}${suffix} | Phase: ${workflow.phase || 'Complete'} | Remaining: ${remaining}`;
}

function advanceResultText(result) {
  const stateLabel = result.result.outcome === 'AWAITING_USER'
    ? 'awaiting user'
    : ['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.result.outcome) ? 'finished' : 'failed';
  const finished = phaseLine({
    ...workflowStatus(result.assignment.session),
    agentId: result.assignment.agentId,
    agentRole: result.assignment.role,
    phase: result.assignment.phase,
    remainingPhases: workflowStatus(result.assignment.session).remainingPhases
  }, ` ${stateLabel}`);
  const manualChecksText = result.result.outcome === 'PASS_WITH_MANUAL_VALIDATION' && result.result.manualChecks?.length
    ? `\nManual validation requested by QA:\n${result.result.manualChecks.map((check, i) => `${i + 1}. ${check}`).join('\n')}\n`
    : '';
  const next = result.session.pendingUserInput?.response == null && result.session.pendingUserInput?.questions?.length
    ? result.session.pendingUserInput.kind === 'qa-manual'
      ? `Manual QA validation required before Integration:\n${result.session.pendingUserInput.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\nRequired next action: perform these checks, then call aiteam_update_session with pendingUserInput containing your confirmation.`
      : `User input required before Intake can advance:\n${result.session.pendingUserInput.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\nRequired next action: ask the user these questions, then call aiteam_update_session with pendingUserInput containing the response.`
    : result.session.status === 'READY_TO_COMPLETE'
    ? 'All enforced gates passed. Required next action: call aiteam_complete.'
    : `Next enforced assignment: ${phaseLine(result.workflow)}`;
  return [finished, `Outcome: ${result.result.outcome}`, `Summary: ${result.result.summary}`, manualChecksText, next].filter(Boolean).join('\n');
}

import http from 'node:http';
import { spawn } from 'node:child_process';

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function ensureWatchServer(repo) {
  if (process.env.NODE_ENV === 'test' || process.env.AITEAM_SKIP_WATCH_SERVER === 'true') {
    return Promise.resolve();
  }
  const url = 'http://127.0.0.1:4317/';
  const encodedRepo = encodeURIComponent(path.resolve(repo));
  return new Promise((resolve) => {
    http.get(`http://127.0.0.1:4317/api/set-repo?repo=${encodedRepo}`, (res) => {
      res.resume();
      openBrowser(url);
      resolve();
    }).on('error', () => {
      const watchScript = path.resolve(fileURLToPath(import.meta.url), '../watch-server.mjs');
      const child = spawn(process.execPath, [watchScript, '--repo', repo, '--port', '4317'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(() => {
        openBrowser(url);
        resolve();
      }, 500);
    });
  });
}

const AGENTS_MD_MARKER = '<!-- aiteam-base-contract -->';
const AGENTS_MD_SECTION = `${AGENTS_MD_MARKER}
## AITEAM Implementation Specialist Contract

You are an AITEAM implementation specialist with **full workspace-write access**.

- You MUST call \`exec_command\` or bash tools to write every file to disk **before** emitting your JSON response.
- Do NOT output file contents in chat and do NOT claim the sandbox is read-only. It is not.
- Only AFTER running a shell command that writes the file and verifying it exists (e.g. \`ls -la filename\`) may you emit your final JSON.
- Return outcome \`"PASS"\` with non-empty \`filesChanged\`. Never return \`"FAIL"\` for your own implementation task.
- **Large files MUST be written in chunks.** The exec_command output limit is ~200 lines per call. For files longer than 150 lines:
  - First chunk: \`cat << 'AITEAM_EOF' > filename\` … first ~100 lines … \`AITEAM_EOF\`
  - Each subsequent chunk: \`cat << 'AITEAM_EOF' >> filename\` … next ~100 lines … \`AITEAM_EOF\` (note \`>>\` for append)
  - After all chunks: verify with \`wc -l filename\`
  - Never write an entire large file in one heredoc — it will be truncated and silently corrupt the file.
`;


function ensureAgentsMd(repo) {
  const agentsMdPath = path.join(repo, 'AGENTS.md');
  let current = '';
  try { current = fs.readFileSync(agentsMdPath, 'utf8'); } catch { /* file doesn't exist yet */ }
  if (current.includes(AGENTS_MD_MARKER)) return; // already written
  const separator = current.trim() ? '\n\n' : '';
  fs.writeFileSync(agentsMdPath, current + separator + AGENTS_MD_SECTION);
}

export async function callTool(name, args) {
  const repo = repoOf(args);

  if (name === 'aiteam_start') {
    ensureGitRepo(repo);
    ensureAgentsMd(repo);

    const existing = readSession(repo);
    if (existing && ['ACTIVE', 'BLOCKED', 'READY_TO_COMPLETE'].includes(existing.status)) {
      throw new Error(`AITEAM session ${existing.id} is already ${existing.status}. Complete or cancel it before starting another request.`);
    }
    const git = gitSnapshot(repo);
    const session = newSession(repo, args.request);
    const registry = loadRegistry(repo);
    const workflow = workflowStatus(session, repo);
    const coordinatorReadOnly = process.env.AITEAM_COORDINATOR_READ_ONLY === 'true';
    
    await ensureWatchServer(repo);
    
    const text = [
      `AITEAM ${VERSION} session started.`,
      `Repository: ${repo}`,
      `Git: ${git.branch}@${git.head.slice(0, 12)}`,
      `Watch Dashboard: http://127.0.0.1:4317/`,
      '',
      coordinatorContract(),
      '',
      coordinatorDirectiveText(session),
      '',
      phaseLine(workflow),
      coordinatorReadOnly
        ? 'Coordinator enforcement: read-only launcher mode is active.'
        : 'Coordinator warning: direct-write prevention is not active. Restart with `v100-ai --aiteam` for a read-only primary Coordinator.',
      '',
      '# Available agents',
      ...registry.agents.map((a) => `- ${a.id}: ${a.role}`),
      '',
      'You are now the AITEAM Coordinator for this request. Keep the user interaction in the primary Codex conversation.'
    ].join('\n');
    const startedContent = {
      session,
      git,
      agents: registry.agents,
      workflow,
      coordinatorReadOnly,
      nextAssignment: getCurrentAssignment(repo),
      coordinatorDirective: coordinatorDirective(session)
    };
    if (args.auto_advance !== false) {
      let firstAdvance;
      try {
        firstAdvance = await advanceWorkflow({
          repo,
          timeoutSeconds: args.timeout_seconds,
          model: args.model || null,
          coordinatorContext: args.request || ''
        });
      } catch (error) {
        const failure = `${text}\n\nAITEAM first-stage execution failed: ${error.message}\nThe session remains active; required next action: call aiteam_advance after resolving the specialist failure.`;
        return textResult(failure, { ...startedContent, firstAdvance: null, firstAdvanceError: error.message });
      }
      return textResult(`${text}\n\n${advanceResultText(firstAdvance)}`, {
        ...startedContent,
        session: firstAdvance.session,
        workflow: firstAdvance.workflow,
        nextAssignment: firstAdvance.session.status === 'ACTIVE' ? getCurrentAssignment(repo) : null,
        coordinatorDirective: coordinatorDirective(firstAdvance.session),
        firstAdvance
      });
    }
    return textResult(`${text}\n\nAutomatic first-stage execution disabled. Required next action: call aiteam_advance.`, startedContent);
  }
  if (name === 'aiteam_status') {
    const session = readSession(repo);
    const git = gitSnapshot(repo);
    const workflow = workflowStatus(session, repo);
    const text = [
      coordinatorDirectiveText(session, { source: 'status' }),
      '',
      phaseLine(workflow),
      '',
      JSON.stringify({ session, git }, null, 2)
    ].join('\n');
    return textResult(text, {
      session,
      git,
      workflow,
      nextAssignment: session?.status === 'ACTIVE' && !session.activeRun ? getCurrentAssignment(repo) : null,
      coordinatorDirective: coordinatorDirective(session)
    });
  }
  if (name === 'aiteam_advance') {
    try {
      const result = await advanceWorkflow({
        repo,
        timeoutSeconds: args.timeout_seconds,
        model: args.model || null,
        coordinatorContext: args.context || ''
      });
      return textResult(advanceResultText(result), result);
    } catch (error) {
      const session = readSession(repo);
      const workflow = workflowStatus(session, repo);
      const text = [
        `AITEAM stage execution encountered an issue: ${error.message}`,
        `Current phase: ${workflow.phase}`,
        '',
        coordinatorDirectiveText(session),
        '',
        'Required action: Review the error, provide guidance if needed, and call aiteam_advance to retry.'
      ].join('\n');
      return textResult(text, { session, workflow, error: error.message, coordinatorDirective: coordinatorDirective(session) });
    }
  }
  if (name === 'aiteam_spawn_agent') {
    const result = await advanceWorkflow({
      repo,
      timeoutSeconds: args.timeout_seconds,
      model: args.model || null,
      coordinatorContext: [args.task || '', args.context || ''].filter(Boolean).join('\n\n'),
      expectedAgentId: args.agent_id
    });
    return textResult(advanceResultText(result), result);
  }
  if (name === 'aiteam_register_specialist') {
    const session = readSession(repo);
    const proposal = session?.verifiedRecruiterProposals?.find((item) => item.id === args.proposal_id && !item.registered);
    if (!proposal || JSON.stringify(proposal.specialist) !== JSON.stringify(args.specialist)) {
      throw new Error('Specialist registration rejected: no matching unregistered Recruiter proposal.');
    }
    const provenance = { source: 'recruiter', runId: proposal.runId, proposalId: proposal.id };
    const specialist = registerScopedSpecialist(repo, args.specialist, { provenance });
    appendEvent(repo, {
      type: 'specialist_registered',
      specialistId: specialist.id,
      role: specialist.role,
      capabilities: specialist.capabilities,
      provenance
    });
    patchSession(repo, {
      verifiedRecruiterProposals: session.verifiedRecruiterProposals.map((item) => item.id === proposal.id ? { ...item, registered: true } : item)
    });
    const text = [
      `Registered workflow-scoped specialist ${specialist.id}: ${specialist.role}.`,
      'Required next action: call aiteam_advance; the server will route the registered specialist at the correct gate.'
    ].join('\n');
    return textResult(text, specialist);
  }
  if (name === 'aiteam_update_session') {
    const allowed = new Set(['coordinatorNotes', 'pendingUserInput']);
    const patch = args.patch || {};
    const rejected = Object.keys(patch).filter((key) => !allowed.has(key));
    if (rejected.length) throw new Error(`Server-owned session fields cannot be patched: ${rejected.join(', ')}`);
    const current = readSession(repo);
    const normalizedPatch = { ...patch };
    if (Object.hasOwn(patch, 'pendingUserInput')) {
      if (!current.pendingUserInput?.questions?.length) throw new Error('No user validation or Analyst question is awaiting a response.');
      const response = typeof patch.pendingUserInput === 'string'
        ? patch.pendingUserInput.trim()
        : patch.pendingUserInput?.response;
      if (typeof response !== 'string' || !response.trim()) throw new Error('pendingUserInput must contain a non-empty user response.');
      normalizedPatch.pendingUserInput = { ...current.pendingUserInput, response: response.trim(), answeredAt: new Date().toISOString() };
    }
    const session = current.pendingUserInput?.kind === 'qa-manual' && Object.hasOwn(patch, 'pendingUserInput')
      ? confirmManualQa(repo, normalizedPatch.pendingUserInput.response)
      : patchSession(repo, normalizedPatch);
    appendEvent(repo, { type: 'session_updated', patch: normalizedPatch });
    return textResult(JSON.stringify(session, null, 2), session);
  }
  if (name === 'aiteam_record_event') {
    const event = appendEvent(repo, { type: 'coordinator_event', ...(args.event || {}) });
    return textResult(JSON.stringify(event, null, 2), event);
  }
  if (name === 'aiteam_complete') {
    const session = completeWorkflow(repo);
    return textResult(`AITEAM session complete at ${session.integration.head}.`, session);
  }
  if (name === 'aiteam_cancel') {
    const session = readSession(repo);
    if (!args.user_confirmed && !args.force) {
      if (session?.status === 'ACTIVE' && session?.currentStage === 'implementation') {
        throw new Error('Coordinator cannot cancel an ACTIVE implementation workflow without explicit user request. Call aiteam_advance to allow the specialist to execute file operations.');
      }
    }
    const child = activeProcesses.get(repo);
    let killed = false;
    if (child) {
      killed = killChildTree(child, 'SIGTERM');
      setTimeout(() => killChildTree(child, 'SIGKILL'), 5000).unref();
    }
    const cancelled = patchSession(repo, { status: 'CANCELLED', cancelReason: args.reason || 'Cancelled by user', activeRun: null });
    appendEvent(repo, { type: 'session_cancelled', reason: args.reason || 'Cancelled by user', processKilled: killed });
    return textResult(JSON.stringify(cancelled, null, 2), cancelled);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handle(msg) {
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

export async function runServer() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { continue; }
    
    handle(msg).then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }).catch((err) => {
      if (msg.id !== undefined) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: `Internal error: ${err.message}` }
        }) + '\n');
      } else {
        process.stderr.write(`AITEAM server error: ${err.stack || err}\n`);
      }
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runServer();
}
