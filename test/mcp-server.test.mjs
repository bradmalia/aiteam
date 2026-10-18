import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleToolCall } from '../src/mcp-server.mjs';

test('AITeam Pure State MCP: full 9-stage setup pipeline and 4-gate task loop with hard gates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-mcp-test-'));

  try {
    // 1. aiteam_start -> intake
    const startRes = await handleToolCall('aiteam_start', {
      repository: tmpDir,
      request: 'Build test app'
    });
    assert.equal(startRes.directive.stage, 'intake');
    assert.equal(startRes.directive.status, 'ACTIVE');

    // 2a. Trying to complete intake with PASS before asking clarifying questions throws AITEAM_INTAKE_INTERVIEW_REQUIRED
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'intake',
          action: 'complete',
          outcome: 'PASS',
          summary: 'Tried skipping clarifying questions'
        });
      },
      /AITEAM_INTAKE_INTERVIEW_REQUIRED/
    );

    // 2b. Submit clarifying questions (outcome: AWAITING_USER) -> opens intake gate
    const interviewRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      action: 'complete',
      outcome: 'AWAITING_USER',
      summary: 'Identified clarifying questions',
      questions: [
        '1. Should the floating menu collapse on mobile? (Recommended default: Yes, below 640px)',
        '2. What zoom range should pinch-to-zoom support? (Recommended default: 0.5x to 2.5x)'
      ]
    });
    assert.equal(interviewRes.directive.status, 'GATE_BLOCKED');
    assert.equal(interviewRes.directive.gate, 'intake');
    assert.equal(interviewRes.directive.questions.length, 2);

    // 2c. User answers the intake questions
    await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'intake',
      decision: 'approved',
      response: 'Q1: Yes, collapse below 640px | Q2: 0.5x to 2.5x'
    });

    // 2d. Trying to complete intake with PASS without .aiteam/docs/prd.html throws AITEAM_ARTIFACT_MISSING
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'intake',
          action: 'complete',
          outcome: 'PASS',
          summary: 'PRD created'
        });
      },
      /AITEAM_ARTIFACT_MISSING/
    );

    // 2e. Write prd.html and complete intake -> opens PRD gate
    fs.writeFileSync(path.join(tmpDir, '.aiteam', 'docs', 'prd.html'), '<h1>PRD</h1>');
    const intakeRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      action: 'complete',
      outcome: 'PASS',
      summary: 'PRD created'
    });
    assert.equal(intakeRes.directive.status, 'GATE_BLOCKED');
    assert.equal(intakeRes.directive.gate, 'prd');
    assert.equal(intakeRes.directive.nextTool, 'aiteam_wait_for_approval');

    // 3. Trying to advance while blocked throws AITEAM_GATE_BLOCKED
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'architecture',
          action: 'complete',
          outcome: 'PASS'
        });
      },
      /AITEAM_GATE_BLOCKED/
    );

    // 4. Test aiteam_wait_for_approval blocking until Watcher Portal click (recordApproval)
    setTimeout(() => {
      handleToolCall('aiteam_record_approval', {
        repository: tmpDir,
        gate: 'prd',
        decision: 'approved',
        response: 'Clicked Approve in Watcher Portal'
      });
    }, 80);

    const apprRes = await handleToolCall('aiteam_wait_for_approval', {
      repository: tmpDir,
      gate: 'prd',
      pollMs: 30
    });
    assert.equal(apprRes.directive.stage, 'architecture');

    // 5. Trying to skip architecture and jump to planning throws AITEAM_STAGE_ORDER_VIOLATION
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'planning',
          action: 'start'
        });
      },
      /AITEAM_STAGE_ORDER_VIOLATION/
    );

    // 6. Complete architecture -> requires .aiteam/docs/trd.html -> advances to ui-design
    fs.writeFileSync(path.join(tmpDir, '.aiteam', 'docs', 'trd.html'), '<h1>TRD</h1>');
    const archRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'architecture',
      action: 'complete',
      outcome: 'PASS',
      summary: 'Architecture defined'
    });
    assert.equal(archRes.directive.stage, 'ui-design');

    // 7. Complete ui-design -> advances to planning
    const uiRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'ui-design',
      action: 'complete',
      outcome: 'PASS',
      summary: 'UI flows defined'
    });
    assert.equal(uiRes.directive.stage, 'planning');

    // 8. Complete planning with TASK_LEDGER.md -> advances to qa-planning
    fs.writeFileSync(
      path.join(tmpDir, 'TASK_LEDGER.md'),
      '# Task Ledger\n\n### T1: Build feature\nFeature details\n- [ ] AC-1: Feature works\n'
    );
    const planRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'planning',
      action: 'complete',
      ledger: 'TASK_LEDGER.md',
      outcome: 'PASS'
    });
    assert.equal(planRes.directive.stage, 'qa-planning');

    // 9. Complete qa-planning -> advances to critical-review
    const qaPlanRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'qa-planning',
      action: 'complete',
      outcome: 'PASS',
      summary: 'Black-box QA plan defined'
    });
    assert.equal(qaPlanRes.directive.stage, 'critical-review');

    // 10. Complete critical-review -> opens TRD gate (trd-review)
    const critRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'critical-review',
      action: 'complete',
      outcome: 'PASS',
      summary: 'TRD finalized and audited'
    });
    assert.equal(critRes.directive.status, 'GATE_BLOCKED');
    assert.equal(critRes.directive.gate, 'trd');
    assert.equal(critRes.directive.nextTool, 'aiteam_wait_for_approval');

    // 11. Trying to enter environment-readiness or implementation before TRD approval throws AITEAM_GATE_BLOCKED
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'environment-readiness',
          action: 'complete',
          outcome: 'PASS'
        });
      },
      /AITEAM_GATE_BLOCKED/
    );

    // 12. Record TRD approval -> advances to environment-readiness
    const trdApprRes = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'trd',
      decision: 'approved',
      response: 'TRD approved'
    });
    assert.equal(trdApprRes.directive.stage, 'environment-readiness');

    // 13. Complete environment-readiness -> advances to Task 1 implementation
    const envRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'environment-readiness',
      action: 'complete',
      outcome: 'PASS',
      summary: 'Environment verified'
    });
    assert.equal(envRes.directive.stage, 'implementation');
    assert.equal(envRes.directive.activeTask.id, 'T1');

    // 14. Complete implementation -> routes to code-review
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("ok");\n');
    const implRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'implementation',
      taskId: 'T1',
      outcome: 'PASS',
      filesChanged: ['app.js'],
      summary: 'Implemented app.js'
    });
    assert.equal(implRes.directive.stage, 'code-review');

    // 15. Complete code-review -> routes to qa
    const revRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'code-review',
      taskId: 'T1',
      outcome: 'PASS',
      summary: 'Clean diff'
    });
    assert.equal(revRes.directive.stage, 'qa');

    // 16. Complete qa -> requires tests/qa/ file, then opens QA gate
    fs.mkdirSync(path.join(tmpDir, 'tests', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tests', 'qa', 'T1.test.js'), 'assert(true);\n');
    const qaRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'qa',
      taskId: 'T1',
      outcome: 'PASS',
      checks: [{ name: 'AC-1', status: 'PASS', evidence: 'verified' }],
      summary: 'QA passed'
    });
    assert.equal(qaRes.directive.status, 'GATE_BLOCKED');
    assert.equal(qaRes.directive.gate, 'qa');

    // 17. Approve QA gate -> routes to integration (Maintainer)
    const qaAppr = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'qa',
      taskId: 'T1',
      decision: 'approved',
      response: 'PASS: verified in app'
    });
    assert.equal(qaAppr.directive.stage, 'integration');
    assert.equal(qaAppr.directive.role, 'maintainer');

    // 18. Complete integration -> marks session COMPLETE
    const intRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'integration',
      taskId: 'T1',
      outcome: 'PASS',
      commitMessage: 'feat: add app.js',
      summary: 'Committed app.js'
    });
    assert.equal(intRes.session.status, 'COMPLETE');
    assert.equal(intRes.directive.status, 'COMPLETE');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
