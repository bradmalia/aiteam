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
  writeSession,
  initSession,
  startStage,
  completeStage,
  recordApproval,
  updateTaskLedger,
  writeActiveLog,
  DEFAULT_PHASE_PLAN
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

  // Check if a human approval gate is open and pending
  const pending = session.pendingUserInput;
  if (pending && !pending.response) {
    return {
      status: 'GATE_BLOCKED',
      gate: pending.gate,
      kind: pending.kind,
      doc: pending.doc || null,
      taskId: pending.taskId || null,
      questions: pending.questions || [],
      instruction: `STOP AND WAIT. The ${pending.gate.toUpperCase()} approval gate is OPEN. Present ${pending.doc || 'the QA checklist'} to the user in chat. Call aiteam_record_approval when they reply. Do NOT call aiteam_advance until the user approves.`,
      nextTool: 'aiteam_record_approval'
    };
  }

  const completedStages = new Set(session.completedStages || []);
  let activeStage = session.currentStage;
  if (activeStage === 'prd-review' && completedStages.has('prd-review')) {
    activeStage = 'architecture';
  } else if (activeStage === 'trd-review' && completedStages.has('trd-review')) {
    activeStage = 'planning';
  }

  // Setup stages before task loop
  if (activeStage === 'intake') {
    return {
      status: 'ACTIVE',
      stage: 'intake',
      role: 'analyst',
      instruction: 'Draft the Product Requirements Document in .aiteam/docs/prd.html. When done, call aiteam_advance with stage="intake", outcome="PASS", and summary.',
      contractFile: 'skill/contracts/analyst.md',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'prd-review') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'prd',
      doc: '.aiteam/docs/prd.html',
      instruction: 'Present .aiteam/docs/prd.html to user for approval. Call aiteam_record_approval with decision="approved" or "changes_requested".',
      nextTool: 'aiteam_record_approval'
    };
  }

  if (activeStage === 'architecture') {
    return {
      status: 'ACTIVE',
      stage: 'architecture',
      role: 'architect',
      instruction: 'Draft the Technical Requirements Document in .aiteam/docs/trd.html. When done, call aiteam_advance with stage="architecture", outcome="PASS", and summary.',
      contractFile: 'skill/contracts/architect.md',
      nextTool: 'aiteam_advance'
    };
  }

  if (activeStage === 'trd-review') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'trd',
      doc: '.aiteam/docs/trd.html',
      instruction: 'Present .aiteam/docs/trd.html to user for approval. Call aiteam_record_approval with decision="approved" or "changes_requested".',
      nextTool: 'aiteam_record_approval'
    };
  }

  const taskLedger = Array.isArray(session.taskLedger) ? session.taskLedger : [];

  if (activeStage === 'planning' || (taskLedger.length === 0 && ['ui-design', 'qa-planning', 'critical-review', 'planning'].includes(activeStage))) {
    return {
      status: 'ACTIVE',
      stage: 'planning',
      role: 'planner',
      instruction: 'Create the task ledger in TASK_LEDGER.md with explicit acceptance criteria. When done, call aiteam_advance with stage="planning", ledger="TASK_LEDGER.md" (or tasks array).',
      nextTool: 'aiteam_advance'
    };
  }

  // Task execution loop: find active or next incomplete task
  const nextTask = taskLedger.find((t) => t.status !== 'qa-passed' && t.status !== 'completed' && t.status !== 'integrated');

  if (!nextTask) {
    return {
      status: 'READY_TO_COMPLETE',
      instruction: 'All tasks have passed QA and integration. Milestone ready to complete.',
      nextTool: 'aiteam_advance'
    };
  }

  // Determine stage for active task
  let taskStage = 'implementation';
  let taskRole = 'programmer';
  let contract = 'skill/contracts/programmer.md';
  let instruction = `Implement task ${nextTask.id} (${nextTask.title || ''}). Verify acceptance criteria and run tests. Call aiteam_advance when done.`;

  if (nextTask.status === 'needs-rework') {
    const failureNote = nextTask.qaFailure?.response || nextTask.qaFailure?.decision || '';
    instruction = `Task ${nextTask.id} (${nextTask.title || ''}) FAILED review/QA and needs rework. User/QA Feedback: "${failureNote || 'Fix issues noted during verification'}". Address issues and call aiteam_advance when resolved.`;
  } else if (nextTask.status === 'implemented') {
    taskStage = 'code-review';
    taskRole = 'code-reviewer';
    contract = 'skill/contracts/reviewer.md';
    instruction = `Perform static code review on git diff for ${nextTask.id}. Call aiteam_advance with stage="code-review", outcome="PASS"|"FAIL".`;
  } else if (nextTask.status === 'review-passed') {
    taskStage = 'qa';
    taskRole = 'qa';
    contract = 'skill/contracts/qa.md';
    instruction = `Author new automated black-box tests in tests/qa/${nextTask.id}.test.ts covering the acceptance criteria for ${nextTask.id}. Run them, ensure they pass with zero regressions, and call aiteam_advance with stage="qa", outcome="PASS"|"FAIL".`;
  } else if (nextTask.status === 'qa-auto-passed') {
    return {
      status: 'GATE_BLOCKED',
      gate: 'qa',
      taskId: nextTask.id,
      instruction: `Automated QA passed for ${nextTask.id}. Present manual checks to user. Call aiteam_record_approval when confirmed.`,
      nextTool: 'aiteam_record_approval'
    };
  } else if (nextTask.status === 'qa-passed') {
    taskStage = 'integration';
    taskRole = 'maintainer';
    contract = 'skill/contracts/maintainer.md';
    instruction = `Stage only files changed for ${nextTask.id} and create a conventional git commit. Call aiteam_advance with stage="integration".`;
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
    description: 'Transition the workflow gate, report stage/task completion, and receive prescriptive instructions for the next required action.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' },
        stage: { type: 'string', description: 'The stage being started or completed (intake, architecture, planning, implementation, code-review, qa, integration).' },
        action: { type: 'string', enum: ['start', 'complete'], default: 'complete', description: 'Whether starting or completing the stage.' },
        taskId: { type: 'string', description: 'Task ID if completing a task-specific stage (e.g. T1).' },
        outcome: { type: 'string', enum: ['PASS', 'FAIL'], default: 'PASS' },
        summary: { type: 'string', description: 'Brief summary of what was accomplished or observed.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Supporting evidence, test outputs, or findings.' },
        filesChanged: { type: 'array', items: { type: 'string' }, description: 'List of files modified during implementation.' },
        ledger: { type: 'string', description: 'Path to TASK_LEDGER.md when completing the planning stage.' }
      }
    }
  },
  {
    name: 'aiteam_record_approval',
    description: 'Record human approval or change requests for PRD, TRD, or per-task QA gates.',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'Target git repository path.' },
        gate: { type: 'string', enum: ['prd', 'trd', 'qa'], description: 'The gate being decided.' },
        decision: { type: 'string', enum: ['approved', 'changes_requested'], description: 'The human decision.' },
        taskId: { type: 'string', description: 'Task ID if deciding a per-task QA gate.' },
        response: { type: 'string', description: 'User feedback, confirmed checks, or requested changes verbatim.' }
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
    const session = initSession(repo, args.request);
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

  if (name === 'aiteam_record_approval') {
    const result = recordApproval(repo, {
      gate: args.gate,
      taskId: args.taskId || null,
      decision: args.decision,
      response: args.response || ''
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
      const desc = args.summary || `Completed stage [${stage}]${taskId ? ` for task ${taskId}` : ''} (outcome: ${args.outcome || 'PASS'})`;
      writeActiveLog(repo, `✓ ${desc}`, stage);
      // If planning provided a ledger file, parse and register tasks
      if (stage === 'planning' && args.ledger) {
        const ledgerPath = path.isAbsolute(args.ledger) ? args.ledger : path.join(repo, args.ledger);
        if (fs.existsSync(ledgerPath)) {
          const content = fs.readFileSync(ledgerPath, 'utf8');
          // Parse tasks from markdown headings
          const tasks = [];
          const taskBlocks = content.split(/^###\s+/m).slice(1);
          for (const block of taskBlocks) {
            const firstLine = block.split('\n')[0].trim();
            const idMatch = firstLine.match(/^\[?([A-Za-z0-9_-]+)\]?:\s*(.+)$/) || firstLine.match(/^([A-Za-z0-9_-]+)\s*-\s*(.+)$/);
            const id = idMatch ? idMatch[1] : `T${tasks.length + 1}`;
            const title = idMatch ? idMatch[2] : firstLine;
            
            const acMatches = [...block.matchAll(/^\s*-\s*(?:\[\s*\]\s*)?(AC-\d+:?.+)$/gm)].map((m) => m[1].trim());
            tasks.push({
              id,
              title,
              status: 'planned',
              description: block.slice(0, 300).trim(),
              acceptanceCriteria: acMatches.length ? acMatches : ['Pass all assigned unit and integration tests.']
            });
          }
          if (tasks.length) updateTaskLedger(repo, tasks);
        }
      }

      completeStage(repo, stage, taskId, {
        outcome: args.outcome || 'PASS',
        summary: args.summary || `${stage} completed`,
        evidence: args.evidence || [],
        filesChanged: args.filesChanged || []
      });
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
