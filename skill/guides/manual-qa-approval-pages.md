# Manual QA approval pages

Create one concrete browser review page for **every task that already requires human manual QA**. Prepare and verify it before opening that gate. A reviewer should be able to understand the acceptance criteria, start the necessary services, reproduce the change, inspect the evidence, and submit a decision without reconstructing the task from chat history.

This procedure supplements the existing automated QA contract and human gates. Automation-only tasks retain their existing QA bypass. A page, screenshot, passing automated test, or elapsed wait never supplies human approval.

## 1. Start from the shipped template

Copy [manual-qa-review.html](../templates/manual-qa-review.html) to the target repository at `.aiteam/docs/qa-<safe-task-id>.html`. Use letters, numbers, dots, underscores or hyphens in the filename. Watcher already discovers top-level HTML files in `.aiteam/docs` and presents clickable document links. Keep the reusable skill template unchanged when preparing a project-specific packet.

Installed projects access this guide through `.agents/skills/aiteam/guides/manual-qa-approval-pages.md` and the template through `.agents/skills/aiteam/templates/manual-qa-review.html`. These are skill-relative locations; do not require another project or this machine’s absolute installation directory.

The template is a labeled, illustrative starting point. Replace its example task identity, commands, criteria, results and sample comparison before presenting a real packet. Delete irrelevant example sections rather than leaving broken image/video URLs. Preserve raw captures and reports separately from any assembled page.

## 2. Fill the review contract

Include all of these sections, adapting their detail to the task:

| Section | Required information |
| --- | --- |
| Identity and change | Task ID/title, concise resulting behavior, reviewed build/revision or artifact hashes, preparation time and actual gate state. Begin with **Pending human review**. A later approved state must identify the real recorded decision and its artifact scope. |
| Acceptance criteria | Stable AC IDs, user-observable expected outcomes, automated evidence and the judgment still pending from the human. |
| Start services or application | Prerequisites, exact working directory, resolved startup commands, safe configuration/test data, readiness checks, actual URLs and process-specific cleanup. Say when no additional service is needed. Omit credentials and redact sensitive log data. |
| Manual test steps | Numbered actions with an expected observable result for each step. Include initial state, reset/retry instructions and the environment or device needed. |
| Tests performed | Commands actually executed, observed result/exit status, relevant counts, revision/time and links to retained logs/reports. Keep planned or unrun checks separate. Code inspection is not a test run. |
| Evidence | Freeform, task-appropriate pictures, video, working interactive pages/components, browser artifacts, readable output or other useful content, associated with criteria. No fixed media set is mandatory. Caption runtime versus mock/staged/demo content and candidate versus production accurately. Preserve original files and source lineage where applicable. |
| Limits and remaining checks | Explicit failed, skipped, unrun, stale or pending-human items. For irrelevant media, say **Not applicable** and give a concrete reason. Missing useful evidence is a gap, not an N/A pass. |
| Decision | Actual Watcher link and a concise existing Watcher/chat approval path. The evidence page has no independent approval button, decision store or automatic gate mutation. |

Use the current task ledger and approved QA plan. Do not mark a human criterion passed merely because automation can measure a related property. A failed acceptance check is reported as failed and routed to rework; it is not hidden behind a polished page. Deliberate negative-case fixtures may show observed failures, clearly labeled as expected fixture behavior.

## 3. Serve the page through the correct Watcher

Prefer the exact repository-specific Watcher URL returned by the current tool or launch output. **Never assume port 4317 or reuse a localhost URL without checking the actual bind address and repository.** A localhost link does not establish that the listener is loopback-only.

1. Inspect occupied ports and the process behind the candidate listener (`ss -ltnp`, or the platform’s equivalent). For reuse, verify loopback binding, the repository returned by `/api/state`, and the intended page bytes.
2. If starting a preview, select an inspected unused high port from 1024–65535. A port race is handled by selecting another unused port; do not stop its occupant. The public Watcher CLI rejects port 0. Developer API fixtures may use `createWatchServer({repo, port:0, host:"127.0.0.1"})`.
3. Explicitly bind loopback. The public Node CLI supports `--host`; the shell wrapper forwards its supported `AITEAM_WATCH_HOST`/`AITEAM_WATCH_PORT` environment inputs, not arbitrary extra command flags.

Example setup, after selecting an unused port and resolving the project directory:

```bash
review_repo="$(pwd)"                       # Run from the actual project root.
review_port=48081                         # Example only: inspect and select a free high port.
ss -ltnp
```

Do not infer an AITeam source path from a symlink’s number of parent directories. For a real launch, obtain the installed AITeam source location from the environment/launcher and use its public Node CLI, or use the installed wrapper with the supported environment inputs:

```bash
# aiteam-watch must be the verified installed launcher (command -v aiteam-watch).
# Set review_repo and an inspected free review_port as above.
AITEAM_WATCH_HOST=127.0.0.1 AITEAM_WATCH_PORT="$review_port" \
  aiteam-watch "$review_repo" > /tmp/aiteam-review-watch.log 2>&1 &
review_watch_pid=$!
```

Alternatively run `node /actual/aiteam/source/src/watch-server.mjs --repo "$review_repo" --host 127.0.0.1 --port "$review_port"` using the verified source path. The expected readiness output names the URL and repository. Read the actual output, inspect the real bind address and process, then verify `/api/state` identifies `review_repo`. Record the PID only for a process you started. If the installed wrapper is unavailable, use the public Node CLI rather than inventing wrapper flags.

The canonical Watcher must remain available throughout human review. Use the project's supported detached launch lifecycle when an agent starts it, with stdin closed and stdout/stderr ignored or retained in a task log rather than tied to a short-lived tool pipe. Verify the actual listener/owner and HTTP repository response from a fresh independent process after the launcher exits. Record the exact supported command, bind, startup output and owned PID; do not assume that returning from a foreground tool call created a durable service.

The task-page URL is `<actual-watcher-origin>/artifacts/qa-<safe-task-id>.html`. Open the dashboard and click its visible document link to confirm that it reaches the same page as the chat handoff. Verify HTTP success, HTML content type and intended content/bytes. Do not substitute only a filesystem path for the reviewer’s clickable HTTP(S) link.

## 4. Make evidence URLs real

Keep task pages in `.aiteam/docs/qa-<safe-task-id>.html` and their retained evidence in `.aiteam/reviews/<safe-task-id>/`. Prefer **origin-relative Watcher URLs** so the packet follows whichever verified Watcher host/port the reviewer is actually using:

```html
<a href="/artifacts/qa-T1.html">Task review</a>
<a href="/review-assets/T1/results.json">Actual test results</a>
<img src="/review-assets/T1/desktop.png" alt="Actual desktop capture">
<video controls preload="metadata" src="/review-assets/T1/change.webm"></video>
```

The read-only `/review-assets/` route serves allowlisted HTML, JSON, text/log/Markdown/source, images, PDF and video **only within `.aiteam/reviews/`**, with byte-range support for clips. Encode each path segment and escape HTML attributes. It refuses traversal, symlink escapes and unsupported formats. Copy only the intended review evidence/source excerpts into that directory; do not expose secrets, unrelated files or `.aiteam/session.json`. Preserve raw files and their hashes. The legacy screenshot endpoint remains available for images, but it is not a video/report server.

Verify that the running Watcher actually supports the route. A backend update requires a controlled restart of the verified repository-owned Watcher process; refreshing an old dashboard tab alone cannot add server routes. Preserve the session and recorded decisions, use explicit loopback binding on the replacement, and verify the returned URL, repository, intended file bytes and process ownership again.

Do not publish a packet that silently depends on a temporary test server. Prefer retained files on the Watcher origin. If a project genuinely needs another preview service, retain its owned process through the entire human review, give exact startup/readiness/root/cleanup instructions, check the actual bind and every resource, and revalidate after restart. Never replace an unrelated listener. When an external/historical resource cannot be retained, show an explicit unavailable/stale note without a dead clickable link. Archive the original raw record separately; an obsolete URL in historical output is not a current startup instruction.

### Choose evidence and make it usable

Use the approval page as a freeform review surface. Choose a picture for a visual state, native playable video for motion/timing, a working page/component when interaction matters, a browser artifact or meaningful output where that better proves the criterion. Combine only useful types and omit irrelevant ones. Report any type through the page and ordinary `evidence` URLs; the existing `screenshots` array is an optional convenience for still captures, not an evidence-type restriction or new required schema.

An interactive feature needs a real operable artifact or a clearly labeled link to it. **A screenshot of Before/After buttons is still an image**, not a working comparison. Use real buttons that switch the intended evidence/content, or embed/link the actual page. A trusted same-origin read-only fixture can use a titled `iframe` with the least sandbox permissions it needs (the template shows an inert authoring example); always offer an open-full-page link and readable fallback. Do not embed the Watcher approval UI, silently grant unnecessary frame rights, or connect a review demo to unintended production writes. Keep comparison/media actions separate from approval state.

At desktop width, show the relevant content at a useful desktop scale. Inspect actual rendered bounds and text, not just a source file named `desktop.png`. Avoid shrinking a whole long page or constraining it to a narrow mobile-sized column; use a relevant viewport/section capture with original-size access, or prefer live content at native readable text size. State the actual capture viewport; label mobile captures separately and make them secondary when reviewing desktop behavior. Responsive evidence can fill its available desktop pane while still fitting390px screens.

Keep original captures and raw downloads unchanged. Images need descriptive alt/captions and original-size access when details matter; clips use native controls with metadata preload and no autoplay. The reusable template ships a working illustrative HTML comparison with both labeled figures available without JavaScript; replace it with appropriate real task evidence. Verify each chosen type's interaction/playback as well as its URLs. For nonvisual tasks, retain meaningful output and explain why particular media add no evidence.

## 5. Verify before asking the human

Perform actual checks and retain their observations:

- Inventory **every** outbound reference: `href`, `src`, `srcset`, poster/source/video/audio URLs, CSS `url(...)`, downloads, script-generated links and plain URLs in startup/manual instructions. Resolve relative references and fragments against the actual page URL, follow redirects, and recursively inspect reachable HTML guides/reports/archives. Verify fragment targets exist. Classify explicit unavailable/historical text separately; never leave a dead clickable reference.
- Request every inventoried page, image, clip, receipt, log, source and archive. Confirm HTTP status, final destination, content type and intended content/bytes (compare hashes with the local source where applicable). HTTP200 alone can be an unrelated error page. Retain an audit row per reference including its source page/field, resolved URL, intended file, observed status/content and fragment/media result. Recheck all links after editing the final packet; selected happy-path URLs are insufficient.
- Click the actual HTTP(S) approval/evidence links rendered in Watcher’s manual checklist and result/task evidence, then verify their destinations. A URL that works only when copied is not a successful handoff; testing only the separate artifact-filename link misses this defect. Use the returned Watcher URL, refresh the served dashboard after a rendering change, and confirm plain URLs or labeled Markdown links open the intended page without approval side effects.
- Load the page in a real browser. Verify images decode, clips load/play when present, comparison controls select the labeled evidence, section/report links work, and console/page errors are absent.
- Operate the evidence on the **actual approval page**, not only a separate fixture: switch every Before/After state, interact with embedded content or open its full page, play applicable clips and verify real visible changes. Measure useful desktop rendering and any frame's actual viewport; a reachable static screenshot containing a button does not prove interactivity. Preserve the no-JavaScript open-page/static fallback.
- Check a representative desktop viewport and 390px mobile width. The document should fit; genuinely wide tables/commands may scroll within their own regions. Use keyboard Tab/Enter/Space, visible focus, readable captions, and controls at least 44px high/wide where interactive.
- Disable JavaScript once. Core criteria, manual instructions and labeled evidence must remain readable. Optional comparison controls must not hide the only evidence.
- Confirm that viewing, reloading, navigating or playing evidence does not approve a task or write approval state. Test synthetic decisions only in disposable test repositories, never against the live human gate.
- Confirm process-specific cleanup. Stop only exact processes you started after review is finished. Do not stop the reviewer’s still-needed Watcher/preview or any reused/unrelated service. A complete packet should normally need only the retained Watcher, not extra fixture servers.

Store the actual validation receipt and useful desktop/mobile captures. The page can report developer checks while independent code review, QA or human judgment remains pending; label those stages honestly.

## 6. Publish, open the existing gate, and keep listening

1. Finish the required automated QA and the verified packet before handoff. Submit the real `checks`, `screenshots`, useful evidence/page URL and concise `manualChecks` through the normal QA result. Use the existing manual outcome (`PASS_WITH_MANUAL_VALIDATION` or equivalent required manual fields) when human validation is required. Preserve the existing fully automated bypass for tasks with no actionable human check.
2. Present the clickable page URL and the short remaining manual checklist in chat. Keep detailed steps on the page. Explain how the reviewer submits **Approve/Request Changes** through the existing Watcher gate or replies in chat.
3. **Immediately invoke the active `aiteam_wait_for_approval` listener for the current gate/task.** Do not only post the link and end the workflow. Keep the listener active using the tool’s supported wait/continuation mechanism; a returned actual decision should resume the server’s next directive without requiring a later “resume” message.
4. For a chat answer, call `aiteam_record_approval` using the actual gate/task, actual decision and **verbatim** human response, then continue the returned directive. Do not invent answers, self-approve, or apply an earlier task’s approval to this one.
5. A timeout, expired listener, interruption or elapsed time is not approval. Recheck `aiteam_status`; if the response is already recorded, process it and continue rather than asking again. If the same gate is still pending, establish a fresh listener. Do not reuse a completed/expired handle or reset a gate to erase a saved response.

Prefer the live MCP tools and their current schema. The CLI fallback is `node .agents/skills/aiteam/lib/state-bridge.mjs wait-approval --repo "$review_repo" --gate qa --taskId "$review_task"` for per-task QA; use the actual intake/PRD/TRD gate when that is the open gate. Recording CLI chat responses must preserve literal human words with proper argument handling; never interpolate them into executable shell code.

## 7. Resume and rework

Read the current session, reviewed revision and actual decision first. Verify that the Watcher still serves the correct repository and retained packet files; redo the **complete outbound-reference audit**, not only the top-level HTML request. Origin-relative artifact/asset links should follow a new verified Watcher origin without fixed helper ports. Restart only verified owned services as needed; retain prior evidence instead of silently overwriting its meaning.

If artifacts or behavior materially change, label stale results, rerun relevant tests/browser checks and route through the existing review/QA requirements before presenting the new version as approved. Preserve original evidence, reviewer response and artifact identity. Do not mutate fingerprint-covered implementation after QA approval without the existing revalidation path.

The server-owned setup order remains: intake/interview → PRD approval → Architecture → UI Design → Planning → **QA Test Planning** → Critical Review → **human TRD approval** → Environment Readiness. The task loop remains Implementation → independent Code Review → independent QA → actual required human QA decision (or existing automated bypass) → Maintainer Integration.
