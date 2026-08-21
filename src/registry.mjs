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
  const dirs = [globalSpecialistDir()];
  if (repo) {
    dirs.push(protectedSpecialistDir(repo), scopedSpecialistDir(repo));
  }
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
  const dirs = [globalSpecialistDir()];
  if (repo) {
    dirs.push(scopedSpecialistDir(repo), protectedSpecialistDir(repo));
  }
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
    ? [
      '# ⚠️ FINAL INSTRUCTION — READ THIS LAST',
      '1. SCOPE DISCIPLINE: You MUST ONLY implement the acceptanceCriteria of your `currentTask`. The project requirements and architecture in your context are for background knowledge only. DO NOT build features belonging to future tasks (like AI, sound, or game loops) unless they are explicitly listed in your task\'s acceptance criteria. Over-achieving breaks the project plan.',
      '2. You MUST use bash/exec tools to write files to disk BEFORE emitting your JSON response.',
      '3. Steps: (1) run `cat << EOF > filename` or equivalent, (2) verify with `ls -la filename`, (3) ONLY THEN emit outcome "PASS" with filesChanged.',
      '4. Do NOT output JSON without first writing the files. Do NOT return "FAIL" claiming sandbox restrictions — you have full write access to the repository.',
      'LARGE FILE WARNING: exec_command truncates heredocs at ~200 lines. For files >150 lines, write in chunks:',
      '  chunk 1: `cat << AITEAM_EOF > filename` … ~100 lines … `AITEAM_EOF`',
      '  chunk 2+: `cat << AITEAM_EOF >> filename` … next ~100 lines … `AITEAM_EOF`  (>> appends)',
      'Then verify: `wc -l filename`. Never write a large file in a single heredoc or it will be silently truncated.',
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
