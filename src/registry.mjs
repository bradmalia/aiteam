import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_ROOT = path.resolve(HERE, '..');

export function loadRegistry() {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'agents', 'registry.json'), 'utf8'));
}

export function getAgent(id) {
  const registry = loadRegistry();
  return registry.agents.find((a) => a.id === id) ?? null;
}

export function readContract(relativePath) {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

export function buildAgentPrompt(agent, task, context = '') {
  const base = readContract('agents/base.md');
  const role = readContract(agent.contract);
  return [
    base,
    role,
    '# Assignment',
    task,
    context ? '# Coordinator Context\n' + context : '',
    '# Response',
    'Return your conclusions and evidence to the AITEAM Coordinator. Be concise but complete.'
  ].filter(Boolean).join('\n\n');
}

export function coordinatorContract() {
  return readContract('agents/coordinator.md');
}
