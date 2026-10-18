#!/usr/bin/env node
/**
 * AITeam MCP Server
 * 
 * Provides a clean, lightweight, authoritative state engine for AITeam
 * workflows without nested subprocess runners.
 * 
 * Exposes standard MCP tools:
 * - aiteam_start: Start a session and launch live watcher
 * - aiteam_advance: Advance the workflow gate, validate stage outcomes, and return the next prescriptive directive
 * - aiteam_wait_for_approval: Block and poll until the user clicks Approve or Request Changes in the Watcher Dashboard
 * - aiteam_status: Inspect active session, gates, active task, and watcher URL
 * - aiteam_record_approval: Record human decisions for PRD, TRD, and QA gates
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  readSession,
  initSession,
  startStage,
  completeStage,
  recordApproval,
  waitForApproval,
  updateTaskLedger,
  parseTaskLedgerMarkdown,
  writeActiveLog
} from '../skill/lib/state-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version || '0.7.0';

// Ensure the Watcher dashboard is running for the repo
function ensureWatcher(repo, port = 4317) {
  return new Promise((resolve) => {
    try {
      // Check if watcher is already up
      import('node:http').then(({ default: http }) => {
        const req = http.get(`http://127.0.0.1:${port}/api/state`, (res) => {
          if (res.statusCode === 200) return resolve(`http://localhost:${port}`);
          spawnWatcher();
        });
        req.on('error', spawnWatcher);
        req.setTimeout(500, () => { req.destroy(); spawnWatcher(); });
      });
    } catch {
      spawnWatcher();
    }

    function spawnWatcher() {
      try {
        const binPath = path.join(ROOT_DIR, 'bin', 'aiteam-watch');
        const child = spawn(binPath, [repo, '--port', String(port)], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      } catch {}
      resolve(`http://localhost:${port}`);
    }
  });
}

function resolveRepo(rawRepo) {
  if (rawRepo) return path.resolve(rawRepo);
  return process.cwd();
}

function isTaskIntegrated(t) {
  return Boolean(
    (t.status === 'qa-passed' && (t.integration?.integrated || t.integration?.committed || t.integration?.reason === 'no_changes')) ||
    t.status === 'integrated' ||
    t.status === 'completed'
  );
}

/**
 * Computes prescriptive next-action directive for the coordinator
 */
function getDirective(session, repo) {
  if (!session) {
    return {
      status: 'NO_SESSION',
      instruction: 'Call aiteam_start with your request to initialize the AITeam workflow.',
      nextTool: 'aiteam_start'
    };
  }

  if (session.status === 'COMPLETE') {
    return {
      status: 'COMPLETE',
      instruction: 'All tasks in the ledger are QA-passed and integrated into Git. Milestone complete!',
      nextTool: null
    };
  }

  // Check if a human approval or intake clarification gate is open and pending
  const pending = session.pendingUserInput;
  if (pending && !pending.response) {
    const taskArg = pending.taskId ? `, taskId="${pending.taskId}"` : '';
    const cliTaskArg = pending.taskId ? ` --taskId "${pending.taskId}"` : '';
    const isIntakeGate = pending.gate === 'intake';
    const formattedQuestions = (pending.questions || []).map((q, i) => `  ${i + 1}. ${q}`).join('\n');
    return {
      status: 'GATE_BLOCKED',
      gate: pending.gate,
      kind: pending.kind,
      doc: pending.doc || null,
      taskId: pending.taskId || null,
      questions: pending.questions || [],
      instruction: isIntakeGate
        ? `🛑 INTAKE CLARIFYING INTERVIEW OPEN. Present these clarifying questions clearly to the user in chat:\n${formattedQuestions}\nThen IMMEDIATELY wait for the user's answers in the Watcher Dashboard Portal by calling aiteam_wait_for_approval(gate="intake") (or run bash: node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "${repo}" --gate intake && call aiteam_status). If the user replies in chat instead, record their answers via aiteam_record_approval(gate="intake", decision="approved", response="<user's answers>").`
        : `🛑 GATE OPEN (${pending.gate.toUpperCase()}). Present ${pending.doc || 'the QA verification checklist'} briefly to the user, then IMMEDIATELY wait for the Watcher Portal click by calling aiteam_wait_for_approval(gate="${pending.gate}"${taskArg}) (or if that tool is not in your schema, run bash: node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "${repo}" --gate ${pending.gate}${cliTaskArg} && call aiteam_status). It will block and automatically resume the moment the user clicks "Approve Gate" or "Request Changes" in the Watcher Dashboard Portal.`,
      nextTool: 'aiteam_wait_for_approval'
    };
  }

  const completedStages = new Set(session.completedStages || []);
  let activeStage = session.currentStage;
  if (activeStage === 'prd-review' && completedStages.has('prd-review')) {
    activeStage = 'architecture';
  } else if (activeStage === 'trd-review' && completedStages.has('trd-review')) {
    activeStage = 'environment-readiness';
  } else if (activeStage === 'environment-readiness' && completedStages.has('environment-readiness')) {
    activeStage = 'implementation';
  }

  // Setup stages before task loop (exact 9-stage Gate Progress order)
  if (activeStage === 'intake') {
    const prdFeedback = session.approvals?.prd?.decision === 'CHANGES_REQUESTED' ? session.approvals.prd.response : null;
    let instruction;
    if (prdFeedback) {
      instruction = `User requested changes on the PRD: "${prdFeedback}". Revise .aiteam/docs/prd.html accordingly, then call aiteam_advance with stage="intake", outcome="PASS", and summary.`;
    } else if (!session.intakeClarified) {
      instruction = 'STEP 1 OF 2 (MANDATORY INTAKE CLARIFYING INTERVIEW): Inspect the repository first so your questions are grounded in the existing codebase, then formulate 3-5 concrete, high-impact clarifying questions covering ambiguous scope, user flows, edge cases, or visual/UX behavior (include a recommended default in parentheses for each question). Do NOT write .aiteam/docs/prd.html yet — the state engine rejects intake PASS until clarifying questions are asked and answered. Call aiteam_advance with stage="intake", outcome="AWAITING_USER", questions=["1. ...", "2. ..."], and summary.';
    } else {
      instruction = `STEP 2 OF 2 (AUTHOR PRD FROM USER ANSWERS): The user answered the intake clarifying questions: "${session.intakeAnswers || 'Use recommended defaults'}". Incorporate all user answers into a comprehensive Product Requirements Document at .aiteam/docs/prd.html following skill/contracts/analyst.md (including a "Clarifications & Product Decisions" table). When .aiteam/docs/prd.html is written on disk, call aiteam_advance with stage="intake", outcome="PASS", and summary.`;
    }
    return {
      status: 'ACTIVE',
      stage: 'intake',
      role: 'analyst',
      instruction,
      contractFile: 'skill/contracts/analyst.md',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'prd-review') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'prd',
      doc: '.aiteam/docs/prd.html',
      instruction: `🛑 PRD GATE OPEN — Call aiteam_wait_for_approval(gate="prd") (or run bash: node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "${repo}" --gate prd) to wait until the user clicks "Approve Gate" or "Request Changes" in the Watcher Dashboard.`,
      nextTool: 'aiteam_wait_for_approval'
    };
  }

  if (activeStage === 'architecture') {
    return {
      status: 'ACTIVE',
      stage: 'architecture',
      role: 'architect',
      instruction: 'Execute the Systems Architect stage (skill/contracts/architect.md): define component boundaries, interfaces, data models, and initialize .aiteam/docs/trd.html. When done, call aiteam_advance with stage="architecture", outcome="PASS", and summary.',
      contractFile: 'skill/contracts/architect.md',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'ui-design') {
    return {
      status: 'ACTIVE',
      stage: 'ui-design',
      role: 'ui-designer',
      instruction: 'Execute the UI/UX Designer stage (skill/contracts/ui-designer.md): define user flows, screen mockups, layout hierarchy, design tokens, and interaction states, and append the UI/UX section to .aiteam/docs/trd.html. Then call aiteam_advance with stage="ui-design", outcome="PASS", and summary.',
      contractFile: 'skill/contracts/ui-designer.md',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'planning') {
    return {
      status: 'ACTIVE',
      stage: 'planning',
      role: 'planner',
      contractFile: 'skill/contracts/planner.md',
      instruction: 'Execute the Technical Planner stage (skill/contracts/planner.md): create TASK_LEDGER.md with explicit acceptance criteria (### T1: Title and - [ ] AC-1: ...) and append the Implementation Plan section to .aiteam/docs/trd.html. Then call aiteam_advance with stage="planning", ledger="TASK_LEDGER.md", outcome="PASS".',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'qa-planning') {
    return {
      status: 'ACTIVE',
      stage: 'qa-planning',
      role: 'qa-planner',
      contractFile: 'skill/contracts/qa-planner.md',
      instruction: 'Execute the QA Test Planner stage (skill/contracts/qa-planner.md): design pre-implementation black-box test plans and regression strategy for every task in TASK_LEDGER.md, and append the QA Testing Plan section to .aiteam/docs/trd.html. Then call aiteam_advance with stage="qa-planning", outcome="PASS", and summary.',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'critical-review') {
    const trdFeedback = session.approvals?.trd?.decision === 'CHANGES_REQUESTED' ? session.approvals.trd.response : null;
    return {
      status: 'ACTIVE',
      stage: 'critical-review',
      role: 'critical-reviewer',
      contractFile: 'skill/contracts/critical-reviewer.md',
      instruction: trdFeedback
        ? `User requested changes on the TRD: "${trdFeedback}". Revise .aiteam/docs/trd.html and TASK_LEDGER.md as needed, then call aiteam_advance with stage="critical-review", outcome="PASS", and summary to re-open the TRD approval gate.`
        : 'Execute the Critical Reviewer stage (skill/contracts/critical-reviewer.md): audit Architecture, UI Design, TASK_LEDGER.md, and QA Plan against .aiteam/docs/prd.html, and finalize .aiteam/docs/trd.html. Then call aiteam_advance with stage="critical-review", outcome="PASS", and summary (which opens the 🛑 TRD Approval Gate).',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'trd-review') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'trd',
      doc: '.aiteam/docs/trd.html',
      instruction: `🛑 TRD GATE OPEN — Call aiteam_wait_for_approval(gate="trd") (or run bash: node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "${repo}" --gate trd) to wait until the user clicks "Approve Gate" or "Request Changes" in the Watcher Dashboard.`,
      nextTool: 'aiteam_wait_for_approval'
    };
  }

  if (activeStage === 'environment-readiness') {
    return {
      status: 'ACTIVE',
      stage: 'environment-readiness',
      role: 'environment-readiness',
      contractFile: 'skill/contracts/environment-readiness.md',
      instruction: 'Execute the Environment Readiness stage (skill/contracts/environment-readiness.md): verify workspace build, unit test, and Playwright black-box test runners work cleanly. Then call aiteam_advance with stage="environment-readiness", outcome="PASS", and summary to begin Task 1 implementation.',
      nextTool: 'aiteam_advance'
    };
  }

  const taskLedger = Array.isArray(session.taskLedger) ? session.taskLedger : [];

  // Task execution loop: find active or next unintegrated task
  const nextTask = taskLedger.find((t) => !isTaskIntegrated(t));

  if (!nextTask) {
    return {
      status: 'READY_TO_COMPLETE',
      instruction: 'All tasks have passed QA and Git integration. Milestone complete!',
      nextTool: null
    };
  }

  // Determine stage for active task
  let taskStage = 'implementation';
  let taskRole = 'programmer';
  let contract = 'skill/contracts/programmer.md';
  let instruction = `Implement task ${nextTask.id} (${nextTask.title || ''}) per skill/contracts/programmer.md. Verify acceptance criteria, run unit tests, and call aiteam_advance with stage="implementation", taskId="${nextTask.id}", filesChanged=[...], and summary.`;

  if (nextTask.status === 'needs-rework') {
    const failureNote = nextTask.qaFailure?.response || nextTask.qaFailure?.summary || nextTask['code-reviewFailure']?.summary || '';
    instruction = `Task ${nextTask.id} (${nextTask.title || ''}) FAILED review/QA and needs rework. Feedback: "${failureNote || 'Fix issues noted during verification'}". Address root causes, verify unit tests, and call aiteam_advance with stage="implementation", taskId="${nextTask.id}", filesChanged=[...].`;
  } else if (nextTask.status === 'implemented') {
    taskStage = 'code-review';
    taskRole = 'code-reviewer';
    contract = 'skill/contracts/reviewer.md';
    instruction = `Spawn an isolated Code Reviewer subagent (skill/contracts/reviewer.md in READ-ONLY mode—do not self-review inline) to audit git diff for ${nextTask.id}. Then call aiteam_advance with stage="code-review", taskId="${nextTask.id}", outcome="PASS"|"FAIL", and findings.`;
  } else if (nextTask.status === 'review-passed') {
    taskStage = 'qa';
    taskRole = 'qa';
    contract = 'skill/contracts/qa.md';
    instruction = `Spawn an isolated QA Engineer subagent (skill/contracts/qa.md) to author and execute dedicated black-box tests in tests/qa/${nextTask.id}.test.* covering ${nextTask.id}. Call aiteam_advance with stage="qa", taskId="${nextTask.id}", outcome="PASS"|"FAIL", and checks.`;
  } else if (nextTask.status === 'qa-auto-passed') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'qa',
      taskId: nextTask.id,
      instruction: `🛑 QA GATE OPEN for ${nextTask.id} — Call aiteam_wait_for_approval(gate="qa", taskId="${nextTask.id}") to wait until the user clicks "Pass & Approve" or "Fail / Request Rework" in the Watcher Dashboard.`,
      nextTool: 'aiteam_wait_for_approval'
    };
  } else if (nextTask.status === 'qa-passed') {
    taskStage = 'integration';
    taskRole = 'maintainer';
    contract = 'skill/contracts/maintainer.md';
    instruction = `Execute Maintainer Git integration (skill/contracts/maintainer.md) for ${nextTask.id}: verify unchanged SHA-256 fingerprint, stage ONLY [${(nextTask.filesChanged || []).join(', ')}], create a conventional git commit, and call aiteam_advance with stage="integration", taskId="${nextTask.id}", outcome="PASS".`;
  }

  return {
    status: 'ACTIVE',
    stage: taskStage,
    role: taskRole,
    activeTask: {
      id: nextTask.id,
      title: nextTask.title,
      status: nextTask.status,
      description: nextTask.description,
      acceptanceCriteria: nextTask.acceptanceCriteria,
      filesChanged: nextTask.filesChanged || []
    },
    contractFile: contract,
    instruction,
    nextTool: 'aiteam_advance'
  };
}

// Tool definitions for MCP
export const toolDefs = [
  {
    name: 'aiteam_start',
    description: 'Initialize an AITeam workflow in the repository, launch the live Watcher dashboard, and enter Stage 1 (Intake).',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The raw user feature/upgrade request prompt.' },
        repository: { type: 'string', description: 'Target git repository path (defaults to current directory).' }
      },
      required: ['request']
    }
  },
  {
    name: 'aiteam_advance',
    description: 'Transition the workflow gate, report stage/task completion, validate artifacts/tests/fingerprints, and receive prescriptive instructions for the next required action.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' },
        stage: { type: 'string', description: 'The stage being started or completed (intake, architecture, planning, implementation, code-review, qa, integration).' },
        action: { type: 'string', enum: ['start', 'complete'], default: 'complete', description: 'Whether starting or completing the stage.' },
        taskId: { type: 'string', description: 'Task ID if completing a task-specific stage (e.g. T1).' },
        outcome: { type: 'string', enum: ['PASS', 'FAIL', 'AWAITING_USER', 'PASS_WITH_MANUAL_VALIDATION'], default: 'PASS' },
        summary: { type: 'string', description: 'Brief summary of what was accomplished or observed.' },
        questions: { type: 'array', items: { type: 'string' }, description: 'Clarifying questions for the user when completing intake with outcome="AWAITING_USER".' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Supporting evidence, test outputs, or findings.' },
        filesChanged: { type: 'array', items: { type: 'string' }, description: 'List of files modified during implementation.' },
        findings: { type: 'array', items: { type: 'object' }, description: 'Code review findings array (if stage="code-review").' },
        checks: { type: 'array', items: { type: 'object' }, description: 'QA black-box check results (if stage="qa").' },
        commitMessage: { type: 'string', description: 'Git commit message created during integration.' },
        ledger: { type: 'string', description: 'Path to TASK_LEDGER.md when completing the planning stage.' }
      }
    }
  },
  {
    name: 'aiteam_wait_for_approval',
    description: 'Block and wait until the human user submits answers or clicks "Approve Gate" / "Request Changes" in the Watcher Dashboard Portal for an open intake, PRD, TRD, or per-task QA gate, then automatically return the next directive.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' },
        gate: { type: 'string', enum: ['intake', 'prd', 'trd', 'qa'], description: 'The open gate to wait on (intake, prd, trd, or qa).' },
        taskId: { type: 'string', description: 'Task ID if waiting on a per-task QA gate.' }
      },
      required: ['gate']
    }
  },
  {
    name: 'aiteam_record_approval',
    description: 'Record the human user answers or decision for intake, PRD, TRD, or per-task QA gates ONLY AFTER the human user has explicitly replied in chat. Prefer aiteam_wait_for_approval so the user can interact in the Watcher Portal.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' },
        gate: { type: 'string', enum: ['intake', 'prd', 'trd', 'qa'], description: 'The gate being decided.' },
        decision: { type: 'string', enum: ['approved', 'changes_requested'], description: 'The human decision.' },
        taskId: { type: 'string', description: 'Task ID if deciding a per-task QA gate.' },
        response: { type: 'string', description: 'Exact verbatim words or answers from the human user reply.' }
      },
      required: ['gate', 'decision']
    }
  },
  {
    name: 'aiteam_status',
    description: 'Get current AITeam workflow status, active gates, active task, and watcher URL without modifying state.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' }
      }
    }
  },
  {
    name: 'aiteam_log',
    description: 'Stream live activity, progress notes, thoughts, or command status to the AITeam live monitor in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Activity note, command output, or progress description to display live.' },
        agentId: { type: 'string', description: 'Optional agent or role name (e.g. programmer, qa, architect).' },
        repository: { type: 'string', description: 'Target git repository path.' }
      },
      required: ['message']
    }
  }
];

export async function handleToolCall(name, args = {}) {
  const repo = resolveRepo(args.repository);

  if (name === 'aiteam_start') {
    const watchUrl = await ensureWatcher(repo);
    initSession(repo, args.request);
    startStage(repo, 'intake');
    const directive = getDirective(readSession(repo), repo);

    return {
      content: [
        {
          type: 'text',
          text: [
            `🚀 AITeam v${VERSION} session started!`,
            `📁 Repository: ${repo}`,
            `📊 Live Dashboard: ${watchUrl}`,
            `🎯 Current Stage: intake`,
            '',
            `👉 NEXT DIRECTIVE:`,
            directive.instruction
          ].join('\n')
        }
      ],
      session: readSession(repo),
      directive,
      watchUrl
    };
  }

  if (name === 'aiteam_status') {
    const session = readSession(repo);
    const watchUrl = await ensureWatcher(repo);
    const directive = getDirective(session, repo);

    return {
      content: [
        {
          type: 'text',
          text: [
            `AITeam Status: ${session ? session.status : 'NO SESSION'}`,
            `Stage: ${session ? session.currentStage : '—'}`,
            `Watcher: ${watchUrl}`,
            '',
            `👉 DIRECTIVE:`,
            directive.instruction
          ].join('\n')
        }
      ],
      session,
      directive,
      watchUrl
    };
  }

  if (name === 'aiteam_wait_for_approval') {
    const { session, approval } = await waitForApproval(repo, {
      gate: args.gate,
      taskId: args.taskId || null,
      pollMs: args.pollMs || 750,
      timeoutMs: args.timeoutMs || 3600000
    });
    const directive = getDirective(session, repo);

    return {
      content: [
        {
          type: 'text',
          text: [
            `✅ Watcher Portal Gate [${approval.gate}${approval.taskId ? ':' + approval.taskId : ''}] decided by human: ${approval.decision}`,
            approval.response ? `💬 Human Notes: "${approval.response}"` : '',
            '',
            `👉 NEXT DIRECTIVE:`,
            directive.instruction
          ].filter(Boolean).join('\n')
        }
      ],
      approval,
      directive,
      session
    };
  }

  if (name === 'aiteam_record_approval') {
    const result = recordApproval(repo, {
      gate: args.gate,
      taskId: args.taskId || null,
      decision: args.decision,
      response: args.response || '',
      approvedBy: 'user',
      enforceDwell: true
    });

    const session = readSession(repo);
    const directive = getDirective(session, repo);

    return {
      content: [
        {
          type: 'text',
          text: [
            `✅ Approval recorded: Gate [${args.gate}] = ${args.decision.toUpperCase()}`,
            '',
            `👉 NEXT DIRECTIVE:`,
            directive.instruction
          ].join('\n')
        }
      ],
      approval: result,
      directive,
      session
    };
  }

  if (name === 'aiteam_advance') {
    let session = readSession(repo);
    if (!session) throw new Error(`No active AITeam session found in ${repo}. Run aiteam_start first.`);

    const stage = args.stage || session.currentStage;
    const action = args.action || 'complete';
    const taskId = args.taskId || session.currentTaskId || null;

    if (action === 'start') {
      startStage(repo, stage, taskId);
      const desc = args.summary || `Starting stage [${stage}]${taskId ? ` for task ${taskId}` : ''}`;
      writeActiveLog(repo, `▶ ${desc}`, stage);
    } else {
      // If planning provided a ledger file, parse and register tasks before completing planning
      if (stage === 'planning' && args.ledger) {
        const ledgerPath = path.isAbsolute(args.ledger) ? args.ledger : path.join(repo, args.ledger);
        if (!fs.existsSync(ledgerPath)) {
          throw new Error(`AITEAM_ARTIFACT_MISSING: Ledger file "${args.ledger}" does not exist.`);
        }
        const content = fs.readFileSync(ledgerPath, 'utf8');
        const tasks = parseTaskLedgerMarkdown(content);
        if (tasks.length === 0) {
          throw new Error(`AITEAM_LEDGER_EMPTY: No tasks ("### T1: Title") found in "${args.ledger}".`);
        }
        updateTaskLedger(repo, tasks);
      }

      completeStage(repo, stage, taskId, {
        outcome: args.outcome || 'PASS',
        summary: args.summary || `${stage} completed`,
        questions: args.questions || [],
        evidence: args.evidence || [],
        filesChanged: args.filesChanged || [],
        findings: args.findings || [],
        checks: args.checks || [],
        commitMessage: args.commitMessage || null
      });

      const desc = args.summary || `Completed stage [${stage}]${taskId ? ` for task ${taskId}` : ''} (outcome: ${args.outcome || 'PASS'})`;
      writeActiveLog(repo, `✓ ${desc}`, stage);
    }

    session = readSession(repo);
    const directive = getDirective(session, repo);

    return {
      content: [
        {
          type: 'text',
          text: [
            `🔄 AITeam advanced: stage [${stage}] ${action}ed (outcome: ${args.outcome || 'PASS'}).`,
            `Status: ${session.status}`,
            '',
            `👉 NEXT DIRECTIVE:`,
            directive.instruction
          ].join('\n')
        }
      ],
      directive,
      session
    };
  }

  if (name === 'aiteam_log') {
    const message = args.message || '';
    const agentId = args.agentId || 'specialist';
    writeActiveLog(repo, message, agentId);

    return {
      content: [
        {
          type: 'text',
          text: `⚡ Logged to live monitor: ${message}`
        }
      ],
      ok: true
    };
  }

  throw new Error(`Unknown AITeam tool: ${name}`);
}

// JSON-RPC / MCP stdio server loop
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.method === 'initialize') {
      const resp = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'aiteam-mcp', version: VERSION },
          capabilities: { tools: {} }
        }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    } else if (msg.method === 'tools/list') {
      const resp = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: toolDefs }
      };
      process.stdout.write(JSON.stringify(resp) + '\n');
    } else if (msg.method === 'tools/call') {
      try {
        const { name, arguments: toolArgs } = msg.params;
        const res = await handleToolCall(name, toolArgs);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: res }) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `❌ AITeam Error: ${err.message}` }],
            isError: true
          }
        }) + '\n');
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Fatal MCP Error: ${err.stack}\n`);
    process.exit(1);
  });
}
