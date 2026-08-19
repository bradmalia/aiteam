# AITEAM Workflow Contract

## Lifecycle

The server enforces:

```text
Intake -> Architecture -> [Recruiting] -> Planning -> Critical Review
       -> Implementation(task) -> Code Review(task) -> QA(task)
       -> next task or Integration -> Ready to Complete -> Complete
```

Recruiting is an Architecture subphase and appears only for a genuine missing capability.

## Gates

- **Intake:** non-empty requirements and acceptance criteria.
- **Intake interaction:** the Analyst owns the user conversation. `AWAITING_USER` is a valid Intake result when clarification is required; the server records the questions and keeps the gate open. The user response is persisted through `aiteam_update_session`, then the Analyst must run again and return `PASS` with `userConfirmed: true` and no remaining questions.
- **Architecture:** non-empty design and explicit specialist-gap list.
- **Recruiting:** successful Recruiter JSON with a substantive inline contract and recorded provenance.
- **Planning:** unique tasks, valid dependencies, acceptance criteria, and registered specialist IDs.
- **Critical Review:** initial comprehensive review. BLOCKER/MAJOR findings route to Architecture or Planning and become locked repair findings.
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
