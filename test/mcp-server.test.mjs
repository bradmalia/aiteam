import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { handleToolCall } from '../src/mcp-server.mjs';
import { stopWatcher } from '../src/watcher-discovery.mjs';
import { offerUpgradeIfAvailable, readSession } from '../skill/lib/state-bridge.mjs';
import { readInstallMetadata } from '../skill/lib/upgrader.mjs';

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
      manualChecks: ['Open browser and verify UI rendered properly'],
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
    await stopWatcher(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AITeam Pure State MCP: multi-round intake interview and critical-review adversarial repair routing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-mcp-upgrade-test-'));

  try {
    // 1. Start session -> intake round 1
    const startRes = await handleToolCall('aiteam_start', {
      repository: tmpDir,
      request: 'Build multi-player offline-first canvas editor'
    });
    assert.equal(startRes.directive.stage, 'intake');
    assert.match(startRes.directive.instruction, /MULTI-DIMENSIONAL DISCOVERY/);

    // 2. Round 1 AWAITING_USER with discovery evidence
    const round1Res = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      outcome: 'AWAITING_USER',
      summary: 'Round 1 discovery questions',
      evidence: ['Inspected repo root; greenfield workspace'],
      questions: [
        '1. [User Flow & State Transitions] How should offline edits sync on reconnect? (Decision required: Last-write-wins vs CRDT merge)',
        '2. [Edge Cases & Failure Modes] What happens if IndexedDB quota is exceeded? (Recommended default: Warn user and offer JSON export)'
      ]
    });
    assert.equal(round1Res.directive.status, 'GATE_BLOCKED');
    assert.equal(round1Res.session.intakeRound, 1);
    assert.deepEqual(round1Res.session.intakeDiscovery, ['Inspected repo root; greenfield workspace']);

    // 3. User answers Round 1
    const ans1Res = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'intake',
      decision: 'approved',
      response: 'Q1: Use CRDT merge across collaborators | Q2: Use recommended default'
    });
    assert.equal(ans1Res.session.intakeClarified, true);
    assert.match(ans1Res.directive.instruction, /EVALUATE FOLLOW-UP OR AUTHOR PRD/);

    // 4. Analyst triggers Round 2 follow-up because CRDT merge introduced new conflict-UI ambiguity
    const round2Res = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      outcome: 'AWAITING_USER',
      summary: 'Round 2 follow-up on CRDT collaborator identity and presence',
      questions: [
        '1. [Domain Rules & Visual/Quantitative Precision] Should offline collaborator cursors show stale timestamps after reconnect? (Recommended default: Show last-seen badge)'
      ]
    });
    assert.equal(round2Res.directive.status, 'GATE_BLOCKED');
    assert.equal(round2Res.directive.gate, 'intake');
    assert.equal(round2Res.session.intakeRound, 2);
    assert.equal(round2Res.session.intakeClarified, false);

    // Trying to bypass Round 2 and PASS intake before Round 2 is answered throws
    fs.writeFileSync(path.join(tmpDir, '.aiteam', 'docs', 'prd.html'), '<h1>PRD</h1>');
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'intake',
          outcome: 'PASS',
          summary: 'Attempted to skip round 2 answer'
        });
      },
      /AITEAM_INTAKE_INTERVIEW_REQUIRED/
    );

    // 5. User answers Round 2 -> history preserves both rounds
    const ans2Res = await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'intake',
      decision: 'approved',
      response: 'Q1: Show last-seen badge'
    });
    assert.equal(ans2Res.session.intakeClarified, true);
    assert.equal(ans2Res.session.intakeHistory.length, 2);

    // 6. Complete intake -> approve PRD -> advance to critical-review
    await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'intake',
      outcome: 'PASS',
      summary: 'PRD authored from both rounds'
    });
    await handleToolCall('aiteam_record_approval', {
      repository: tmpDir,
      gate: 'prd',
      decision: 'approved',
      response: 'PRD looks solid'
    });

    fs.writeFileSync(path.join(tmpDir, '.aiteam', 'docs', 'trd.html'), '<h1>TRD</h1>');
    await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'architecture',
      outcome: 'PASS',
      summary: 'Architecture defined'
    });
    await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'ui-design',
      outcome: 'PASS',
      summary: 'UI design added'
    });

    fs.writeFileSync(
      path.join(tmpDir, 'TASK_LEDGER.md'),
      '# Task Ledger\n\n### T1: Offline CRDT store\nPersist edits locally\n- [ ] AC-1: Edits survive reload\n'
    );
    await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'planning',
      ledger: 'TASK_LEDGER.md',
      outcome: 'PASS'
    });
    const qaPlanRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'qa-planning',
      outcome: 'PASS',
      summary: 'QA test plan added'
    });
    assert.equal(qaPlanRes.directive.stage, 'critical-review');
    assert.match(qaPlanRes.directive.instruction, /Spawn an isolated Critical Reviewer subagent in READ-ONLY mode/);

    // 7a. Critical review cannot PASS if BLOCKER/MAJOR findings are present
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'critical-review',
          outcome: 'PASS',
          findings: [
            {
              id: 'CR-1',
              severity: 'MAJOR',
              description: 'Missing storage quota fallback task',
              recommendation: 'Add quota exceeded recovery AC to T1',
              repairStage: 'planning'
            }
          ]
        });
      },
      /AITEAM_REVIEW_CONFLICT/
    );

    // 7b. Critical review cannot FAIL without BLOCKER/MAJOR findings
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'critical-review',
          outcome: 'FAIL',
          repairStage: 'planning',
          findings: [{ id: 'CR-0', severity: 'INFO', description: 'Minor note' }]
        });
      },
      /AITEAM_CRITICAL_REVIEW_FINDINGS_REQUIRED/
    );

    // 7c. Critical review cannot FAIL without a valid repairStage
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'critical-review',
          outcome: 'FAIL',
          repairStage: 'invalid-stage',
          findings: [{ id: 'CR-1', severity: 'BLOCKER', description: 'Broken gap' }]
        });
      },
      /AITEAM_INVALID_REPAIR_STAGE/
    );

    // 7d. Critical review FAIL with repairStage="planning" rolls back planning/qa-planning/critical-review and locks findings
    const failCritRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'critical-review',
      outcome: 'FAIL',
      repairStage: 'planning',
      summary: 'Found uncovered offline quota recovery AC',
      findings: [
        {
          id: 'CR-1',
          dimension: 'prd-traceability',
          severity: 'BLOCKER',
          location: 'TASK_LEDGER.md',
          description: 'Storage quota recovery requirement is missing from task acceptance criteria',
          recommendation: 'Add AC-2 for quota exceeded warning and JSON export',
          repairStage: 'planning'
        }
      ]
    });

    assert.equal(failCritRes.directive.status, 'ACTIVE');
    assert.equal(failCritRes.directive.stage, 'planning');
    assert.match(failCritRes.directive.instruction, /CRITICAL REVIEW REWORK REQUIRED/);
    assert.match(failCritRes.directive.instruction, /CR-1/);
    assert.equal(failCritRes.session.lockedCriticalFindings.length, 1);
    assert.ok(!failCritRes.session.completedStages.includes('planning'));
    assert.ok(!failCritRes.session.completedStages.includes('qa-planning'));
    assert.ok(!failCritRes.session.completedStages.includes('critical-review'));
    assert.notEqual(failCritRes.session.pendingUserInput?.gate, 'trd');
    assert.ok(!failCritRes.session.pendingUserInput || failCritRes.session.pendingUserInput.response !== null);

    // Cannot skip straight back to critical-review without re-running planning & qa-planning
    await assert.rejects(
      async () => {
        await handleToolCall('aiteam_advance', {
          repository: tmpDir,
          stage: 'critical-review',
          outcome: 'PASS',
          repairStage: 'none',
          findings: []
        });
      },
      /AITEAM_STAGE_ORDER_VIOLATION/
    );

    // 8. Re-complete planning -> qa-planning -> critical-review (VERIFY_REPAIRS -> PASS)
    fs.writeFileSync(
      path.join(tmpDir, 'TASK_LEDGER.md'),
      '# Task Ledger\n\n### T1: Offline CRDT store\nPersist edits locally\n- [ ] AC-1: Edits survive reload\n- [ ] AC-2: Quota exceeded shows warning and exports JSON\n'
    );
    await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'planning',
      ledger: 'TASK_LEDGER.md',
      outcome: 'PASS'
    });
    const reQaPlanRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'qa-planning',
      outcome: 'PASS',
      summary: 'Updated QA test plan with AC-2'
    });
    assert.equal(reQaPlanRes.directive.stage, 'critical-review');
    assert.match(reQaPlanRes.directive.instruction, /VERIFY_REPAIRS MODE/);

    const passCritRes = await handleToolCall('aiteam_advance', {
      repository: tmpDir,
      stage: 'critical-review',
      outcome: 'PASS',
      repairStage: 'none',
      findings: [],
      auditMatrix: [{ dimension: 'prd-traceability', status: 'PASS', notes: 'CR-1 resolved' }],
      summary: 'All 6 dimensions verified after repair'
    });
    assert.equal(passCritRes.directive.status, 'GATE_BLOCKED');
    assert.equal(passCritRes.directive.gate, 'trd');
    assert.equal(passCritRes.session.lockedCriticalFindings.length, 0);
  } finally {
    await stopWatcher(tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AITeam Upgrader: detects GitHub update and outdated project files, upgrades on approval, and supports skip', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aiteam-upgrade-test-'));
  const remoteDir = path.join(sandbox, 'remote.git');
  const seedDir = path.join(sandbox, 'seed');
  const cloneDir = path.join(sandbox, 'aiteam-clone');
  const targetRepo = path.join(sandbox, 'target-project');

  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  try {
    // 1. Set up bare remote ("GitHub") and initial commit v0.8.0
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, 'init', '--bare');
    git(remoteDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');

    fs.mkdirSync(path.join(seedDir, 'skill', 'templates'), { recursive: true });
    git(seedDir, 'init', '-b', 'main');
    git(seedDir, 'config', 'user.email', 'test@example.com');
    git(seedDir, 'config', 'user.name', 'Test Runner');
    fs.writeFileSync(path.join(seedDir, 'VERSION'), '0.8.0\n');
    fs.writeFileSync(path.join(seedDir, 'skill', 'SKILL.md'), '# AITeam v0.8.0\n');
    fs.writeFileSync(
      path.join(seedDir, 'skill', 'templates', 'AGENTS.skill.md'),
      '# Project Agent Instructions\nOld template v0.8.0\n'
    );
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'chore: initial v0.8.0');
    git(seedDir, 'remote', 'add', 'origin', remoteDir);
    git(seedDir, 'push', '-u', 'origin', 'main');

    // Clone into cloneDir (simulating local /home/brad/aiteam installation)
    execFileSync('git', ['clone', '--branch', 'main', remoteDir, cloneDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Set up target project with custom AGENTS.md header + outdated AITeam section
    fs.mkdirSync(targetRepo, { recursive: true });
    git(targetRepo, 'init', '-b', 'main');
    fs.writeFileSync(
      path.join(targetRepo, 'AGENTS.md'),
      '# My Custom Game Header\nKeep this section intact!\n\n# Project Agent Instructions\nOutdated instructions\n'
    );

    // 2. Push newer release v0.9.0-test to remote
    fs.writeFileSync(path.join(seedDir, 'VERSION'), '0.9.0-test\n');
    fs.writeFileSync(
      path.join(seedDir, 'skill', 'templates', 'AGENTS.skill.md'),
      '# Project Agent Instructions\nUpdated template v0.9.0-test with GitHub upgrade gate\n'
    );
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'feat: release v0.9.0-test');
    git(seedDir, 'push', 'origin', 'main');

    // 3. Start AITeam on target project and offer upgrade against cloneDir
    await handleToolCall('aiteam_start', {
      repository: targetRepo,
      request: 'Add online leaderboard'
    });

    const offerRes = offerUpgradeIfAvailable(targetRepo, {
      aiteamRoot: cloneDir,
      forceCheck: true
    });
    assert.equal(offerRes.upgradeAvailable, true);
    assert.equal(offerRes.check.githubBehind, true);
    assert.equal(offerRes.check.commitsBehind, 1);
    assert.equal(offerRes.check.remoteVersion, '0.9.0-test');
    assert.equal(offerRes.check.projectOutdated, true);

    const statusRes = await handleToolCall('aiteam_status', { repository: targetRepo });
    assert.equal(statusRes.directive.status, 'GATE_BLOCKED');
    assert.equal(statusRes.directive.gate, 'upgrade');
    assert.match(statusRes.directive.instruction, /AITEAM GITHUB UPGRADE AVAILABLE/);

    // 4. Approve upgrade -> pulls from remote, refreshes AGENTS.md, preserves header, writes install.json
    const apprRes = await handleToolCall('aiteam_record_approval', {
      repository: targetRepo,
      gate: 'upgrade',
      decision: 'approved',
      response: 'Yes, upgrade now'
    });
    assert.equal(apprRes.directive.status, 'ACTIVE');
    assert.equal(apprRes.directive.stage, 'intake');

    assert.equal(fs.readFileSync(path.join(cloneDir, 'VERSION'), 'utf8').trim(), '0.9.0-test');
    const updatedAgents = fs.readFileSync(path.join(targetRepo, 'AGENTS.md'), 'utf8');
    assert.match(updatedAgents, /# My Custom Game Header\nKeep this section intact!/);
    assert.match(updatedAgents, /Updated template v0\.9\.0-test with GitHub upgrade gate/);

    const skillLink = fs.readlinkSync(path.join(targetRepo, '.agents', 'skills', 'aiteam'));
    assert.equal(path.resolve(path.dirname(path.join(targetRepo, '.agents', 'skills', 'aiteam')), skillLink), path.join(cloneDir, 'skill'));

    const meta = readInstallMetadata(targetRepo);
    assert.equal(meta.version, '0.9.0-test');
    assert.equal(meta.commit, git(cloneDir, 'rev-parse', '--short', 'HEAD'));

    // Re-checking now sees everything up to date
    const cleanCheck = offerUpgradeIfAvailable(targetRepo, {
      aiteamRoot: cloneDir,
      forceCheck: true
    });
    assert.equal(cleanCheck.upgradeAvailable, false);

    // 5. Push v0.9.1-test and test skipping ("changes_requested") suppresses repeat nag for same commit
    fs.writeFileSync(path.join(seedDir, 'VERSION'), '0.9.1-test\n');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'chore: release v0.9.1-test');
    git(seedDir, 'push', 'origin', 'main');

    const secondOffer = offerUpgradeIfAvailable(targetRepo, {
      aiteamRoot: cloneDir,
      forceCheck: true
    });
    assert.equal(secondOffer.upgradeAvailable, true);

    const skipRes = await handleToolCall('aiteam_record_approval', {
      repository: targetRepo,
      gate: 'upgrade',
      decision: 'changes_requested',
      response: 'skip'
    });
    assert.equal(skipRes.directive.status, 'ACTIVE');
    assert.equal(skipRes.directive.stage, 'intake');
    const sessAfterSkip = readSession(targetRepo);
    assert.equal(sessAfterSkip.declinedUpgradeCommit, secondOffer.check.remoteCommit);

    process.env.AITEAM_ENABLE_UPGRADE_CHECK = '1';
    try {
      const suppressed = offerUpgradeIfAvailable(targetRepo, { aiteamRoot: cloneDir });
      assert.equal(suppressed.upgradeAvailable, false);
      assert.equal(suppressed.declined, true);
    } finally {
      delete process.env.AITEAM_ENABLE_UPGRADE_CHECK;
    }
  } finally {
    await stopWatcher(targetRepo);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
