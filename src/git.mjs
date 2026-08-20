import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitWithEnv(repo, args, env) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  }).trim();
}

export function ensureGitRepo(repo) {
  let root;
  try {
    root = git(repo, ['rev-parse', '--show-toplevel']);
  } catch {
    git(repo, ['init']);
    root = git(repo, ['rev-parse', '--show-toplevel']);
  }
  const expected = path.resolve(repo);
  if (path.resolve(root) !== expected) {
    throw new Error(`Repository boundary mismatch. Requested ${expected}, Git root is ${root}. Initialize Git in the project itself before using AITEAM.`);
  }
}

export function gitSnapshot(repo) {
  ensureGitRepo(repo);
  const root = path.resolve(repo);
  let head = null;
  try {
    head = git(repo, ['rev-parse', 'HEAD']);
  } catch {
    head = 'EMPTY_INITIAL_REPO';
  }
  let branch = '';
  try {
    branch = git(repo, ['branch', '--show-current']);
  } catch {
    branch = 'main';
  }
  return {
    root,
    branch,
    head,
    status: git(repo, ['status', '--short'])
  };
}

function validatedRepoPath(repo, candidate) {
  const value = String(candidate || '').trim();
  if (!value) throw new Error('Validated Git paths must be non-empty.');
  const absolute = path.resolve(repo, value);
  const relative = path.relative(repo, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Validated path escapes the repository: ${value}`);
  }
  if (relative === '.aiteam' || relative.startsWith(`.aiteam${path.sep}`) || relative === '.git' || relative.startsWith(`.git${path.sep}`)) {
    throw new Error(`AITEAM control state cannot be integrated: ${value}`);
  }
  return relative.replaceAll(path.sep, '/');
}

export function fingerprintPaths(repo, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Cannot fingerprint an empty path set.');
  const validated = [...new Set(paths.map((item) => validatedRepoPath(repo, item)))].sort();
  const records = [];
  for (const candidate of validated) {
    const listed = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '--', candidate]);
    const files = listed ? listed.split('\n').filter(Boolean).sort() : [candidate];
    for (const relative of files) {
      const absolute = path.join(repo, relative);
      if (!fs.existsSync(absolute)) {
        records.push([relative, 'missing']);
        continue;
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) records.push([relative, 'symlink', fs.readlinkSync(absolute)]);
      else if (stat.isFile()) records.push([relative, stat.mode, crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
      else records.push([relative, 'non-file']);
    }
  }
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function commitValidatedPaths(repo, paths, message) {
  gitSnapshot(repo);
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('Integration requires at least one QA-validated path.');
  }
  const validated = [...new Set(paths.map((item) => validatedRepoPath(repo, item)))].sort();
  const commitMessage = String(message || '').trim();
  if (!commitMessage) throw new Error('Integration requires a non-empty commit message.');

  let hasHead = true;
  try {
    git(repo, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }

  if (hasHead) {
    const diff = spawnSync('git', ['-C', repo, 'diff', '--quiet', 'HEAD', '--', ...validated]);
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '--', ...validated]);
    if (diff.status === 0 && !untracked) {
      return { committed: false, reason: 'no_changes', paths: validated, head: git(repo, ['rev-parse', 'HEAD']) };
    }
    if (![0, 1].includes(diff.status)) {
      throw new Error(`Unable to inspect validated Git paths: ${String(diff.stderr || '').trim()}`);
    }
  }

  for (const relative of validated) {
    const absolute = path.join(repo, relative);
    if (!fs.existsSync(absolute)) {
      const tracked = spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', relative]);
      if (tracked.status !== 0) throw new Error(`Validated path does not exist and is not tracked: ${relative}`);
    }
  }

  const controlDir = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'aiteam']));
  fs.mkdirSync(controlDir, { recursive: true });
  const tempIndex = path.join(controlDir, `integration-index-${crypto.randomUUID()}`);
  const indexEnv = { GIT_INDEX_FILE: tempIndex };
  try {
    if (hasHead) {
      gitWithEnv(repo, ['read-tree', 'HEAD'], indexEnv);
    }
    gitWithEnv(repo, ['add', '-A', '--', ...validated], indexEnv);
    gitWithEnv(repo, ['commit', '-m', commitMessage], indexEnv);
    git(repo, ['add', '-A', '--', ...validated]);
  } finally {
    if (fs.existsSync(tempIndex)) fs.unlinkSync(tempIndex);
  }
  return {
    committed: true,
    paths: validated,
    head: git(repo, ['rev-parse', 'HEAD']),
    message: commitMessage
  };
}
