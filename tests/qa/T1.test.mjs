/** Independent T1 black-box coverage. All simulated decisions use disposable repos.
 * Public documents, HTTP/browser behavior and CLI outputs are the assertions.
 * No live project approval state or private state helpers are imported.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const bridge = path.join(sourceRoot, 'skill/lib/state-bridge.mjs');
const watcher = path.join(sourceRoot, 'src/watch-server.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidenceRoot = process.env.AITEAM_QA_ARTIFACT_DIR || path.join(sourceRoot, '.aiteam/qa-evidence/T1');
const children = new Set();
const servers = new Set();
let sandbox, repo, packet, docsRoot, browser, watchOrigin, mediaOrigin, docsOrigin, template, interactiveFixtureURL;
const observations = [];

function cli(targetRepo, ...args) {
  assert.notEqual(path.resolve(targetRepo), path.resolve(sourceRoot), 'synthetic CLI decisions must never target the live project');
  return execFileSync(process.execPath, [bridge, ...args, '--repo', targetRepo], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function child(command, args) {
  const processChild = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(processChild);
  processChild.once('exit', () => children.delete(processChild));
  return processChild;
}
async function unusedHighPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.ok(port >= 1024 && port <= 65535);
  return port;
}
async function waitUntil(check, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await check()) return; } catch {}
    await pause(60);
  }
  throw new Error(`Timed out: ${label}`);
}
async function startWatcher(targetRepo) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await unusedHighPort();
    const proc = child(process.execPath, [watcher, '--repo', targetRepo, '--host', '127.0.0.1', '--port', String(port)]);
    let output = ''; proc.stdout.on('data', chunk => { output += chunk; }); proc.stderr.on('data', chunk => { output += chunk; });
    const origin = `http://127.0.0.1:${port}`;
    try {
      await waitUntil(async () => (await (await fetch(origin + '/api/state')).json()).repository === targetRepo, 'public Watcher readiness');
      assert.match(output, /127\.0\.0\.1/);
      // Observe the listening socket through the OS, rather than inferring bind
      // scope from a localhost URL. This environment check is part of QA setup.
      if (process.platform === 'linux') {
        const sockets = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
        const binding = sockets.split('\n').find(line => line.includes(`127.0.0.1:${port} `));
        assert.ok(binding, `owned Watcher binds loopback at ${port}`);
        assert.ok(binding.includes(`pid=${proc.pid},`), 'listener belongs to the exact process just launched');
      }
      return { origin, proc };
    } catch (error) {
      proc.kill('SIGTERM');
      if (attempt === 2) throw new Error(`${error.message}\n${output}`);
    }
  }
}
async function staticServer(root, { routes = {} } = {}) {
  const types = { '.html': 'text/html', '.md': 'text/plain', '.png': 'image/png', '.webm': 'video/webm', '.json': 'application/json', '.txt': 'text/plain', '.css': 'text/css', '.vtt': 'text/vtt' };
  const server = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (routes[requestPath]) {
        const fixture = routes[requestPath];
        response.writeHead(fixture.status, fixture.location ? { Location: fixture.location } : { 'Content-Type': fixture.type }); response.end(fixture.body || ''); return;
      }
      const destination = path.resolve(root, '.' + requestPath);
      if (!destination.startsWith(path.resolve(root) + path.sep)) { response.writeHead(403).end(); return; }
      const bytes = await fs.readFile(destination);
      response.writeHead(200, { 'Content-Type': types[path.extname(destination)] || 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404).end('Fixture resource not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  assert.equal(server.address().address, '127.0.0.1');
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}
async function assertBytes(url, file, contentType) {
  const response = await fetch(url); assert.equal(response.status, 200, url);
  assert.match(response.headers.get('content-type') || '', contentType);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), await fs.readFile(file));
}

const resourceTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/plain', '.txt': 'text/plain', '.log': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.webm': 'video/webm', '.mp4': 'video/mp4', '.vtt': 'text/vtt' };
function reviewExpectedFile(target, targetRepo) {
  const url = new URL(target); let base, relative;
  if (url.pathname.startsWith('/artifacts/')) { base = path.join(targetRepo, '.aiteam/docs'); relative = decodeURIComponent(url.pathname.slice('/artifacts/'.length)); }
  else if (url.pathname.startsWith('/review-assets/')) { base = path.join(targetRepo, '.aiteam/reviews'); relative = decodeURIComponent(url.pathname.slice('/review-assets/'.length)); }
  else if (url.pathname === '/api/screenshot') { base = targetRepo; relative = url.searchParams.get('path'); }
  else return null;
  if (!relative) return null;
  const file = path.resolve(base, relative);
  assert.ok(file.startsWith(path.resolve(base) + path.sep), 'expected evidence stays inside its declared root');
  return file;
}

/** Full published-packet audit: report/guide/archive HTML, every resource edge,
 * redirect target, fragment and interactive alternate. No actual gate writes.
 */
async function auditReviewPacket(entryURL, { resolveExpected, allowedOrigins = [new URL(entryURL).origin], manualURLs = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const failures = [], references = [], documents = [], fetched = new Map(), pending = [entryURL], visited = new Set();
  const allowed = new Set(allowedOrigins);
  const mutating = url => /\/api\/(approve|set-repo|log)(?:\/|$)/.test(new URL(url).pathname);
  await context.route('**/*', route => {
    if (!['GET', 'HEAD'].includes(route.request().method()) || mutating(route.request().url())) {
      failures.push({ kind: 'write_attempt', url: route.request().url() }); return route.abort();
    }
    return route.continue();
  });
  const cssURLs = (text, base) => [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g), ...text.matchAll(/@import\s+(['"])(.*?)\1/g)].map(match => ({ url: new URL(match[2], base).href, source: base, attribute: 'CSS resource' }));
  async function retrieve(raw) {
    let target = new URL(raw); target.hash = ''; const key = target.href;
    if (fetched.has(key)) return fetched.get(key);
    const redirects = [], seen = new Set();
    for (let count = 0; count < 7; count++) {
      if (!allowed.has(target.origin)) throw new Error(`undeclared_or_stale_origin: ${target.origin}`);
      if (mutating(target.href)) throw new Error('mutating_endpoint_is_not_evidence');
      if (seen.has(target.href)) throw new Error('redirect_loop');
      seen.add(target.href);
      const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); if (!location) throw new Error('redirect_without_location');
        redirects.push({ url: target.href, status: response.status, location }); target = new URL(location, target); continue;
      }
      if (response.status !== 200) throw new Error(`HTTP_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const expected = resolveExpected?.(target.href);
      const expectedMime = resourceTypes[path.extname(expected || target.pathname).toLowerCase()];
      if (expectedMime && mime !== expectedMime) throw new Error(`wrong_content_type: ${mime}, expected ${expectedMime}`);
      if (expected) {
        let original; try { original = await fs.readFile(expected); } catch { throw new Error(`missing_expected_file: ${expected}`); }
        if (!bytes.equals(original)) throw new Error(`wrong_content_bytes: ${expected}`);
      }
      const result = { url: target.href, mime, bytes, redirects, expectedFile: expected };
      fetched.set(key, result); fetched.set(target.href, result); return result;
    }
    throw new Error('too_many_redirects');
  }
  try {
    while (pending.length) {
      const documentURL = pending.shift(); const key = new URL(documentURL); key.hash = '';
      if (visited.has(key.href)) continue;
      if (visited.size >= 60) { failures.push({ kind: 'document_limit_exceeded', url: documentURL }); break; }
      visited.add(key.href);
      let response;
      try { response = await retrieve(documentURL); } catch (error) { failures.push({ kind: 'document_unavailable', url: documentURL, error: error.message }); continue; }
      if (response.mime !== 'text/html') continue;
      const page = await context.newPage();
      try {
        page.on('pageerror', error => failures.push({ kind: 'browser_page_error', url: documentURL, error: String(error) }));
        await page.goto(response.url, { waitUntil: 'domcontentloaded' });
        const edges = [], interactions = [];
        async function collect(state) {
          const found = await page.evaluate(({ state, manualURLs }) => {
            const result = [], base = document.baseURI;
            const add = (raw, attribute, mediaKind) => {
              if (!raw) return;
              try { result.push({ raw, url: new URL(raw, base).href, attribute, mediaKind, state }); }
              catch { result.push({ raw, url: raw, attribute, mediaKind, state, malformed: true }); }
            };
            for (const element of document.querySelectorAll('*')) {
              for (const attribute of ['href', 'src', 'poster']) if (element.hasAttribute(attribute)) add(element.getAttribute(attribute), element.tagName + ':' + attribute, attribute === 'poster' || element.tagName === 'IMG' || (element.tagName === 'SOURCE' && element.parentElement?.tagName === 'PICTURE') ? 'image' : null);
              if (element.tagName === 'OBJECT') add(element.getAttribute('data'), 'OBJECT:data');
              const srcset = element.getAttribute('srcset');
              if (srcset) for (const candidate of srcset.matchAll(/(?:^|,)\s*((?:data:[^\s]+|[^,\s]+))(?:\s+[^,]+)?/g)) add(candidate[1].replace(/,$/, ''), element.tagName + ':srcset', 'image');
              for (const attribute of element.attributes) if (attribute.name.startsWith('data-') && /^(?:https?:|\/|\.\.?\/)|\.(?:png|jpe?g|gif|webp|svg|mp4|webm|vtt)(?:[?#]|$)/i.test(attribute.value)) add(attribute.value, attribute.name);
            }
            for (const element of document.querySelectorAll('style,[style]')) {
              const text = element.tagName === 'STYLE' ? element.textContent : element.getAttribute('style');
              for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) add(match[2], 'CSS url()');
            }
            if (manualURLs) for (const block of document.querySelectorAll('pre,code')) {
              // Explicit examples/source dumps are not live startup claims.
              if (block.closest('[data-illustrative],[data-historical]')) continue;
              for (const match of block.textContent.matchAll(/https?:\/\/[^\s<>"']+/g)) add(match[0].replace(/[.,;)]+$/, ''), 'manual command URL');
            }
            return result;
          }, { state, manualURLs });
          for (const edge of found) edges.push({ ...edge, source: response.url });
        }
        await collect('initial');
        for (const name of ['Before', 'After']) {
          const button = page.getByRole('button', { name, exact: true });
          if (await button.count() && await button.first().isVisible()) {
            await button.first().click();
            const selected = await button.first().getAttribute('aria-pressed');
            if (selected !== null && selected !== 'true') failures.push({ kind: 'comparison_did_not_select', url: response.url, control: name });
            const view = await button.first().getAttribute('data-view');
            if (view && !(await page.locator(`[data-evidence="${view}"]`).isVisible())) failures.push({ kind: 'comparison_evidence_not_visible', url: response.url, control: name });
            interactions.push({ control: name, selected });
            await collect(name);
          }
        }
        for (const media of await page.locator('video,audio').all()) {
          try { await media.evaluate(async el => { el.muted = true; el.load(); await el.play(); el.pause(); }); }
          catch (error) { failures.push({ kind: 'media_decode_or_playback', url: response.url, error: String(error) }); }
          interactions.push({ control: 'native media activation' });
          await collect('media activation');
        }
        const unique = new Map(edges.map(edge => [edge.url + '|' + edge.attribute + '|' + edge.state, edge]));
        for (const edge of unique.values()) {
          references.push(edge); let target;
          try {
            target = new URL(edge.url);
            if (target.protocol === 'data:') {
              if (!/^data:image\//i.test(edge.url) || edge.attribute.endsWith(':href')) throw new Error('non_image_or_navigable_data_URL');
              await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); }, edge.url); continue;
            }
            if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported_or_ephemeral_URL_scheme');
            const resource = await retrieve(target.href);
            if (edge.mediaKind === 'image' && !resource.mime.startsWith('image/')) throw new Error('image_reference_returned_non_image_content');
            if (target.hash && resource.mime === 'text/html') {
              const exists = await page.evaluate(({ html, fragment }) => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                return !!doc.getElementById(fragment) || [...doc.getElementsByName(fragment)].some(el => el.tagName === 'A');
              }, { html: resource.bytes.toString('utf8'), fragment: decodeURIComponent(target.hash.slice(1)) });
              if (!exists) throw new Error('missing_fragment_target');
            }
            if (resource.mime.startsWith('image/')) await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); }, resource.url);
            if (resource.mime === 'text/css') {
              const styles = [resource], inspected = new Set();
              while (styles.length) {
                const style = styles.shift(); if (inspected.has(style.url)) continue; inspected.add(style.url);
                for (const nested of cssURLs(style.bytes.toString('utf8'), style.url)) {
                  references.push(nested);
                  try {
                    const asset = await retrieve(nested.url);
                    if (asset.mime === 'text/css') styles.push(asset);
                    if (asset.mime.startsWith('image/')) await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); }, asset.url);
                  } catch (error) { failures.push({ ...nested, kind: 'invalid_resource', error: error.message }); }
                }
              }
            }
            // The dashboard itself is an entry point, not a recursive index of
            // every historical project event. Linked report/guide HTML is crawled.
            if (resource.mime === 'text/html' && new URL(resource.url).pathname !== '/') pending.push(resource.url);
          } catch (error) { failures.push({ ...edge, kind: 'invalid_resource', error: error.message }); }
        }
        documents.push({ url: response.url, references: unique.size, interactions });
      } catch (error) { failures.push({ kind: 'browser_navigation', url: response.url, error: String(error) }); }
      finally { await page.close(); }
    }
  } finally { await context.close(); }
  const resources = [...new Set(fetched.values())].map(item => ({ url: item.url, contentType: item.mime, byteLength: item.bytes.length, expectedFile: item.expectedFile, redirects: item.redirects }));
  return { entryURL, documents, references, checkedResources: resources.length, resources, failures };
}

async function verifyCompletePacketResources() {
  await fs.writeFile(path.join(packet, 'audit-secondary.css'), '.secondary{background-image:url("./before.png")}');
  await fs.writeFile(path.join(packet, 'audit.css'), '@import "./audit-secondary.css"; .evidence{background-image:url("./after.png")}');
  await fs.writeFile(path.join(packet, 'audit-detail.html'), '<h1 id="detail">Nested actual report</h1><a href="audit.html#top">Return to packet</a>');
  const positiveHTML = `<!doctype html><html><head><link rel="stylesheet" href="audit.css"></head><body><h1 id="top">Complete resource fixture</h1><a href="#top">Local fragment</a><a href="audit-detail.html#detail">Nested report fragment</a><a href="redirect-report">Redirected receipt</a><picture><source srcset="before.png 1x, after.png 2x"><img id="alternate" src="before.png" alt="Alternating browser evidence"></picture><button>Before</button><button>After</button><video controls preload="metadata" poster="after.png"><source src="fixture.webm" type="video/webm"></video><object data="results.json"></object><div class="evidence">CSS evidence</div><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelector('#alternate').src=button.textContent==='After'?'after.png':'before.png')</script></body></html>`;
  await fs.writeFile(path.join(packet, 'audit.html'), positiveHTML);
  await fs.copyFile(path.join(packet, 'before.png'), path.join(packet, 'wrong-bytes.png'));
  await fs.writeFile(path.join(packet, 'negative.css'), '.evidence{background-image:url("missing-css.png")}');
  await fs.writeFile(path.join(packet, 'audit-negative.html'), `<!doctype html><link rel="stylesheet" href="negative.css"><h1>Deliberately invalid resource fixture</h1><a href="audit-detail.html#absent">Missing fragment</a><a href="redirect-missing">Bad redirect</a><a href="redirect-loop">Redirect loop</a><a href="http://127.0.0.1:48082/retired-review.png">Stale auxiliary origin</a><img id="alternate" src="before.png" srcset="before.png 1x, missing-2x.png 2x"><img src="generic-error.png"><img src="wrong-bytes.png"><button>After</button><script>document.querySelector('button').onclick=()=>document.querySelector('#alternate').src='missing-after.png'</script>`);
  const auditServer = await staticServer(packet, { routes: {
    '/redirect-report': { status: 302, location: '/results.json' },
    '/redirect-missing': { status: 302, location: '/missing-redirect.txt' },
    '/redirect-loop': { status: 302, location: '/redirect-loop' },
    '/generic-error.png': { status: 200, type: 'text/html', body: '<h1>Generic error, not image evidence</h1>' },
    '/wrong-bytes.png': { status: 200, type: 'image/png', body: await fs.readFile(path.join(packet, 'after.png')) }
  } });
  const expected = target => path.join(packet, decodeURIComponent(new URL(target).pathname.slice(1)));
  const good = await auditReviewPacket(auditServer.origin + '/audit.html', { resolveExpected: expected });
  assert.deepEqual(good.failures, [], 'complete valid packet graph, redirects, media, fragments and alternates');
  assert.ok(good.resources.some(item => item.redirects.length), 'redirect destinations actually validated');
  assert.ok(good.references.some(item => item.state === 'After'), 'resource inventory rescanned after interaction');
  const bad = await auditReviewPacket(auditServer.origin + '/audit-negative.html', { resolveExpected: expected });
  for (const missing of ['missing-2x.png', 'missing-after.png', 'missing-css.png']) assert.ok(bad.failures.some(item => item.url.includes(missing)), `auditor catches unselected/interactive/CSS asset ${missing}`);
  assert.ok(bad.failures.some(item => item.error === 'missing_fragment_target'));
  assert.ok(bad.failures.some(item => item.error === 'redirect_loop'));
  assert.ok(bad.failures.some(item => item.url.endsWith('redirect-missing') && item.error.includes('HTTP_404')));
  assert.ok(bad.failures.some(item => item.url.endsWith('generic-error.png') && item.error.includes('wrong_content_type')));
  assert.ok(bad.failures.some(item => item.url.endsWith('wrong-bytes.png') && item.error.includes('wrong_content_bytes')));
  assert.ok(bad.failures.some(item => item.error.includes('undeclared_or_stale_origin')));
  await fs.writeFile(path.join(evidenceRoot, 'complete-resource-auditor-cases.json'), JSON.stringify({ positive: good, deliberateNegative: bad }, null, 2));

  // Default/CI is generated only from shipped sources and test data. It neither
  // requires nor silently relies on today's ignored review packet or server.
  const generated = path.join(repo, '.aiteam/reviews/QA-generated');
  await fs.mkdir(generated, { recursive: true });
  for (const name of ['before.png', 'after.png', 'fixture.webm', 'results.json']) await fs.copyFile(path.join(packet, name), path.join(generated, name));
  const guide = await fs.readFile(path.join(sourceRoot, 'skill/guides/manual-qa-approval-pages.md'), 'utf8');
  const escapedGuide = guide.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  await fs.writeFile(path.join(generated, 'guide.md'), guide);
  await fs.writeFile(path.join(generated, 'guide.html'), `<h1>Exact shipped guide as labelled source</h1><a href="/artifacts/qa-generated-template.html">Reusable template</a><a href="guide.md">Exact Markdown bytes</a><pre data-illustrative>${escapedGuide}</pre>`);
  await fs.writeFile(path.join(repo, '.aiteam/docs/qa-generated-template.html'), template);
  const generatedURL = watchOrigin + '/artifacts/qa-generated-resources.html';
  let generatedHTML = await authorPacket({ origin: watchOrigin + '/review-assets/QA-generated', packetURL: generatedURL });
  generatedHTML = generatedHTML.replace('</main>', '<section><h2>Shipped instructions</h2><a href="/review-assets/QA-generated/guide.html">Portable guide</a><a href="/artifacts/qa-interactive-fixture.html#evidence">Working interactive evidence</a></section></main>');
  await fs.writeFile(path.join(repo, '.aiteam/docs/qa-generated-resources.html'), generatedHTML);
  const generatedAudit = await auditReviewPacket(generatedURL, { resolveExpected: target => reviewExpectedFile(target, repo) });
  await fs.writeFile(path.join(evidenceRoot, 'generated-production-route-resource-audit.json'), JSON.stringify(generatedAudit, null, 2));
  assert.deepEqual(generatedAudit.failures, [], 'generated packet uses real production artifact/asset routes, with every dependency validated');

  const liveURL = process.env.AITEAM_QA_REVIEW_URL;
  if (liveURL) {
    // Formal QA supplies the actual URL. This separately audits the entire
    // authoritative deployed graph and cannot substitute generated fixtures.
    const actual = await auditReviewPacket(liveURL, { resolveExpected: target => reviewExpectedFile(target, sourceRoot), manualURLs: true });
    await fs.writeFile(path.join(evidenceRoot, 'actual-published-packet-resource-audit.json'), JSON.stringify({ ...actual, authoritativeInput: 'Actual current published URL', noAuxiliaryPreviewOriginsAllowed: true }, null, 2));
    assert.deepEqual(actual.failures, [], 'ALL actual current report/guide/archive links and interactive assets must work without retired helper servers');
    observations.push({ scenario: 'BB2-complete-resources', actualPacketAudited: true, documents: actual.documents.length, resourceEdges: actual.references.length, checkedResources: actual.checkedResources, allValid: true });
  } else observations.push({ scenario: 'BB2-complete-resources', generatedProductionPacketAudited: true, activeHumanPacketNotClaimed: true, actualLiveAuditRequires: 'AITEAM_QA_REVIEW_URL', documents: generatedAudit.documents.length, resourceEdges: generatedAudit.references.length, allValid: true });
}
async function captureFixtureMedia() {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  for (const variant of ['before', 'after']) {
    await page.setContent(`<main style="font:24px system-ui;padding:40px;background:${variant === 'before' ? '#182733' : '#315565'};color:white;height:280px"><h1>${variant} — QA fixture</h1><p>Actual browser capture of a synthetic document scenario.</p></main>`);
    await page.screenshot({ path: path.join(packet, `${variant}.png`) });
  }
  const clip = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    document.body.append(canvas); const context = canvas.getContext('2d');
    const chunks = []; const recorder = new MediaRecorder(canvas.captureStream(12), { mimeType: 'video/webm;codecs=vp8' });
    const completion = new Promise(resolve => { recorder.ondataavailable = e => chunks.push(e.data); recorder.onstop = async () => resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]); });
    recorder.start(); let count = 0;
    const timer = setInterval(() => { context.fillStyle = '#182733'; context.fillRect(0, 0, 320, 180); context.fillStyle = '#eef5f7'; context.font = '20px sans-serif'; context.fillText('Synthetic QA clip ' + count++, 20, 90); }, 70);
    await new Promise(resolve => setTimeout(resolve, 1100)); clearInterval(timer); recorder.stop();
    return completion;
  });
  await fs.writeFile(path.join(packet, 'fixture.webm'), Buffer.from(clip)); await page.close();
}
async function authorPacket({ nonvisual = false, origin = mediaOrigin, packetURL = watchOrigin + '/artifacts/qa-T1.html' } = {}) {
  // This is ordinary authoring of the published HTML template, not a generator API.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage(); await page.setContent(template);
  await page.evaluate(({ nonvisual, origin, watchOrigin, repo, packetURL }) => {
    document.title = 'T1 synthetic QA packet';
    document.querySelector('h1').textContent = 'T1 — synthetic reviewer fixture';
    document.querySelector('.meta').textContent = 'Task: T1-FIXTURE · Revision: fixture-v1 · Prepared: 2026-11-05 · Synthetic evidence only';
    document.querySelector('.notice').textContent = 'Synthetic QA fixture: actual browser captures and deliberate test outcomes; no real product or human approval is claimed.';
    const section = (id, html) => { const element = document.getElementById(id); const heading = element.querySelector('h2').outerHTML; element.innerHTML = heading + html; };
    section('criteria', '<table><thead><tr><th>Criterion</th><th>Expected observation</th><th>Evidence</th></tr></thead><tbody><tr><td>AC-F1</td><td>Read the reviewed identity and open labeled evidence.</td><td>Fixture command receipts; human readability pending.</td></tr></tbody></table>');
    section('startup', `<p>Prerequisites: Node.js20+ and this disposable QA repository. Working directory: <code>${repo}</code>.</p><pre data-startup>node -e "console.log('fixture service readiness: ready')"</pre><p>Readiness: expect “fixture service readiness: ready”, exit0. Packet URL: <a href="${packetURL}">Open fixture packet</a>.</p><p>Cleanup: this command exits itself; the test harness stops only its owned Watcher/media PIDs. No other service is required for the readiness check.</p>`);
    section('manual', '<ol><li>Open this packet. Expected: T1-FIXTURE and fixture-v1 are visible.</li><li>Read the outcomes. Expected: deliberate failure, skipped and stale results stay distinct from passing evidence.</li><li>Inspect applicable evidence, then return to the existing gate. Expected: the page remains Pending human review until an explicit reviewer decision.</li></ol>');
    section('tests', `<p>Actual synthetic fixture commands and observed results. These are not live product QA results.</p><table><thead><tr><th>Command/check</th><th>Observed result</th><th>Receipt</th></tr></thead><tbody><tr><td>node -e "process.exit(0)"</td><td>Passed · observed exit0</td><td><a href="${origin}/results.json">Actual fixture receipts</a></td></tr><tr><td>node -e "process.exit(7)"</td><td>Failed · observed exit7 · deliberate negative case</td><td>Actual fixture receipts</td></tr><tr><td>Device-only demonstration</td><td>Skipped · no physical device required by synthetic fixture</td><td>Not executed</td></tr><tr><td>Future follow-up</td><td>Unrun · planned only</td><td>No pass claimed</td></tr><tr><td>Prior fixture-v0 capture</td><td>Stale · superseded identity</td><td>Not evidence for fixture-v1</td></tr><tr><td>Readability judgment</td><td>Pending human review</td><td>Automation does not approve</td></tr></tbody></table>`);
    const evidence = document.getElementById('evidence');
    evidence.querySelector('p').textContent = nonvisual ? 'Not applicable: this nonvisual fixture checks command outcomes; screenshots/video would not add evidence.' : 'Actual browser captures and clip of a synthetic QA document, not a live product change.';
    if (nonvisual) { evidence.querySelector('.controls').remove(); evidence.querySelectorAll('figure').forEach(el => el.remove()); }
    else {
      for (const figure of evidence.querySelectorAll('figure')) {
        const label = figure.dataset.evidence;
        figure.innerHTML = `<img src="${origin}/${label}.png" alt="${label} synthetic document capture"><figcaption>${label} — actual browser capture of synthetic QA fixture</figcaption>`;
      }
      const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.src = origin + '/fixture.webm'; video.setAttribute('aria-label', 'Synthetic runtime clip'); evidence.append(video);
    }
    section('decision', `<p>Pending human review. This is evidence only: use the <a href="${watchOrigin}">existing Watcher gate</a> or reply in chat. Viewing or comparison controls do not record approval. The facilitator keeps aiteam_wait_for_approval active; actual chat responses are recorded verbatim.</p>`);
  }, { nonvisual, origin, watchOrigin, repo, packetURL });
  const result = await page.content(); await context.close(); return result;
}

async function prepareInteractiveFixture() {
  const assets = path.join(repo, '.aiteam/reviews/QA-interactive');
  await fs.mkdir(assets, { recursive: true });
  // An explicitly synthetic narrow version; the real prior source is exercised
  // separately by AITEAM_QA_REVIEW_URL, not inferred from screenshot pixels.
  const narrow = template.replace('</style>', '.sample{max-width:560px}</style>');
  await fs.writeFile(path.join(assets, 'before.html'), narrow);
  await fs.writeFile(path.join(repo, '.aiteam/docs/qa-interactive-current.html'), template);
  const beforeURL = watchOrigin + '/review-assets/QA-interactive/before.html#evidence';
  const afterURL = watchOrigin + '/artifacts/qa-interactive-current.html#evidence';
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage(); await page.setContent(template);
  await page.evaluate(({ beforeURL, afterURL }) => {
    document.querySelector('h1').textContent = 'Synthetic working evidence fixture';
    const evidence = document.querySelector('#evidence');
    evidence.innerHTML = '<h2>Working HTML evidence, not a screenshot</h2><div class="controls" role="group" aria-label="Compare actual template versions" hidden><button type="button" aria-pressed="false">Before</button><button type="button" aria-pressed="true">After</button></div><iframe id="interactive-evidence" class="evidence-preview" title="Working template evidence" sandbox="allow-scripts"></iframe><p><a target="_blank" rel="noopener noreferrer">Open previous template full page</a> · <a target="_blank" rel="noopener noreferrer">Open current interactive page full size</a></p><noscript>Both full-page HTML versions are available without JavaScript.</noscript>';
    evidence.querySelector('iframe').src = afterURL;
    const links = evidence.querySelectorAll('a'); links[0].href = beforeURL; links[1].href = afterURL;
    const buttons = evidence.querySelectorAll('button'); buttons[0].dataset.source = beforeURL; buttons[1].dataset.source = afterURL;
    document.querySelectorAll('script').forEach(script => script.remove());
    const script = document.createElement('script');
    script.textContent = "const controls=document.querySelector('[aria-label=\"Compare actual template versions\"]');controls.hidden=false;for(const button of controls.querySelectorAll('button'))button.onclick=()=>{document.querySelector('iframe').src=button.dataset.source;for(const peer of controls.querySelectorAll('button'))peer.setAttribute('aria-pressed',String(peer===button));};";
    document.body.append(script);
  }, { beforeURL, afterURL });
  await fs.writeFile(path.join(repo, '.aiteam/docs/qa-interactive-fixture.html'), await page.content());
  await context.close();
  interactiveFixtureURL = watchOrigin + '/artifacts/qa-interactive-fixture.html#evidence';
}

async function verifyWorkingEvidencePage(url, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [], writes = [];
  await context.route('**/*', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  const page = await context.newPage(); await page.goto(url);
  const versions = page.getByRole('group', { name: 'Compare actual template versions', exact: true });
  assert.equal(await versions.count(), 1, 'actual operable version controls, not pixels resembling buttons');
  const frame = page.locator('iframe[title="Working template evidence"]');
  assert.equal(await frame.count(), 1);
  assert.equal((await frame.getAttribute('sandbox')).trim(), 'allow-scripts', 'only permissions needed by this read-only fixture');
  const beforeLink = page.getByRole('link', { name: 'Open previous template full page', exact: true });
  const afterLink = page.getByRole('link', { name: 'Open current interactive page full size', exact: true });
  const beforeURL = new URL(await beforeLink.getAttribute('href'), page.url()).href;
  const afterURL = new URL(await afterLink.getAttribute('href'), page.url()).href;
  assert.notEqual(beforeURL, afterURL); assert.ok([beforeURL, afterURL].every(value => new URL(value).pathname.endsWith('.html')));
  async function loaded(expected) {
    await waitUntil(async () => {
      const element = await frame.elementHandle(); const childFrame = await element.contentFrame();
      return childFrame?.url() === expected;
    }, 'working frame navigates to the selected actual HTML version');
    await page.frameLocator('iframe[title="Working template evidence"]').getByRole('button', { name: 'After', exact: true }).waitFor();
  }
  await versions.getByRole('button', { name: 'Before', exact: true }).click(); await loaded(beforeURL);
  assert.equal(await versions.getByRole('button', { name: 'Before', exact: true }).getAttribute('aria-pressed'), 'true');
  let inner = page.frameLocator('iframe[title="Working template evidence"]');
  await inner.getByRole('button', { name: 'After', exact: true }).click();
  const oldBox = await inner.locator('[data-evidence="after"] .sample').boundingBox();
  const outerAfter = versions.getByRole('button', { name: 'After', exact: true });
  await outerAfter.focus(); await page.keyboard.press('Space'); await loaded(afterURL);
  assert.equal(await outerAfter.getAttribute('aria-pressed'), 'true');
  inner = page.frameLocator('iframe[title="Working template evidence"]');
  const paneBox = await frame.boundingBox(), currentBox = await inner.locator('[data-evidence="after"] .sample').boundingBox();
  assert.ok(paneBox.width >= 1000 && currentBox.width >= 1000, 'desktop evidence uses readable rendered width');
  assert.ok(currentBox.width > oldBox.width * 1.5, 'current rendered component is materially wider than the narrow prior version');
  const innerBefore = inner.getByRole('button', { name: 'Before', exact: true }); await innerBefore.click();
  assert.equal(await innerBefore.getAttribute('aria-pressed'), 'true');
  assert.equal(await inner.locator('[data-evidence="before"]').isVisible(), true);
  assert.equal(await inner.locator('[data-evidence="after"]').isVisible(), false);
  const beforeText = await inner.locator('[data-evidence="before"]').innerText();
  const innerAfter = inner.getByRole('button', { name: 'After', exact: true }); await innerAfter.focus(); await page.keyboard.press('Enter');
  assert.equal(await innerAfter.getAttribute('aria-pressed'), 'true');
  assert.equal(await inner.locator('[data-evidence="after"]').isVisible(), true);
  assert.equal(await inner.locator('[data-evidence="before"]').isVisible(), false);
  assert.notEqual(await inner.locator('[data-evidence="after"]').innerText(), beforeText, 'real visible inner component changes');
  const opened = context.waitForEvent('page'); await afterLink.click(); const fullPage = await opened;
  await fullPage.waitForURL(afterURL); assert.ok((await fullPage.locator('[data-evidence="after"] .sample').boundingBox()).width >= 1000);
  await fullPage.close();
  await page.screenshot({ path: path.join(evidenceRoot, `${label}-interactive-desktop.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok((await frame.boundingBox()).width <= 390);
  assert.ok(await inner.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth));
  await inner.getByRole('button', { name: 'Before', exact: true }).click();
  assert.equal(await inner.locator('[data-evidence="before"]').isVisible(), true);
  await page.screenshot({ path: path.join(evidenceRoot, `${label}-interactive-mobile.png`) });
  await context.close();
  const noJS = await browser.newContext({ javaScriptEnabled: false }); const fallback = await noJS.newPage(); await fallback.goto(url);
  assert.equal(await fallback.getByRole('link', { name: 'Open previous template full page', exact: true }).isVisible(), true);
  assert.equal(await fallback.getByRole('link', { name: 'Open current interactive page full size', exact: true }).isVisible(), true);
  const fallbackFrame = fallback.frameLocator('iframe[title="Working template evidence"]');
  assert.equal(await fallbackFrame.locator('[data-evidence="before"]').isVisible(), true);
  assert.equal(await fallbackFrame.locator('[data-evidence="after"]').isVisible(), true);
  await noJS.close(); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  const result = { scenario: 'BB3-working-evidence', label, url, paneWidth: paneBox.width, priorComponentWidth: oldBox.width, currentComponentWidth: currentBox.width, actualVersionNavigation: true, innerPointerAndKeyboardChangeVisibleContent: true, fullSizeFallback: true, mobileFits: true, noJSLabeledFallback: true, noApprovalWrites: true };
  observations.push(result); await fs.writeFile(path.join(evidenceRoot, `${label}-interactive-observations.json`), JSON.stringify(result, null, 2));
}

async function verifyReturnedReviewLinks() {
  // Reproduce the human's failing surface, not merely the document-file list.
  // Public CLI/report artifacts populate a real isolated Watcher response.
  const linkRepo = path.join(sandbox, 'returned-links-project');
  await fs.mkdir(path.join(linkRepo, '.aiteam/docs'), { recursive: true });
  cli(linkRepo, 'init', '--request', 'Synthetic returned-link rendering fixture only');
  await fs.copyFile(path.join(repo, '.aiteam/docs/qa-T1.html'), path.join(linkRepo, '.aiteam/docs/qa-T1.html'));
  const { origin } = await startWatcher(linkRepo);
  const packetURL = origin + '/artifacts/qa-T1.html';
  const reportURL = mediaOrigin + '/results.json?label=Read%20me&value=one%26two';
  const manualURL = mediaOrigin + '/results.json?surface=manual&case=1';
  const secureURL = 'https://qa-renderer.invalid/review?label=Read%20me&value=one%26two';
  const unsafeText = '<img src=x onerror="window.__qaInjected=1"> javascript:alert(1) data:text/html,<svg/onload=alert(1)>';
  const questions = [`Open ${manualURL} and inspect the actual fixture receipt.`, `Preserve this literal text: ${unsafeText}`];
  const run = JSON.parse(cli(linkRepo, 'stage-start', '--stage', 'intake')).run;
  const returnedResult = {
    outcome: 'PASS_WITH_MANUAL_VALIDATION',
    summary: `Synthetic review summary: [Open review](${packetURL}). ${unsafeText}`,
    evidence: [`Review packet: ${packetURL}.`, `Named report: [Fixture receipts](${reportURL}).`, `Secure evidence: ${secureURL}.`],
    checks: [
      { name: 'Synthetic observable receipt', expected: `Read ${reportURL}`, actual: `Observed ${reportURL}`, passed: true },
      { name: 'Boolean unsuccessful fixture', actual: 'Observed deliberate negative fixture', passed: false },
      { name: 'String successful fixture', actual: 'Observed supported string outcome', status: ' pass ' },
      { name: 'Explicit failure precedence fixture', actual: 'Observed explicit negative outcome', status: 'FAIL', passed: true },
      { name: 'Pending precedence fixture', actual: 'Observed awaiting user judgment', status: 'PENDING', passed: true },
      { name: 'Skipped string fixture', actual: 'Observed not executed for this fixture', status: ' skipped ' },
      { name: 'Unknown supplied status fixture', actual: 'Observed unfamiliar producer vocabulary', status: 'future-format', passed: true },
      { name: 'Missing outcome fixture', actual: 'Observed outcome not supplied' }
    ],
    manualChecks: questions, requiresManualValidation: true
  };
  // The CLI run ID identifies the standard external-agent output artifact.
  // Writing fixture agent output is setup; assertions use the public API/UI.
  await fs.writeFile(path.join(linkRepo, '.aiteam/runs', run.runId + '.stdout.txt'), JSON.stringify(returnedResult));
  cli(linkRepo, 'stage-complete', '--stage', 'intake', '--result', JSON.stringify({ ...returnedResult, outcome: 'AWAITING_USER', questions }));
  cli(linkRepo, 'request-approval', '--gate', 'qa', '--taskId', 'T1', '--kind', 'qa-manual', '--questions', JSON.stringify(questions));
  const before = await (await fetch(origin + '/api/state')).json();
  assert.equal((before.currentResult || before.latestEvidence?.result)?.summary, returnedResult.summary, 'public stage-completion result is recognized');
  assert.equal(before.session.pendingUserInput.kind, 'qa-manual');
  const context = await browser.newContext();
  await context.route('https://qa-renderer.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Controlled HTTPS QA fixture</h1>' }));
  const page = await context.newPage(); const errors = []; const writes = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  await page.goto(origin);
  const resultPanel = page.locator('#result');
  await resultPanel.getByText(/Synthetic review summary/).waitFor();
  await page.screenshot({ path: path.join(evidenceRoot, 'returned-check-labels.png'), fullPage: true });
  const expectedLabels = [
    ['Synthetic observable receipt', 'PASS', `Observed ${reportURL}`],
    ['Boolean unsuccessful fixture', 'FAIL', 'Observed deliberate negative fixture'],
    ['String successful fixture', 'PASS', 'Observed supported string outcome'],
    ['Explicit failure precedence fixture', 'FAIL', 'Observed explicit negative outcome'],
    ['Pending precedence fixture', 'PENDING', 'Observed awaiting user judgment'],
    ['Skipped string fixture', 'SKIPPED', 'Observed not executed for this fixture'],
    ['Unknown supplied status fixture', 'UNKNOWN', 'Observed unfamiliar producer vocabulary'],
    ['Missing outcome fixture', 'UNKNOWN', 'Observed outcome not supplied']
  ];
  for (const [name, status, actual] of expectedLabels) {
    const visibleRow = resultPanel.getByText(name, { exact: false }).first();
    assert.equal(await visibleRow.isVisible(), true, `visible check ${name}`);
    const rendered = await visibleRow.evaluate(el => (el.closest('li,tr') || el.parentElement).innerText);
    assert.match(rendered, new RegExp(`^\\s*\\[${status}\\]`), `rendered check label for ${name}`);
    assert.ok(rendered.includes(actual), `actual observation remains visible for ${name}`);
    assert.doesNotMatch(rendered, /\[undefined\]/);
  }
  async function follow(link, expectedURL, expectedBody) {
    assert.equal(await link.count(), 1, `actual clickable returned evidence link: ${expectedURL}`);
    assert.equal(await link.isVisible(), true);
    assert.equal(await link.getAttribute('target'), '_blank');
    const rel = (await link.getAttribute('rel') || '').split(/\s+/);
    assert.ok(rel.includes('noopener') && rel.includes('noreferrer'));
    assert.equal(await link.getAttribute('href'), expectedURL);
    const opened = context.waitForEvent('page'); await link.click(); const destination = await opened;
    await destination.waitForLoadState('domcontentloaded');
    assert.equal(destination.url(), expectedURL);
    assert.match(await destination.locator('body').innerText(), expectedBody);
    await destination.close();
  }
  await follow(resultPanel.getByRole('link', { name: 'Open review', exact: true }), packetURL, /T1.*synthetic reviewer fixture/);
  await follow(resultPanel.getByRole('link', { name: packetURL, exact: true }), packetURL, /T1.*synthetic reviewer fixture/);
  await follow(resultPanel.getByRole('link', { name: 'Fixture receipts', exact: true }), reportURL, /fixtureOnly/);
  await follow(resultPanel.getByRole('link', { name: secureURL, exact: true }), secureURL, /Controlled HTTPS QA fixture/);
  const checkLink = resultPanel.getByRole('link', { name: reportURL, exact: true });
  assert.ok(await checkLink.count() >= 1, 'returned observed checks expose their evidence URL');
  await follow(checkLink.first(), reportURL, /fixtureOnly/);
  for (const panel of ['#questions', '#liveLog']) {
    const manualLinks = page.locator(panel).getByRole('link', { name: manualURL, exact: true });
    assert.ok(await manualLinks.count() >= 1, `${panel} manual QA questions expose actionable links`);
    await follow(manualLinks.first(), manualURL, /fixtureOnly/);
  }
  const event = page.locator('#events details.event').filter({ hasText: /Review packet:/ }).first();
  assert.equal(await event.count(), 1, 'Recent Events retains fixture response evidence');
  await event.locator('summary').first().click();
  const eventLinks = event.getByRole('link', { name: packetURL, exact: true });
  assert.ok(await eventLinks.count() >= 1, 'Recent Events response evidence is clickable');
  await follow(eventLinks.first(), packetURL, /T1.*synthetic reviewer fixture/);
  assert.match(await resultPanel.innerText(), /<img src=x onerror=/);
  assert.equal(await page.locator('img[src="x"],svg[onload],a[href^="javascript:"],a[href^="data:"]').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.__qaInjected), 'undefined');
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  const after = await (await fetch(origin + '/api/state')).json();
  assert.deepEqual(after.session.approvals, before.session.approvals);
  assert.deepEqual(after.session.pendingUserInput, before.session.pendingUserInput);
  await page.screenshot({ path: path.join(evidenceRoot, 'returned-review-links.png'), fullPage: true });
  await context.close();
  observations.push({ scenario: 'BB2-returned-links', latestResultClicks: true, manualQaClickable: true, renderedCheckLabels: true, statusPrecedencePreserved: true, queryAndHttpsPreserved: true, hostileTextInert: true, liveOrFixtureApprovalsChanged: false });
}

describe('T1 approved manual-QA-page black-box plan', { concurrency: false, timeout: 120000 }, () => {
  before(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'aiteam-T1-qa-')); repo = path.join(sandbox, 'project'); packet = path.join(repo, '.aiteam/evidence'); docsRoot = path.join(sandbox, 'published-instructions');
    await fs.mkdir(path.join(repo, '.aiteam/docs'), { recursive: true }); await fs.mkdir(packet, { recursive: true }); await fs.mkdir(evidenceRoot, { recursive: true });
    cli(repo, 'init', '--request', 'Synthetic QA fixture only, never human approval');
    const launched = await startWatcher(repo); watchOrigin = launched.origin;
    mediaOrigin = (await staticServer(packet)).origin;
    const browserOptions = process.env.AITEAM_QA_CHROMIUM ? { executablePath: process.env.AITEAM_QA_CHROMIUM } : {};
    if (!browserOptions.executablePath) { try { await fs.access('/usr/bin/google-chrome'); browserOptions.executablePath = '/usr/bin/google-chrome'; } catch {} }
    browser = await chromium.launch({ ...browserOptions, headless: true, args: ['--no-sandbox'] });
    template = await fs.readFile(path.join(sourceRoot, 'skill/templates/manual-qa-review.html'), 'utf8');
    await captureFixtureMedia();
    const outcomes = [0, 7].map(code => { try { execFileSync(process.execPath, ['-e', `process.exit(${code})`]); return { command: `node -e "process.exit(${code})"`, exit: 0 }; } catch (error) { return { command: `node -e "process.exit(${code})"`, exit: error.status }; } });
    await fs.writeFile(path.join(packet, 'results.json'), JSON.stringify({ fixtureOnly: true, outcomes }, null, 2));
    await fs.writeFile(path.join(repo, '.aiteam/docs/qa-T1.html'), await authorPacket());
    await prepareInteractiveFixture();
    await fs.mkdir(path.join(docsRoot, '.agents/skills'), { recursive: true });
    await fs.cp(path.join(sourceRoot, 'skill'), path.join(docsRoot, '.agents/skills/aiteam'), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, 'skill/templates/AGENTS.skill.md'), path.join(docsRoot, 'AGENTS.md'));
    docsOrigin = (await staticServer(docsRoot)).origin;
  });
  after(async () => {
    await fs.writeFile(path.join(evidenceRoot, 'black-box-observations.json'), JSON.stringify({ fixtureOnly: true, humanApprovalClaimed: false, observations }, null, 2));
    await browser?.close();
    for (const proc of children) proc.kill('SIGTERM');
    await Promise.all([...servers].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('BB1 portable authoring and consistent public instruction handoff', async () => {
    const entrypoints = ['.agents/skills/aiteam/SKILL.md', '.agents/skills/aiteam/contracts/qa.md', '.agents/skills/aiteam/contracts/qa-planner.md', 'AGENTS.md'];
    for (const entry of entrypoints) {
      const url = docsOrigin + '/' + entry; const response = await fetch(url); assert.equal(response.status, 200);
      const content = await response.text();
      const references = [...content.matchAll(/\[[^\]]+\]\(([^)]+manual-qa-approval-pages\.md)\)/g), ...content.matchAll(/`([^`]+manual-qa-approval-pages\.md)`/g)];
      assert.ok(references.length, `visible, resolvable guide reference from ${entry}`);
      for (const match of references) { const guide = await fetch(new URL(match[1], url)); assert.equal(guide.status, 200); assert.match(await guide.text(), /# Manual QA approval pages/); }
    }
    const guide = await (await fetch(docsOrigin + '/.agents/skills/aiteam/guides/manual-qa-approval-pages.md')).text();
    for (const expected of [/aiteam_wait_for_approval/, /verbatim/i, /bypass/i, /loopback/i, /resume/i, /materially change/i, /raw captures|original captures/i, /code inspection is not a test/i]) assert.match(guide, expected);
    const templateLink = [...guide.matchAll(/\[[^\]]+\]\(([^)]+manual-qa-review\.html)\)/g)][0]; assert.ok(templateLink);
    assert.equal((await fetch(new URL(templateLink[1], docsOrigin + '/.agents/skills/aiteam/guides/manual-qa-approval-pages.md'))).status, 200);
    observations.push({ scenario: 'BB1', entrypoints: 4, portableGuide: true });
  });

  it('BB2 Watcher link and exact served evidence on owned loopback servers', async () => {
    const page = await browser.newPage(); await page.goto(watchOrigin);
    const link = page.getByRole('link', { name: /qa-T1\.html/ }); await link.waitFor();
    const href = await link.getAttribute('href'); assert.equal(new URL(href, watchOrigin).href, watchOrigin + '/artifacts/qa-T1.html');
    const popupPromise = page.waitForEvent('popup'); await link.click(); const popup = await popupPromise; await popup.waitForLoadState();
    assert.equal(popup.url(), watchOrigin + '/artifacts/qa-T1.html');
    await assertBytes(popup.url(), path.join(repo, '.aiteam/docs/qa-T1.html'), /text\/html/);
    for (const [name, mime] of [['before.png', /image\/png/], ['after.png', /image\/png/], ['fixture.webm', /video\/webm/], ['results.json', /application\/json/]]) await assertBytes(mediaOrigin + '/' + name, path.join(packet, name), mime);
    await assertBytes(watchOrigin + '/api/screenshot?path=' + encodeURIComponent('.aiteam/evidence/after.png'), path.join(packet, 'after.png'), /image\/png/);
    assert.notEqual((await fetch(watchOrigin + '/artifacts/results.json')).status, 200);
    assert.notEqual((await fetch(watchOrigin + '/api/screenshot?path=' + encodeURIComponent('../outside.png'))).status, 200);
    const sentinel = await staticServer(packet); assert.equal((await fetch(sentinel.origin + '/results.json')).status, 200);
    const extra = await startWatcher(repo); extra.proc.kill('SIGTERM');
    assert.equal((await fetch(sentinel.origin + '/results.json')).status, 200, 'owned cleanup leaves unrelated sentinel service running');
    await popup.close(); await page.close(); observations.push({ scenario: 'BB2', watcherLinked: true, exactMediaBytes: true });
    await verifyReturnedReviewLinks();
    await verifyCompletePacketResources();
  });

  it('BB3 responsive keyboard/media behavior and readable no-JavaScript fallback', async () => {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 } }); const errors = []; page.on('pageerror', error => errors.push(String(error)));
      await page.goto(watchOrigin + '/artifacts/qa-T1.html');
      for (const heading of ['Acceptance criteria', 'Start services or application', 'How to manually test', 'Tests performed', 'Evidence showing the change', 'Remaining observations and decision']) assert.equal(await page.getByRole('heading', { name: heading, exact: true }).count(), 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const beforeButton = page.getByRole('button', { name: 'Before', exact: true }); await beforeButton.focus(); await page.keyboard.press('Enter');
      assert.equal(await beforeButton.getAttribute('aria-pressed'), 'true'); assert.equal(await page.getByAltText('before synthetic document capture').isVisible(), true);
      assert.ok(await beforeButton.evaluate(el => getComputedStyle(el).outlineStyle !== 'none'));
      const box = await beforeButton.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44);
      await page.keyboard.press('Tab'); await page.keyboard.press('Space');
      assert.equal(await page.getByRole('button', { name: 'After', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      const video = page.getByLabel('Synthetic runtime clip'); assert.equal(await video.evaluate(el => el.controls && !el.autoplay), true);
      await video.evaluate(async el => { el.muted = true; await el.play(); }); await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1); await video.evaluate(el => el.pause());
      for (const anchor of await page.locator('nav a').all()) assert.equal(await page.locator(await anchor.getAttribute('href')).count(), 1);
      assert.deepEqual(errors, []); await page.screenshot({ path: path.join(evidenceRoot, `fixture-${width}.png`), fullPage: true }); await page.close();
    }
    const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage(); await page.goto(watchOrigin + '/artifacts/qa-T1.html');
    assert.equal(await page.getByAltText('before synthetic document capture').isVisible(), true); assert.equal(await page.getByAltText('after synthetic document capture').isVisible(), true);
    assert.match(await page.locator('body').innerText(), /AC-F1/); await context.close(); observations.push({ scenario: 'BB3', viewports: [1280, 390], keyboard: true, videoPlayed: true, noJsEvidenceVisible: true });
    await verifyWorkingEvidencePage(interactiveFixtureURL, 'generated');
    if (process.env.AITEAM_QA_REVIEW_URL) await verifyWorkingEvidencePage(process.env.AITEAM_QA_REVIEW_URL, 'actual-published');
  });

  it('BB4 honest failed/skipped/stale/no-media states and reverified startup', async () => {
    const nonvisual = await authorPacket({ nonvisual: true }); await fs.writeFile(path.join(repo, '.aiteam/docs/qa-nonvisual.html'), nonvisual);
    const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(String(error))); await page.goto(watchOrigin + '/artifacts/qa-nonvisual.html');
    const content = await page.locator('body').innerText();
    for (const status of [/Passed.*exit0/, /Failed.*exit7/, /Skipped/, /Unrun/, /Stale/, /Pending human review/, /Not applicable.*nonvisual/]) assert.match(content, status);
    assert.equal(await page.locator('img,video').count(), 0);
    const displayedCommand = await page.locator('[data-startup]').innerText(); const output = execFileSync(process.execPath, ['-e', "console.log('fixture service readiness: ready')"], { encoding: 'utf8' });
    assert.equal(displayedCommand, 'node -e "console.log(\'fixture service readiness: ready\')"'); assert.match(output, /fixture service readiness: ready/);
    const receipts = await (await fetch(mediaOrigin + '/results.json')).json(); assert.deepEqual(receipts.outcomes.map(item => item.exit), [0, 7]);
    const resumed = await staticServer(packet); assert.notEqual(resumed.origin, mediaOrigin); await assertBytes(resumed.origin + '/results.json', path.join(packet, 'results.json'), /application\/json/);
    assert.notEqual((await fetch(resumed.origin + '/../outside-secret.txt')).status, 200);
    assert.deepEqual(errors, []); await page.close(); observations.push({ scenario: 'BB4', observedExits: [0, 7], nonvisualNoErrors: true, resumedUrlReverified: true });
  });

  it('BB5 evidence is read-only; synthetic public listener and verbatim decisions', async () => {
    await fs.writeFile(path.join(repo, '.aiteam/docs/prd.html'), '<h1>Synthetic PRD fixture, not real approval</h1>');
    cli(repo, 'request-approval', '--gate', 'prd', '--kind', 'prd-review', '--doc', '.aiteam/docs/prd.html', '--stage', 'intake');
    const initial = await (await fetch(watchOrigin + '/api/state')).json();
    await fs.writeFile(path.join(evidenceRoot, 'synthetic-pending-state.json'), JSON.stringify(initial, null, 2));
    assert.equal(initial.session.pendingUserInput.gate, 'prd');
    assert.equal(initial.session.pendingUserInput.response, null);
    const page = await browser.newPage(); const writes = []; page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    await page.goto(watchOrigin + '/artifacts/qa-T1.html'); await page.getByRole('button', { name: 'Before', exact: true }).click(); await page.getByRole('button', { name: 'After', exact: true }).click(); await page.reload();
    assert.deepEqual(writes, []); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    const unchanged = await (await fetch(watchOrigin + '/api/state')).json();
    assert.deepEqual(unchanged.session.approvals, initial.session.approvals);
    assert.deepEqual(unchanged.session.pendingUserInput, initial.session.pendingUserInput);
    let timedOut = false; try { cli(repo, 'wait-approval', '--gate', 'prd', '--timeoutMs', '160', '--pollMs', '40'); } catch (error) { timedOut = true; assert.match(String(error.stderr), /timeout|timed out/i); } assert.equal(timedOut, true);
    const listener = child(process.execPath, [bridge, 'wait-approval', '--repo', repo, '--gate', 'prd', '--timeoutMs', '10000', '--pollMs', '40']); let listenerOutput = ''; listener.stdout.on('data', data => { listenerOutput += data; });
    let resolved = false; const exit = new Promise(resolve => listener.once('exit', code => { resolved = true; resolve(code); })); await pause(200); assert.equal(resolved, false);
    await page.goto(watchOrigin); await page.getByRole('button', { name: /Approve Gate/ }).click(); assert.equal(await exit, 0); assert.match(listenerOutput, /APPROVED/);
    // A separate public CLI gate proves literal chat preservation without a live approval.
    const chatRepo = path.join(sandbox, 'chat-project'); await fs.mkdir(chatRepo); cli(chatRepo, 'init', '--request', 'Synthetic chat-only QA fixture'); cli(chatRepo, 'request-approval', '--gate', 'prd', '--kind', 'prd-review');
    await pause(1100);
    const literal = 'Synthetic reviewer said: approved — literal $HOME and `unchanged`, not a real human decision.';
    cli(chatRepo, 'record-approval', '--gate', 'prd', '--decision', 'approved', '--response', literal);
    const decision = JSON.parse(cli(chatRepo, 'wait-approval', '--gate', 'prd', '--timeoutMs', '1000', '--pollMs', '40')); assert.equal(decision.response, literal); assert.equal(decision.decision, 'APPROVED');
    await page.close(); observations.push({ scenario: 'BB5', fixtureOnly: true, pageWrites: 0, listenerWaitsUntilExplicitDecision: true, literalResponsePreserved: true });
  });
});
