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
half-finished and this build does not offer it anywhere — the wizard, the language
picker and `PUT /api/settings` all derive that from `test-harness/java/` not existing
(see [docs/adding-a-language.md](docs/adding-a-language.md)).

**Models:** Claude, or any OpenAI-compatible endpoint you already run — llama.cpp,
llama-swap, vLLM, Ollama, LM Studio — including with no API key at all. You choose in
the browser on first run; see [Which model writes your problems](#which-model-writes-your-problems).

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
    It will ask which model should write your problems, then stock the bank.

    bin/status  how it is doing      bin/stop   stop the server
    bin/logs    tail the log         bin/setup  safe to run again
```

On a machine that has not built the sandbox images before, the images line instead
reads `· building sandbox images: javascript python go (first time only; several
minutes)…` and takes a few minutes and ~3 GB of disk. A re-run of `bin/setup` after
that skips everything unchanged and finishes in about half a second — it is meant to be
re-run.

The browser then walks you through four screens: **pick who writes the problems**
(Claude, or a model you already run yourself), pick a language, optionally stock the
bank with 8 starter problems, and start your first session.

### Which model writes your problems

codegrind is provider-agnostic, and this is the part worth knowing before you start.
The first wizard screen offers two paths, and neither of them is a text box you can
get subtly wrong:

- **Claude.** Paste an Anthropic key. It is checked against Anthropic before it is
  stored — a `models.list` call, which costs nothing — and then kept in this machine's
  SQLite database, never in `.env`. Best quality; a few cents an hour.
- **Your own model — any OpenAI-compatible endpoint.** llama.cpp, llama-swap, vLLM,
  Ollama, LM Studio, or anything else speaking `/v1/chat/completions`. Type the base
  URL including the `/v1` segment, press Models, and choose from what that server
  actually advertises in `GET /v1/models`. **No API key at all** is the normal case
  here; there is a collapsed field for the rare endpoint behind a gateway that wants a
  bearer token. Slower than Claude, and free.

Either way the choice is *proved before it is stored*, and the two paths prove
different things because different things go wrong. A key is checked with a real
`models.list` call against Anthropic — the only thing that tells a typo from a revoked
key. A local endpoint gets the harder test: a genuine **forced tool call** against the
model you picked, timed, so the screen can tell you roughly how long one generated
problem will take on it. Ten of this app's eleven LLM calls are forced tool calls, so a
model that answers with prose instead is refused right there, with a message naming the
likely fix (usually llama.cpp started without `--jinja`) rather than failing three
screens later inside a 30-second generate. Nothing is stored when the check fails.

A local install is never asked for an Anthropic key — not by the wizard, not by the
seed step, not by `bin/seed-bank`. Two roles are routed independently: the
**workhorse** (generation, hints, session plans, primers, lessons, coaching) and the
**tutor** (the chat behind `POST /api/ask`). The tutor defaults to matching the
workhorse's **provider**, so local stays local and no bill appears that nobody agreed
to; pointing one of them at Claude while the other runs locally is supported and opt-in.
On the Claude path the two **models** differ on purpose — the coach runs on the larger,
dearer one, because it is one call per question you actually ask. The wizard's last
screen and the Settings page both name the two models by the job they do, and Settings
can pin the coach to the same model that writes your problems. There is no failover — if your endpoint is down, calls fail
loudly and name the endpoint and the model rather than quietly becoming Claude calls.

All of it is changeable later from the **Settings** tab, which hosts the same control.
A deploy can pin any of it from the environment, which then wins over anything saved
in the browser — see [docs/operations.md](docs/operations.md#configuration).

### What you need first

| | |
|---|---|
| **Node 20 or 22** | **Not Node 24.** `better-sqlite3` is ABI-pinned and hard-crashes under it. `bin/setup` detects this and tells you what to run. |
| **Docker** | Daemon reachable, and you in the `docker` group. Every submission runs in a `--network none --read-only --cap-drop=ALL` container. There is no fallback that runs your code in-process. |
| **~3 GB free disk** | Where Docker stores images. `bin/setup` hard-stops below 3 GB and warns below 6. |
| **A free port** | 9416 by default. `bin/setup --port 9500` moves it and writes it to `.env`. |
| **Something to write the problems** | Either an **Anthropic API key** *or* an **OpenAI-compatible endpoint** you already run (llama.cpp, llama-swap, vLLM, Ollama, LM Studio). Asked for **in the browser**, not before `bin/setup`. A key is stored in the database, never in `.env`; a local endpoint usually needs no key at all. |

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

Five tabs. Three of them are the loop.

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
the language picker lives. **Settings** is the fifth, and the only one that is not a
place you practise: how you are currently routed, which model answers — the same
control the wizard's first screen uses, key and all — and the same language picker.)

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
   ├── llm.service         generate, coach, hint, plan, lessons — says WHAT it wants
   │    └── llm.client     …and this is the only file that knows WHO answers:
   │                       Anthropic, or an OpenAI-compatible endpoint
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
npx vitest run       # 448 tests, no database, no network, no docker
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
