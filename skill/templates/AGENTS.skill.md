# Project Agent Instructions

## AITeam MCP Tools Available
You have native MCP tools for managing the AITeam workflow. **Prefer calling MCP tools over running bash commands**:
- `aiteam_start(request: "...")`: Initializes a session, starts the live watcher dashboard, and enters `intake`.
- `aiteam_advance(stage: "...", outcome: "PASS"|"FAIL"|"AWAITING_USER"|"PASS_WITH_MANUAL_VALIDATION", summary: "...", questions: [...], taskId: "...", filesChanged: [...], checks: [...], findings: [...], ledger: "...")`: Call this whenever you finish a stage or task (or submit intake clarifying questions). Follow the live tool schema. It validates stage ordering, artifacts, tests, and fingerprints, updates the live dashboard, and **returns the exact next directive and task**.
- `aiteam_wait_for_approval(gate: "intake"|"prd"|"trd"|"qa", taskId: "...")`: **MANDATORY AT EVERY GATE.** Blocks and waits until the human user submits answers or clicks **Approve Gate** / **Request Changes** in the Watcher Dashboard Portal, then automatically returns the next stage directive so you can continue without terminal typing.
- `aiteam_record_approval(gate: "intake"|"prd"|"trd"|"qa", decision: "approved"|"changes_requested", taskId: "...", response: "...")`: Only used if the human user typed their answers or decision directly in chat instead of clicking the Watcher Portal button.
- `aiteam_status()`: Inspects current stage, active task, open gates, and live dashboard URL.
- `aiteam_log(message: "...", agentId: "...")`: Streams live progress notes to the Watcher Dashboard.

## Human Approval Gates & Automatic Portal Waiting (MANDATORY)
AITeam enforces the full 9-stage setup pipeline and 4-Gate Task Loop with these human interaction gates (per-task QA sign-off applies when manual validation is required):
1. **Intake Clarifying Interview Gate (`intake`)**: Before writing `.aiteam/docs/prd.html`, the Analyst MUST inspect the repo, ask 3–5 clarifying questions via `aiteam_advance(stage: "intake", outcome: "AWAITING_USER", questions: [...])`, and wait via `aiteam_wait_for_approval(gate: "intake")`.
2. **PRD Gate (`prd-review`)**: Opens after `intake` completes with `PASS` (requires `.aiteam/docs/prd.html` on disk incorporating user answers).
3. **TRD Gate (`trd-review`)**: Opens after `architecture` → `ui-design` → `planning` → `qa-planning` → `critical-review` have all completed and finalized `.aiteam/docs/trd.html`.
4. **Per-Task QA Sign-Off Gate (`qa-manual`)**: Opens after automated `qa` passes (requires automated tests in `tests/qa/` on disk).

At each gate:
1. Present the concrete verified artifact/questions. For every manual QA gate, first prepare the Watcher-linked approval page using `.agents/skills/aiteam/guides/manual-qa-approval-pages.md` and `.agents/skills/aiteam/templates/manual-qa-review.html`. Include acceptance criteria, exact service startup and manual test actions, actual tests/results and useful screenshot/video/output evidence; explain failed/skipped/unrun/stale/N/A states and remaining human judgment. The page is evidence-only.
2. Immediately call `aiteam_wait_for_approval(gate: "<intake|prd|trd|qa>", taskId: "<id>")` (or run `node .agents/skills/aiteam/lib/state-bridge.mjs wait-approval --repo "$PWD" --gate <intake|prd|trd|qa> [--taskId <id>]`). Keep the active listener running rather than merely posting a link and ending the workflow.
3. The command listens for the actual user response. Use the exact returned repository-specific Watcher URL; never assume port 4317. Verify the actual loopback bind, repository, page/media content and controls. A public CLI preview needs explicit `--host 127.0.0.1` and an inspected unused high port; wrapper host/port settings use its supported environment inputs. Do not replace an unrelated server.
4. On a Watcher decision, continue its returned server directive. For chat, record the actual decision and verbatim response with `aiteam_record_approval`, then continue. A timeout/expired handle is not approval: check current state, process any saved response, or re-establish a listener for the still-pending gate. Never ask for an already recorded decision again or fabricate approval.

The canonical portable page guide above covers resource hosting, browser/mobile/keyboard/no-JavaScript checks, process-specific cleanup, resumption and changed-artifact revalidation. Existing automation-only QA bypass remains available; these page instructions do not create new manual gates.

Retain evidence under `.aiteam/reviews/<task>/` and prefer same-origin `/review-assets/` URLs with `/artifacts/` task pages. Before handoff and after restart, audit every linked page/media/source/receipt/archive, redirect, fragment and manual URL against its intended content and actual browser behavior. Do not silently rely on ephemeral fixture ports or leave dead historical links clickable.

Choose evidence freely for the task: useful pictures, playable videos, real interactive pages/components, browser artifacts or output, omitting irrelevant types. The page must show readable desktop evidence and real working interactions or a clear full-page link; a screenshot of Before/After buttons is not interactive proof. Verify actual deployed controls/frames/playback, separately labeled mobile evidence and a no-JavaScript fallback. Keep evidence interactions separate from approval and use least-needed frame permissions.

## Resuming Work: "resume aiteam" / "aiteam"
When the user says **"resume aiteam"**, **"run aiteam"**, or **"aiteam"**:
1. Call `aiteam_status()` (or read `.aiteam/session.json`) to get `currentStage`, `currentTaskId`, and `pendingUserInput`.
2. **If a gate is open** (`pendingUserInput.response` is `null`), immediately call `aiteam_wait_for_approval(gate: "<intake|prd|trd|qa>")` so the user can interact in the Watcher Dashboard and you automatically continue.
3. Execute every stage in strict order (`AITEAM_STAGE_ORDER_VIOLATION` blocks skipping any stage) using the contracts in `.agents/skills/aiteam/contracts/`:
   - **Pre-Implementation Setup Pipeline (9 Stages)**:
     1. `intake` (`analyst.md`): **Step 1**: Inspect repo and ask 3–5 clarifying questions with `aiteam_advance(stage: "intake", outcome: "AWAITING_USER", questions: [...])`, then call `aiteam_wait_for_approval(gate: "intake")`. **Step 2**: Write `.aiteam/docs/prd.html` incorporating the user's answers, call `aiteam_advance(stage: "intake", outcome: "PASS")`, then call `aiteam_wait_for_approval(gate: "prd")`.
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
     - `qa` (`qa.md`): Spawn an **isolated QA subagent** to author and run black-box tests in `tests/qa/<taskId>.test.*`. For required human validation, publish/verify the approval page, report the existing manual outcome and checks, then invoke `aiteam_wait_for_approval(gate: "qa", taskId: "...")`. For an eligible automation-only task, preserve the existing `PASS` with empty manual checks bypass.
     - `integration` (`maintainer.md`): Only after the actual required human QA sign-off or existing automated bypass, verify unchanged SHA-256 fingerprint (`task.qaFingerprint`), stage only `task.filesChanged`, create a conventional git commit, and call `aiteam_advance(stage: "integration", taskId: "...", commitMessage: "...")`.
