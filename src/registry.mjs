import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedStateDir, stateDir } from './state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_ROOT = path.resolve(HERE, '..');

function builtInRegistry() {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'agents', 'registry.json'), 'utf8'));
}

function globalSpecialistDir() {
  if (process.env.AITEAM_GLOBAL_SPECIALIST_DIR) {
    return process.env.AITEAM_GLOBAL_SPECIALIST_DIR;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '/home/brad';
  return path.join(home, '.aiteam', 'specialists');
}

function scopedSpecialistDir(repo) {
  return path.join(stateDir(repo), 'specialists');
}

function protectedSpecialistDir(repo) {
  return path.join(protectedStateDir(repo), 'specialists');
}

function validateId(id) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id || '')) {
    throw new Error('Specialist id must be 2-64 lowercase letters, numbers, or hyphens and start with a letter.');
  }
  return id;
}

function stringList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('Specialist triggers and capabilities must be arrays of non-empty strings.');
  }
  return value.map((item) => item.trim());
}

function normalizeSpecialist(input) {
  const id = validateId(input?.id);
  const role = String(input?.role || '').trim();
  const contractText = String(input?.contract || input?.contractText || '').trim();
  const sandbox = input?.sandbox || 'workspace-write';
  if (!role) throw new Error('Specialist role is required.');
  if (!contractText) throw new Error('Specialist contract is required.');
  if (contractText.length < 80) {
    throw new Error('Specialist contract must contain at least 80 characters of inline instructions.');
  }
  if (/^(?:[.]{0,2}[/\\])?[a-zA-Z0-9_.-]+(?:[/\\][a-zA-Z0-9_.-]+)*\.md$/i.test(contractText)) {
    throw new Error('Specialist contract must be inline instructions, not a file path.');
  }
  if (!['read-only', 'workspace-write'].includes(sandbox)) {
    throw new Error('Specialist sandbox must be read-only or workspace-write.');
  }
  return {
    id,
    role,
    contractText,
    sandbox,
    triggers: stringList(input?.triggers),
    capabilities: stringList(input?.capabilities),
    workflowScoped: true
  };
}

export function loadScopedSpecialists(repo) {
  const dirs = repo
    ? [protectedSpecialistDir(repo), scopedSpecialistDir(repo)]
    : [globalSpecialistDir()];
  const records = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
      const fileId = name.slice(0, -'.json'.length);
      if (records.has(fileId)) continue;
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!records.has(raw.id)) records.set(raw.id, normalizeSpecialist(raw));
    }
  }
  return [...records.values()];
}

export function loadRegistry(repo = null) {
  const registry = builtInRegistry();
  return { ...registry, agents: registry.agents.concat(loadScopedSpecialists(repo)) };
}

export function getAgent(id, repo = null) {
  const registry = loadRegistry(repo);
  return registry.agents.find((a) => a.id === id) ?? null;
}

export function registerScopedSpecialist(repo, input, { provenance } = {}) {
  if (provenance?.source !== 'recruiter' || !provenance.runId || !provenance.proposalId) {
    throw new Error('Specialists may only be registered from a verified Recruiter proposal.');
  }
  const specialist = normalizeSpecialist(input);
  if (builtInRegistry().agents.some((agent) => agent.id === specialist.id)) {
    throw new Error(`Cannot replace built-in AITEAM agent: ${specialist.id}`);
  }
  const dirs = repo
    ? [scopedSpecialistDir(repo), protectedSpecialistDir(repo)]
    : [globalSpecialistDir()];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  const record = { ...specialist, provenance, createdAt: new Date().toISOString() };
  const serialized = JSON.stringify(record, null, 2) + '\n';
  for (const dir of dirs) fs.writeFileSync(path.join(dir, `${specialist.id}.json`), serialized);
  return record;
}

export function readContract(relativePath) {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

export function buildAgentPrompt(agent, task, context = '', stage = null) {
  const base = readContract('agents/base.md');
  const role = agent.contractText || readContract(agent.contract);

  // Stage-specific final reminder placed AFTER coordinator context so it's the
  // last thing the model reads before generating output.
  const finalReminder = stage === 'implementation'
    ? (() => {
      let writeMethodDirective = '3a. If coordinator context contains `environmentProfile`, reuse its verified tools, executable paths, syntax checker, and write method instead of rediscovering or reinstalling them. Do not experiment with alternative shell redirection unless the primary method fails.';
      try {
        const parsed = JSON.parse(context);
        const method = parsed?.environmentProfile?.fileOperations?.writeMethod;
        if (method) {
          writeMethodDirective = `3a. PROVEN FILE-WRITING METHOD FOR THIS ENVIRONMENT: ${method}. Use this proven method; do not experiment with alternative shell redirection unless this method is not working.`;
        }
      } catch {}
      return [
        '# ⚠️ FINAL INSTRUCTION — READ THIS LAST',
        '1. SCOPE DISCIPLINE: You MUST ONLY implement the acceptanceCriteria of your `currentTask`. The project requirements and architecture in your context are for background knowledge only. DO NOT build features belonging to future tasks (like AI, sound, or game loops) unless they are explicitly listed in your task\'s acceptance criteria. Over-achieving breaks the project plan.',
        '2. You MUST write or edit the necessary files on disk (using a direct edit tool like apply_patch if exposed, or bash/exec commands with cat heredocs) BEFORE emitting your JSON response.',
        '3. Steps: (1) use a direct edit tool if exposed, otherwise run one literal quoted heredoc such as `cat > filename <<\'AITEAM_EOF\'`, (2) verify with `ls -la filename` and the language syntax checker/compiler, (3) ONLY THEN emit outcome "PASS" with filesChanged.',
        writeMethodDirective,
        '4. Do NOT output JSON without first writing the files. Do NOT return "FAIL" claiming sandbox restrictions — you have full write access to the repository.',
        '5. ESCAPING DISCIPLINE: Do not search for unavailable editing tools or generate source through nested `bash -lc`, `python -c`, base64, long echo chains, or repeated sed repairs. Keep source text in a literal quoted heredoc.',
        'LARGE FILE WARNING: exec_command truncates heredocs at ~200 lines. For files >150 lines, write in chunks:',
        '  chunk 1: `cat > filename <<\'AITEAM_EOF\'` … ~100 lines … `AITEAM_EOF`',
        '  chunk 2+: `cat >> filename <<\'AITEAM_EOF\'` … next ~100 lines … `AITEAM_EOF`  (>> appends)',
        'Then verify: `wc -l filename` plus the language syntax checker/compiler. Never write a large file in a single heredoc or it will be silently truncated.',
        '6. MANDATORY OUTPUT FORMAT — RAW JSON ONLY:',
        '   Your final answer must be ONLY one valid JSON object. Do NOT emit conversational markdown summaries (e.g. "Here is what I did...", "All fixes implemented...", "### Summary"). The workflow engine strictly parses your final message as JSON. Any surrounding prose or missing JSON keys will be rejected.',
        '   Example final output: {"outcome": "PASS", "summary": "Implemented and verified acceptance criteria on disk.", "evidence": ["Checked PRD and TRD", "Ran python3 tests/test.py -> passed"], "filesChanged": ["index.html"], "validations": [{"command": "python3 tests/test.py", "result": "passed"}]}'
      ].join('\n');
    })()
    : stage === 'qa'
    ? (() => {
      let regressionIds = [];
      try {
        const parsed = JSON.parse(context);
        if (Array.isArray(parsed?.completedPriorTasks)) {
          for (const priorTask of parsed.completedPriorTasks) {
            if (Array.isArray(priorTask.regressionTests)) {
              for (const test of priorTask.regressionTests) {
                if (test?.id) regressionIds.push(test.id);
              }
            }
          }
        }
      } catch {
        // Context may not be pure JSON or may be empty; fallback
      }
      const regressionReminder = regressionIds.length
        ? [
          '7. MANDATORY PRIOR REGRESSION TEST IDS: Your structured output MUST include test entries in `checks` or `automationAttempts[].covers` for each of the following prior test IDs:',
          ...regressionIds.map((id) => `   - ${id}`)
        ].join('\n')
        : '7. CROSS-TASK REGRESSION: Include checks or automationAttempts for all prior task regression IDs listed in your context.';

      return [
        '# FINAL QA EXECUTION ORDER — READ THIS LAST',
        '1. RUN BEFORE WRITING: Execute applicable existing test runners and commands from `currentTask.validations` first. Do not create a duplicate test merely to make it your own.',
        '2. PROVE TOOL AVAILABILITY DIRECTLY: Test the actual import/command. Keep browser discovery commands independent; never infer that Playwright is missing because a chained `which ... && ...` command stopped early.',
        '2a. If `environmentProfile` is present, start with its verified black-box runner and executable paths. Re-probe only when the recorded command now fails.',
        '3. DO NOT INSTALL CASUALLY: Install only after a direct capability check fails. Never use `--break-system-packages`, modify product dependency manifests for QA setup, or perform a system-wide install.',
        '4. WRITE ONLY IF UNAVOIDABLE: Prefer no new file. If a temporary helper is required, use one literal quoted heredoc in temporary storage, syntax-check it immediately, and clean it up. Never generate it through nested `bash -lc`, `python -c`, base64, long echo chains, or repeated sed escaping repairs.',
        '5. STOP ESCAPE LOOPS: After two helper-writing or syntax failures, stop rewriting the helper. Use an existing runner or a different reasonable black-box interface and record the concrete attempt.',
        '6. RETURN ONLY OBSERVATIONS: Report test, expected result, actual result, and runtime evidence. Do not inspect implementation source or prescribe a fix.',
        '6a. TEST HARNESS SANITY (AUDIO & UI): When testing Web Audio / AudioContext, trigger actions via simulated DOM user gestures (e.g. clicking `#playBtn`). Do not invoke synthetic `AudioContext.resume()` via `page.evaluate()` which violates browser autoplay policy. Distinguish machine-verifiable DOM/state checks from audible perception (use PASS_WITH_MANUAL_VALIDATION for human listening tests; never fail solely because headless has no speakers).',
        regressionReminder
      ].join('\n');
    })()
    : stage === 'code-review'
    ? [
      '# FINAL CODE REVIEW ORDER — READ THIS LAST',
      '1. FIRST TURN FILE INSPECTION MANDATE: You MUST run bash/file inspection tools (e.g. `cat <file>`, `grep`, `git diff`) in your FIRST turn to read actual code on disk. Do NOT review from memory or hallucinate code without tool execution.',
      '2. ANTI-HALLUCINATION: Do NOT claim functions, methods, or formulas are missing unless you ran `grep` or `cat` during this run and verified they are absent. The methods `_playWallBounce`, `_playAIScore`, `_playPaddleHit`, and `_playPlayerScore` exist in `index.html`. Emitting a rejection on hallucinated missing code is a strict protocol violation.',
      '3. REPAIR VERIFICATION: When reviewing a rework task, test previous findings as hypotheses against current files on disk. If the code on disk already satisfies the requirements or if prior claims are disproven, mark findings resolved and return PASS.',
      '4. RETURN RAW JSON ONLY: Your final response must be ONLY one valid JSON object with `outcome`, `summary`, `evidence`, and `findings`.'
    ].join('\n')
    : stage === 'environment-readiness'
    ? [
      '# FINAL ENVIRONMENT READINESS ORDER — READ THIS LAST',
      '1. VERIFY, DO NOT ASSUME: Run direct import, executable, version, and functional probes for every approved capability. A user saying "installed" is not proof.',
      '2. KEEP PROBES INDEPENDENT: Never let a missing optional executable prevent the actual package/import probe from running through a chained `&&` command.',
      '3. PROVE FUNCTION: Browser capability requires actual browser launch/close. File operations require create/read/syntax-check/delete with no scratch file left behind.',
      '4. PROTECT THE PRODUCT: Do not edit source, manifests, or lockfiles. Never use sudo, system package installation, or `pip --break-system-packages`.',
      '5. HUMAN HANDOFF: If safe isolated preparation cannot provide a required capability, return AWAITING_USER with exact tool, reason, observed problem, alternatives, install steps, and verification command.',
      '6. PASS PROFILE: PASS only with VERIFIED capabilities, verified file operations, no missing tools, and concrete command evidence.'
    ].join('\n')
    : null;


  return [
    base,
    role,
    '# Assignment',
    task,
    context ? '# Coordinator Context\n' + context : '',
    finalReminder,
    '# Response',
    'Return your conclusions and evidence to the AITEAM Coordinator. Be concise but complete.'
  ].filter(Boolean).join('\n\n');
}


export function coordinatorContract() {
  return readContract('agents/coordinator.md');
}
