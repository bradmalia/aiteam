# Project Agent Instructions

## AITeam MCP Tools Available
You have native MCP tools for managing the AITeam workflow. **Prefer calling MCP tools over running bash commands**:
- `aiteam_start(request: "...")`: Initializes a session, starts the live watcher dashboard, and enters `intake`.
- `aiteam_advance(stage: "...", outcome: "PASS"|"FAIL", summary: "...", taskId: "...", filesChanged: [...], checks: [...], findings: [...], ledger: "...")`: Call this whenever you finish a stage or task. It validates stage ordering, artifacts, tests, and fingerprints, updates the live dashboard, and **returns the exact next directive and task**.
- `aiteam_wait_for_approval(gate: "prd"|"trd"|"qa", taskId: "...")`: **MANDATORY AT EVERY GATE.** Blocks and waits until the human user clicks **Approve Gate** or **Request Changes** in the Watcher Dashboard Portal, then automatically returns the next stage directive so you can continue without terminal typing.
- `aiteam_record_approval(gate: "prd"|"trd"|"qa", decision: "approved"|"changes_requested", taskId: "...", response: "...")`: Only used if the human user typed their decision directly in chat instead of clicking the Watcher Portal button.
- `aiteam_status()`: Inspects current stage, active task, open gates, and live dashboard URL.
- `aiteam_log(message: "...", agentId: "...")`: Streams live progress notes to the Watcher Dashboard.

## Human Approval Gates & Automatic Portal Waiting (MANDATORY)
AITeam enforces the full 9-stage setup pipeline and 4-Gate Task Loop with three **HARD** human-approval gates:
1. **PRD Gate (`prd-review`)**: Opens after `intake` (requires `.aiteam/docs/prd.html` on disk).
2. **TRD Gate (`trd-review`)**: Opens after `architecture` → `ui-design` → `planning` → `qa-planning` → `critical-review` have all completed and finalized `.aiteam/docs/trd.html`.
3. **Per-Task QA Sign-Off Gate (`qa-manual`)**: Opens after automated `qa` passes (requires automated tests in `tests/qa/` on disk).

At each gate:
1. Call `aiteam_wait_for_approval(gate: "<prd|trd|qa>", taskId: "<id>")` (or run `node .agents/skills/aiteam/lib/state-bridge.mjs wait-approval --repo "$PWD" --gate <prd|trd|qa> [--taskId <id>]`).
2. This command **blocks and listens** until the user clicks **Approve Gate** or **Request Changes** in the Watcher Dashboard browser UI (`http://localhost:4317`).

## Resuming Work: "resume aiteam" / "aiteam"
When the user says **"resume aiteam"**, **"run aiteam"**, or **"aiteam"**:
1. Call `aiteam_status()` (or read `.aiteam/session.json`) to get `currentStage`, `currentTaskId`, and `pendingUserInput`.
2. **If a gate is open** (`pendingUserInput.response` is `null`), immediately call `aiteam_wait_for_approval(gate: "<prd|trd|qa>")` so the user can click **Approve Gate** in the Watcher Dashboard and you automatically continue.
3. Execute every stage in strict order (`AITEAM_STAGE_ORDER_VIOLATION` blocks skipping any stage) using the contracts in `.agents/skills/aiteam/contracts/`:
   - **Pre-Implementation Setup Pipeline (9 Stages)**:
     1. `intake` (`analyst.md`): Write `.aiteam/docs/prd.html`, call `aiteam_advance(stage: "intake")`, then call `aiteam_wait_for_approval(gate: "prd")`.
     2. `prd-review`: Human PRD Approval Gate.
     3. `architecture` (`architect.md`): Define component boundaries/interfaces and initialize `.aiteam/docs/trd.html`, then call `aiteam_advance(stage: "architecture")`.
     4. `ui-design` (`ui-designer.md`): Design user flows, screen mockups, layout hierarchy, and interaction states; append UI/UX section to `.aiteam/docs/trd.html`, then call `aiteam_advance(stage: "ui-design")`.
     5. `planning` (`planner.md`): Write `TASK_LEDGER.md` (`### T1: Title` + `- [ ] AC-1: ...`), append Implementation Plan to `.aiteam/docs/trd.html`, and call `aiteam_advance(stage: "planning", ledger: "TASK_LEDGER.md")`.
     6. `qa-planning` (`qa-planner.md`): Author pre-implementation black-box test plans for all tasks in `.aiteam/docs/trd.html`, then call `aiteam_advance(stage: "qa-planning")`.
     7. `critical-review` (`critical-reviewer.md`): Audit Architecture, UI Design, Task Ledger, and QA Plan against PRD; finalize `.aiteam/docs/trd.html`, call `aiteam_advance(stage: "critical-review")`, then call `aiteam_wait_for_approval(gate: "trd")`.
     8. `trd-review`: Human TRD Approval Gate.
     9. `environment-readiness` (`environment-readiness.md`): Verify build/unit/Playwright runners work, then call `aiteam_advance(stage: "environment-readiness")`.
   - **Per-Task Execution Loop (4 Gates per Task)**:
     - `implementation` (`programmer.md`): Implement task `acceptanceCriteria`, run unit tests, and call `aiteam_advance(stage: "implementation", taskId: "...", filesChanged: [...])`.
     - `code-review` (`reviewer.md`): Spawn an **isolated read-only subagent** to audit `git diff` against `acceptanceCriteria` and call `aiteam_advance(stage: "code-review", taskId: "...", outcome: "PASS"|"FAIL", findings: [...])`.
     - `qa` (`qa.md`): Spawn an **isolated QA subagent** to author and run black-box tests in `tests/qa/<taskId>.test.*`, call `aiteam_advance(stage: "qa", taskId: "...", outcome: "PASS"|"FAIL", checks: [...])`, then call `aiteam_wait_for_approval(gate: "qa", taskId: "...")`.
     - `integration` (`maintainer.md`): Only after human QA sign-off is approved, verify unchanged SHA-256 fingerprint (`task.qaFingerprint`), stage only `task.filesChanged`, create a conventional git commit, and call `aiteam_advance(stage: "integration", taskId: "...", commitMessage: "...")`.
