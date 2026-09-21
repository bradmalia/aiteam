# Project Agent Instructions

## Human Approval Gates (MANDATORY)
AITeam enforces three **HARD** human-approval gates. You (the coordinator) MUST stop
and get the user's explicit approval in chat before advancing — the state bridge rejects
the next stage with `AITEAM_GATE_BLOCKED`, and **no git commit can happen**, until the
user's decision is recorded. Never self-approve.

| Gate | Opens after | You reply | Record the decision |
|------|-------------|-----------|---------------------|
| **PRD** | `intake` | `APPROVED` or list changes | `record-approval --gate prd --decision approved --response "<their words>"` |
| **TRD** | `architecture` | `APPROVED` or list changes | `record-approval --gate trd --decision approved --response "<their words>"` |
| **QA (per-task)** | `qa` passes | `PASS: …` or `FAIL: <defects>` | `record-approval --gate qa --taskId <id> --decision approved --response "<their words>"` |

At each gate: present the artifact/checklist → **stop and wait** → on approval record it
and continue; on requested changes revise/route back to rework, re-present, and wait again.

## Quick Trigger: "resume aiteam" / "aiteam"
When the user says **"resume aiteam"**, **"run aiteam"**, or **"aiteam"**:
1. Read `.aiteam/session.json` to get `currentStage`, `currentTaskId`, and `pendingUserInput`.
2. **If a gate is open** (`pendingUserInput.response` is `null`), present it to the user
   and wait for their decision before doing anything else. Record it with:
   ```bash
   node .agents/skills/aiteam/lib/state-bridge.mjs record-approval --repo "$PWD" --gate <prd|trd|qa> [--taskId <id>] --decision <approved|changes> --response "<their words>"
   ```
3. Activate the `aiteam` skill (`.agents/skills/aiteam/SKILL.md`).
4. **DO NOT run or reference legacy `resume-driver.mjs` or `src/server.mjs`.** You (the coordinator) directly execute the current stage or dispatch the specialist using the contracts in `.agents/skills/aiteam/contracts/`:
   - `implementation`: Code the task's `acceptanceCriteria`, run tests, and record `filesChanged`.
   - `code-review`: Statically audit the git diff in 1 turn against the acceptance criteria.
   - `qa`: Execute black-box integration tests in `tests/qa/`.
   - `integration`: Verify file fingerprints and create a conventional git commit (only after the per-task QA sign-off gate is approved).
5. After each stage, update state via:
   ```bash
   node .agents/skills/aiteam/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage <stage> [--taskId <taskId>] --result '<json>'
   ```
   Completing `intake`, `architecture`, or `qa` **auto-opens** the next approval gate — stop and wait for the user.
6. Continue driving the remaining tasks in `taskLedger` until all tasks reach `qa-passed` / `complete`.
