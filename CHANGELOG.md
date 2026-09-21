# Changelog

## 0.7.0 - 2026-09-20

- Mandatory **hard human-approval gates** at three points in the workflow:
  - **PRD** gate opens after `intake`; **TRD** gate opens after `architecture`; per-task **QA sign-off** gate opens when automated QA passes.
  - Each gate is a HARD STOP: the state bridge rejects the next stage with `AITEAM_GATE_BLOCKED`, and no git commit can happen, until the user's decision is recorded.
  - Decision loop: `APPROVED` proceeds / a list of requested changes iterates the artifact or routes the task back to rework, then re-presents. Never self-approved.
- `state-bridge.mjs`: new `recordApproval` / `openGate` APIs, `approvals` session map (schema v3), `requiredApprovals` enforcement in both `stage-start` and `stage-complete`, and gate auto-open on `intake` / `architecture` / `qa`.
- Per-task QA: automated `PASS` now lands a task in `qa-auto-passed` (held) with the sign-off gate open; `record-approval --gate qa --taskId …` promotes it to `qa-passed`, sets the fingerprint, and adds it to `completedTasks`; `changes` routes it back to `needs-rework`.
- New CLI commands `record-approval` and `request-approval`; usage line updated.
- `SKILL.md` and the `AGENTS.md` template now mandate the gate protocol (present → stop & wait → record → continue / reroute) and document the exact `record-approval` commands.
- Dashboard: surfaced the new `qa-auto-passed` status (friendly "awaiting QA sign-off" label) plus the open gate's prompt and pending/response fields.
- Tests: lifecycle now records the PRD/TRD/`qa` approvals and asserts the `qa-auto-passed` → sign-off → `qa-passed` + commit-block flow; added a dedicated gate-enforcement test.
- Note (pre-existing): docs reference `state-bridge.mjs update-ledger`, but no `update-ledger` CLI branch exists (only the `updateTaskLedger()` function). Ledger registration should use the exported function until a CLI branch is added.

## Unreleased

- Give every specialist a fixed one-hour execution timeout, regardless of shorter or longer compatibility inputs from a coordinator.
- Discard stale downstream review and QA artifacts when implementation rework succeeds.
- Enforce structured reporting retries after implementation output-contract failures.

## 0.2.0 - 2026-08-19

- Explicit coordinator-driven execution guidance; no passive status polling
- Isolated, launcher-matched Codex subprocess configuration for specialists
- Repository-local generated specialist registration through `aiteam_register_specialist`
- Recruiter-to-registration-to-spawn workflow contract
- Nonzero specialist exits reported as failures instead of successful completions
- Focused tests for child invocation and generated specialist resolution
- Mandatory user-visible agent, current-phase, and remaining-phase reporting around every specialist call
- Server-owned `aiteam_advance` lifecycle with structured stage schemas and an enforced task ledger
- Mandatory Critical Review, per-task Code Review and QA, and `aiteam_complete` gates
- Reviewer/QA failure routing back to the assigned implementation task
- Recruiter-provenance enforcement and rejection of file-path specialist contracts
- Protected Git-local control-state mirror plus automatic `.aiteam/` exclusion
- POSIX process-group termination and 300–7200 second timeout bounds
- Read-only Maintainer inspection and server-controlled commits of QA-approved paths only
- Implementation/QA path fingerprints that invalidate stale approvals after later edits
- Dedicated `v100-ai --aiteam` read-only primary Coordinator mode
- Adversarial workflow, timeout, state-recovery, provenance, and Git-isolation tests

## 0.1.0 - 2026-08-18

Initial AITEAM foundation.

- Git-native source repository
- dependency-free Node MCP server
- Codex-first invocation contract: "Using AITEAM, I want to..."
- Coordinator-owned agentic workflow
- persistent agent registry and specialist contracts
- subprocess specialist runner through Codex CLI
- repo-local session/event/run state
- Git repository-boundary validation
- initial Critical Review, QA, Code Review, Recruiter, and Maintainer contracts
