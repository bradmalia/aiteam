# AITEAM

AITEAM is a server-governed engineering team for GitHub Copilot, Codex, and other MCP-capable coding environments on Windows, Linux, and macOS.

Invoke it from a Git repository with:

```text
Using AITEAM, I want to add ...
```

The primary Copilot or Codex conversation remains the user interface. The AITEAM MCP server owns workflow order, specialist routing, evidence gates, task state, and validated Git integration.

## Enforced workflow

```text
Intake -> PRD Review -> Architecture -> optional UI/UX Design -> Planning
       -> QA Test Planning -> Critical Review -> TRD Review
       -> Environment Readiness -> Implementation -> Code Review -> QA
       -> Integration -> Complete
```

`aiteam_advance` runs exactly the specialist required by the current server gate. Specialist results must be structured JSON. Invalid output, timeouts, nonzero exits, out-of-order agents, material review findings, and QA failures cannot advance the workflow.

Coordinator-facing `aiteam_start` and `aiteam_advance` results intentionally return compact structured content: the completed-stage summary and evidence, routing state, exact human questions, and required next action. Full specialist stdout/stderr, session evidence, and task context remain available through the Watch Dashboard, `.aiteam/runs`, and the explicit `aiteam_status` inspection tool instead of being duplicated into every coordinator turn.

After the human approves the TRD, Environment Readiness proves the required runtime, build, black-box testing, browser-startup, and file-writing capabilities. Verified paths and commands are stored in the session for later agents. A missing system-level tool pauses with exact installation and verification instructions, then is probed again after the user responds. Every implementation task must pass Code Review and QA. Failed review or QA returns that task to Implementation. `aiteam_complete` refuses completion until all tasks pass and server-controlled Git integration succeeds.

## Agent roster

- Analyst, Architect, Planner, QA Test Planner, Critical Reviewer, Environment Readiness Specialist
- Recruiter, Code Reviewer, QA, Maintainer
- Godot/GDScript, .NET/C#, Python, Java, Oracle PL/SQL, and SQL Server T-SQL programmers

Architect identifies genuine capability gaps. Recruiter proposes a complete inline specialist contract; the server verifies its provenance and registers it automatically. Coordinator-authored specialists and file-path contracts are rejected.

## Install

AITEAM has no npm runtime dependencies. Node.js 20+, Git, and GitHub Copilot CLI or Codex CLI are required.

### Windows 11 / PowerShell

Run from PowerShell:

```powershell
.\install.ps1
```

This installs `aiteam-mcp.cmd`, `aiteam-watch.cmd`, and PowerShell scripts into `~/.local/bin`.

### Linux / macOS

```bash
./install.sh
```

The installer creates `~/.local/bin/aiteam-mcp` and `~/.local/bin/aiteam-watch`. Add the delegation contract from `templates/AGENTS.aiteam.md` to the target project's `AGENTS.md`.

## GitHub Copilot Configuration

AITEAM auto-detects GitHub Copilot from session environment variables (`COPILOT_AGENT_SESSION_ID`, `COPILOT_CLI`, `COPILOT_LOADER_PID`), or when configured with `AITEAM_RUNNER=copilot`.

Add AITEAM to your Copilot MCP configuration (e.g. `~/.copilot/mcp-config.json` or VS Code MCP settings):

```json
{
  "mcpServers": {
    "aiteam": {
      "command": "C:\\Users\\YOUR_USER\\.local\\bin\\aiteam-mcp.cmd",
      "env": {
        "AITEAM_RUNNER": "copilot"
      }
    }
  }
}
```

On Linux/macOS:

```json
{
  "mcpServers": {
    "aiteam": {
      "command": "/home/YOUR_USER/.local/bin/aiteam-mcp",
      "env": {
        "AITEAM_RUNNER": "copilot"
      }
    }
  }
}
```

Copilot runner options can be customized via environment variables:
- `AITEAM_COPILOT_BIN`: Path or name of the Copilot CLI binary (default: `copilot`)
- `AITEAM_COPILOT_MODEL`: Override model passed to Copilot CLI via `--model`
- `AITEAM_COPILOT_REASONING_EFFORT`: Override reasoning effort passed via `--effort`

## Codex MCP configuration

```toml
[mcp_servers.aiteam]
command = "/home/YOUR_USER/.local/bin/aiteam-mcp"
env = { AITEAM_RUNNER = "codex" }
env_vars = [
  "AITEAM_RUNNER",
  "AITEAM_CODEX_BIN",
  "AITEAM_CODEX_PREFIX_ARGS_JSON",
  "AITEAM_CODEX_HOME",
  "AITEAM_CODEX_WRITABLE_SANDBOX",
  "AITEAM_CODEX_MODEL",
  "AITEAM_CODEX_REASONING_EFFORT",
  "AITEAM_CODEX_PROVIDER",
  "AITEAM_CODEX_PROVIDER_NAME",
  "AITEAM_CODEX_BASE_URL",
  "AITEAM_CODEX_WIRE_API",
  "AITEAM_CODEX_REQUIRES_OPENAI_AUTH",
  "AITEAM_CODEX_CONTEXT_WINDOW",
  "AITEAM_CODEX_AUTO_COMPACT_LIMIT",
  "AITEAM_COORDINATOR_READ_ONLY",
  "AITEAM_WATCH_PORT",
]
startup_timeout_sec = 10
tool_timeout_sec = 7200
```

Restart Codex after changing MCP configuration.

By default on Codex, AITEAM inherits the active parent Codex session's model, provider, reasoning effort, and Codex home on each specialist launch. Changing models in a long-running Codex session therefore changes subsequent AITEAM specialists too. Explicit `AITEAM_CODEX_MODEL` or `AITEAM_CODEX_PROVIDER` settings take precedence for intentionally pinned projects such as local V100 workflows. When parent-session discovery is unavailable, AITEAM omits model/provider overrides and lets the normal Codex configuration choose them.

Writable Codex specialists default to `danger-full-access` so implementation and QA can launch browsers and other project tooling that the `workspace-write` process sandbox may block. Read-only planning and review agents remain sandboxed. Set `AITEAM_CODEX_WRITABLE_SANDBOX=workspace-write` in the MCP server environment to restore the stricter writable sandbox.

For Agy, configure the same server with an explicit runner identity so host detection does not depend on stripped subprocess environment variables:

```bash
agy mcp add --env AITEAM_RUNNER=agy aiteam /home/YOUR_USER/.local/bin/aiteam-mcp
```

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
AITEAM | Agent: Architect (architect) | Phase: Architecture | Remaining: Planning -> QA Test Planning -> Critical Review -> TRD Review -> Environment Readiness -> Implementation -> Code Review -> QA -> Integration
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
