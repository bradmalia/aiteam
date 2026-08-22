# AITEAM Architecture

## Control boundary

The AITEAM server owns mechanical workflow authority:

- repository-bound state and Git snapshots
- fixed phase ordering and allowed stage transitions
- required specialist selection
- structured result validation
- task ledger and dependency readiness
- Code Review and QA gates
- Recruiter provenance and specialist registration
- subprocess timeout and process-group termination
- exact validated paths eligible for integration
- completion eligibility

Agents retain semantic authority inside their assigned scope: requirements, design, task decomposition, review findings, validation evidence, and implementation choices. A semantic result affects workflow state only after it satisfies the server's stage schema.

## Interaction

```text
User -> read-only Coordinator -> AITEAM MCP -> focused specialist Codex subprocess
                                      |
                                      +-> protected state and server Git integration
```

`aiteam_advance` reads the current session, derives the only legal assignment, starts one synchronous specialist subprocess, validates its JSON result, and applies the legal transition. `aiteam_spawn_agent` funnels through the same function and rejects a mismatched agent ID.

## State

The workspace `.aiteam/` directory contains readable session, event, specialist, and run artifacts and is automatically added to `.git/info/exclude`. Critical session/event/specialist records are mirrored under `.git/aiteam/`, allowing recovery if a model deletes the workspace copy.

Authoritative session fields cannot be patched through MCP. Coordinator may persist only notes and pending user input.

## Execution

Specialists use the launcher-selected Codex version, model provider, context limits, and isolated child `CODEX_HOME`. Analysis, review, QA, Recruiter, and Maintainer roles are read-only. Registered implementation specialists use their declared workspace sandbox.

On POSIX, each specialist is a detached process-group leader. Every specialist receives a fixed one-hour execution timeout. If that hour expires, AITEAM sends `SIGTERM` to the whole process group and follows with `SIGKILL`, preventing descendant Codex processes from continuing to edit after a timeout. The MCP client's longer `tool_timeout_sec` is transport headroom and does not extend specialist execution beyond one hour.

## Structured evidence

Each stage returns one JSON object containing an outcome, summary, evidence, and stage-specific fields. PASS results without required evidence are rejected. Review cannot pass with BLOCKER/MAJOR findings. Planner tasks must use registered specialists and valid dependencies. QA must report executed checks and distinguish manual validation.

The server fingerprints each task's changed paths after implementation and again after QA. Any later change invalidates the approval and routes the task back to Implementation before review, QA, or integration can continue.

## Specialist recruitment

Architecture may identify capability gaps. The server routes each gap to Recruiter, hashes the successful run and proposal, and writes provenance with the generated specialist. Direct registration without a matching Recruiter proposal is rejected. Contracts must be substantive inline instructions, never paths to unrelated built-in contracts.

## Git integration

Maintainer inspects validated work read-only and proposes a commit message. The server gathers only paths recorded by implementation and approved by QA, builds a temporary index from `HEAD`, adds only those paths, commits that index, then synchronizes those paths in the real index. Unrelated staged or unstaged user work is preserved. `.aiteam/` and `.git/` paths are categorically rejected.
