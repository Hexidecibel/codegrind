# Architecture

One Node process. One SQLite file. Docker for execution, and one configured LLM for
everything that needs judgement — Claude, or any OpenAI-compatible endpoint you run
yourself; see [Who answers](#who-answers--the-llm-seam). No queues, no workers, no
second service.

```
src/
  shared/       types + the language registry, imported by BOTH sides
  server/
    index.ts    Hono app: mounts every route under /api, serves dist/ for the rest
    routes/     HTTP shape only — parse, delegate, serialize
    services/   all the actual behaviour
  client/       React SPA
bin/            every operational entry point
  lib/          sourced-not-executed: node.sh (which Node) + languages.sh (docker facts)
test-harness/   one sandbox harness per language + the shared conformance fixture
deploy/         systemd units
```

---

## The request path

### Serving a problem

```
POST /api/session/start
  └─ getActiveLanguage()            the language for the whole sitting, read ONCE
  └─ planSession()                  Claude, best-effort — falls back to DEFAULT_PLAN
  └─ nextIntent({language, plan})   scheduler.service — free, deterministic, no LLM
  └─ getAdaptiveProblem(intent)     bank.service
       ├─ findUnusedProblem(language, topic, difficulty)   a banked problem: instant
       └─ generateAndStore(...)     nothing banked: 15–30s
  └─ createSession(language, …)     the language is stored ON the session row
```

Two deliberate choices here.

**The scheduler is free.** `scheduler.service` runs on every problem and makes no LLM
call at all: it reads per-topic skill state and derived mastery and emits a
`SchedulerIntent` — `{kind, language, topic, difficulty, rationale}` where `kind` is
one of `warm-up`, `reinforce`, `variation`, `level-up`, `new-pattern`, `review`. The
Claude session planner only nudges it through `plan.focus`. This is why the app can be
adaptive per problem without being expensive per problem.

**The language rides on the intent**, not alongside it, so `getAdaptiveProblem(intent)`
cannot be handed a language that disagrees with the state the intent was computed from.
`POST /api/session/:id/next` reads the language back off the session row rather than
re-reading the setting, so flipping the picker mid-sitting cannot serve a problem the
plan was never built for.

### Generating a problem — and why it takes 15–30 seconds

```
generateAndStore(language, topic, difficulty)
  └─ generateProblem(...)           Claude, forced tool use → emit_problem
  └─ canonicalize()
       ├─ runTests(reference, sampleTests)  ─┐ the reference solution, in the sandbox
       └─ runTests(reference, hiddenTests)  ─┘
       └─ adopt each run's ACTUAL as the stored `expected`; drop tests the reference errors on
  └─ insertProblem({…, canonicalized})
```

The model does not get to decide what the right answer is. Every stored `expected` is
the output of really running the reference. That closes the most common generation
failure — a correct reference paired with a hand-authored `expected` that disagrees with
it, or one of several valid answers for an ambiguous case — and makes the problem
self-consistent by construction.

If too few tests survive (fewer than 1 sample or 4 hidden), it regenerates, up to
`MAX_GEN_ATTEMPTS = 3`.

**When the sandbox itself fails, the languages part ways.** JavaScript keeps a lenient
path: the problem is stored with the model's own `expected` values and stamped
`canonicalized = 0`, which keeps it out of every future bank read. Every other language
**throws**. The reasoning is in `bank.service.ts`: a missing runner image would otherwise
mint problems whose `expected` no real run can ever reproduce — unsolvable, served
silently, and the failure looks exactly like the player being wrong.

### Running a submission

```
POST /api/run     {problemId, code}    sample tests, no AI, records nothing
POST /api/submit  {problemId, code}    hidden tests + coaching + records an attempt
  └─ getProblem(problemId)             ← the language comes from HERE
  └─ runTests({language, functionName, userCode, tests})
       └─ sandbox.service writes  <id>.solution.<ext>  and  <id>.tests.json  into $DATA_DIR/tmp
       └─ execFile bin/run-submission <language> <solution> <tests>     (45s outer cap)
            └─ mktemp -d under $DATA_DIR/tmp; chmod 0711 / 0644
            └─ timeout -k 3 <CG_TIMEOUT> docker run --rm
                 --network none --read-only --cap-drop=ALL --security-opt no-new-privileges
                 --memory=<CG_MEMORY> --cpus=1 --pids-limit=<CG_PIDS>
                 --tmpfs <CG_TMPFS> --label codegrind.runner=1
                 -v <host work dir>:/work:ro
                 <CG_IMAGE> <CG_CMD> /work/<CG_SRCNAME> /work/tests.json
       └─ harness prints ONE JSON object to stdout
  └─ toRunResult()                     the seam: pure JSON → typed RunResult
  └─ coach()                           Claude, best-effort — a failure degrades, never loses the run
  └─ insertAttempt / updateSkillOnAttempt / review-queue bookkeeping
```

Neither request body carries a language. That is the whole design in one line.

**The harness contract.** Input is `{functionName, tests}`; output is one JSON object:

```
{ results: [{name, passed, expected, actual, stderr, stdout, timeMs}],
  passed, total,
  phase?: "compile" | "load" | "run",
  error?, stdout? }
```

`phase` is how a compiled language reports that nothing ever ran — it is what turns a JS
`SyntaxError`, a Python `IndentationError` and a Go build diagnostic into one
`compile_error` verdict, instead of the actively misleading "0 of 8 tests passed".
Verdicts: `accepted`, `wrong_answer`, `runtime_error`, `compile_error`, `timeout`,
`error`.

**Every runner hand-writes its own `deepEqual` and its own canonical JSON serializer**,
because the alternative is embedding a JS engine in the Python image. Hand-written
comparators drift, so `test-harness/conformance/equality-cases.json` is the single
fixture all of them are checked against by `<runner> --selftest`, which
`bin/build-runner-image` runs as a post-build gate. **An image that disagrees with the
fixture is deleted, not published.** The fixture also pins the things comparators
reliably get wrong: `{"$cg":"nan"|"inf"|"-inf"|"-zero"}` sentinels, a float tolerance of
`abs(a-b) <= max(1e-9, 1e-9*max(|a|,|b|))` that never applies to two integers and never
to a non-finite value, and sorted-key serialization so identical values render
identically.

**Budgets nest, and each one is strictly inside the next:** per-test (~2s) → run (~10s)
→ compile (~10s, compiled languages) → the container's `timeout` (`CG_TIMEOUT`: 12s
interpreted, 30s compiled) → `sandbox.service`'s own 45s `execFile` cap. If an outer one
fired first you would lose the structured partial results and see an opaque kill instead
of "3 of 8 passed, then this one hung."

---

## Who answers — the LLM seam

Nothing in this app talks to a vendor. `llm.service.ts` — every prompt, every schema,
all eleven calls — says *what* it wants and *what kind of call* it is, and one file
turns that into a client:

```
llm.service.ts     WHAT: "structured, this schema, this budget, role=workhorse"
  └─ llm.client.ts   WHO:  resolves the role → a configured LlmClient   ← the only
       ├─ llm.anthropic.ts   the Anthropic SDK                            file that
       └─ llm.openai.ts      anything speaking /v1/chat/completions       knows
  llm.types.ts     the contract all three share: LlmClient, ToolSpec, CallRole,
                   per-provider timeouts, the output-token ceiling
```

The word "provider" does not appear in `llm.service.ts`, and that is the design, not a
coincidence: a second implementation was added by adding **one branch to `clientFor`**,
and no call site changed or could tell. (The counter-example is one directory over in
soulseek-helper, where an `if` per function went out of step function by function.)

**Three call roles, two routes.** `CallRole` is `workhorse | small | tutor`.

| role | what it is | routed as |
|---|---|---|
| `workhorse` | generation, hints, session plans, primers, lessons, coaching | its own configuration |
| `small` | the cheap structured calls — classification, tagging, short rewrites | **the workhorse's client**, with a tighter timeout |
| `tutor` | the chat behind `POST /api/ask`, one call per question actually asked | its own configuration |

`small` deliberately has no configuration of its own. It exists so
`DEFAULT_TIMEOUT_MS` can give a 3-second classification a different budget from a
30-second generation without inventing a second model to configure;
`clientFor('small') === clientFor('workhorse')` and there is a test that says so.

**Resolution is two layers, and the environment wins field by field** — not wholesale,
so a deploy that pins only the model still lets the wizard choose an endpoint. The
environment is read **once at module load** (a misspelt provider is a boot error, not a
3am one); the stored layer is two rows in `settings`, `llm.workhorse` and `llm.tutor`,
written by the wizard and by Settings. `llm.client` does **not** import `db.ts` — it
would open a SQLite file at import time, and its own test re-imports the module
seventeen times under different environments. `provider.service.ts` pushes a reader in
through `useStoredProviderConfig` instead. Until something does, the stored layer is
simply empty, which is exactly right for a process that never opened a database.

Routing is resolved **lazily and cached**: a request must not be able to re-route a
running server, but a settings write has to take effect without a restart, so the cache
is invalidated by `reloadRouting()` and by nothing else.

**The tutor defaults to matching the workhorse — except on Anthropic, where it never
has.** A local install must stay local: no key, no signup, no spend, so an unconfigured
tutor inherits the workhorse's provider *and* model. On the Anthropic path the defaults
are `claude-sonnet-5` for the workhorse and `claude-opus-5` for the tutor, which is a
deliberate quality choice — but `storeProviderConfig` writes both rows from one
configuration, so nobody chose it and nothing said so. `roleDefaultModel()` now reports
each role's default through `GET /api/providers`, the wizard's Ready screen and Settings
name both models by the job they do, and Settings can pin the coach to the workhorse's
model (`chatModel` on `PUT /api/providers`; `null` restores the default). An absent
`chatModel` deliberately leaves an existing pin alone, because ProviderPicker's key form
posts `{provider:'anthropic'}` on every key save. `client/lib/role-summary.ts` is the
pure, tested half — including the rule that a local install, where both roles are the
same self-hosted model, is told about no cost at all.

**There is no failover.** A configured endpoint that is down produces failures naming
the endpoint and the model. They never silently become Anthropic calls.

`CODEGRIND_MODEL_DENY` is filtered out of the wizard's model list *and* refused at call
time — a list you cannot pick from is a better guard than an error after you did. The
ids it holds are facts about one machine's router, so they live in a systemd drop-in and
never in the repo. Every environment variable is tabulated in
[operations.md](operations.md#running-on-something-other-than-claude).

---

## The data model

One SQLite database at `$DATA_DIR/codegrind.db`, WAL mode. `db.ts` opens it at module
scope and runs `migrate()` from `db.migrate.ts` on import, inside one transaction — so
the server can never run against an unmigrated database. `SCHEMA_VERSION` is 3, stored
in `PRAGMA user_version`.

| table | key | language | notes |
|---|---|---|---|
| `problems` | `id` | `language` column | the bank. `canonicalized` gates serving. |
| `attempts` | `id` | `language` column | denormalized against `problems` on purpose |
| `sessions` | `id` | `language` column | a sitting keeps the language it started in |
| `skill_state` | **`(topic, language)`** | in the PK | spaced repetition + per-topic ladder |
| `review_queue` | `problemId` | via join | keyed on the problem, already correct |
| `revealed_solutions` | `problemId` | via join | the assistance ledger |
| `lessons`, `lesson_tracks`, `lesson_reads`, `pattern_primers` | — | **shared** | prose is language-free |
| `code_translations` | `(sourceId, language)` | in the PK | the only language-bound bytes in the corpus |
| `settings` | `key` | — | JSON values |

**Why a `language` column and not a `problem_variants` table.** A variant would fork
`starterCode`, `functionName`, `sampleTests`, `hiddenTests` and `referenceSolution` — 5
of 7 substantive columns plus the whole test payload — and would corrupt tier credit,
since clean solves are counted as DISTINCT `problemId` and one shared id would bank one
credit for two languages' work.

**Why `attempts.language` is denormalized.** Six accessors read `attempts` with no join
at all, and folding "Python indentation" and "JS hoisting" into one `syntax-error` tally
is worse than having no tally.

**Why only `skill_state` was rebuilt.** Lesson bodies contain no code by construction, so
the corpus needed no PK change — five table rebuilds collapsed to one, and every existing
read receipt and reading position stayed valid.

### The migration's own rules

`db.migrate.ts` takes the connection as an argument and owns no state, which is what
makes it testable (`db.migrate.test.ts`, 53 tests, in-memory). It has two tiers:

- **Always-run** steps — cheap and self-detecting (`addColumnIfMissing`, `CREATE TABLE
  IF NOT EXISTS`). Run every startup regardless of `user_version`, so a database whose
  version marker lies heals itself.
- **Versioned** steps — expensive or destructive (the `skill_state` rebuild, backfills).
  Gated on the marker, but each still detects its own real state, and two of them can
  **force the gate open**. That matters: `upsertSkillStmt` says `ON CONFLICT(topic,
  language)`, which against the old single-column key is a hard runtime error on the next
  submit, so a lying marker must not be the last word.

Three things it does that are easy to get wrong:

1. **`PRAGMA foreign_keys` is toggled OUTSIDE the transaction.** It is a documented
   no-op inside one — a migration that "disables" constraints on its own first line has
   disabled nothing.
2. **`DROP INDEX IF EXISTS` before recreating `idx_problems_slot`.** `CREATE INDEX IF NOT
   EXISTS` matches on *name*, so adding `language` to that line is a silent no-op on any
   database where the index already exists. It passes on a fresh database and rots on the
   real one.
3. **Row counts are snapshotted and re-verified inside the transaction**, and a
   mismatch throws. A rebuild-and-copy that drops rows still leaves a perfectly
   valid-looking database. A failed migration crash-loops against an **untouched**
   database, which is the correct failure mode.

---

## How `settings` works

A `settings(key, value JSON, updatedAt)` table, read through
`getSetting`/`setSetting`, with two named accessors on top:
`getActiveLanguage()`/`setActiveLanguage()`.

**Server-side, not localStorage**, and that is the point: the language decides what gets
*generated*, and generation happens on the server hours before any client asks for it
(`bin/seed-bank` overnight, `warmAhead` while you read). A preference the server cannot
see is not a preference, it is a display filter.

`getActiveLanguage()` is defensive on the way out — an unparseable row is treated as
unset, and a value this build does not know (`"kotlin"`) logs and falls back to
`javascript` rather than throwing.

`GET/PUT /api/settings` is the HTTP face. `PUT` is a partial update over a `WRITERS`
table, and **nothing is committed unless every field validates** — a half-applied
settings write is how you end up serving a language whose bank is empty.

### The API key is a setting, and it is not like the others

Two sources, and the ordering is a compatibility guarantee, not a preference:

1. **`ANTHROPIC_API_KEY` in the environment always wins.** An existing deploy keeps
   behaving exactly as it did and nothing the wizard writes can shadow it.
2. Otherwise, a row in `settings`, written by the first-run wizard.

`hydrate()` copies a stored key into `process.env.ANTHROPIC_API_KEY` at boot **only**
when the environment has none, so every existing consumer (`llm.service`, `bin/seed-bank`,
`bin/warm-lessons`, `bin/translate-corpus`) keeps reading the variable it always read.
`llm.service` re-creates its cached client when the value changes, so a key pasted into
the wizard is live without a restart.

Secrecy is enforced in `apikey.service.ts`, not by convention:

- `describe()` — `{configured, source: 'env'|'settings'|null, suffix}` — is the **only**
  shape that crosses the HTTP boundary. There is no route, query parameter or debug flag
  that returns the key.
- It is **validated against Anthropic before it is stored**, via `models.list` (costs no
  tokens, `maxRetries: 0`). That is what distinguishes "wrong key" (401) from "no
  internet" (transport error) from "no credit" (400) — three failures a newcomer hits
  that need completely different advice.
- `redact()` scrubs the key out of provider error messages before they are shown.
- **It must never go in `.env`.** See
  [troubleshooting.md](troubleshooting.md#the-api-key-vanished-from-env).

---

## The first-run flow

Server: three endpoints in `routes/setup.ts`.

```
GET  /api/setup/state    what is missing, and what each language can serve
POST /api/setup/seed     stock a bank, streaming REAL progress as NDJSON
POST /api/setup/dismiss  "I know the bank is empty; let me in"
```

**`needed` is derived, never a flag.** The obvious implementation is an `onboarded = true`
row and it is wrong in both directions: a returning user who restores a backup gets no
help when they genuinely need it, and any user whose flag is somehow cleared gets a
wizard in front of a working app. So `readSetupState()` just asks the two questions the
wizard exists to answer:

- no usable key → `reason: 'no-api-key'` (never suppressible — there is nothing to skip
  to), else
- the active language has zero **servable** problems (`used = 0 AND canonicalized = 1`)
  and `setup.dismissed` is not set → `reason: 'empty-bank'`.

The one stored bit, `setup.dismissed`, can only ever *suppress* the empty-bank prompt.

**`supported` per language is read off the filesystem** — `test-harness/<lang>/Dockerfile`
exists — the same question `cg_buildable_languages` asks in bash. A hardcoded list here
would go stale the moment `test-harness/java/` lands. Seeding a language with no harness
is refused with a 400 *before* any spend, because it is the most expensive possible way
to learn that Java is not finished.

**Seeding streams NDJSON, not SSE**, because seeding is a POST (it spends money, so it
must not be a GET a browser can prefetch or a proxy can retry) and `EventSource` cannot
POST. The events come from `runSeed()` in `seed.service.ts` — one async generator driving
both the CLI and the browser, so `bin/seed-bank` and the wizard cannot disagree about
whether a slot is stocked. Every number in them is real: `total` is counted out of the
database before anything is generated, `done` advances only when a call has returned.
There is no timer anywhere in that file, which is why the progress bar visibly sits still
during a 15–30s generate and is telling the truth when it does. A failed generation is a
`failed` event and the run **continues** — a partial bank is a usable bank.

Client: `App.tsx` asks `/api/setup/state` on mount, before the router renders. **A failed
request renders the app** — help that appears when the server is merely unreachable would
lock a working install behind a form nobody can submit. `SetupWizard.tsx` is four screens
(provider → language → seed → ready — a PROVIDER step, not a key step, because an
install pointed at a local endpoint needs no key and must not open by demanding one);
the last one calls `POST /api/session/start` and writes
the same `codegrind.grind` localStorage snapshot GrindPage persists for itself, so you
land inside a live session rather than at a menu.

---

## The client

React 18 + Vite + Tailwind + shadcn-style primitives, dark only. Built into `dist/`,
served by the same Hono process with `precompressed: true` (`bin/build` writes `.br`/`.gz`
siblings — Monaco is bundled locally rather than CDN-loaded and its chunks are multi-MB).

```
src/App.tsx                      the first-run gate, then the router
  client/components/Layout.tsx   4 tabs: Grind · Manual · Reflect · Study
  client/pages/GrindPage.tsx     the adaptive loop
  client/pages/WorkspacePage.tsx "Manual" — pick topic/difficulty; hosts LanguagePicker
  client/pages/ProgressPage.tsx  "Reflect"
  client/pages/StudyPage.tsx     the reading feed
  client/components/SolveSurface.tsx   editor + problem + results + coach
  client/components/CodeEditor.tsx     → MonacoEditor (desktop) | CodeMirrorEditor (mobile)
  client/lib/api.ts              every fetch in one place
```

Two editors on purpose: Monaco on desktop, CodeMirror 6 on a phone. Monaco is free per
language — its default ESM entry already registers the `javascript`, `python`, `go` and
`java` grammars and none needs a worker — while **CodeMirror needs a package per
language** (`@codemirror/lang-go` and friends), registered in `GRAMMARS` in
`CodeMirrorEditor.tsx`. A missing grammar there degrades silently to an unhighlighted
buffer, which is why `languages.test.ts` asserts the dependency exists.

`LANGUAGE_META.indentSize` / `insertSpaces` drive both editors. Go is the one language
where `insertSpaces` is false (gofmt uses tabs) — and `indentSize` then means the
*display width* of a tab, which is why Go's is 4 and not 1.

**The grind snapshot.** `GrindPage` keeps a whole session in `localStorage` under
`codegrind.grind`, including a whole `Problem`. Switch language in Manual, come back to
Grind, and the resumed session would put a JavaScript problem on screen while everything
scheduled after it is Python — nothing errors, it is just quietly wrong.
`staleForLanguage()` (`client/lib/grind-snapshot.ts`, pure and tested) closes it, keyed on
the **problem's** language, not the session's. An unreachable settings request is treated
as "unknown", not "mismatch", so a network blip does not cost you a live session.
