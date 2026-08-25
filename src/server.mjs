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
import { advanceWorkflow, completeWorkflow, confirmHumanReview, confirmManualQa, getCurrentAssignment, workflowStatus } from './workflow.mjs';

const VERSION = '0.2.0';

export const toolDefs = [
  {
    name: 'aiteam_start',
    description: 'Initialize a server-governed AITEAM request in the repository directory and synchronously run the first required specialist stage. This does not start background workers; the coordinator must advance each stage. Present intake/manual QA questions to the user verbatim, submit responses via aiteam_update_session, and loop aiteam_advance until completion.',
    inputSchema: { type: 'object', properties: { request: { type: 'string', description: 'The exact raw text of the user prompt. DO NOT REPHRASE, SUMMARIZE, OR EXPAND. Pass the raw string verbatim.' }, repository: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Compatibility input. The server always gives every specialist exactly one hour.' }, auto_advance: { type: 'boolean', description: 'Testing/compatibility escape hatch; defaults to true.' } }, required: ['request'] }
  },
  {
    name: 'aiteam_status',
    description: 'Read one AITEAM session, enforced workflow gate, active agent, current phase, and remaining phases. This never advances work and must not be polled.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' } } }
  },
  {
    name: 'aiteam_advance',
    description: 'Run exactly the specialist required by the server-owned workflow gate, validate its structured result, update the task ledger, and advance or route rework. The call is synchronous; use the Watch Dashboard for live subprocess output and report the result after it returns.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, context: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Compatibility input. The server always gives every specialist exactly one hour.' } } }
  },
  {
    name: 'aiteam_spawn_agent',
    description: 'Compatibility alias for aiteam_advance. The requested agent_id must equal the server-required agent for the current phase; arbitrary or out-of-order delegation is rejected.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, agent_id: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Compatibility input. The server always gives every specialist exactly one hour.' } }, required: ['agent_id', 'task'] }
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
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, patch: { type: 'object', description: 'To pass the user response back, provide exactly: { "pendingUserInput": "the user string here" }' } }, required: ['patch'] }
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
    description: 'Cancel the active session and discard unintegrated work. DO NOT USE THIS TOOL autonomously. You may ONLY call this tool if the human user explicitly tells you to cancel the session.',
    inputSchema: { type: 'object', properties: { repository: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'] }
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

export function advanceResultText(result) {
  const stateLabel = result.result.outcome === 'AWAITING_USER'
    ? 'awaiting user'
    : ['PASS', 'PASS_WITH_MANUAL_VALIDATION'].includes(result.result.outcome) ? 'finished' : 'failed';
  const updatedWorkflow = workflowStatus(result.session);
  const finished = phaseLine({
    ...updatedWorkflow,
    agentId: result.assignment.agentId,
    agentRole: result.assignment.role,
    phase: result.assignment.phase,
    remainingPhases: updatedWorkflow.remainingPhases
  }, ` ${stateLabel}`);
  const manualChecksText = result.result.outcome === 'PASS_WITH_MANUAL_VALIDATION' && result.result.manualChecks?.length
    ? `\nManual validation requested by QA:\n${result.result.manualChecks.map((check, i) => `${i + 1}. ${check}`).join('\n')}\n`
    : '';
  const next = result.session.pendingUserInput?.response == null && result.session.pendingUserInput?.questions?.length
    ? ['prd-review', 'trd-review'].includes(result.session.pendingUserInput.kind)
      ? `STOP CALLING TOOLS! Human ${result.session.pendingUserInput.kind === 'prd-review' ? 'PRD' : 'TRD'} approval required:\n${result.session.pendingUserInput.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\nYou MUST present the URL to the user and wait for their reply. DO NOT call aiteam_update_session yet.`
      : result.session.pendingUserInput.kind === 'qa-manual'
      ? `STOP CALLING TOOLS! Manual QA validation required before Integration:\n${result.session.pendingUserInput.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\nYou MUST print these checks to the user and wait for their reply. DO NOT call aiteam_update_session yet.`
      : `STOP CALLING TOOLS! User input required before Intake can advance:\n${result.session.pendingUserInput.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\nYou MUST print these questions to the user and wait for their reply. DO NOT call aiteam_update_session until the real user responds.`
    : result.session.status === 'READY_TO_COMPLETE'
    ? 'All enforced gates passed. Required next action: call aiteam_complete.'
    : `Next enforced assignment: ${phaseLine(result.workflow)}\nMANDATORY SAME-TURN ACTION: After reporting this result, call aiteam_advance immediately. Do not end your turn after this update; continue advancing until real human input is required or the workflow is ready to complete.`;
  const urgentUserInput = result.session.pendingUserInput?.response == null && result.session.pendingUserInput?.questions?.length
    ? `${next}\n\n`
    : '';
  return [urgentUserInput, finished, `Outcome: ${result.result.outcome}`, `Summary: ${result.result.summary}`, manualChecksText, urgentUserInput ? '' : next].filter(Boolean).join('\n');
}

import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const watchPorts = new Map();

export function getWatchPort(repo) {
  const resolved = path.resolve(repo);
  if (watchPorts.has(resolved)) return watchPorts.get(resolved);
  if (process.env.AITEAM_WATCH_PORT) {
    const configured = Number(process.env.AITEAM_WATCH_PORT);
    if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) {
      throw new Error('AITEAM_WATCH_PORT must be an integer between 1024 and 65535.');
    }
    return configured;
  }
  const hash = crypto.createHash('sha256').update(resolved).digest();
  return 4320 + (hash.readUInt32BE(0) % 20000);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function watchHealth(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 8192) body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({ occupied: true, repository: null });
        try {
          const parsed = JSON.parse(body);
          finish({ occupied: true, repository: parsed.repository ? path.resolve(parsed.repository) : null });
        } catch {
          finish({ occupied: true, repository: null });
        }
      });
    });
    req.setTimeout(500, () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

async function ensureWatchServer(repo) {
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT || process.env.AITEAM_SKIP_WATCH_SERVER === 'true') {
    return getWatchPort(repo);
  }
  const resolved = path.resolve(repo);
  const basePort = getWatchPort(resolved);
  const watchScript = path.resolve(fileURLToPath(import.meta.url), '../watch-server.mjs');
  for (let offset = 0; offset < 20; offset += 1) {
    const port = 1024 + ((basePort - 1024 + offset) % (65535 - 1024 + 1));
    const existing = await watchHealth(port);
    if (existing?.repository === resolved) {
      watchPorts.set(resolved, port);
      openBrowser(`http://127.0.0.1:${port}/`);
      return port;
    }
    if (existing?.occupied) continue;
    const child = spawn(process.execPath, [watchScript, '--repo', resolved, '--port', String(port)], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = await watchHealth(port);
      if (started?.repository === resolved) {
        watchPorts.set(resolved, port);
        openBrowser(`http://127.0.0.1:${port}/`);
        return port;
      }
      if (started?.occupied) break;
    }
  }
  throw new Error(`Unable to allocate an AITEAM Watch port for ${resolved}.`);
}

export async function callTool(name, args) {
  const repo = repoOf(args);

  if (name === 'aiteam_start') {
    if (typeof args.request !== 'string' || !args.request.trim()) {
      throw new Error('aiteam_start requires a non-empty "request" string.');
    }
    ensureGitRepo(repo);

    const existing = readSession(repo);
    if (existing && ['ACTIVE', 'BLOCKED', 'READY_TO_COMPLETE'].includes(existing.status)) {
      throw new Error(`AITEAM session ${existing.id} is already ${existing.status}. Complete or cancel it before starting another request.`);
    }
    const git = gitSnapshot(repo);
    let session = newSession(repo, args.request);
    const registry = loadRegistry(repo);
    const coordinatorReadOnly = process.env.AITEAM_COORDINATOR_READ_ONLY === 'true';
    const watchPort = await ensureWatchServer(repo);
    session = patchSession(repo, { watchPort });
    const workflow = workflowStatus(session, repo);
    
    const text = [
      `AITEAM ${VERSION} session started.`,
      `Repository: ${repo}`,
      `Git: ${git.branch}@${git.head.slice(0, 12)}`,
      `Watch Dashboard: http://127.0.0.1:${watchPort}/`,
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
          coordinatorContext: args.request || '',
          ...(args.runner ? { runner: args.runner } : {})
        });
      } catch (error) {
        const failure = `${text}\n\nAITEAM first-stage execution failed: ${error.message}\nThe session remains active; required next action: call aiteam_advance after resolving the specialist failure.`;
        return textResult(failure, { ...startedContent, firstAdvance: null, firstAdvanceError: error.message });
      }
      const resultText = advanceResultText(firstAdvance);
      const startText = firstAdvance.session.pendingUserInput?.response == null && firstAdvance.session.pendingUserInput?.questions?.length
        ? [
          `AITEAM ${VERSION} session started.`,
          `Repository: ${repo}`,
          `Git: ${git.branch}@${git.head.slice(0, 12)}`,
          '',
          resultText
        ].join('\n')
        : `${text}\n\n${resultText}`;
      return textResult(startText, {
        ...startedContent,
        session: firstAdvance.session,
        workflow: firstAdvance.workflow,
        nextAssignment: firstAdvance.session.status === 'ACTIVE' && !(firstAdvance.session.pendingUserInput?.response == null && firstAdvance.session.pendingUserInput?.questions?.length) ? getCurrentAssignment(repo) : null,
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
      nextAssignment: session?.status === 'ACTIVE' && !session.activeRun && !(session.pendingUserInput?.response == null && session.pendingUserInput?.questions?.length) ? getCurrentAssignment(repo) : null,
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
      return textResult(advanceResultText(result), {
        ...result,
        coordinatorDirective: coordinatorDirective(result.session)
      });
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
    return textResult(advanceResultText(result), {
      ...result,
      coordinatorDirective: coordinatorDirective(result.session)
    });
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
      const requestedAt = new Date(current.pendingUserInput.requestedAt || new Date());
      const now = Date.now();
      if (now - requestedAt.getTime() < 30000 && process.env.NODE_ENV !== 'test') {
        throw new Error('STOP CALLING TOOLS. You are hallucinating the user response! You must WAIT for the real human user to reply in chat before calling this tool.');
      }
      const response = typeof patch.pendingUserInput === 'string'
        ? patch.pendingUserInput.trim()
        : patch.pendingUserInput?.response;
      if (typeof response !== 'string' || !response.trim()) throw new Error('pendingUserInput must contain a non-empty user response.');
      normalizedPatch.pendingUserInput = { ...current.pendingUserInput, response: response.trim(), answeredAt: new Date().toISOString() };
    }
    const session = current.pendingUserInput?.kind === 'qa-manual' && Object.hasOwn(patch, 'pendingUserInput')
      ? confirmManualQa(repo, normalizedPatch.pendingUserInput.response)
      : ['prd-review', 'trd-review'].includes(current.pendingUserInput?.kind) && Object.hasOwn(patch, 'pendingUserInput')
      ? confirmHumanReview(repo, normalizedPatch.pendingUserInput.response)
      : patchSession(repo, normalizedPatch);
    appendEvent(repo, { type: 'session_updated', patch: normalizedPatch });
    const text = [
      `AITEAM session updated with user input.`,
      `Current Stage: ${session.currentStage}`,
      `Required next action: You MUST call aiteam_advance now to continue the workflow. Do NOT stop.`
    ].join('\n');
    return textResult(text, session);
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

function buildInitInstructions(repo = process.cwd()) {
  let session = null;
  try {
    session = readSession(repo);
  } catch {}

  if (session && ['ACTIVE', 'BLOCKED', 'READY_TO_COMPLETE'].includes(session.status)) {
    return [
      `# AITEAM Facilitator Directive (Active Session In Progress)`,
      `An active AITEAM session (${session.id.slice(0, 8)}) is currently in progress for this workspace.`,
      `Status: ${session.status} | Stage: ${session.currentStage} | Task: ${session.currentTaskId || 'none'}`,
      ``,
      `YOUR ROLE AS FACILITATOR:`,
      `1. Do NOT call aiteam_start (a session is already active).`,
      `2. Remind the user: "Active session in progress. You can monitor live progress on the [AITEAM Watch Dashboard](http://127.0.0.1:${session.watchPort || getWatchPort(repo)}/)."`,
      `3. Call aiteam_advance immediately to continue advancing the workflow gates.`,
      `   - Progress updates are not stopping points. After every result update, call aiteam_advance again in the same assistant turn while no real human input is pending.`,
      `4. If questions or manual QA checks are pending for the user:`,
      `   - Present the exact questions / checks directly to the user in chat.`,
      `   - DO NOT answer questions yourself, do NOT guess user preferences, and do NOT self-approve manual QA.`,
      `   - Wait for the user to reply in chat, then call aiteam_update_session(patch: { pendingUserInput: "<user response>" }).`,
      `   - Immediately call aiteam_advance to re-enter the execution loop.`,
      `5. Continue looping aiteam_advance in the same assistant turn until real human input is required, the project reaches COMPLETED, or the user explicitly pauses/cancels.`
    ].join('\n');
  }

  return [
    `# AITEAM Facilitator Directive`,
    `You are the Facilitator for an AITEAM autonomous team project using the AITEAM MCP server.`,
    ``,
    `HOW TO START:`,
    `1. If the user's initial message contains concrete functional requirements (e.g. game rules, app features, tech stack):`,
    `   - Immediately call aiteam_start(request: "<raw verbatim user prompt>").`,
    `   - Report to the user that the project has started and provide them the clickable AITEAM Watch link: [AITEAM Watch Dashboard](http://127.0.0.1:${getWatchPort(repo)}/) to monitor live progress.`,
    `   - Do NOT implement code, initialize git, or run shell commands yourself.`,
    `2. If the user's message is a greeting, setup question, or ambiguous request (e.g. "hello", "are you ready?"):`,
    `   - Greet the user warmly and ask them to describe the project they would like to create:`,
    `     1. What kind of project / game are you building?`,
    `     2. Visual style / theme preferences?`,
    `     3. Key features or requirements?`,
    `     4. Preferred tech stack / platform?`,
    `   - Inform the user that once started, they can monitor live progress on the [AITEAM Watch Dashboard](http://127.0.0.1:${getWatchPort(repo)}/).`,
    `   - Once they provide requirements, call aiteam_start(request: "<raw verbatim user prompt>") and share the [AITEAM Watch Dashboard](http://127.0.0.1:${getWatchPort(repo)}/) link.`,
    ``,
    `WORKFLOW LOOP & MANUAL QA PROTOCOL:`,
    `- After calling aiteam_start, confirm: "The AITEAM project is now running! Use the Watch Dashboard URL returned by aiteam_start to monitor live progress."`,
    `- Loop calling aiteam_advance for each step until status is COMPLETED.`,
    `- A progress update is never a stopping point. After reporting each result, call aiteam_advance again in the same assistant turn unless real human input is pending or the user explicitly pauses/cancels.`,
    `- When QA reaches manual validation:`,
    `  1. Present the exact manual test checklist to the human user in chat.`,
    `  2. DO NOT answer or pass manual checks yourself, and do NOT guess that tests pass.`,
    `  3. Wait for the user to physically test and reply with their findings.`,
    `  4. Call aiteam_update_session(patch: { pendingUserInput: "<user findings>" }).`,
    `  5. Immediately call aiteam_advance to resume the loop.`,
    `- Never provide manual code diffs or patches when the user reports bugs — always route them via aiteam_update_session and aiteam_advance so AITEAM specialists perform the fix.`,
    `- Let AITEAM specialists handle all coding, git, and testing. Do not edit files directly.`
  ].join('\n');
}

export async function handle(msg) {
  if (msg.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aiteam', version: VERSION },
        instructions: buildInitInstructions()
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
    catch (parseErr) { process.stderr.write(`AITEAM: malformed JSON-RPC input (${parseErr.message}): ${line.slice(0, 200)}\n`); continue; }
    
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
