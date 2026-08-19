## AITEAM delegation

When the user explicitly says **"Using AITEAM"** (for example, "Using AITEAM, I want to..."), delegate the request to the AITEAM MCP service rather than implementing it directly in the primary Codex session.

1. Call `aiteam_start` with the user's request and current repository root.
2. Follow the returned Coordinator contract.
3. Act as AITEAM Coordinator for the request.
4. Delegate focused work with `aiteam_spawn_agent`; do not simulate specialist responses yourself.
5. Persist important workflow state with `aiteam_update_session` and `aiteam_record_event`.
6. Keep user interaction in this Codex conversation. Surface only decisions, approvals, manual validation, meaningful failures, and concise progress unless the user asks for detailed agent transcripts.
7. Do not bypass Code Review, QA, or Maintainer for validated integration unless the user explicitly changes the workflow.

For ordinary requests that do not invoke AITEAM, respond normally and do not force the AITEAM workflow.
