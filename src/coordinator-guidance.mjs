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
          : `Session stage was rejected or blocked: "${session.blockedReason || 'Specialist validation failure'}". Do NOT report this as an unrecoverable blocker. Call aiteam_advance immediately to retry this stage.`
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
        ? 'STOP CALLING TOOLS. You MUST paste the QA manual checks into chat for the real user to physically perform. Do NOT approve them yourself, infer pass from the code, or fabricate a confirmation. Wait for the user\'s actual reply, then call aiteam_update_session with their exact response before advancing to Integration.'
        : 'STOP CALLING TOOLS AND DO NOT EXPLORE THE CODEBASE. You are the Facilitator. Present these exact questions directly to the human user in your chat response and wait. DO NOT read or explore repository files to answer them yourself, and DO NOT guess user intent. Only after the user replies in chat, submit their exact words via aiteam_update_session and immediately loop aiteam_advance.')
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
    '# 🛑 CRITICAL FACILITATOR BOUNDARY RULES',
    '1. YOU ARE STRICTLY A MESSAGE FACILITATOR AND GATE DISPATCHER. DO NOT STEP IN TO WRITE CODE.',
    '2. You are PROHIBITED from directly editing, creating, or deleting project files (via replace_file_content, write_to_file, bash, etc.).',
    '3. You are PROHIBITED from directly writing tests, fixing bugs, or executing regression test suites outside of spawned specialists.',
    '4. ALL implementation, code review, QA testing, and git operations MUST be performed exclusively by spawned specialists via aiteam_advance.',
    '5. If a specialist fails, encounters an error, or times out, DO NOT write the fix yourself. Simply call aiteam_advance again to let the workflow engine route the rework to the appropriate specialist.',
    '6. TIMEOUT HANDLING: Complex engine builds and smoke test suites (e.g. Godot, Unity, TypeScript full suites) may take several minutes to compile and execute. Always allow aiteam_advance to run up to 3600 seconds (1 hour). NEVER cancel or assume the server has hung while a specialist tool call is in progress.',
    '',
    '# 🔄 BOUNCE-BACK LOOP DETECTION & SELF-HEALING POLICY',
    '1. Loop Detection: If any task undergoes >= 2 rework cycles between Implementation <-> Code Review or Implementation <-> QA without passing:',
    '   a) Inspect the last 2 rejection logs to diagnose the exact root cause (e.g. vague reviewer guidance, scope ambiguity, or missing formula).',
    '   b) Synthesize the concrete algorithmic solution or mathematical formula required.',
    '   c) Supply this exact guidance in the `context` argument of `aiteam_advance({ context: "..." })` so the next specialist implements it on the first attempt.',
    '   d) If the bounce-back was caused by an ambiguous prompt or framework contract in AITEAM, patch `aiteam/agents/*.md` immediately and COMMIT the changes to Git (`git add <files> && git commit -m "fix(aiteam): ..."`) to persist the self-healing improvements across future sessions.',
    '',
    '# REQUIRED USER-VISIBLE PHASE REPORTING',
    'Declare and persist an ordered phase plan for this request. A normal plan is: Intake -> Architecture -> Planning -> Critical Review -> Implementation -> Code Review -> QA -> Integration.',
    '1. Cadence & Format: Provide detailed, rich minute-by-minute status updates. DO NOT just output generic titles. Inspect the specialist\'s actual output, evidence, and changed files to describe specifically what code was written or what tests executed:',
    '   ### ⏱️ Minute X Update (<Local Time>) — <Specific Headline of Progress>',
    '   * **Current Stage / Task:** <stage> (<task id/title>)',
    '   * **Active Specialist:** <role> (<agentId>)',
    '   * **What\'s Happening:**',
    '     - Exact file paths modified or inspected (e.g. `src/game/game.js`, `scripts/ambient/lake_fish.gd`)',
    '     - Concrete code logic changes (e.g. "clamping math adjusted to `minY + (offset + 1) * (maxY - minY) / 2`")',
    '     - Test suite results and assertion counts (e.g. "All 221 Unit 7 assertions passed")',
    '     - Reviewer or QA findings (mentioning exact outcome: PASS/FAIL and why)',
    '   * **Next Action:** <Upcoming phase, specialist, or manual verification checkpoint>',
    '2. Immediately before every aiteam_advance call, use the assignment in the latest AITEAM response and tell the user exactly:',
    'AITEAM | Agent: <role> (<agent_id>) | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
    '3. Immediately after the synchronous call returns, tell the user exactly:',
    'AITEAM | Agent: <role> (<agent_id>) <finished|failed> | Phase: <current phase> | Remaining: <ordered phases after this phase, or none>',
    '4. If the workflow plan changes, show the revised remaining phases. Never leave the user guessing which agent or phase is active.'
  ].join('\n');
}
