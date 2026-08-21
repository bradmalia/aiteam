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
    const isImplFail = (session.blockedReason || '').includes('Implementation specialist returned FAIL') ||
      (session.blockedReason || '').includes('did not write files');
    return {
      autonomous: false,
      userProgressReporting: { required: true },
      requiredNextAction: {
        tool: 'aiteam_advance',
        recommendedAgentId: null,
        instruction: isImplFail
          ? `Implementation specialist did not call exec tools to write files — this is NOT a sandbox restriction. ` +
            `Do NOT paste code in chat, output the file contents, or tell the user to save files manually. ` +
            `Call aiteam_advance immediately to re-spawn the specialist; it will write the files this time.`
          : `Session was blocked: "${session.blockedReason || 'Specialist blocked'}". Call aiteam_advance to retry this stage with the updated specialist directives.`
      },
      prohibitedActions: [
        'aiteam_cancel',
        'wait_for_background_progress',
        'poll_status_for_progress',
        ...(isImplFail ? ['paste_code_in_chat', 'claim_sandbox_restriction', 'tell_user_to_save_files_manually'] : [])
      ]
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
    const qaManual = session.pendingUserInput.kind === 'qa-manual';
    const intakeQuestions = !qaManual && session.pendingUserInput.questions;
    return {
      autonomous: false,
      userProgressReporting: { required: true },
      requiredNextAction: {
        tool: 'aiteam_update_session',
        recommendedAgentId: qaManual ? null : 'analyst',
        instruction: qaManual
          ? `STOP. You MUST paste these exact QA manual checks into chat for the real user to perform physically. Do NOT mark them as passed yourself, do NOT fabricate results, do NOT infer they pass from the code. Wait for the user to actually run the checks and reply with their findings. Only after the user confirms in chat may you call aiteam_update_session with their exact response. The checks are: ${JSON.stringify(session.pendingUserInput?.questions)}.`
          : `STOP. You must show these questions to the USER in chat and wait for their reply. DO NOT answer the questions yourself, guess, or invent answers. The questions are: ${JSON.stringify(intakeQuestions)}. Only after the real user has responded may you call aiteam_update_session with their actual answers.`
      },
      prohibitedActions: [
        'advance_without_user_response',
        'auto_confirm_manual_qa',
        'fabricate_user_qa_confirmation',
        'implement_specialist_work_in_the_coordinator',
        ...(qaManual ? [
          'self_approve_qa_checks',
          'infer_qa_pass_from_code',
          'fabricate_qa_confirmation',
          'mark_checks_passed_without_user'
        ] : [
          'skip_intake_confirmation',
          'answer_intake_questions_yourself',
          'guess_user_preferences',
          'invent_user_responses',
          'proceed_without_showing_questions_to_user'
        ])
      ]
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
  const isImplFail = session.status === 'BLOCKED' &&
    ((session.blockedReason || '').includes('Implementation specialist returned FAIL') ||
     (session.blockedReason || '').includes('did not write files'));
  const continuation = directive.requiredNextAction.tool === 'aiteam_complete'
    ? 'All enforced gates have passed. Do not run another specialist; call aiteam_complete.'
    : directive.requiredNextAction.tool === 'aiteam_update_session'
      ? (session.pendingUserInput?.kind === 'qa-manual'
        ? 'STOP. You MUST paste the QA manual checks into chat for the real user to physically perform. Do NOT approve them yourself, infer pass from the code, or fabricate a confirmation. Wait for the user\'s actual reply, then call aiteam_update_session with their exact response before advancing to Integration.'
        : 'STOP. You MUST show these exact questions to the user in your chat response and then wait — do NOT answer them yourself or call aiteam_update_session until the real user has replied. Never guess, infer, or invent the user\'s answers. Only after the user responds in chat may you call aiteam_update_session with their actual words, then aiteam_advance.')
    : isImplFail
      ? 'CRITICAL: The implementation specialist returned FAIL without calling exec_command or bash to write files. This is NOT a real sandbox restriction — the specialist has full workspace-write access. Do NOT output code in chat, do NOT tell the user to copy-paste or save files manually. Call aiteam_advance immediately to retry. The specialist will write the files to disk on the next invocation.'
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
