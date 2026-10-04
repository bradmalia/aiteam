#!/usr/bin/env python3
"""
AITeam FastMCP Server for Qwen Code
Uses standard FastMCP to guarantee 100% protocol and connection stability with Qwen Code.
Under the hood, delegates to the node state-bridge and mcp-server logic.
"""
import sys
import json
import subprocess
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("aiteam")

NODE_MCP = "/home/brad/aiteam/src/mcp-server.mjs"

def call_node(tool_name: str, args: dict) -> str:
    script = f"""
    import('{NODE_MCP}').then(async ({{ handleToolCall }}) => {{
        try {{
            const res = await handleToolCall('{tool_name}', {json.dumps(args)});
            const text = (res.content || []).map(c => c.text).join('\\n');
            console.log(text);
        }} catch (err) {{
            console.error('ERROR: ' + err.message);
            process.exit(1);
        }}
    }});
    """
    proc = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True)
    if proc.returncode != 0:
        return f"Error: {proc.stderr.strip() or proc.stdout.strip()}"
    return proc.stdout.strip()

@mcp.tool()
def aiteam_start(request: str, repository: str = "") -> str:
    """Initialize an AITeam workflow in the repository, launch the live Watcher dashboard, and enter Stage 1 (Intake)."""
    return call_node("aiteam_start", {"request": request, "repository": repository})

@mcp.tool()
def aiteam_status(repository: str = "") -> str:
    """Get current AITeam workflow status, active gates, active task, and watcher URL."""
    return call_node("aiteam_status", {"repository": repository})

@mcp.tool()
def aiteam_advance(
    stage: str = "",
    action: str = "complete",
    outcome: str = "PASS",
    summary: str = "",
    taskId: str = "",
    ledger: str = "",
    repository: str = ""
) -> str:
    """Transition the workflow gate, report stage/task completion, and receive prescriptive instructions for the next required action."""
    args = {
        "stage": stage,
        "action": action,
        "outcome": outcome,
        "summary": summary,
        "taskId": taskId,
        "ledger": ledger,
        "repository": repository
    }
    return call_node("aiteam_advance", args)

@mcp.tool()
def aiteam_record_approval(gate: str, decision: str, taskId: str = "", response: str = "", repository: str = "") -> str:
    """Record human approval or change requests for PRD, TRD, or per-task QA gates."""
    return call_node("aiteam_record_approval", {
        "gate": gate,
        "decision": decision,
        "taskId": taskId,
        "response": response,
        "repository": repository
    })

if __name__ == "__main__":
    mcp.run()
