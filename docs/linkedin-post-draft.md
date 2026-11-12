I wrote a dozen Pong games over the last few weeks. Here’s why.

Whenever I’m testing a new workflow or model setup, I need a small, visual project where I already know what "done" looks like. If the ball goes through the paddle, it’s broken.

So Pong became the testbed for a project I’ve been building called AITeam (https://github.com/bradmalia/aiteam).

At a high level, AITeam wraps a coding agent in an actual software engineering process—with separate roles for requirements, architecture, coding, code review, and QA—and pairs it with a live web dashboard.

I built it because I kept running into the same three frustrations using AI coding tools on real projects, and they’re the exact same problems I see engineering teams struggling with at scale:

1. Having no idea what the agent is doing (or how long it’ll take)
There is nothing worse than kicking off an AI task and staring at a terminal for 20 minutes wondering if it’s making progress, stuck in a retry loop, or quietly trashing your repo.
I built the AITeam Watcher dashboard so I could see what stage the work is in, read the live specialist logs as they stream, track how long each task is taking, and click through visual QA screenshots right in the browser.

2. AI loves to "overachieve" (and blow up its own context)
Ask an agent to fix one feature and it’ll happily decide to refactor four unrelated files while it’s in there. Once that happens, the context window fills up with noise and the model loses the plot. That’s a problem on frontier models, and it’s a total dealbreaker when you’re running smaller or cheaper models (I ran several of these Pong builds on local Qwen and Gemma models on a V100).
AITeam puts hard guardrails around each step. It breaks the work into a task ledger with strict acceptance criteria, and each specialist only gets the context for its single job. When you keep the scope that tight, even smaller models stay on the rails.

3. Letting the same agent write code and grade its own homework doesn't work
If the model that wrote the code also runs the review in the same session, it will rubber-stamp its own bugs almost every time.
Instead of inventing a new "AI workflow," I just enforced standard software engineering gates in code:
• It starts with clarifying questions and a Product Requirements Doc (PRD), followed by Architecture, UI, and QA plans in a Technical Design Doc (TRD). Nothing gets coded until you approve those in the dashboard.
• Every task then goes through a strict loop: Implementation, an isolated read-only Code Reviewer, and an isolated QA agent that writes and runs black-box Playwright tests.
• Once QA passes, the changed files are locked with a SHA-256 fingerprint before Git commit. If a file gets touched after QA, the commit is rejected and sent back for rework.

After beating up the workflow on a dozen Pong variations, I’ve been using it on much larger projects—including a full multi-player board game and a 2D platformer—with almost zero regressions making it to main.

Most of the pain teams are feeling with AI code right now isn't a model intelligence problem. It’s a process problem. Give the models the same visibility, scope limits, and independent QA gates you’d expect on a human engineering team, and the results get a lot more predictable.

I’ve attached a few screenshots of the live Watcher dashboard and the QA approval view below. If you want to check out how the state gates work, the code is here: https://github.com/bradmalia/aiteam

#SoftwareEngineering #AIAgents #QualityAssurance
