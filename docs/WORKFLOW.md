# AITEAM Workflow Contract

## Lifecycle

The server enforces:

```text
Intake -> Architecture -> [Recruiting] -> Planning -> Critical Review
       -> Implementation(task) -> Code Review(task) -> QA(task)
       -> next task or Integration -> Ready to Complete -> Complete
```

Recruiting is an Architecture subphase and appears only for a genuine missing capability.
Two human approval gates are server-owned pseudo-stages:

```text
Intake -> PRD Review -> Architecture -> ... -> Critical Review -> TRD Review -> Implementation
```

## Gates

- **Intake:** user-confirmed goals, target users, user stories, functional requirements, acceptance criteria, MVP scope, out-of-scope boundaries, assumptions, constraints, non-functional requirements, success metrics, risks, and any remaining clarification questions.
- **Intake interaction:** the Analyst owns the user conversation. `AWAITING_USER` is a valid Intake result when clarification is required; the server records the questions and keeps the gate open. The user response is persisted through `aiteam_update_session`, then the Analyst must run again and return `PASS` with `userConfirmed: true` and no remaining questions.
- **PRD Review:** after Intake passes, the server generates `.aiteam/docs/prd.html`, exposes it through the Watch server as `/artifacts/prd.html`, and blocks until the human approves or requests changes. Requested changes route back to Intake.
- **Architecture:** structured, repository-grounded artifact with design overview, context, constraints, quality attribute scenarios, solution strategy, building blocks, runtime scenarios, deployment view, cross-cutting concepts, decisions/tradeoffs, risks, UI routing, and explicit specialist-gap list.
- **UI/UX Design:** user flows, usability risks, accessibility heuristics, validation hypotheses, visual theme, screens, interaction states, and design tokens when Architecture declares a user interface.
- **Recruiting:** successful Recruiter JSON with gap justification, existing-specialist assessment, evaluation criteria, a substantive inline contract, and recorded provenance.
- **Planning:** unique tasks, valid dependencies, acceptance criteria, registered specialist IDs, and black-box test plans derived from Intake requirements plus relevant Architecture runtime scenarios, Architecture quality attributes, and UI/UX validation hypotheses.
- **Critical Review:** initial comprehensive review. BLOCKER/MAJOR findings route to Architecture or Planning and become locked repair findings.
- **TRD Review:** after Critical Review passes, the server generates `.aiteam/docs/trd.html`, exposes it through the Watch server as `/artifacts/trd.html`, and blocks until the human approves or requests changes. The TRD includes architecture, UI/UX mockups when available, implementation tasks, and the black-box testing plan. Requested changes route back to Planning.

## Document Ownership

The server writes the PRD/TRD HTML files. Analyst owns PRD source content. Architect, UI/UX Designer, Planner, and Critical Reviewer own TRD source content. All PRD/TRD source material must use clear, simple language: avoid jargon and buzzwords when a simpler term works, and define necessary technical terms. The intended reader is a high school graduate with a strong computer science background. After approval, PRD and TRD become source-of-truth references for implementation, code review, QA, and integration.

The PRD must explain the problem, users, goals, success metrics, requirements, acceptance criteria, assumptions, out-of-scope boundaries, risks, and open questions. The TRD must explain the system boundary, building blocks, interfaces, data/state, dependencies, run/deploy/back-out path, security/privacy considerations, implementation tasks, test plan, traceability, risks, and open questions.
- **Implementation:** repository changes, exact changed paths, and observed validation results for one task.
- **Code Review:** no BLOCKER or MAJOR finding.
- **QA:** executed checks pass; any human-only checks are listed separately.
- **Integration:** read-only Maintainer approval followed by a server-owned commit of QA-approved paths.
- **Complete:** every task is `qa-passed` and integration has a resulting Git `HEAD`.

Failed Code Review or QA sets the current task to `needs-rework` and returns it to its assigned implementation specialist. Invalid JSON, a nonzero process exit, or a timeout records failure without advancing the stage.

## Coordinator behavior

Coordinator reports the exact agent, phase, and remaining phases before and after every call. Coordinator repeatedly calls `aiteam_advance`; it does not decide the next role. It calls `aiteam_complete` only when instructed by a `READY_TO_COMPLETE` response.

`aiteam_start` performs the first required advance synchronously so the coordinator cannot stop after merely creating a session. Subsequent stages use `aiteam_advance` and remain server-gated. `aiteam_start({auto_advance:false})` is reserved for tests and compatibility tooling.

Status reads never advance work. Direct session patches cannot alter workflow authority. Out-of-order `aiteam_spawn_agent` calls are rejected.

## Human validation

QA may return `PASS_WITH_MANUAL_VALIDATION` when machine-verifiable checks pass but honest visual, auditory, hardware, or usability judgment remains. Coordinator reports those checks to the user; their existence is not misclassified as a programmer defect.
