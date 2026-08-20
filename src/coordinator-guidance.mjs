export function coordinatorDirective(session = null) {
  if (!session) {
    return {
      autonomous: false,
      sessionExists: false,
      userProgressReporting: { required: false },
      requiredNextAction: null,
      prohibitedActions: ['invent_session_state', 'claim_agent_is_running']
    };
  }
  if (session.status === 'READY_TO_COMPLETE') {
    return {
      autonomous: false,
      userProgressReporting: { required: true },
      requiredNextAction: {
        tool: 'aiteam_complete',
        recommendedAgentId: null,
        instruction: 'Call aiteam_complete now; the server has verified all required gates.'
      },
      prohibitedActions: ['run_more_specialists', 'implement_specialist_work_in_the_coordinator']
    };
  }
  if (session.status === 'BLOCKED') {
    return {
      autonomous: false,
      userProgressReporting: { required: true },
      requiredNextAction: {
        tool: 'aiteam_advance',
        recommendedAgentId: null,
        instruction: `Session was blocked: "${session.blockedReason || 'Specialist blocked'}". Call aiteam_advance to retry this stage with the updated specialist directives.`
      },
      prohibitedActions: ['aiteam_cancel', 'wait_for_background_progress', 'poll_status_for_progress']
    };
  }
  if (session.status !== 'ACTIVE') {
    return {
      autonomous: false,
      requiredNextAction: null,
      prohibitedActions: ['wait_for_background_progress', 'poll_status_for_progress']
    };
  }

  if (session.pendingUserInput?.questions?.length && session.pendingUserInput.response == null) {
    return {
      autonomous: false,
      userProgressReporting: { required: true },
      requiredNextAction: {
        tool: 'aiteam_update_session',
        recommendedAgentId: 'analyst',
        instruction: 'Ask the user the pending Analyst questions, then call aiteam_update_session with pendingUserInput containing the user response. Do not advance to Architecture.'
      },
      prohibitedActions: ['advance_without_user_response', 'implement_specialist_work_in_the_coordinator', 'skip_intake_confirmation']
    };
  }

  return {
    autonomous: false,
    userProgressReporting: {
      required: true,
      beforeEveryAdvance: 'AITEAM | Agent: <role> (<agent_id>) | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
      afterEveryResult: 'AITEAM | Agent: <role> (<agent_id>) <finished|failed> | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
      rules: [
        'Declare and persist the ordered phase plan at session start.',
        'Emit the beforeEverySpawn line immediately before every aiteam_advance call.',
        'Emit the afterEveryResult line immediately after every aiteam_advance result.',
        'Never say an agent is running after its synchronous advance call has returned.',
        'When the plan changes, report the revised ordered remaining phases.'
      ]
    },
    requiredNextAction: {
      tool: 'aiteam_advance',
      recommendedAgentId: session.currentStage === 'intake' ? 'analyst' : null,
      instruction: 'Call aiteam_advance now. The server selects the required specialist and refuses out-of-order or ungated work.'
    },
    prohibitedActions: [
      'wait_for_background_progress',
      'sleep_then_poll',
      'poll_status_for_progress',
      'cancel_active_session_without_user_request',
      'claim_sandbox_restriction_excuses',
      'implement_specialist_work_in_the_coordinator'
    ]
  };
}

export function coordinatorDirectiveText(session = null, { source = 'start' } = {}) {
  const directive = coordinatorDirective(session);
  if (!session || session.status === 'CANCELLED' || session.status === 'COMPLETE') {
    const statusNote = session ? `The previous session (${session.id.slice(0, 8)}) was ${session.status}.` : 'No session exists.';
    return [
      '# NO ACTIVE AITEAM SESSION',
      `${statusNote} To start a new AITEAM workflow, call aiteam_start with the user's request.`,
      'Do not call aiteam_status or claim an agent is running until aiteam_start creates an ACTIVE session.'
    ].join('\n');
  }

  const recommendation = directive.requiredNextAction.recommendedAgentId
    ? ` For the current stage, start with agent_id \"${directive.requiredNextAction.recommendedAgentId}\".`
    : '';

  const sourceWarning = source === 'status'
    ? 'This status snapshot does not advance the workflow and is not evidence of background processing.'
    : 'Starting a session runs the first required specialist synchronously; no specialists are processing in parallel.';
  const continuation = directive.requiredNextAction.tool === 'aiteam_complete'
    ? 'All enforced gates have passed. Do not run another specialist; call aiteam_complete.'
    : directive.requiredNextAction.tool === 'aiteam_update_session'
      ? 'Ask the user the listed Analyst questions, persist the response with aiteam_update_session, and only then call aiteam_advance for Analyst. Architecture is forbidden until Intake is confirmed.'
    : 'When the synchronous tool call returns, report its result and call aiteam_advance again until the server reports READY_TO_COMPLETE, then call aiteam_complete.';

  return [
    '# REQUIRED NEXT ACTION — AITEAM is not autonomous',
    `AITEAM has no background scheduler or autonomous worker loop. ${sourceWarning}`,
    'Do not wait, sleep, repeatedly poll aiteam_status, or implement specialist work yourself while claiming AITEAM is running.',
    `Immediately call ${directive.requiredNextAction.tool}.${recommendation}`,
    'The AITEAM server owns phase order, specialist selection, task gates, and completion eligibility. Do not bypass a rejected or failed gate with direct implementation.',
    continuation,
    'Only report that a specialist is working while an AITEAM tool call is actually running or an agent_started event exists.',
    '',
    '# REQUIRED USER-VISIBLE PHASE REPORTING',
    'Declare and persist an ordered phase plan for this request. A normal plan is: Intake -> Architecture -> Planning -> Critical Review -> Implementation -> Code Review -> QA -> Integration.',
    'Immediately before every aiteam_advance call, use the assignment in the latest AITEAM response and tell the user exactly:',
    'AITEAM | Agent: <role> (<agent_id>) | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
    'Immediately after the synchronous call returns, tell the user exactly:',
    'AITEAM | Agent: <role> (<agent_id>) <finished|failed> | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
    'If the workflow plan changes, show the revised remaining phases. Never leave the user guessing which agent or phase is active.'
  ].join('\n');
}
