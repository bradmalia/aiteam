---
name: aiteam
description: >-
  Enterprise-ready, lightweight agentic software engineering team.
  Coordinates a multi-stage development workflow (Analyst, Architect, Planner,
  Programmer, Code Reviewer, QA, and Maintainer) with zero regressions, strict
  acceptance criteria, enforced disk-level artifact/test gates, and 100%
  compatibility with the AITeam Watcher Dashboard.
---

# AITeam Skill Guide

AITeam provides an automated software engineering workflow that coordinates specialized subagents through structured, mechanically enforced quality gates.

```
Intake interview → PRD → human PRD approval
  → Architecture → UI Design → Planning → QA Test Planning → Critical Review
  → human TRD approval → Environment Readiness
  → [Task: Implementation → independent Code Review → independent QA
       → required human QA sign-off (or existing automation-only bypass)
       → Maintainer Integration] → next task

Human decisions must be real Watcher/chat responses. Viewing evidence or
passing automated tests does not supply approval. Fingerprint checks remain.
```

---

## Human Approval Gates & Mechanical Enforcement (MANDATORY)

AITeam has **three human-approval gate types**, plus the intake interview and strict per-stage artifact/order checks. The per-task QA human gate applies only when manual validation is required; eligible automation-only tasks retain their existing bypass:

| Gate | When it opens | Enforced Disk Prerequisite | User Action |
|------|---------------|----------------------------|-------------|
| **PRD** | After `intake` completes | `.aiteam/docs/prd.html` must exist and be non-empty | Click **Approve Gate** in Watcher Portal or reply `APPROVED` in chat |
| **TRD** | After `architecture` → `ui-design` → `planning` → `qa-planning` → `critical-review` | `.aiteam/docs/trd.html` must exist and be non-empty | Click **Approve Gate** in Watcher Portal or reply `APPROVED` in chat |
| **QA (per-task)** | After `qa` passes | Automated test in `tests/qa/` must exist on disk & pass | Click **Pass & Approve** in Watcher Portal or reply `PASS: …` in chat |

**Coordinator protocol at each gate (NEVER self-approve):**
1. Present the artifact (`.aiteam/docs/prd.html` / `.aiteam/docs/trd.html`) or QA verification checklist to the user.
2. **Immediately call `aiteam_wait_for_approval`** (or run `node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "$PWD" --gate <prd|trd|qa> [--taskId <id>]`).
3. This command **blocks and polls `.aiteam/session.json`** until the user clicks **Approve Gate** or **Request Changes** in the Watcher Dashboard Portal at the actual repository-specific URL, then automatically resolves with the user's decision so you continue immediately without requiring terminal input:
   - If **`APPROVED`** → immediately execute the exact returned server directive; never guess or skip the next stage.
   - If **`CHANGES_REQUESTED`** → revise the artifact (or route the task back to rework) per the returned feedback notes, call `stage-complete` / `aiteam_advance`, and call `wait-approval` again.

---

## 1. Quick Start & Invocation

When asked to build or maintain a project using AITeam:

1. **Verify or Initialize State (FIRST ACTION - DO NOT SKIP)**:
   - **New run / New milestone / Brownfield feature**:
     Execute `state-bridge init` and `stage-start --stage intake` (or `aiteam_start` MCP tool) in your very first turn BEFORE asking questions, researching, or writing the PRD:
     ```bash
     node /home/brad/aiteam/skill/lib/state-bridge.mjs init --repo "$PWD" --request "<user-request>"
     node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-start --repo "$PWD" --stage intake
     ```
   - **Resumed run**: Inspect `.aiteam/session.json` (or call `aiteam_status`) to identify current stage and active gate.

2. **Verify Watcher & Communicate Its Actual URL (Mandatory)**:
   Prefer the current MCP start/status result and report its exact repository-specific Watcher URL. Never assume port 4317 or that a prior process survived. Before reusing a preview, inspect its actual bind address, process, repository and served content; a localhost URL does not establish loopback binding.
   For a new local preview, use the verified public Node CLI with `--host 127.0.0.1` and an inspected unused high port (1024–65535), or the wrapper's supported `AITEAM_WATCH_HOST=127.0.0.1` and `AITEAM_WATCH_PORT` environment inputs. The public CLI rejects port `0`; only API fixtures may request an ephemeral port. Handle port races by selecting another port, never terminating its occupant. See [the complete launch/verification procedure](guides/manual-qa-approval-pages.md).

---

## 2. Core Workflow Stages

### Stage 1: Analyst Intake Interview & PRD (`skill/contracts/analyst.md`)
- **Brownfield Safety**: If `.aiteam/docs/prd.html` already exists from a prior milestone, `stage-start --stage intake` automatically archives it into `.aiteam/docs/archive/prd-<timestamp>.html`.
- **Step 1 — Mandatory Clarifying Interview (`outcome: "AWAITING_USER"`)**:
  - Inspect the repository first, then formulate 3–5 concrete clarifying questions (each with a `(Recommended default: ...)`).
  - The state engine **blocks** `intake` `PASS` (`AITEAM_INTAKE_INTERVIEW_REQUIRED`) until clarifying questions have been asked and answered.
  - Submit the questions and wait for the user's answers in the Watcher Portal (or chat):
    ```bash
    node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage intake --result '{"outcome":"AWAITING_USER","summary":"Clarifying questions","questions":["1. ... (Recommended default: ...)","2. ... (Recommended default: ...)"]}'
    node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "$PWD" --gate intake
    ```
- **Step 2 — Draft `.aiteam/docs/prd.html` (`outcome: "PASS"`)**:
  - Incorporate the user's answers into `.aiteam/docs/prd.html` (including a *Clarifications & Product Decisions* section) following `/home/brad/aiteam/skill/contracts/analyst.md`.
  - Record completion (throws `AITEAM_ARTIFACT_MISSING` if `.aiteam/docs/prd.html` is missing):
    ```bash
    node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage intake --result '{"outcome":"PASS","summary":"PRD drafted incorporating user clarifications"}'
    ```
- **🛑 PRD GATE (hard stop):** Call `wait-approval --gate prd` (or `aiteam_wait_for_approval(gate="prd")`) to wait for the user's PRD approval in the Watcher Portal.

### Stage 2: Architecture & Technical Design (`skill/contracts/architect.md`)
- **Brownfield Safety**: If `.aiteam/docs/trd.html` already exists, `stage-start --stage architecture` automatically archives it into `.aiteam/docs/archive/trd-<timestamp>.html`.
- Define component boundaries, state machines, and data models in `.aiteam/docs/trd.html` following `/home/brad/aiteam/skill/contracts/architect.md`.
- Record completion (throws `AITEAM_ARTIFACT_MISSING` if `.aiteam/docs/trd.html` is missing):
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage architecture --result '{"outcome":"PASS","summary":"TRD drafted"}'
  ```
- Architecture advances to **UI Design**, not TRD approval.

### Stage 3: UI/UX Design (`skill/contracts/ui-designer.md`)
- Append user flows, layouts, interaction states and accessibility rules to the TRD, then complete `ui-design`.

### Stage 4: Task Planning (`skill/contracts/planner.md`)
- After UI Design, write `TASK_LEDGER.md` with `### T1: Title` and `- [ ] AC-1: ...` entries, append the implementation plan to the TRD, and complete `planning` with its ledger path.

### Stage 5: QA Test Planning (`skill/contracts/qa-planner.md`)
- Author the pre-implementation black-box plan and regression strategy in the TRD, including the review-page plan when manual QA is required. Complete `qa-planning` before Critical Review.

### Stage 6: Critical Review and Human TRD Approval
- Audit the complete architecture, UI, tasks and QA plan using `skill/contracts/critical-reviewer.md`; complete `critical-review`.
- Present the finalized TRD and immediately invoke the active `aiteam_wait_for_approval(gate="trd")` listener. Process the actual recorded decision and continue the server directive; do not merely post links and end the workflow.

### Stage 7: Environment Readiness (`skill/contracts/environment-readiness.md`)
- Only after actual TRD approval, verify the required build/runtime/browser capabilities and complete `environment-readiness` before task implementation.

---

## 3. The Strict 4-Gate Task Execution Loop

For each task in `TASK_LEDGER.md`, execute these 4 gates in strict sequential order (`AITEAM_STAGE_ORDER_VIOLATION` is thrown if any stage is skipped):

### Gate 1: Implementation (`programmer`)
- **Contract**: `/home/brad/aiteam/skill/contracts/programmer.md`
- **Responsibilities**:
  - Write or modify the assigned source code for this task's `acceptanceCriteria`.
  - Run unit tests (`tests/unit/`) and compiler checks.
  - Report non-empty `filesChanged` (verified on disk) and `validations`.
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage implementation --taskId "<task-id>" --result '<json-result>'
  ```

### Gate 2: Code Review (`reviewer` — Subagent Isolation Required)
- **Action**: Spawn an **isolated** `reviewer` subagent in **read-only mode** (do NOT self-review inline in the same context that wrote the code).
- **Contract**: `/home/brad/aiteam/skill/contracts/reviewer.md`
- **Responsibilities**:
  - Inspect `git diff` against the exact acceptance criteria.
  - Reject (`outcome: "FAIL"`) for BLOCKER or MAJOR defects (`AITEAM_REVIEW_CONFLICT` blocks passing with BLOCKER/MAJOR findings).
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage code-review --taskId "<task-id>" --result '<json-result>'
  ```

### Gate 3: QA Black-Box Testing (`qa` — Subagent Isolation & `tests/qa/` Required)
- **Action**: Spawn an **isolated** `qa` subagent.
- **Contract**: `/home/brad/aiteam/skill/contracts/qa.md`
- **Responsibilities**:
  - Author and execute automated black-box tests in `tests/qa/<task-id>.test.*` (`AITEAM_QA_TEST_MISSING` blocks completing QA if `tests/qa/` has no test files).
  - Test user-observable behavior and verify zero cross-task regressions.
- **State Update**:
  - **Headless / Backend Tasks (No Manual Human Validation)**: If `outcome: "PASS"` and there are no manual verification checks (`manualChecks: []`), the state engine automatically promotes the task to `qa-passed`, records an automated bypass approval, and routes directly to Gate 4 (Git Integration) without blocking on human sign-off.
  - **UI / User-Facing Tasks (Manual Verification Required)**: If `outcome: "PASS_WITH_MANUAL_VALIDATION"` or `manualChecks` has steps (or `requiresManualValidation: true`), the task is held in `qa-auto-passed` and opens the human QA sign-off gate.
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage qa --taskId "<task-id>" --result '<json-result>'
  ```
- **Manual QA approval page (required for every existing manual QA gate):** Follow [the canonical procedure](guides/manual-qa-approval-pages.md) and adapt [the reusable HTML template](templates/manual-qa-review.html) to `.aiteam/docs/qa-<safe-task-id>.html`. Publish and verify it before opening the gate. Include task/revision identity, acceptance criteria, exact service startup/readiness/manual actions/expected results/cleanup, tests actually performed, useful screenshot/video/output and pending human judgment. Label failed/skipped/unrun/stale/example evidence and explain N/A media honestly.
- **Durable packet links:** Keep evidence in `.aiteam/reviews/<task>/` and use origin-relative `/review-assets/` references alongside `/artifacts/` pages. Audit all outbound links/media/receipts/sources/archives/fragments and manual URLs against intended content, with real browser navigation. Recheck after restart/resume; do not hand off only a healthy top-level page whose other links rely on dead fixture servers.
- **Freeform, usable evidence:** Choose task-appropriate pictures, video, real interactive/browser content or output; no screenshot-only format is required. Evidence must be readable at useful desktop size. Show working controls or a live/full-page artifact when interaction matters, not only an image containing buttons. Verify the actual approval-page Before/After/playback/frame behavior and mobile/no-JavaScript fallback without changing approval semantics.
- **🛑 QA SIGN-OFF:** Present the verified clickable HTTP(S) page and concise checks; immediately invoke the active `aiteam_wait_for_approval(gate="qa", taskId="...")` listener. The page is evidence-only. A Watcher decision resumes its exact server directive; an actual chat decision is recorded verbatim using `aiteam_record_approval` before continuing. Timeout is not approval: check status for a saved response or re-establish a listener for a still-pending gate. Never request an already recorded approval again. Existing automation-only bypass and fingerprint protections remain unchanged.

### Gate 4: Maintainer Git Integration (`maintainer`)
- **Blocked until the QA sign-off gate passes or automated QA bypass is recorded** (`AITEAM_GATE_BLOCKED` / `AITEAM_STAGE_ORDER_VIOLATION`).
- **Contract**: `/home/brad/aiteam/skill/contracts/maintainer.md`
- **Responsibilities**:
  - Stage ONLY `task.filesChanged` and create a clean conventional git commit.
  - `stage-complete --stage integration` automatically verifies `task.qaFingerprint` (`AITEAM_FINGERPRINT_MISMATCH` invalidates approval and routes the task back to `needs-rework` if any file was altered after QA).
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage integration --taskId "<task-id>" --result '<json-result>'
  ```

---

## 4. Subagent Dispatch: Native vs. CLI Mode

To preserve context isolation (especially for `code-review` and `qa`):

1. **Native Subagents (Antigravity / Gemini CLI)**:
   Invoke specialists via `invoke_subagent` (`research` for read-only `reviewer`, `self` for `programmer` / `qa`) with the prompt contracts in `/home/brad/aiteam/skill/contracts/`.
2. **CLI Agents (Codex, Qwen Code, Agy)**:
   Use `/home/brad/aiteam/skill/lib/runner-adapter.mjs` to execute specialists in isolated CLI subprocesses.
