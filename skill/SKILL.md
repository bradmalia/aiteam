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
Request ──► Intake/PRD ──► Architecture ──► Task Planning
                                                  │
                 ┌────────────────────────────────┴────────────────────────┐
                 ▼                                                         ▼
        [Task N: Implementation]                                [Next Task 1..N]
                 │
                 ▼
        [Code Review Gate]  ── (Fail) ──► Needs Rework
                 │ (Pass)
                 ▼
        [QA Black-Box Gate] ── (Fail) ──► Needs Rework
                 │ (Pass)
                 ▼
        [Maintainer Git Commit]
```

---

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
- Once approved, record completion:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage intake --result '{"outcome":"PASS","summary":"PRD approved"}'
  ```

### Stage 2: Architecture & Technical Design
- Define component boundaries, state machines, and data models in `.aiteam/docs/trd.html`.
- Document quality attributes and cross-cutting concepts.

### Stage 3: Task Planning & Ledger Creation
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
- **State Update**:
  ```bash
  node /home/brad/aiteam/skill/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage qa --taskId "<task-id>" --result '<json-result>'
  ```

### Gate 4: Maintainer Git Integration (`maintainer`)
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
