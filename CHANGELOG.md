# Changelog

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
