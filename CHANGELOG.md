# Changelog

## 0.8.0 - 2026-11-21

- **Automatic GitHub Upgrade Check & Project Self-Upgrade (`skill/lib/upgrader.mjs`)**:
  - `aiteam_start` and `aiteam_status` automatically check `origin/main` on GitHub for newer AITeam releases and check whether the target project's `AGENTS.md` / `.aiteam/install.json` is out of date.
  - Opens an interactive `upgrade` gate (`gate="upgrade"`) presenting the version diff and recent commit changelog; approving in chat (`aiteam_record_approval` / `aiteam_upgrade`) or the Watcher Portal pulls the latest commits via fast-forward (`git pull --ff-only`), refreshes `.agents/skills/aiteam` and `AGENTS.md` (preserving any project-specific header), writes `.aiteam/install.json`, and seamlessly resumes the workflow.
  - Upgraded `bin/aiteam-install` to refresh existing `AGENTS.md` files and write `.aiteam/install.json`.
- **Adversarial Critical Review Overhaul**:
  - Enforced isolated read-only subagent execution for `critical-review` (`skill/contracts/critical-reviewer.md`) and moved final TRD traceability assembly to `qa-planning`.
  - Added 6 mandatory falsification dimensions (`prd-traceability`, `repo-grounding`, `state-and-failure-modes`, `math-and-layout-sanity`, `task-and-assembly-integrity`, `qa-falsifiability`), `AITEAM_REVIEW_CONFLICT` rejection on `PASS` with `BLOCKER`/`MAJOR` findings, and `FAIL` + `repairStage` routing (`architecture` | `ui-design` | `planning` | `qa-planning`) with `session.lockedCriticalFindings` and `VERIFY_REPAIRS` mode.
- **Deepened Multi-Round Intake**:
  - Upgraded `skill/contracts/analyst.md` and `mcp-server.mjs` intake directives to require pre-interview codebase discovery (`evidence`), 4–8 dimension-tagged clarifying questions across 5 dimensions, explicit `(Decision required: ...)` vs `(Recommended default: ...)` framing, and optional multi-round follow-up interviews.
- **State-Engine & Runner Adapter Fixes**:
  - Made `hasQaTestFiles(repo, taskId)` task-scoped so `T1` tests cannot satisfy `T2..TN`.
  - Required non-empty `.aiteam/docs/trd.html` for `ui-design` and `qa-planning`, prevented `FAIL` outcomes from marking stages complete in `session.completedStages`, removed the 400-character task description truncation in `parseTaskLedgerMarkdown`, fixed `resolveSandboxMode` in `skill/lib/runner-adapter.mjs`, and synced `src/mcp-bridge.py`.

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
