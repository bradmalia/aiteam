import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleToolCall } from '../src/mcp-server.mjs';
import { readSession } from '../skill/lib/state-bridge.mjs';

test('AITeam Pure State MCP: lifecycle from start to TRD gate', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-mcp-test-'));

  try {
    // 1. aiteam_start
    const startRes = await handleToolCall('aiteam_start', {
      repository: tmpDir,
      request: 'Build test app'
    });
    assert.equal(startRes.directive.stage, 'intake');
    assert.equal(startRes.directive.status, 'ACTIVE');

    // 2. complete intake -> opens PRD gate
    const intakeRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      action: 'complete',
      outcome: 'PASS',
      summary: 'PRD created'
    });
    assert.equal(intakeRes.directive.status, 'GATE_BLOCKED');
    assert.equal(intakeRes.directive.gate, 'prd');

    // 3. Trying to advance while blocked throws
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

    // 4. Record PRD approval
    const apprRes = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'prd',
      decision: 'approved',
      response: 'Looks great'
    });
    assert.equal(apprRes.directive.stage, 'architecture');

    // 5. Complete architecture -> opens TRD gate
    const archRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'architecture',
      action: 'complete',
      outcome: 'PASS',
      summary: 'TRD created'
    });
    assert.equal(archRes.directive.status, 'GATE_BLOCKED');
    assert.equal(archRes.directive.gate, 'trd');

    // 6. Record TRD approval
    const trdApprRes = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'trd',
      decision: 'approved'
    });
    assert.equal(trdApprRes.directive.stage, 'planning');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
