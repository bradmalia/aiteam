# AITEAM

AITEAM is an agentic engineering team that is invoked from a coding IDE such as Codex.

The intended interaction is:

```text
Using AITEAM, I want to add ...
```

Codex remains the user interface. AITEAM provides the engineering-team contracts, state, specialist registry, and agent runner through MCP.

## Design principle

AITEAM deliberately keeps the runtime small:

> If a decision requires understanding what the task means, an agent makes the decision. If it only involves safely executing the decision, the runtime handles it.

The runtime therefore handles process execution, state persistence, repository boundaries, timeouts, and MCP transport. It does **not** contain a hard-coded Analyst -> Architect -> Planner -> QA state machine.

## Initial agent roster

- Coordinator
- Analyst
- Architect
- Planner
- Critical Reviewer
- Recruiter
- Code Reviewer
- QA
- Maintainer
- Godot / GDScript Programmer
- .NET / C# Programmer
- Python Programmer
- Java Programmer
- Oracle PL/SQL Programmer
- SQL Server T-SQL Programmer

Architect must reuse an existing specialist when one fits. Recruiter is used only for a real capability gap.

## Install

AITEAM has no npm runtime dependencies. Node.js 20+ and Codex CLI are required.

```bash
./install.sh
```

The installer creates a symlink at `~/.local/bin/aiteam-mcp` and prints the Codex MCP configuration to add to `~/.codex/config.toml`.

Then add the AITEAM delegation contract to the project's `AGENTS.md`. A ready-to-copy template is in:

```text
templates/AGENTS.aiteam.md
```

## Codex MCP configuration

```toml
[mcp_servers.aiteam]
command = "/home/YOUR_USER/.local/bin/aiteam-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 3600
```

Restart Codex after adding the MCP server.

## Usage

From a repository:

```bash
codex
```

Then:

```text
Using AITEAM, I want to create a human-vs-computer Pong game with keyboard and gamepad support.
```

The primary Codex session acts as AITEAM Coordinator after calling the `aiteam_start` MCP tool. It may delegate focused work to specialist agents with `aiteam_spawn_agent`.

## Project state

AITEAM stores transient workflow state in the target repository under:

```text
.aiteam/
  session.json
  events.jsonl
  runs/
```

`.aiteam/` should normally be ignored by the target repository. Durable engineering artifacts should be written into the project itself when appropriate.

## Source repository

This distribution is itself a Git repository. Continue development by cloning/copying it locally and committing changes normally.

See `docs/ARCHITECTURE.md` and `docs/WORKFLOW.md` for the design.
