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
  recordApproval,
  waitForApproval,
  updateTaskLedger,
  parseTaskLedgerMarkdown,
  determineAcceptanceObligations,
  checkAndInvalidateStaleTasks
} from '../skill/lib/state-bridge.mjs';
import { computeFingerprint, verifyFingerprint } from '../skill/lib/fingerprint.mjs';
import { validateMotionEvidence } from '../skill/lib/motion-evidence.mjs';
import { createWatchServer } from '../src/watch-server.mjs';

function createMockVideoWebm(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Minimal EBML header for a WebM container
  const header = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, // EBML
    0x9f, 0x42, 0x86, 0x81, 0x01, // DocType: webm
    0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04,
    0x42, 0xf3, 0x81, 0x08,
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d,
    0x42, 0x87, 0x81, 0x04,
    0x42, 0x85, 0x81, 0x02
  ]);
  fs.writeFileSync(filePath, header);
}

test('1. Establishing acceptance obligations before implementation', () => {
  const ledgerContent = `
# Task Ledger

### T1: Traversal jump mechanics and goose pursuit animation
Gameplay chase encounter requiring player controls and physics motion.
Obligations: actual-input, motion-evidence, rendered-checks, human-review
- [ ] AC-1: Player Jump and Zoomies traversal completes 3 escalating cycles under actual input
- [ ] AC-2: Rendered goose feet contact floor at y=640 with zero offset
- [ ] AC-3: Chase retreat motion plays at 120 px/s with visible rearm

### T2: Backend data cache and hashing
Non-visual headless data indexing.
Obligations: automated-only
- [ ] AC-1: Cache returns SHA-256 for parsed records
`;

  const tasks = parseTaskLedgerMarkdown(ledgerContent);
  assert.equal(tasks.length, 2);

  const t1 = tasks[0];
  assert.equal(t1.id, 'T1');
  assert.equal(t1.acceptanceObligations.actualInput, true);
  assert.equal(t1.acceptanceObligations.renderedChecks, true);
  assert.equal(t1.acceptanceObligations.motionEvidence, true);
  assert.equal(t1.acceptanceObligations.humanReview, true);

  const t2 = tasks[1];
  assert.equal(t2.id, 'T2');
  assert.equal(t2.acceptanceObligations.actualInput, false);
  assert.equal(t2.acceptanceObligations.renderedChecks, false);
  assert.equal(t2.acceptanceObligations.motionEvidence, false);
  assert.equal(t2.acceptanceObligations.humanReview, false);
});

test('2. Server immutability: later updates cannot silently remove or weaken obligations', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-immutability-test-'));
  try {
    initSession(tmpRepo, 'Obligations immutability test');
    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Grounded chase traversal',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Chase velocity 236 px/s under actual input'],
        acceptanceObligations: {
          actualInput: true,
          renderedChecks: true,
          motionEvidence: true,
          humanReview: true
        }
      }
    ]);

    // Later attempt by specialist to update ledger with weaker interpretation
    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Grounded chase traversal',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Chase velocity 236 px/s under actual input'],
        acceptanceObligations: {
          actualInput: false,
          renderedChecks: false,
          motionEvidence: false,
          humanReview: false
        }
      }
    ]);

    const session = readSession(tmpRepo);
    const t1 = session.taskLedger[0];
    assert.equal(t1.acceptanceObligations.actualInput, true, 'actualInput obligation was preserved');
    assert.equal(t1.acceptanceObligations.renderedChecks, true, 'renderedChecks obligation was preserved');
    assert.equal(t1.acceptanceObligations.motionEvidence, true, 'motionEvidence obligation was preserved');
    assert.equal(t1.acceptanceObligations.humanReview, true, 'humanReview obligation was preserved');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('3. Missing motion evidence blocks acceptance for motion-obligated task', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-motion-missing-test-'));
  try {
    initSession(tmpRepo, 'Motion evidence test');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Goose charge and retreat animation',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Goose charges at 420 px/s and retreats'],
        acceptanceObligations: {
          actualInput: true,
          renderedChecks: true,
          motionEvidence: true,
          humanReview: true
        }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T1', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'goose.gd'), 'extends Node2D\n');
    completeStage(tmpRepo, 'implementation', 'T1', {
      outcome: 'PASS',
      filesChanged: ['goose.gd'],
      summary: 'Implemented goose charge'
    });

    startStage(tmpRepo, 'code-review', 'T1', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T1', { outcome: 'PASS', summary: 'Clean code' });

    startStage(tmpRepo, 'qa', 'T1', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T1.test.gd'), 'extends SceneTree\n');

    // Missing motion evidence submission fails with AITEAM_MOTION_EVIDENCE_MISSING
    assert.throws(
      () =>
        completeStage(tmpRepo, 'qa', 'T1', {
          outcome: 'PASS_WITH_MANUAL_VALIDATION',
          summary: 'Automated checks passed but no video was attached',
          checks: [
            {
              name: 'Rendered goose floor contact',
              executionMethod: 'rendered-measurement',
              expected: 'y=640',
              actual: 'y=640',
              passed: true
            }
          ],
          manualChecks: ['Verify retreat animation']
        }),
      /AITEAM_MOTION_EVIDENCE_MISSING/
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('4. Empty manual checks or requiresManualValidation=false cannot bypass pre-established human review', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-bypass-conflict-test-'));
  try {
    initSession(tmpRepo, 'Bypass conflict test');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T4',
        title: 'Reinforcing goose chase encounter',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Chase traversal with camera pressure'],
        acceptanceObligations: {
          actualInput: true,
          renderedChecks: true,
          motionEvidence: true,
          humanReview: true
        }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T4', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'director.gd'), 'extends Node2D\n');
    completeStage(tmpRepo, 'implementation', 'T4', {
      outcome: 'PASS',
      filesChanged: ['director.gd'],
      summary: 'Implemented chase director'
    });

    startStage(tmpRepo, 'code-review', 'T4', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T4', { outcome: 'PASS', summary: 'Diff audited' });

    startStage(tmpRepo, 'qa', 'T4', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T4.test.gd'), 'extends SceneTree\n');

    // Create a real video artifact so motion evidence exists
    const videoFile = path.join(tmpRepo, '.aiteam', 'reviews', 'w1l3', 'T4', 'chase.webm');
    createMockVideoWebm(videoFile);

    // QA attempts the Tail of Destruction T4 shortcut: outcome=PASS, requiresManualValidation=false, manualChecks=[]
    assert.throws(
      () =>
        completeStage(tmpRepo, 'qa', 'T4', {
          outcome: 'PASS',
          summary: 'QA claiming logic layer complete and bypassing human playtest',
          motionEvidence: videoFile,
          checks: [
            {
              name: 'Rendered camera bounds',
              executionMethod: 'rendered-measurement',
              expected: 'viewports visible',
              actual: 'verified',
              passed: true
            }
          ],
          requiresManualValidation: false,
          manualChecks: []
        }),
      /AITEAM_ACCEPTANCE_OBLIGATION_CONFLICT/
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('5. Valid evidence package reaches human gate, approval permits transition, and request changes routes feedback', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-valid-gate-test-'));
  try {
    initSession(tmpRepo, 'Valid gate lifecycle test');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T4',
        title: 'Reinforcing goose chase encounter',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Chase traversal with camera pressure'],
        acceptanceObligations: {
          actualInput: true,
          renderedChecks: true,
          motionEvidence: true,
          humanReview: true
        }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T4', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'chase.gd'), 'extends Node2D\nvar speed = 236\n');
    completeStage(tmpRepo, 'implementation', 'T4', {
      outcome: 'PASS',
      filesChanged: ['chase.gd'],
      summary: 'Implemented chase logic'
    });

    startStage(tmpRepo, 'code-review', 'T4', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T4', { outcome: 'PASS', summary: 'Clean code' });

    startStage(tmpRepo, 'qa', 'T4', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T4.test.gd'), 'extends SceneTree\n');

    const videoFile = path.join(tmpRepo, '.aiteam', 'reviews', 'w1l3', 'T4', 'chase.webm');
    createMockVideoWebm(videoFile);

    // Complete QA with valid evidence and manual review checklist
    completeStage(tmpRepo, 'qa', 'T4', {
      outcome: 'PASS_WITH_MANUAL_VALIDATION',
      summary: 'Verified actual-input traversal and recorded 120s motion capture clip',
      evidence: [videoFile],
      motionEvidence: [
        {
          name: 'chase-preview',
          scenario: 'normal-operation',
          caption: 'Full 120s traversal with visible trailing entries',
          videoPath: videoFile
        }
      ],
      checks: [
        {
          name: 'Rendered camera visibility and lead',
          executionMethod: 'rendered-measurement',
          expected: '98% visibility at 1280x720',
          actual: '99.5% observed',
          passed: true
        }
      ],
      manualChecks: [
        'Review chase.webm in Watcher Portal to verify rear pursuer readability under default camera',
        'Confirm goose retreat and rearm timing feels fair after a jump'
      ],
      requiresManualValidation: true
    });

    let session = readSession(tmpRepo);
    // Task is held in qa-auto-passed, pending human review
    assert.equal(session.taskLedger[0].status, 'qa-auto-passed');
    assert.equal(session.pendingUserInput?.kind, 'qa-manual');
    assert.equal(session.pendingUserInput?.taskId, 'T4');
    assert.ok(session.pendingUserInput?.motionClips?.length > 0);
    assert.ok(!session.completedTasks.includes('T4'));

    // Test Request Changes routes feedback back to implementation
    recordApproval(tmpRepo, {
      gate: 'qa',
      taskId: 'T4',
      decision: 'changes_requested',
      response: 'Pursuit velocity too slow at Gate 1; geese do not maintain pressure.'
    });

    session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'needs-rework');
    assert.equal(session.taskLedger[0].qaFailure?.decision, 'CHANGES_REQUESTED');
    assert.match(session.taskLedger[0].qaFailure?.response, /Pursuit velocity too slow/);
    assert.equal(session.currentStage, 'implementation');
    assert.equal(session.currentTaskId, 'T4');

    // Programmer fixes the defect
    startStage(tmpRepo, 'implementation', 'T4', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'chase.gd'), 'extends Node2D\nvar speed = 252\n');
    completeStage(tmpRepo, 'implementation', 'T4', {
      outcome: 'PASS',
      filesChanged: ['chase.gd'],
      summary: 'Adjusted Gate 1 pace to 252'
    });

    startStage(tmpRepo, 'code-review', 'T4', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T4', { outcome: 'PASS', summary: 'Pace fix verified' });

    startStage(tmpRepo, 'qa', 'T4', 'qa', 'QA');
    // Fresh video capture for the fix
    createMockVideoWebm(videoFile);
    completeStage(tmpRepo, 'qa', 'T4', {
      outcome: 'PASS_WITH_MANUAL_VALIDATION',
      summary: 'Re-tested at 252 px/s',
      evidence: [videoFile],
      motionEvidence: [videoFile],
      checks: [
        {
          name: 'Rendered pace at 252 px/s',
          executionMethod: 'rendered-measurement',
          expected: '252 px/s',
          actual: '252.0 px/s measured',
          passed: true
        }
      ],
      manualChecks: ['Verify 252 px/s pace'],
      requiresManualValidation: true
    });

    session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'qa-auto-passed');

    // Human approves the fix
    recordApproval(tmpRepo, {
      gate: 'qa',
      taskId: 'T4',
      decision: 'approved',
      response: 'PASS: pace and pressure confirmed'
    });

    session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'qa-passed');
    assert.ok(session.completedTasks.includes('T4'));
    assert.equal(session.currentStage, 'integration');

    // Maintainer can now integrate cleanly
    startStage(tmpRepo, 'integration', 'T4', 'maintainer', 'Maintainer');
    completeStage(tmpRepo, 'integration', 'T4', {
      outcome: 'PASS',
      commitMessage: 'feat: adjust Gate 1 chase velocity',
      summary: 'Committed T4'
    });

    session = readSession(tmpRepo);
    assert.equal(session.status, 'COMPLETE');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('6. Material source changes invalidate affected evidence and approval state', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-staleness-test-'));
  try {
    initSession(tmpRepo, 'Stale evidence invalidation test');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Player controller speed',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Speed is 300 px/s'],
        acceptanceObligations: { actualInput: true, renderedChecks: true, motionEvidence: false, humanReview: true }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T1', 'programmer', 'Programmer');
    const playerFile = path.join(tmpRepo, 'player.gd');
    fs.writeFileSync(playerFile, 'var speed = 300\n');
    completeStage(tmpRepo, 'implementation', 'T1', {
      outcome: 'PASS',
      filesChanged: ['player.gd'],
      summary: 'Set speed to 300'
    });

    startStage(tmpRepo, 'code-review', 'T1', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T1', { outcome: 'PASS', summary: 'ok' });

    startStage(tmpRepo, 'qa', 'T1', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T1.test.gd'), 'extends SceneTree\n');
    completeStage(tmpRepo, 'qa', 'T1', {
      outcome: 'PASS_WITH_MANUAL_VALIDATION',
      summary: 'Passed speed test',
      checks: [{ name: 'Rendered player speed', executionMethod: 'rendered-measurement', actual: '300 px/s', passed: true }],
      manualChecks: ['Verify speed']
    });

    let session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'qa-auto-passed');
    assert.ok(session.taskLedger[0].qaFingerprint);

    // Human approves gate
    recordApproval(tmpRepo, { gate: 'qa', taskId: 'T1', decision: 'approved', response: 'looks great' });
    session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'qa-passed');

    // Material source change occurs after QA approval!
    fs.writeFileSync(playerFile, 'var speed = 999\n');

    // Staleness detection invalidates approval and routes task back to needs-rework
    const invalidated = checkAndInvalidateStaleTasks(tmpRepo, session);
    assert.equal(invalidated, true);
    assert.equal(session.taskLedger[0].status, 'needs-rework');
    assert.equal(session.taskLedger[0].qaFingerprint, null);
    assert.ok(!session.completedTasks.includes('T1'));
    assert.equal(session.approvals['qa:T1'], undefined);

    // Attempting to approve a stale task throws AITEAM_EVIDENCE_STALE
    session.taskLedger[0].status = 'qa-auto-passed';
    session.taskLedger[0].qaFingerprint = 'stale-hash';
    writeSession(tmpRepo, session);
    assert.throws(
      () => recordApproval(tmpRepo, { gate: 'qa', taskId: 'T1', decision: 'approved', response: 'ok' }),
      /AITEAM_EVIDENCE_STALE/
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('7. Broken or mismatched artifact references are detected and rejected', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-broken-ref-test-'));
  try {
    initSession(tmpRepo, 'Broken reference test');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Artifact test task',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Has working artifact links'],
        acceptanceObligations: { actualInput: false, renderedChecks: false, motionEvidence: false, humanReview: true }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T1', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'index.html'), '<h1>Test</h1>');
    completeStage(tmpRepo, 'implementation', 'T1', {
      outcome: 'PASS',
      filesChanged: ['index.html'],
      summary: 'Written index.html'
    });

    startStage(tmpRepo, 'code-review', 'T1', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T1', { outcome: 'PASS', summary: 'ok' });

    startStage(tmpRepo, 'qa', 'T1', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T1.test.mjs'), 'export default true;\n');

    // References a non-existent artifact file
    assert.throws(
      () =>
        completeStage(tmpRepo, 'qa', 'T1', {
          outcome: 'PASS_WITH_MANUAL_VALIDATION',
          summary: 'QA reporting broken link',
          evidence: ['.aiteam/reviews/non-existent-report.json'],
          checks: [{ name: 'AC-1', passed: true }],
          manualChecks: ['Verify page']
        }),
      /AITEAM_ARTIFACT_REFERENCE_BROKEN/
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('8. Nonvisual and backend tasks retain appropriate automated completion', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-automated-backend-test-'));
  try {
    initSession(tmpRepo, 'Headless nonvisual task');
    recordApproval(tmpRepo, { gate: 'prd', decision: 'approved', response: 'ok' });
    recordApproval(tmpRepo, { gate: 'trd', decision: 'approved', response: 'ok' });

    updateTaskLedger(tmpRepo, [
      {
        id: 'T1',
        title: 'Backend caching service and database query optimizer',
        status: 'planned',
        acceptanceCriteria: ['AC-1: Cache hit returns cached record in <5ms'],
        acceptanceObligations: {
          actualInput: false,
          renderedChecks: false,
          motionEvidence: false,
          humanReview: false
        }
      }
    ]);

    startStage(tmpRepo, 'implementation', 'T1', 'programmer', 'Programmer');
    fs.writeFileSync(path.join(tmpRepo, 'cache.js'), 'export const cache = new Map();\n');
    completeStage(tmpRepo, 'implementation', 'T1', {
      outcome: 'PASS',
      filesChanged: ['cache.js'],
      summary: 'Implemented memory cache'
    });

    startStage(tmpRepo, 'code-review', 'T1', 'reviewer', 'Reviewer');
    completeStage(tmpRepo, 'code-review', 'T1', { outcome: 'PASS', summary: 'ok' });

    startStage(tmpRepo, 'qa', 'T1', 'qa', 'QA');
    fs.mkdirSync(path.join(tmpRepo, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'qa', 'T1.test.mjs'), 'export default true;\n');

    // Automated bypass succeeds cleanly for backend tasks with no manual checks
    completeStage(tmpRepo, 'qa', 'T1', {
      outcome: 'PASS',
      summary: 'Automated benchmarks passed with 100% assertion coverage',
      checks: [{ name: 'Cache latency < 5ms', passed: true, actual: '1.2ms' }],
      manualChecks: []
    });

    const session = readSession(tmpRepo);
    assert.equal(session.taskLedger[0].status, 'qa-passed');
    assert.equal(session.approvals['qa:T1'].approvedBy, 'qa-automated-bypass');
    assert.equal(session.currentStage, 'integration');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('9. Existing session data loads safely with explicit policy for legacy tasks', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-legacy-session-test-'));
  try {
    const sessionDir = path.join(tmpRepo, '.aiteam');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Legacy session JSON lacking acceptanceObligations
    const legacySession = {
      schema: 3,
      id: 'legacy-session-id',
      status: 'ACTIVE',
      currentStage: 'implementation',
      currentTaskId: 'T1',
      phasePlan: ['intake', 'prd-review', 'architecture', 'ui-design', 'planning', 'qa-planning', 'critical-review', 'trd-review', 'environment-readiness', 'implementation', 'code-review', 'qa', 'integration'],
      completedStages: ['intake', 'prd-review', 'architecture', 'ui-design', 'planning', 'qa-planning', 'critical-review', 'trd-review', 'environment-readiness'],
      approvals: { prd: { decision: 'APPROVED' }, trd: { decision: 'APPROVED' } },
      taskLedger: [
        {
          id: 'T1',
          title: 'Legacy task without acceptanceObligations',
          status: 'planned',
          description: 'Old task from previous version',
          acceptanceCriteria: ['AC-1: Old criterion']
          // Note: acceptanceObligations is undefined
        }
      ],
      completedTasks: []
    };

    fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(legacySession, null, 2));

    const loaded = readSession(tmpRepo);
    assert.ok(loaded);
    assert.equal(loaded.id, 'legacy-session-id');
    assert.equal(loaded.taskLedger.length, 1);
    assert.equal(loaded.taskLedger[0].id, 'T1');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('10. Repository-specific Watcher URLs and motion artifact hosting work', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-watcher-video-test-'));
  let server = null;
  const testPort = 44231;

  try {
    initSession(tmpRepo, 'Watcher artifact hosting test');
    const reviewDir = path.join(tmpRepo, '.aiteam', 'reviews', 'w1l3', 'T1');
    fs.mkdirSync(reviewDir, { recursive: true });
    const videoFile = path.join(reviewDir, 'preview.webm');
    createMockVideoWebm(videoFile);

    server = createWatchServer({ repo: tmpRepo, port: testPort, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));

    // Request review asset video via HTTP Range request
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/review-assets/w1l3/T1/preview.webm',
        method: 'GET',
        headers: { Range: 'bytes=0-10' }
      }, (r) => {
        let data = Buffer.alloc(0);
        r.on('data', chunk => data = Buffer.concat([data, chunk]));
        r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.statusCode, 206, 'HTTP 206 Partial Content returned for video byte range');
    assert.equal(res.headers['content-type'], 'video/webm');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.body.length, 11);

    // Request via /api/media
    const resMedia = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: `/api/media?path=${encodeURIComponent('.aiteam/reviews/w1l3/T1/preview.webm')}`,
        method: 'GET'
      }, (r) => {
        let data = Buffer.alloc(0);
        r.on('data', chunk => data = Buffer.concat([data, chunk]));
        r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(resMedia.statusCode, 200);
    assert.equal(resMedia.headers['content-type'], 'video/webm');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
