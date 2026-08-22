#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(ROOT, 'watch-dashboard.html');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function repoArgument() {
  const value = argument('--repo');
  if (!value) throw new Error('Usage: watch-server.mjs --repo <repository> [--port <port>]');
  return path.resolve(value);
}

function portArgument() {
  const port = Number(argument('--port', '4317'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535.');
  return port;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tailEvents(file, repo, limit = 80) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).flatMap((line) => {
      try {
        const ev = JSON.parse(line);
        const runId = ev.runId || (ev.stdoutPath ? path.basename(ev.stdoutPath, '.stdout.txt') : null);
        if (runId) {
          const stdoutFile = ev.stdoutPath && fs.existsSync(ev.stdoutPath)
            ? ev.stdoutPath
            : path.join(repo, '.aiteam', 'runs', `${runId}.stdout.txt`);
          if (fs.existsSync(stdoutFile)) {
            try {
              const res = JSON.parse(fs.readFileSync(stdoutFile, 'utf8'));
              if (res && typeof res === 'object') {
                ev.responseSummary = res.summary || null;
                ev.responseOutcome = res.outcome || ev.outcome || null;
                ev.responseEvidence = res.evidence || [];
              }
            } catch {}
          }
        }
        return [ev];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

function snapshot(repo) {
  const sessionPath = path.join(repo, '.aiteam', 'session.json');
  const protectedSessionPath = path.join(repo, '.git', 'aiteam', 'session.json');
  const eventPath = path.join(repo, '.aiteam', 'events.jsonl');
  const protectedEventPath = path.join(repo, '.git', 'aiteam', 'events.jsonl');
  const session = readJson(sessionPath) || readJson(protectedSessionPath);
  const events = tailEvents(eventPath, repo).length ? tailEvents(eventPath, repo) : tailEvents(protectedEventPath, repo);
  const lastEvent = events.at(-1) || null;
  const activeRun = session?.activeRun || null;
  const startedAt = activeRun?.startedAt ? Date.parse(activeRun.startedAt) : NaN;
  const activeRunElapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : null;
  const sessionCreatedAt = session?.createdAt ? Date.parse(session.createdAt) : NaN;
  const isTerminalSession = session?.status === 'COMPLETE' || session?.status === 'CANCELLED';
  const sessionEndTime = isTerminalSession && (session?.completedAt || session?.updatedAt)
    ? Date.parse(session.completedAt || session.updatedAt)
    : Date.now();
  const sessionElapsedSeconds = Number.isFinite(sessionCreatedAt) ? Math.max(0, Math.floor((sessionEndTime - sessionCreatedAt) / 1000)) : null;
  const evidence = Object.values(session?.stageEvidence || {}).filter((item) => item?.result).sort((a, b) => Date.parse(a.completedAt || 0) - Date.parse(b.completedAt || 0));
  const stageResult = evidence.at(-1)?.result || null;
  const packageJson = readJson(path.join(ROOT, '..', 'package.json'));
  
  let activeLogTail = null;
  const runsDir = path.join(repo, '.aiteam', 'runs');
  try {
    if (fs.existsSync(runsDir) && activeRun) {
      const targetFile = fs.readdirSync(runsDir)
        .filter((f) => f.endsWith('.stderr.txt') && f.includes(activeRun.agentId || ''))
        .sort()
        .at(-1);
      if (targetFile) {
        const rawContent = fs.readFileSync(path.join(runsDir, targetFile), 'utf8').trim();
        const splitIndex = rawContent.lastIndexOf('mcp startup: no servers');
        if (splitIndex !== -1) {
          const afterMcp = rawContent.slice(splitIndex).replace(/^mcp startup: no servers\r?\n?/i, '').trim();
          activeLogTail = afterMcp.replace(/^warning: Model metadata[^\n]*\n?/i, '').trim();
        } else {
          const lines = rawContent.split(/\r?\n/).filter(Boolean);
          activeLogTail = lines.slice(-25).join('\n').trim();
        }
      }
    }
  } catch {}

  return {
    repository: repo,
    version: packageJson?.version || 'unknown',
    updatedAt: session?.updatedAt || lastEvent?.at || null,
    session,
    activeRun,
    activeLogTail,
    elapsedSeconds: activeRunElapsedSeconds ?? sessionElapsedSeconds,
    activeRunElapsedSeconds,
    sessionElapsedSeconds,
    currentResult: stageResult,
    latestEvidence: evidence.at(-1) || null,
    recentEvents: events,
    watcher: { readOnly: true, generatedAt: new Date().toISOString() }
  };
}

function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'http://127.0.0.1'
  });
  response.end(body);
}

export function createWatchServer({ repo, port = 4317, host = '127.0.0.1' } = {}) {
  let activeRepo = path.resolve(repo);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (url.pathname === '/api/set-repo' && (request.method === 'GET' || request.method === 'POST')) {
      const newRepo = url.searchParams.get('repo');
      if (newRepo) {
        activeRepo = path.resolve(newRepo);
      }
      return sendJson(response, { ok: true, repository: activeRepo });
    }
    if (request.method !== 'GET') return sendJson(response, { error: 'Only GET is supported.' }, 405);
    if (url.pathname === '/api/state') return sendJson(response, snapshot(activeRepo));
    if (url.pathname === '/health') return sendJson(response, { ok: true, repository: activeRepo });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(fs.readFileSync(dashboardPath));
    }
    return sendJson(response, { error: 'Not found.' }, 404);
  });
  server.listen(port, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const repo = repoArgument();
    const port = portArgument();
    const server = createWatchServer({ repo, port });
    server.once('listening', () => process.stdout.write(`AITEAM watch: http://127.0.0.1:${port}/\nRepository: ${repo}\n`));
    server.on('error', (error) => { process.stderr.write(`AITEAM watch failed: ${error.message}\n`); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write(`AITEAM watch failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
