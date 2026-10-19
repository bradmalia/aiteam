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
Request ──► Intake/PRD ──► 🛑 PRD APPROVAL ──► Architecture ──► 🛑 TRD APPROVAL
                                                                       │
                                                                       ▼
                                                                  Task Planning
                                                                       │
                 ┌───────────────────────────────────────────────────────┴────────┐
                 ▼                                                                ▼
        [Task N: Implementation]                                       [Next Task 1..N]
                 │
                 ▼
        [Code Review Gate]  ── (Fail) ──► Needs Rework
                 │ (Pass)
                 ▼
        [QA Black-Box Gate] ── (Fail) ──► Needs Rework
                 │ (auto-pass)
                 ▼
        🛑 QA SIGN-OFF (per-task)
                 │ (approved)
                 ▼
        [Maintainer Git Commit]

  🛑 = HARD HUMAN-APPROVAL GATE — the workflow does not advance, and NOTHING is
      committed, until the user explicitly approves it in the Watcher Dashboard
      Portal or in chat. Same-turn self-approval is blocked (AITEAM_SELF_APPROVAL_BLOCKED).
```

---

## Human Approval Gates & Mechanical Enforcement (MANDATORY)

Every AITeam run has **three hard human-approval gates** plus **strict per-stage artifact and order checks**:

| Gate | When it opens | Enforced Disk Prerequisite | User Action |
|------|---------------|----------------------------|-------------|
| **PRD** | After `intake` completes | `.aiteam/docs/prd.html` must exist and be non-empty | Click **Approve Gate** in Watcher Portal or reply `APPROVED` in chat |
| **TRD** | After `architecture` completes | `.aiteam/docs/trd.html` must exist and be non-empty | Click **Approve Gate** in Watcher Portal or reply `APPROVED` in chat |
| **QA (per-task)** | After `qa` passes | Automated test in `tests/qa/` must exist on disk & pass | Click **Pass & Approve** in Watcher Portal or reply `PASS: …` in chat |

**Coordinator protocol at each gate (NEVER self-approve):**
1. Present the artifact (`.aiteam/docs/prd.html` / `.aiteam/docs/trd.html`) or QA verification checklist to the user.
2. **Immediately call `aiteam_wait_for_approval`** (or run `node /home/brad/aiteam/skill/lib/state-bridge.mjs wait-approval --repo "$PWD" --gate <prd|trd|qa> [--taskId <id>]`).
3. This command **blocks and polls `.aiteam/session.json`** until the user clicks **Approve Gate** or **Request Changes** in the Watcher Dashboard Portal (`http://localhost:4317`), then automatically resolves with the user's decision so you continue immediately without requiring terminal input:
   - If **`APPROVED`** → immediately execute the next stage (`architecture`, `planning`, or `integration`).
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

2. **Auto-Launch Watcher & Communicate URL (Mandatory)**:
   Always ensure the watcher is running on the project:
   ```bash
   nohup /home/brad/aiteam/bin/aiteam-watch "$PWD" --port 4317 >/dev/null 2>&1 &
   ```
   **Rule:** Proactively report the watcher URL (e.g. `http://localhost:4317`) in your initial response so the user can view PRD/TRD artifacts and approve gates directly in the portal.

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
- **🛑 TRD GATE (hard stop):** Present `.aiteam/docs/trd.html` to the user and **end your turn**. Wait for their approval in the Watcher Portal or chat.

### Stage 3: Task Planning & Ledger Creation (`skill/contracts/planner.md`)
- (Unblocked once **both the PRD and TRD gates are approved**.)
- Decompose the architecture into an ordered list of modular tasks in `TASK_LEDGER.md` (`### T1: Title` and `- [ ] AC-1: ...` bullets) following `/home/brad/aiteam/skill/contracts/planner.md`.
- Register the task ledger:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs update-ledger --repo "$PWD" --ledger TASK_LEDGER.md
  ```

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
- **🛑 QA SIGN-OFF GATE (for tasks requiring human manual verification):** Present the automated results and manual verification checklist to the user and **end your turn**. Wait for their decision in the Watcher Portal or chat.

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
