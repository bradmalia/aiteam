# Project Agent Instructions

## Quick Trigger: "resume aiteam" / "aiteam"
When the user says **"resume aiteam"**, **"run aiteam"**, or **"aiteam"**:
1. Read `.aiteam/session.json` to get `currentStage` and `currentTaskId`.
2. Activate the `aiteam` skill (`.agents/skills/aiteam/SKILL.md`).
3. Execute the current stage using the specialist contracts in `.agents/skills/aiteam/contracts/`:
   - `implementation`: Code the task's `acceptanceCriteria`, run tests, and record `filesChanged`.
   - `code-review`: Statically audit the git diff in 1 turn against the acceptance criteria.
   - `qa`: Execute black-box integration tests in `tests/qa/`.
   - `integration`: Verify file fingerprints and create a conventional git commit.
4. After each stage, update state via:
   ```bash
   node .agents/skills/aiteam/lib/state-bridge.mjs stage-complete --repo "$PWD" --stage <stage> [--taskId <taskId>] --result '<json>'
   ```
5. Continue driving the remaining tasks in `taskLedger` until all tasks reach `qa-passed` / `complete`.
