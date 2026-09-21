---
name: aiteam
description: >-
  Enterprise-ready, lightweight agentic software engineering team.
  Coordinates a multi-stage development workflow (Analyst, Architect, Planner,
  Programmer, Code Reviewer, QA, and Maintainer) with zero regressions, strict
  acceptance criteria, and 100% compatibility with the AITeam Watcher Dashboard.
---

# AITeam Skill Guide

AITeam provides an automated software engineering workflow that coordinates specialized subagents through structured quality gates.

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
      committed, until YOU explicitly approve it in chat (or request changes,
      which iterates the artifact). See "Human Approval Gates (MANDATORY)".
```

---

## Human Approval Gates (MANDATORY)

Every AITeam run has **three hard human-approval gates**. These are not optional
checkpoints — they are enforced in state: the next stage throws `AITEAM_GATE_BLOCKED`
and **no git commit can happen** until you explicitly approve the gate in chat, or
request changes (which iterates the artifact).

| Gate | When it opens | You reply | Record your decision |
|------|---------------|-----------|----------------------|
| **PRD** | PRD drafted (`.aiteam/docs/prd.html`) | `APPROVED` or list the changes you want | `record-approval --gate prd --decision approved --response "<your words>"` |
| **TRD** | Technical design drafted (`.aiteam/docs/trd.html`) | `APPROVED` or list the changes you want | `record-approval --gate trd --decision approved --response "<your words>"` |
| **QA (per-task)** | A task's automated QA passes | `PASS: …` (confirmed in the running app) or `FAIL: <defects>` | `record-approval --gate qa --taskId <id> --decision approved --response "<your words>"` |

**Coordinator protocol at each gate (never self-approve):**
1. Present the artifact (PRD/TRD) or the QA verification checklist to the user in chat.
2. **Stop and wait** for the user's explicit decision. Do not call the next stage's
   commands until they respond — the state bridge will reject them anyway.
3. If **approved** → record it with `record-approval`, then continue to the next stage.
4. If the user **requests changes** → record the decision, revise the artifact (or
   route the task back to rework), re-present, and wait again.

Gates **auto-open** when the prior stage completes (PRD after `intake`, TRD after
`architecture`, per-task QA after `qa` passes). To open one manually:
```bash
node /home/brad/aiteam/skill/lib/state-bridge.mjs request-approval --repo "$PWD" --gate prd
```

## 1. Quick Start & Invocation

When asked to build or maintain a project using AITeam:

1. **Verify or Initialize State**:
   Ensure `.aiteam/session.json` exists in the target repository.
   ```bash
   node /home/brad/aiteam/skill/lib/state-bridge.mjs init --repo "$PWD" --request "<user-request>"
   ```
2. **Launch the Live Watcher Dashboard** (Optional but Recommended):
   ```bash
   /home/brad/aiteam/bin/aiteam-watch "$PWD" --port 22924
   ```
   Open `http://localhost:22924` to monitor real-time task progress, logs, and artifacts.

---

## 2. Core Workflow Stages

### Stage 1: Analyst Intake & PRD
- Collect requirements and generate `.aiteam/docs/prd.html`.
- Confirm MVP scope, user stories, constraints, and acceptance criteria.
- Record the PRD as complete — this **auto-opens the PRD approval gate**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage intake --result '{"outcome":"PASS","summary":"PRD drafted"}'
  ```
- **🛑 PRD GATE (hard stop):** Present the PRD to the user and wait for their explicit
  decision. On approval → `record-approval --repo "$PWD" --gate prd --decision approved
  --response "<their words>"`. On requested changes → revise the PRD, re-present, and
  wait again. **Do not start Architecture until approved** — `stage-start --stage
  architecture` returns `AITEAM_GATE_BLOCKED` otherwise.

### Stage 2: Architecture & Technical Design
- Define component boundaries, state machines, and data models in `.aiteam/docs/trd.html`.
- Document quality attributes and cross-cutting concepts.
- Record the TRD as complete — this **auto-opens the TRD approval gate**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage architecture --result '{"outcome":"PASS","summary":"TRD drafted"}'
  ```
- **🛑 TRD GATE (hard stop):** Present the TRD to the user and wait for their explicit
  decision. On approval → `record-approval --repo "$PWD" --gate trd --decision approved
  --response "<their words>"`. On requested changes → revise the TRD, re-present, and
  wait again. **Do not start Task Planning until approved.**

### Stage 3: Task Planning & Ledger Creation
- (Unblocked once **both the PRD and TRD gates are approved**.)
- Decompose the architecture into an ordered list of modular tasks in `TASK_LEDGER.md`.
- Each task must have **explicit behavioral acceptance criteria**.
- Register the task ledger:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs update-ledger --repo "$PWD" --ledger TASK_LEDGER.md
  ```

---

## 3. The 4-Gate Task Execution Loop

For each task in `TASK_LEDGER.md`, execute these gates sequentially:

### Gate 1: Implementation (`programmer`)
- **Action**: Spawn the `programmer` specialist with the task description and acceptance criteria.
- **Contract**: `/home/brad/aiteam/skill/contracts/programmer.md`
- **Responsibilities**:
  - Write or modify the assigned source code.
  - Run unit tests (`tests/unit/`) and compiler checks.
  - Report `filesChanged` and `validations`.
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage implementation --taskId "<task-id>" --result '<json-result>'
  ```

### Gate 2: Code Review (`reviewer`)
- **Action**: Spawn the `reviewer` specialist in **read-only mode**.
- **Contract**: `/home/brad/aiteam/skill/contracts/reviewer.md`
- **Responsibilities**:
  - Inspect `git diff` against the exact acceptance criteria.
  - Reject *only* for BLOCKER or MAJOR defects (syntax errors, security bugs, scope creep).
  - Complete review in 1–2 turns without running tests.
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage code-review --taskId "<task-id>" --result '<json-result>'
  ```

### Gate 3: QA Black-Box Testing (`qa`)
- **Action**: Spawn the `qa` specialist.
- **Contract**: `/home/brad/aiteam/skill/contracts/qa.md`
- **Responsibilities**:
  - Execute automated black-box tests in `tests/qa/` (Playwright, CLI, HTTP).
  - Test user-observable behavior; do NOT inspect implementation source.
  - Verify that previously completed tasks were not broken (cross-task regression check).
- **State Update** (a `PASS` puts the task into `qa-auto-passed` and **auto-opens the QA sign-off gate**):
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage qa --taskId "<task-id>" --result '<json-result>'
  ```
- **🛑 QA SIGN-OFF GATE (hard stop, per-task):** Present the automated results and the
  manual-verification checklist to the user and wait for their explicit decision.
  - **PASS** (confirmed in the running app) →
    `record-approval --repo "$PWD" --gate qa --taskId "<task-id>" --decision approved --response "<their words>"`
    — this promotes the task to `qa-passed` and clears the commit block.
  - **FAIL / defects** →
    `record-approval --repo "$PWD" --gate qa --taskId "<task-id>" --decision changes --response "<defects>"`
    — this routes the task back to **implementation/rerwork**.

### Gate 4: Maintainer Git Integration (`maintainer`)
- **Blocked until the QA sign-off gate passes** — `stage-start --stage integration`
  returns `AITEAM_GATE_BLOCKED` if the per-task QA approval is not recorded.
- **Action**: Verify the SHA-256 fingerprint of approved files.
- **Responsibilities**:
  - Confirm files match `task.qaFingerprint`.
  - Stage only `task.filesChanged` and create a clean git commit.
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage integration --taskId "<task-id>" --result '<json-result>'
  ```

---

## 4. Runner Flexibility: Native vs. CLI Mode

The coordinator can dispatch subagents using either method:

1. **Native Subagents (Antigravity / Gemini CLI)**:
   Invoke specialists directly via `invoke_subagent` using the system prompts in `/home/brad/aiteam/skill/contracts/`.
2. **CLI Agents (Codex, Qwen Code, Agy)**:
   Use `/home/brad/aiteam/skill/lib/runner-adapter.mjs` to execute tasks via the active CLI binary.
