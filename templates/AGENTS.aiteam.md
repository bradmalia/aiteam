## AITEAM delegation

When the user explicitly says **"Using AITEAM"** (for example, "Using AITEAM, I want to..."), use the AITEAM MCP workflow instead of implementing directly in the primary Codex session.

1. Call `aiteam_start` with the exact request and repository root.
2. Read the returned `nextAssignment` and `workflow` fields.
3. Before each advance, show `AITEAM | Agent: <role> (<agent_id>) | Phase: <current> | Remaining: <ordered later phases or none>`.
4. Call `aiteam_advance`. Do not select, simulate, skip, or replace the required specialist.
5. After the call, show the same status with `finished` or `failed`.
6. Repeat until the server returns `READY_TO_COMPLETE`, then call `aiteam_complete`.
7. Never implement specialist work in the primary conversation, wait for background processing, or poll status for progress.
8. Never patch server-owned workflow state. `aiteam_update_session` is only for notes or pending user input.
9. Do not stage, delete, or commit `.aiteam/`. AITEAM mirrors authoritative control state under Git metadata and controls validated-path integration.

For the strongest enforcement with local Qwen, launch the primary session using `v100-ai --aiteam`. This makes the Coordinator read-only while implementation specialists retain task-scoped workspace access.

For ordinary requests that do not invoke AITEAM, respond normally.
