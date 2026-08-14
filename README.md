# codegrind

An AI-coached interview-prep trainer. It writes you a problem, runs your answer in a
locked-down container, and then tells you what you actually did wrong — not "wrong
answer", but which pattern you missed and what your complexity really was.

It is a single-user app you run on your own machine. Everything lives in one SQLite
file; every LLM call is one you triggered, so an idle instance costs nothing.

**Who it is for:** somebody grinding toward interviews who wants a coach rather than a
scoreboard. You do not pick topics or difficulty — the scheduler does, from what you
have actually solved.

**Languages:** JavaScript, Python and Go are wired up end to end. Java is deliberately
half-finished (see [docs/adding-a-language.md](docs/adding-a-language.md)).

---

## Quickstart

```
git clone git@github.com:Hexidecibel/codegrind.git
cd codegrind
bin/setup
```

That is the whole thing. There is no file to edit first — no `.env` to fill in, no API
key on disk. `bin/setup` checks what it needs, installs, builds, migrates, builds the
sandbox images, starts the server, and tells you where to go:

```
codegrind setup  /home/you/src/codegrind

  ✓ node v22.22.0
  ✓ docker 29.1.3
  ✓ disk 540 GB free on /var/lib/docker
  ✓ .env written (port 9416, data /home/you/src/codegrind/data)
  · installing dependencies (npm, a minute or two the first time)…
  ✓ dependencies installed
  · building the client (typecheck + bundle; Monaco makes this the slow part)…
  ✓ client built
  · preparing the database…
  ✓ database ready — schema v3, 0 problems, 0 attempts, 0 lessons, 0 settings
  ✓ runner images: javascript python go (already done)
  · starting the server…
  ✓ listening on http://localhost:9416

  → open http://localhost:9416 to finish setup
    It will ask for an Anthropic API key, then stock your problem bank.

    bin/status  how it is doing      bin/stop   stop the server
    bin/logs    tail the log         bin/setup  safe to run again
```

On a machine that has not built the sandbox images before, the images line instead
reads `· building sandbox images: javascript python go (first time only; several
minutes)…` and takes a few minutes and ~3 GB of disk. A re-run of `bin/setup` after
that skips everything unchanged and finishes in about half a second — it is meant to be
re-run.

The browser then walks you through four screens: paste an Anthropic key (checked against
Anthropic before it is stored), pick a language, optionally stock the bank with 8
starter problems, and start your first session.

### What you need first

| | |
|---|---|
| **Node 20 or 22** | **Not Node 24.** `better-sqlite3` is ABI-pinned and hard-crashes under it. `bin/setup` detects this and tells you what to run. |
| **Docker** | Daemon reachable, and you in the `docker` group. Every submission runs in a `--network none --read-only --cap-drop=ALL` container. There is no fallback that runs your code in-process. |
| **~3 GB free disk** | Where Docker stores images. `bin/setup` hard-stops below 3 GB and warns below 6. |
| **A free port** | 9416 by default. `bin/setup --port 9500` moves it and writes it to `.env`. |
| **An Anthropic API key** | Asked for **in the browser**, not before `bin/setup`. It is stored in the database, never in `.env`. |

Nothing else. No secret manager, no external services.

### Setup flags

```
bin/setup                 # everything, then start the server
bin/setup --port 9500     # bind somewhere else (writes it to .env)
bin/setup --no-start      # prepare everything, start nothing
bin/setup --force         # redo the install and the build even if unchanged
bin/setup --check         # preflight only: report, change nothing
```

---

## The daily loop

Four tabs. Three of them are the loop.

**Grind** — the main event. Press start and the app plans a sitting, then serves one
problem at a time. It picks each one itself from an intent: `warm-up`, `reinforce`,
`variation`, `level-up`, `new-pattern` or `review`, and tells you which and why. You
write code, hit Run against the sample tests (free, no AI), then Submit against the
hidden tests — which grades you, records the attempt, and returns a coaching brief:
the pattern you should have recognised, your complexity against the optimal, and what
to fix. Ask follow-up questions inline. "Show me the answer" is always available and is
recorded, not refused — a revealed problem just does not earn tier credit.

**Study** — a reading track alongside the grind. Lessons and pattern primers, ordered
against your actual mastery, with personalized slots generated from your own mistake
history. Prose is shared across languages; only the code snippets are translated.

**Reflect** — what you have actually done: the skill tree, the tier ladder, a mistake
ledger, an activity heatmap and trend charts. Per-language, except your streak and your
lessons-read count, which are global.

(**Manual** is the fourth tab: pick a topic and difficulty yourself. It is also where
the language picker lives.)

Progression is a tier ladder per topic: **3 distinct problems solved at a difficulty
with zero hints** completes that tier, and completing `easy` on a topic's prerequisites
unlocks the topics downstream of it.

---

## Multi-language

The one idea everything follows from:

> **Language is a property of the problem, not of the submission.**

A problem's `expected` values are produced by running its reference solution in the
sandbox, so its test data is bound to the language that produced it. Therefore
`POST /api/run` and `POST /api/submit` carry only `{problemId, code}` — no language.
The server reads `problem.language`. Handing Python source to the JavaScript harness is
not unlikely, it is *unrepresentable*.

Everything else falls out of that:

- **The bank forks.** Each language has its own problems. There is deliberately no
  cross-language fallback, so a new language's bank starts empty and its first problems
  are cold 15–30s generates. `bin/seed-bank --language go` is the mitigation.
- **Skills, tiers and unlocks fork, and start cold on purpose.** A tier means "3
  distinct problems solved at this difficulty with zero hints." You have not done that
  in Go. Transferring the unlock would serve a Go beginner expert-tier problems on day
  one. Nothing is lost — your JavaScript state is untouched and waiting when you switch
  back.
- **Your streak and your lessons-read count stay global.** A streak is a habit metric:
  Python yesterday plus Go today is a two-day streak. And you have already read the
  lesson; re-reading it is not the gap.
- **Lesson prose is shared, snippets are translated.** Lesson bodies contain no code by
  construction (the prompt forbids fenced code in a body and puts code in a separate
  field), so the corpus is written once and only its snippets fork — 18 batched
  translation calls per language instead of 90–180 generation calls.

Switching language changes what gets served next, never what is on screen. The solve
surface shows a read-only language badge for exactly that reason.

---

## Architecture, briefly

```
browser (React + Vite, Monaco on desktop / CodeMirror on mobile)
   │  fetch /api/*
Hono server (single process, tsx)
   │
   ├── scheduler.service   free, deterministic: what to serve next
   ├── llm.service         Claude: generate, coach, hint, plan, lessons
   ├── bank.service        generate → canonicalize → store
   ├── sandbox.service ──► bin/run-submission ──► docker run --network none --read-only
   └── db.ts               one SQLite file, WAL
```

A generated problem is not trusted until its reference solution has been *run*: the
sandbox's output becomes the stored `expected`, which is why every problem you are
served is guaranteed solvable and why a generate takes 15–30 seconds.

A language is described in four places, each owning a different kind of fact —
`src/shared/languages.ts` (presentation), `bin/lib/languages.sh` (Docker),
`src/server/services/llm.language.ts` (prompts), `test-harness/<lang>/` (the harness).
`src/shared/languages.test.ts` is what makes a half-added language fail loudly.

Read next:

- **[docs/architecture.md](docs/architecture.md)** — the request path, the data model,
  how `settings` works, the client structure.
- **[docs/adding-a-language.md](docs/adding-a-language.md)** — the contract for a fourth
  language, as a checklist.
- **[docs/operations.md](docs/operations.md)** — every `bin/` script, backups and restores, systemd.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — the failure modes and their
  fixes.

## Development

```
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"   # or nvm use 22
npx vitest run       # 319 tests, no database, no network, no docker
npx tsc -b           # typecheck
bin/build            # typecheck + bundle + precompress into dist/
```

The test suite is deliberately hermetic: nothing in it imports `db.ts` at module scope
against the live database, nothing calls Claude, nothing runs Docker.

## Three rules for contributors

1. **Every language-partitioned db accessor takes `language` as a required, leading,
   non-defaulted parameter.** An optional one would turn every missed call site into a
   silent cross-language read that looks perfectly correct on a JavaScript-only machine.
   Required means a missed site is a compile error. (`getProblem(id)` is the exception —
   the id carries its own language.)
2. **The API key never goes in `.env`.** See
   [docs/troubleshooting.md](docs/troubleshooting.md).
3. **Never put the database on mergerfs, NFS or NTFS.** SQLite's locking breaks there
   and it corrupts. NVMe/ext4 only.
