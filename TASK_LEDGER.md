# Task Ledger

## Milestone: Manual QA approval pages

Implement the human-approved PRD in `.aiteam/docs/prd.html` and the finalized TRD after its required human gate. Keep this instruction-first change cohesive: one task ships the guide, reusable page, agent-entry references and end-to-end Watcher handoff together. No production implementation begins before TRD approval.

### T1: Ship the manual QA approval-page workflow and reusable template

Create `skill/guides/manual-qa-approval-pages.md` and `skill/templates/manual-qa-review.html`. Update `skill/contracts/qa.md`, `skill/contracts/qa-planner.md`, `skill/SKILL.md` and `skill/templates/AGENTS.skill.md` to use the same procedure. Reuse Watcher discovery of top-level `.aiteam/docs/qa-<safe-task-id>.html` pages and existing screenshot routes; document verified loopback hosting for unsupported media/report formats. Include developer regression coverage under `test/` as appropriate. Independent QA owns dedicated black-box tests under `tests/qa/` and the actual review packet. This task includes final assembly: adapt the shipped template into a representative task page, verify the running Watcher opens it, and exercise the complete reviewer handoff without self-approving any live gate. Do not change the Watcher UI, session schema, approval API, gate order or fingerprint mechanism.

- [ ] AC-1: A new agent can follow the portable guide and reusable HTML template without the reference game repository; all four agent entry points consistently link the same preparation, validation and human-handoff procedure. (PRD-R1; PRD-A1)
- [ ] AC-2: A generated page identifies the task, reviewed revision/date and actual pending/decision state, lists acceptance criteria with expected observations, provides complete prerequisite/service startup/manual-action/cleanup instructions, and distinguishes actually executed tests/results from planned, failed, skipped or illustrative content. (PRD-R2–R5; PRD-A2–A4)
- [ ] AC-3: From a running Watcher the reviewer can open the intended task page through its existing document link; verified HTTP(S) page/media/report URLs serve the intended evidence, useful comparison/media controls work, and the page remains readable with usable keyboard controls at desktop and 390px widths without document overflow or browser page errors. (PRD-R6–R8; PRD-A5–A7)
- [ ] AC-4: The evidence page has no approval side effects or independent decision store; the coordinator opens the existing gate, invokes the existing active approval listener, processes real Watcher decisions, and records actual chat decisions verbatim before continuing server directives. Existing automated-QA requirements, automation-only bypass and human authority remain intact. (PRD-R9–R10; PRD-A9–A10)
- [ ] AC-5: The procedure verifies port/server identity and actual URLs before handoff and on resume, binds optional previews to loopback with packet-scoped roots, avoids secrets and unrelated-process termination, preserves original evidence, and calls for revalidation when reviewed artifacts materially change. (PRD-R4, R8, R10; PRD-A8, A10)
- [ ] AC-6: The shipped guide/template and references assemble into a real Watcher-linked review packet that demonstrates the required sections and honest evidence. Appropriate developer checks, `npm run check`, `npm test` and independently authored black-box QA under `tests/qa/` pass; existing artifact path restrictions, gate order, bypass behavior and fingerprint protections continue to pass regression checks. (PRD-R1, R7, R10; PRD-A1, A6, A10)

## Required order and ownership

Architecture → UI/UX Design → this task planning → independent QA Test Planning → Critical Review → human TRD approval → environment readiness → T1 implementation → independent code review → independent QA execution → actual human QA decision where required → maintainer integration.

The QA Planner will append the approved black-box test plan to the TRD before Critical Review. The independent QA specialist executes that plan later and authors `tests/qa/` coverage. Task acceptance checkboxes remain unchecked until observable evidence exists; planning, PRD approval and template examples are not QA approval.
