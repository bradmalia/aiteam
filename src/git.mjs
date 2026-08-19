import { execFileSync } from 'node:child_process';
import path from 'node:path';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitSnapshot(repo) {
  let root;
  try {
    root = git(repo, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`Not a Git repository: ${repo}`);
  }
  const expected = path.resolve(repo);
  if (path.resolve(root) !== expected) {
    throw new Error(`Repository boundary mismatch. Requested ${expected}, Git root is ${root}. Initialize Git in the project itself before using AITEAM.`);
  }
  return {
    root,
    branch: git(repo, ['branch', '--show-current']),
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--short'])
  };
}
