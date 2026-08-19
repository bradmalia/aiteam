# AITEAM

AITEAM is a server-governed engineering team for Codex and other MCP-capable coding IDEs.

Invoke it from a Git repository with:

```text
Using AITEAM, I want to add ...
```

The primary Codex conversation remains the user interface. The AITEAM MCP server owns workflow order, specialist routing, evidence gates, task state, and validated Git integration.

## Enforced workflow

```text
Intake -> Architecture -> Planning -> Critical Review
       -> Implementation -> Code Review -> QA -> Integration -> Complete
```

`aiteam_advance` runs exactly the specialist required by the current server gate. Specialist results must be structured JSON. Invalid output, timeouts, nonzero exits, out-of-order agents, material review findings, and QA failures cannot advance the workflow.

Every implementation task must pass Code Review and QA. Failed review or QA returns that task to Implementation. `aiteam_complete` refuses completion until all tasks pass and server-controlled Git integration succeeds.

## Agent roster

- Analyst, Architect, Planner, Critical Reviewer
- Recruiter, Code Reviewer, QA, Maintainer
- Godot/GDScript, .NET/C#, Python, Java, Oracle PL/SQL, and SQL Server T-SQL programmers

Architect identifies genuine capability gaps. Recruiter proposes a complete inline specialist contract; the server verifies its provenance and registers it automatically. Coordinator-authored specialists and file-path contracts are rejected.

## Install

AITEAM has no npm runtime dependencies. Node.js 20+, Git, and Codex CLI are required.

```bash
./install.sh
```

The installer creates `~/.local/bin/aiteam-mcp`. Add the delegation contract from `templates/AGENTS.aiteam.md` to the target project's `AGENTS.md`.

## Codex MCP configuration

```toml
[mcp_servers.aiteam]
command = "/home/YOUR_USER/.local/bin/aiteam-mcp"
env_vars = [
  "AITEAM_CODEX_BIN",
  "AITEAM_CODEX_PREFIX_ARGS_JSON",
  "AITEAM_CODEX_HOME",
  "AITEAM_CODEX_MODEL",
  "AITEAM_CODEX_PROVIDER",
  "AITEAM_CODEX_PROVIDER_NAME",
  "AITEAM_CODEX_BASE_URL",
  "AITEAM_CODEX_WIRE_API",
  "AITEAM_CODEX_REQUIRES_OPENAI_AUTH",
  "AITEAM_CODEX_CONTEXT_WINDOW",
  "AITEAM_CODEX_AUTO_COMPACT_LIMIT",
  "AITEAM_COORDINATOR_READ_ONLY",
]
startup_timeout_sec = 10
tool_timeout_sec = 7200
```

Restart Codex after changing MCP configuration.

## Local Qwen on v100-ai

Use the dedicated mode:

```bash
v100-ai --aiteam /path/to/repository
```

This pins the compatible Codex version and local model, gives specialist subprocesses an isolated `CODEX_HOME`, and launches the primary Coordinator with a read-only sandbox and `approval_policy="never"`. Implementation specialists receive only their registered task sandbox. The AITEAM server—not the primary Qwen session or Maintainer—performs validated-path Git commits.

Without `--aiteam`, the server still enforces MCP workflow gates but cannot stop the primary model from using unrelated direct-write tools.

## User-visible progress

Before and after each synchronous specialist call, Coordinator reports:

```text
AITEAM | Agent: Architect (architect) | Phase: Architecture | Remaining: Planning -> Critical Review -> Implementation -> Code Review -> QA -> Integration
```

AITEAM has no background scheduler. `aiteam_start` synchronously runs the first required specialist (Analyst by default), while `aiteam_status` only reads state and must not be polled for progress.

Intake is owned by the Analyst. The Analyst may return `AWAITING_USER` with clarification questions; the server keeps the workflow in Intake until the user response is recorded with `aiteam_update_session` and the Analyst returns a user-confirmed requirements artifact. Architecture cannot run against an unconfirmed request.

## Protected state

Human-readable run data is written under `.aiteam/`, which the server automatically adds to `.git/info/exclude`:

```text
.aiteam/
  session.json
  events.jsonl
  specialists/
  runs/
```

Authoritative session, event, and specialist state is mirrored under Git metadata at `.git/aiteam/`. Deleting the workspace copy therefore does not erase the active workflow. `.aiteam/` is never an integration candidate.

## Main MCP tools

- `aiteam_start`: create a governed session and run the first required specialist
- `aiteam_status`: inspect the current gate without advancing
- `aiteam_advance`: execute and validate one required specialist stage
- `aiteam_complete`: complete only after all gates pass
- `aiteam_cancel`: cancel the active session

`aiteam_spawn_agent` remains a compatibility alias but rejects any agent not required by the current stage. `aiteam_update_session` accepts notes and pending user input only.

See `docs/ARCHITECTURE.md` and `docs/WORKFLOW.md` for details.
