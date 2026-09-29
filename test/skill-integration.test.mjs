import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  initSession,
  readSession,
  writeSession,
  startStage,
  completeStage,
  updateTaskLedger,
  writeActiveLog,
  recordApproval
} from '../skill/lib/state-bridge.mjs';
import { computeFingerprint, verifyFingerprint } from '../skill/lib/fingerprint.mjs';

test('AITeam Skill: State Bridge lifecycle and task ledger state transitions', async (t) => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-skill-test-'));

  try {
    // 1. Session initialization
    const session = initSession(tmpRepo, 'Build sample pong game');
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.currentStage, 'intake');
    assert.ok(fs.existsSync(path.join(tmpRepo, '.aiteam', 'session.json')));
    assert.ok(fs.existsSync(path.join(tmpRepo, '.aiteam', 'events.jsonl')));

    // 2. Set task ledger
    const tasks = [
      {
        id: 'task-1-canvas',
        title: 'Render basic canvas playfield',
        acceptanceCriteria: ['Canvas renders with 800x600 resolution'],
        status: 'planned'
      },
      {
        id: 'task-2-paddle',
        title: 'Add left player paddle',
        acceptanceCriteria: ['Left paddle moves with W/S keys'],
        status: 'planned'
      }
    ];
    updateTaskLedger(tmpRepo, tasks);
    let current = readSession(tmpRepo);
    assert.equal(current.taskLedger.length, 2);

    // 2b. Approve the two up-front human gates (PRD + TRD) — required before task execution
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'PRD approved' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'TRD approved' });
    assert.equal(readSession(tmpRepo).approvals.prd.decision, 'APPROVED');
    assert.equal(readSession(tmpRepo).approvals.trd.decision, 'APPROVED');

    // 3. Start implementation on Task 1
    const run = startStage(tmpRepo, 'implementation', 'task-1-canvas', 'programmer', 'Programmer');
    assert.equal(run.stage, 'implementation');
    assert.equal(run.taskId, 'task-1-canvas');

    current = readSession(tmpRepo);
    assert.equal(current.currentStage, 'implementation');
    assert.equal(current.currentTaskId, 'task-1-canvas');
    assert.ok(current.activeRun);

    // 4. Stream active logs
    writeActiveLog(tmpRepo, 'Analyzing directory structure...');
    writeActiveLog(tmpRepo, 'Writing index.html and styles.css...');
    const logPath = path.join(tmpRepo, '.aiteam', 'runs', `${run.runId}.stderr.txt`);
    assert.ok(fs.existsSync(logPath));
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /Writing index\.html/);

    // Create a mock file on disk to test fingerprint
    fs.writeFileSync(path.join(tmpRepo, 'index.html'), '<canvas id="pong"></canvas>');

    // 5. Complete implementation
    completeStage(tmpRepo, 'implementation', 'task-1-canvas', {
      outcome: 'PASS',
      summary: 'Created index.html with basic canvas',
      filesChanged: ['index.html'],
      validations: [{ command: 'ls -la index.html', result: 'found' }]
    });

    current = readSession(tmpRepo);
    assert.equal(current.taskLedger[0].status, 'implemented');
    assert.deepEqual(current.taskLedger[0].filesChanged, ['index.html']);

    // 6. Code review pass
    startStage(tmpRepo, 'code-review', 'task-1-canvas', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'task-1-canvas', {
      outcome: 'PASS',
      summary: 'Code satisfies acceptance criteria',
      evidence: ['Clean canvas tag with correct ID'],
      findings: []
    });

    current = readSession(tmpRepo);
    assert.equal(current.taskLedger[0].status, 'review-passed');

    // 7. QA testing pass — automated QA passes, task is held in qa-auto-passed with the
    //    human sign-off gate open. Integration must be hard-blocked until the user signs off.
    startStage(tmpRepo, 'qa', 'task-1-canvas', 'qa', 'QA');
    completeStage(tmpRepo, 'qa', 'task-1-canvas', {
      outcome: 'PASS',
      summary: 'Automated test verified 800x600 canvas resolution',
      evidence: ['Playwright canvas width/height verified'],
      checks: [{ name: 'Canvas Dimensions', passed: true }]
    });

    current = readSession(tmpRepo);
    assert.equal(current.taskLedger[0].status, 'qa-auto-passed');
    assert.equal(current.pendingUserInput?.kind, 'qa-manual');
    assert.equal(current.pendingUserInput?.response, null);
    assert.ok(!current.completedTasks.includes('task-1-canvas'));
    assert.throws(
      () => startStage(tmpRepo, 'integration', 'task-1-canvas', 'maintainer', 'Maintainer'),
      /AITEAM_GATE_BLOCKED/
    );

    // 8. Human QA sign-off promotes the task to qa-passed and unblocks integration.
    recordApproval(tmpRepo, { gate: 'qa', taskId: 'task-1-canvas', decision: 'approved', response: 'PASS: verified in browser' });
    current = readSession(tmpRepo);
    assert.equal(current.taskLedger[0].status, 'qa-passed');
    assert.ok(current.taskLedger[0].qaFingerprint);
    assert.ok(current.completedTasks.includes('task-1-canvas'));
    assert.equal(current.approvals['qa:task-1-canvas'].decision, 'APPROVED');
    assert.ok(verifyFingerprint(tmpRepo, ['index.html'], current.taskLedger[0].qaFingerprint));

    // Verify tamper detection
    fs.writeFileSync(path.join(tmpRepo, 'index.html'), '<canvas id="pong-tampered"></canvas>');
    assert.equal(verifyFingerprint(tmpRepo, ['index.html'], current.taskLedger[0].qaFingerprint), false);

    // Restore clean file
    fs.writeFileSync(path.join(tmpRepo, 'index.html'), '<canvas id="pong"></canvas>');
    assert.equal(verifyFingerprint(tmpRepo, ['index.html'], current.taskLedger[0].qaFingerprint), true);

  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('AITeam Skill: Watcher Dashboard compatibility test', async (t) => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-watch-test-'));
  let watchProcess = null;
  const testPort = 44129;

  try {
    // 1. Initialize session and ledger
    initSession(tmpRepo, 'Watcher compatibility test request');
    updateTaskLedger(tmpRepo, [
      { id: 't1', title: 'Task One', status: 'implemented' },
      { id: 't2', title: 'Task Two', status: 'planned' }
    ]);
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });
    const run = startStage(tmpRepo, 'code-review', 't1', 'code-reviewer', 'Code Reviewer');
    writeActiveLog(tmpRepo, 'Reviewing files for task t1...');

    // 2. Launch real watch-server.mjs against our tmpRepo
    const watchServerPath = path.resolve('src/watch-server.mjs');
    watchProcess = spawn('node', [watchServerPath, '--repo', tmpRepo, '--port', String(testPort)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for server to bind
    await new Promise((resolve, reject) => {
      let bound = false;
      const timeout = setTimeout(() => {
        if (!bound) reject(new Error('watch-server.mjs did not bind within 5000ms'));
      }, 5000);

      const check = () => {
        const req = http.get(`http://127.0.0.1:${testPort}/api/state`, (res) => {
          if (res.statusCode === 200) {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                if (data.session && data.session.taskLedger) {
                  bound = true;
                  clearTimeout(timeout);
                  resolve(data);
                  return;
                }
              } catch {}
              setTimeout(check, 100);
            });
          } else {
            setTimeout(check, 100);
          }
        });
        req.on('error', () => setTimeout(check, 100));
      };
      check();
    });

    // 3. Query /api/state and verify data fields
    const snapshotData = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${testPort}/api/state`, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    assert.equal(snapshotData.session.request, 'Watcher compatibility test request');
    assert.equal(snapshotData.session.taskLedger.length, 2);
    assert.equal(snapshotData.session.currentStage, 'code-review');
    assert.equal(snapshotData.activeRun.taskId, 't1');
    assert.match(snapshotData.activeLogTail, /Reviewing files for task t1/);

  } finally {
    if (watchProcess) {
      watchProcess.kill('SIGTERM');
    }
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('AITeam Skill: PRD/TRD gates hard-block downstream stages until approved', (t) => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-gate-test-'));

  try {
    initSession(tmpRepo, 'gate enforcement test');

    // Complete intake -> auto-opens the PRD approval gate.
    completeStage(tmpRepo, 'intake', null, { outcome: 'PASS', summary: 'PRD drafted' });
    let s = readSession(tmpRepo);
    assert.equal(s.pendingUserInput?.gate, 'prd');
    assert.equal(s.pendingUserInput?.response, null);

    // Architecture is hard-blocked until the PRD gate is approved.
    assert.throws(() => startStage(tmpRepo, 'architecture'), /AITEAM_GATE_BLOCKED/);

    // Approving the PRD unblocks architecture.
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'looks good' });
    startStage(tmpRepo, 'architecture', null, 'architect', 'Architect');

    // Planning is blocked until the TRD gate is approved too.
    assert.throws(() => startStage(tmpRepo, 'planning'), /AITEAM_GATE_BLOCKED/);

    // Requesting changes on the TRD does NOT unblock it.
    recordApproval(tmpRepo, { gate: 'trd', decision: 'changes', response: 'add caching section' });
    assert.throws(() => startStage(tmpRepo, 'planning'), /AITEAM_GATE_BLOCKED/);

    s = readSession(tmpRepo);
    assert.equal(s.approvals.trd.decision, 'CHANGES_REQUESTED');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('AITeam Skill: Brownfield projects automatically archive existing PRD/TRD docs', (t) => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-brownfield-test-'));

  try {
    initSession(tmpRepo, 'initial milestone');
    const docsDir = path.join(tmpRepo, '.aiteam', 'docs');
    const prdPath = path.join(docsDir, 'prd.html');
    const trdPath = path.join(docsDir, 'trd.html');

    // Create existing v1 documents
    fs.writeFileSync(prdPath, '<h1>PRD v1</h1>', 'utf8');
    fs.writeFileSync(trdPath, '<h1>TRD v1</h1>', 'utf8');

    // Starting intake archives the existing PRD
    startStage(tmpRepo, 'intake', null, 'analyst', 'Analyst');
    const archiveDir = path.join(docsDir, 'archive');
    assert.ok(fs.existsSync(archiveDir));
    const archivedPrds = fs.readdirSync(archiveDir).filter((f) => f.startsWith('prd-') && f.endsWith('.html'));
    assert.equal(archivedPrds.length, 1);
    assert.equal(fs.readFileSync(path.join(archiveDir, archivedPrds[0]), 'utf8'), '<h1>PRD v1</h1>');

    // Approve PRD and start architecture
    completeStage(tmpRepo, 'intake', null, { outcome: 'PASS', summary: 'PRD v2 drafted' });
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'PRD v2 approved' });
    
    // Starting architecture archives the existing TRD
    startStage(tmpRepo, 'architecture', null, 'architect', 'Architect');
    const archivedTrds = fs.readdirSync(archiveDir).filter((f) => f.startsWith('trd-') && f.endsWith('.html'));
    assert.equal(archivedTrds.length, 1);
    assert.equal(fs.readFileSync(path.join(archiveDir, archivedTrds[0]), 'utf8'), '<h1>TRD v1</h1>');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

