# AITEAM Architecture

## Goal

AITEAM is a team of cooperating engineering agents invoked from Codex or another MCP-capable coding IDE.

The IDE is the user interface. AITEAM is the engineering organization behind the request.

## Boundary

The runtime may make mechanical decisions only:

- validate repository paths
- start subprocesses
- enforce timeouts
- persist state and transcripts
- report process failure
- expose MCP tools
- inspect basic Git metadata

The runtime must not make semantic workflow decisions such as:

- whether a QA finding is really a defect
- whether a design concern is material
- whether a framework claim is credible
- which implementation approach is architecturally best
- whether a task should be split differently

Those decisions belong to agents.

## Primary interaction

```text
User -> Codex -> AITEAM MCP -> focused specialist Codex agents
```

The primary Codex session becomes the Coordinator for the active AITEAM request. The Coordinator invokes specialist agents through `aiteam_spawn_agent` and records decisions with AITEAM state tools.

## Agent execution

`aiteam_spawn_agent` launches a non-interactive Codex subprocess in the target repository. The runtime combines:

1. base agent contract
2. role contract
3. task/context supplied by Coordinator
4. repository path

The agent's stdout/stderr and metadata are preserved under `.aiteam/runs/`.

## Git

AITEAM source is a Git repository.

For target repositories, Maintainer owns commits to the validated baseline. Other agents may modify the working tree when their sandbox permits, but they must not represent unvalidated code as integrated.

Maintainer may resolve merge conflicts when safe. If a conflict is ambiguous, it returns the issue to the appropriate Programmer. Any code change after QA invalidates the earlier QA approval and requires Code Review + QA again.
