# AITEAM Workflow Contract

This document describes the default engineering behavior. It is guidance for Coordinator, not a hard-coded runtime state machine.

## Planning

Coordinator normally delegates to Analyst, Architect, Planner, and QA before implementation.

Architect prefers small vertical slices that produce a runnable result. Architect checks the specialist registry first and calls Recruiter only when there is a genuine capability gap.

## Critical Review

The first Critical Reviewer invocation is comprehensive.

That initial pass creates the authoritative material finding set. The finding set is then locked.

Subsequent Critical Reviewer invocations are repair verification only:

- RESOLVED
- PERSISTING

The Reviewer must not reopen unchanged design areas or create unrelated new findings after the comprehensive pass. Repair verification may repeat as many times as needed.

## Implementation

Programmer implements one task/vertical slice at a time.

Code Reviewer reviews the current task diff and current-task dependencies. BLOCKER and MAJOR findings cause rework. Minor findings are recorded but do not block. Future-task findings do not block the current task.

Claims about frameworks, APIs, or version-specific behavior should be verified against authoritative/version-matched sources or deterministic runtime evidence before they block implementation.

## QA

QA validates machine-verifiable behavior and identifies checks that genuinely require human observation.

Human-only checks do not become Programmer defects merely because they remain unverified. Coordinator routes them to the user after automated QA has otherwise passed.

## Human validation

Codex presents concise manual checks in the same conversation. User feedback is returned to Coordinator, which decides which agent should handle it.

## Maintainer

Maintainer integrates only validated work. If Maintainer changes code while resolving a conflict, prior QA is invalidated and the changed result must pass Code Review and QA again.
