import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_AITEAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function safeExecGit(aiteamRoot, args, timeout = 3500) {
  return execFileSync('git', ['-C', aiteamRoot, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function readVersionFile(aiteamRoot) {
  try {
    const v = fs.readFileSync(path.join(aiteamRoot, 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(aiteamRoot, 'package.json'), 'utf8'));
    if (pkg?.version) return String(pkg.version).trim();
  } catch {}
  return '0.0.0';
}

function getLocalCommit(aiteamRoot) {
  try {
    return safeExecGit(aiteamRoot, ['rev-parse', '--short', 'HEAD']) || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function installMetadataPath(targetRepo) {
  return path.join(path.resolve(targetRepo), '.aiteam', 'install.json');
}

export function readInstallMetadata(targetRepo) {
  try {
    return JSON.parse(fs.readFileSync(installMetadataPath(targetRepo), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Sync AITeam skill symlink, .aiteam directories, git exclude, AGENTS.md instructions,
 * and .aiteam/install.json metadata into a target project repository.
 */
export function syncProjectFiles(targetRepo, aiteamRoot = DEFAULT_AITEAM_ROOT) {
  const repoPath = path.resolve(targetRepo);
  const rootPath = path.resolve(aiteamRoot);

  fs.mkdirSync(path.join(repoPath, '.aiteam', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, '.aiteam', 'docs'), { recursive: true });

  let agentsUpdated = false;
  let symlinkUpdated = false;

  if (repoPath !== rootPath) {
    // 1. Ensure .aiteam/ is excluded in .git/info/exclude if target is a git repo
    const gitDir = path.join(repoPath, '.git');
    if (fs.existsSync(gitDir)) {
      const excludeFile = path.join(gitDir, 'info', 'exclude');
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const existingExclude = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      if (!/^\.aiteam\//m.test(existingExclude)) {
        const prefix = existingExclude && !existingExclude.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(excludeFile, `${existingExclude}${prefix}.aiteam/\n`, 'utf8');
      }
    }

    // 2. Ensure .agents/skills/aiteam symlink points to <aiteamRoot>/skill
    const skillsDir = path.join(repoPath, '.agents', 'skills');
    const skillTarget = path.join(skillsDir, 'aiteam');
    const desiredSkillSource = path.join(rootPath, 'skill');
    fs.mkdirSync(skillsDir, { recursive: true });

    let needsLink = true;
    try {
      const lstat = fs.lstatSync(skillTarget);
      if (lstat.isSymbolicLink() && path.resolve(path.dirname(skillTarget), fs.readlinkSync(skillTarget)) === path.resolve(desiredSkillSource)) {
        needsLink = false;
      }
    } catch {}

    if (needsLink) {
      fs.rmSync(skillTarget, { recursive: true, force: true });
      fs.symlinkSync(desiredSkillSource, skillTarget);
      symlinkUpdated = true;
    }

    // 3. Refresh AITeam instructions block in AGENTS.md while preserving any project-specific header
    const templatePath = path.join(rootPath, 'skill', 'templates', 'AGENTS.skill.md');
    if (fs.existsSync(templatePath)) {
      const templateContent = fs.readFileSync(templatePath, 'utf8').trimEnd() + '\n';
      const agentsPath = path.join(repoPath, 'AGENTS.md');
      let nextAgents = templateContent;

      if (fs.existsSync(agentsPath)) {
        const currentAgents = fs.readFileSync(agentsPath, 'utf8');
        const headingMarker = '# Project Agent Instructions';
        const toolsMarker = '## AITeam MCP Tools Available';
        const headingIdx = currentAgents.indexOf(headingMarker);
        const toolsIdx = currentAgents.indexOf(toolsMarker);

        if (headingIdx !== -1) {
          nextAgents = `${currentAgents.slice(0, headingIdx)}${templateContent}`;
        } else if (toolsIdx !== -1) {
          nextAgents = `${currentAgents.slice(0, toolsIdx)}${templateContent}`;
        } else {
          const sep = currentAgents.length === 0 ? '' : currentAgents.endsWith('\n') ? '\n' : '\n\n';
          nextAgents = `${currentAgents}${sep}${templateContent}`;
        }

        if (nextAgents !== currentAgents) {
          fs.writeFileSync(agentsPath, nextAgents, 'utf8');
          agentsUpdated = true;
        }
      } else {
        fs.writeFileSync(agentsPath, nextAgents, 'utf8');
        agentsUpdated = true;
      }
    }
  }

  const version = readVersionFile(rootPath);
  const commit = getLocalCommit(rootPath);
  const metadata = {
    version,
    commit,
    updatedAt: new Date().toISOString(),
    aiteamRoot: rootPath
  };
  fs.writeFileSync(installMetadataPath(repoPath), JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  return {
    version,
    commit,
    agentsUpdated,
    symlinkUpdated,
    installPath: installMetadataPath(repoPath)
  };
}

/**
 * Check GitHub (remote/branch) for a newer AITeam version/commit and verify whether
 * the target project's deployed AGENTS.md / install.json is out of date.
 */
export function checkForUpgrade(targetRepo, options = {}) {
  const isTestEnv = Boolean(process.env.NODE_TEST_CONTEXT || process.env.AITEAM_TEST_MODE === '1');
  if (isTestEnv && !options.forceCheck && process.env.AITEAM_ENABLE_UPGRADE_CHECK !== '1') {
    return {
      upgradeAvailable: false,
      githubBehind: false,
      commitsBehind: 0,
      projectOutdated: false,
      skipped: true
    };
  }

  const aiteamRoot = path.resolve(options.aiteamRoot || DEFAULT_AITEAM_ROOT);
  const remote = options.remote || 'origin';
  const branch = options.branch || 'main';
  const remoteRef = `${remote}/${branch}`;

  let fetchError = null;
  try {
    safeExecGit(aiteamRoot, ['fetch', '--quiet', remote, branch], options.timeoutMs ?? 3500);
  } catch (err) {
    fetchError = err.message;
  }

  const localVersion = readVersionFile(aiteamRoot);
  const localCommit = getLocalCommit(aiteamRoot);

  let remoteVersion = localVersion;
  let remoteCommit = localCommit;
  let commitsBehind = 0;

  try {
    remoteCommit = safeExecGit(aiteamRoot, ['rev-parse', '--short', remoteRef]) || localCommit;
    const countRaw = safeExecGit(aiteamRoot, ['rev-list', '--count', `HEAD..${remoteRef}`]);
    commitsBehind = Number.isFinite(Number(countRaw)) ? Number(countRaw) : 0;
    try {
      const rv = safeExecGit(aiteamRoot, ['show', `${remoteRef}:VERSION`]);
      if (rv) remoteVersion = rv;
    } catch {}
  } catch {}

  const githubBehind = commitsBehind > 0;
  const targetVersion = githubBehind ? remoteVersion : localVersion;
  const targetCommit = githubBehind ? remoteCommit : localCommit;

  let changelog = [];
  try {
    const logRange = githubBehind ? `HEAD..${remoteRef}` : remoteRef;
    const logLimit = githubBehind ? '5' : '3';
    const rawLog = safeExecGit(aiteamRoot, ['log', '-n', logLimit, '--oneline', logRange]);
    if (rawLog) {
      changelog = rawLog.split(/\r?\n/).filter(Boolean);
    }
  } catch {}

  let projectOutdated = false;
  let installedProjectVersion = null;
  let installedProjectCommit = null;
  let agentsMdOutdated = false;
  let installMetadataMissing = false;
  let symlinkValid = false;

  if (targetRepo && path.resolve(targetRepo) !== aiteamRoot) {
    const repoPath = path.resolve(targetRepo);
    const meta = readInstallMetadata(repoPath);
    if (!meta) {
      installMetadataMissing = true;
    } else {
      installedProjectVersion = meta.version || null;
      installedProjectCommit = meta.commit || null;
    }

    const skillTarget = path.join(repoPath, '.agents', 'skills', 'aiteam');
    const desiredSkillSource = path.join(aiteamRoot, 'skill');
    try {
      const lstat = fs.lstatSync(skillTarget);
      if (lstat.isSymbolicLink()) {
        const linked = path.resolve(path.dirname(skillTarget), fs.readlinkSync(skillTarget));
        symlinkValid = linked === path.resolve(desiredSkillSource);
      }
    } catch {}

    const templatePath = path.join(aiteamRoot, 'skill', 'templates', 'AGENTS.skill.md');
    const agentsPath = path.join(repoPath, 'AGENTS.md');
    try {
      if (fs.existsSync(templatePath)) {
        const expectedTemplate = fs.readFileSync(templatePath, 'utf8').trim();
        const currentAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
        if (!currentAgents.includes(expectedTemplate)) {
          agentsMdOutdated = true;
        }
      }
    } catch {}

    if (!githubBehind && symlinkValid && !agentsMdOutdated) {
      if (
        !meta ||
        meta.version !== targetVersion ||
        (targetCommit && targetCommit !== 'unknown' && meta.commit !== targetCommit)
      ) {
        try {
          fs.mkdirSync(path.join(repoPath, '.aiteam'), { recursive: true });
          fs.writeFileSync(
            installMetadataPath(repoPath),
            JSON.stringify(
              {
                version: targetVersion,
                commit: targetCommit,
                updatedAt: new Date().toISOString(),
                aiteamRoot
              },
              null,
              2
            ) + '\n',
            'utf8'
          );
          installedProjectVersion = targetVersion;
          installedProjectCommit = targetCommit;
          installMetadataMissing = false;
        } catch {}
      }
      projectOutdated = false;
    } else {
      projectOutdated = Boolean(agentsMdOutdated || !symlinkValid);
    }
  }

  const upgradeAvailable = githubBehind || projectOutdated;
  let summary = `AITeam is up to date (${localVersion} @ ${localCommit}).`;
  if (githubBehind) {
    summary = `AITeam update available on GitHub (${remoteVersion} @ ${remoteCommit}, ${commitsBehind} commit${commitsBehind === 1 ? '' : 's'} ahead of local ${localVersion} @ ${localCommit}).`;
  } else if (projectOutdated) {
    summary = `Project AITeam files are out of date (project: ${installedProjectVersion || 'untracked'} @ ${installedProjectCommit || 'none'} -> available: ${targetVersion} @ ${targetCommit}).`;
  }

  return {
    upgradeAvailable,
    githubBehind,
    commitsBehind,
    projectOutdated,
    installMetadataMissing,
    agentsMdOutdated,
    localVersion,
    localCommit,
    remoteVersion: targetVersion,
    remoteCommit: targetCommit,
    installedProjectVersion,
    installedProjectCommit,
    changelog,
    fetchError,
    summary
  };
}

/**
 * Pull latest commits from GitHub (fast-forward only) and sync project files.
 */
export function performUpgrade(targetRepo, options = {}) {
  const aiteamRoot = path.resolve(options.aiteamRoot || DEFAULT_AITEAM_ROOT);
  const remote = options.remote || 'origin';
  const branch = options.branch || 'main';
  const remoteRef = `${remote}/${branch}`;

  const previousVersion = readVersionFile(aiteamRoot);
  const previousCommit = getLocalCommit(aiteamRoot);

  let pulledFromGithub = false;
  try {
    safeExecGit(aiteamRoot, ['fetch', '--quiet', remote, branch], options.timeoutMs ?? 5000);
    const behindCount = Number(safeExecGit(aiteamRoot, ['rev-list', '--count', `HEAD..${remoteRef}`]) || '0');
    if (behindCount > 0) {
      safeExecGit(aiteamRoot, ['pull', '--ff-only', remote, branch], options.timeoutMs ?? 15000);
      pulledFromGithub = true;
    }
  } catch (err) {
    throw new Error(`AITEAM_UPGRADE_FAILED: Unable to pull latest AITeam from ${remoteRef}: ${err.message}`);
  }

  const version = readVersionFile(aiteamRoot);
  const commit = getLocalCommit(aiteamRoot);

  let projectSynced = false;
  let syncDetails = null;
  if (targetRepo) {
    syncDetails = syncProjectFiles(targetRepo, aiteamRoot);
    projectSynced = true;
  }

  const summary = pulledFromGithub
    ? `Upgraded AITeam from ${previousVersion} (${previousCommit}) to ${version} (${commit}) from GitHub and synced project files.`
    : `Synced project AITeam files to ${version} (${commit}).`;

  return {
    ok: true,
    previousVersion,
    previousCommit,
    version,
    commit,
    pulledFromGithub,
    projectSynced,
    syncDetails,
    summary
  };
}

// --- CLI Execution Interface ---
const isMain = Boolean(process.argv[1]) && (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const getArg = (flag, fallback = null) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : fallback;
  };
  const repo = path.resolve(getArg('--repo', process.cwd()));

  try {
    if (cmd === 'check') {
      console.log(JSON.stringify(checkForUpgrade(repo, { forceCheck: true }), null, 2));
    } else if (cmd === 'upgrade') {
      console.log(JSON.stringify(performUpgrade(repo), null, 2));
    } else if (cmd === 'install') {
      console.log(JSON.stringify(syncProjectFiles(repo), null, 2));
    } else {
      console.error('Usage: upgrader.mjs <check|upgrade|install> [--repo <path>]');
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
