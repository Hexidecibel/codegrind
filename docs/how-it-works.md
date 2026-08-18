# How codegrind works

This is the conceptual guide: what the app does between you pressing **Start** and a
coaching brief appearing, and why each step is shaped the way it is. Read it if you want
to understand the system or change it. [architecture.md](architecture.md) is the
code-level map — which file owns what — and it deliberately does not repeat this.

Everything below was written against the code, and the numbers in it are the numbers in
the code. Where a number is load-bearing the file that holds it is named.

---

## The loop, end to end

```
POST /api/session/start
  └─ getActiveLanguage()        the language for this whole sitting, read ONCE
  └─ planSession()              one LLM call, best-effort, only nudges the scheduler
  └─ nextIntent({language})     scheduler.service — NO LLM call, ever
  └─ getAdaptiveProblem(intent) bank.service — a banked problem, or a fresh generate
  └─ createSession(...)         the language is stored ON the session row

  you write code
  POST /api/run     sample tests only. No AI, no recording, free.
  POST /api/submit  hidden tests → coaching brief → one attempt row, one skill update,
                    one review-queue move

POST /api/session/:id/next      the intent is recomputed from the state you just changed
```

Two properties fall out of that and both are deliberate.

**The scheduler is free.** It runs on every single problem and makes no model call at
all. That is what lets the app be adaptive per problem without being expensive per
problem — see [The scheduler](#the-scheduler-free-and-deterministic).

**The language rides on the intent**, not alongside it. `getAdaptiveProblem(intent)`
cannot be handed a language that disagrees with the state the intent was computed from,
and `POST /api/session/:id/next` reads the language back off the session row rather than
re-reading the setting — so flipping the language picker mid-sitting cannot serve a
problem the plan was never built for.

---

## Where a problem comes from

### 1. One forced tool call

`generateProblem` (`llm.service.ts`) sends a per-language system prompt and requires the
model to call one tool, `emit_problem`, exactly once. The tool's JSON Schema **is** the
response schema — title, statement, examples, constraints, pattern, `starterCode`,
`functionName`, `sampleTests`, `hiddenTests`, `referenceSolution`. There is no
prose-and-parse path. Ten of this app's eleven model calls are forced tool calls, which
is why an endpoint that cannot force one is refused at setup rather than discovered
mid-session.

The budget for this call is 16000 output tokens on Anthropic. On an OpenAI-compatible
endpoint it is capped at 8000 by `MAX_OUTPUT_TOKENS` — not for tidiness: a legitimate
generated problem measured 976–5337 output tokens, and a generation that degenerates into
repetition runs to whatever budget it is handed. The cap's only job is to arrive sooner
(144s instead of 293s for the same discarded problem). `CODEGRIND_MAX_OUTPUT_TOKENS`
overrides it; `0` removes it.

### 2. Test canonicalization — the step that matters

The model does **not** get to decide what the right answer is.

```
canonicalize(language, generated)
  ├─ runTests(referenceSolution, sampleTests)   in the real sandbox
  ├─ runTests(referenceSolution, hiddenTests)   in the real sandbox
  └─ for each test:
        the reference errored on it            → drop the test
        its output is not serializable         → drop the test
        otherwise                              → that output becomes `expected`
                                                 (`args` and `name` are kept verbatim)
```

That is `canonicalizeTests` in `bank.service.ts`, and it exists because of one specific,
extremely common model failure: a **correct** reference solution paired with a
hand-authored `expected` that disagrees with it — or one of several defensible answers
chosen for an ambiguous case. A problem stored that way is unsolvable, is served
silently, and fails in the one way you cannot diagnose, because it looks exactly like
your own mistake.

Running the reference makes the problem self-consistent by construction: the reference
always passes its own tests, so every problem you are served is guaranteed solvable. It
is also why a fresh generate takes 15–30 seconds on Claude rather than 5 — you are paying
for two extra sandbox runs plus the model.

If too few tests survive (fewer than 1 sample or 4 hidden — `MIN_SAMPLE_TESTS`,
`MIN_HIDDEN_TESTS`) the whole problem is thrown away and regenerated, up to
`MAX_GEN_ATTEMPTS = 3`.

### 3. When the sandbox itself cannot run, the languages part ways

A missing image or a dead Docker daemon is infrastructure, not a bad generation, so
retrying would only burn generation calls against the same broken sandbox. JavaScript
keeps a lenient path — the problem is stored with the model's own `expected` values and
stamped `canonicalized = 0`, which keeps it out of every future bank read. **Every other
language throws.** The reasoning is in `bank.service.ts`: minting problems whose
`expected` no real run can ever reproduce is worse than failing loudly.

This is also the mechanism that makes a language with no harness fail honestly rather
than expensively — see [Java](#why-java-is-missing).

### 4. Novelty

Avoiding repeated *titles* only stops repeated names; the generator will happily re-serve
the same algorithm in a fresh costume. So `noveltyOpts` also sends a digest of the last
`RECENT_DIGEST_LIMIT = 4` problems for that topic — title plus a 160-character slice of
the statement — and demands a different structural variant of the technique.

That block is a function rather than inline code because two callers must not drift:
`getAdaptiveProblem`, the path a player travels, and `bin/dry-run-generate`, the
instrument that judges a model. With those opts missing, eight consecutive local-model
dry runs of easy/arrays came back as "find the maximum" under six different titles, and
the same model on the real path produced eight genuinely different problems. The
narrowness was the measurement, not the model.

---

## The scheduler: free and deterministic

`scheduler.service.ts` decides what to serve next. It reads per-topic skill state and
derived tier progress out of SQLite and emits a `SchedulerIntent`:

```ts
{ kind, language, topic, difficulty, rationale, avoidTitles?, variationOfProblemId?, reviewProblemId? }
```

**It makes zero LLM calls.** The one model call in the session path — `planSession` — runs
once per sitting and only nudges the scoring through `plan.focus` (worth +0.5 to a
candidate's score). If it fails, a default plan is used and nothing else changes.

### The six intent kinds

| kind | when it is a candidate | difficulty served |
|---|---|---|
| `review` | anything is due in the review queue. **Outranks everything** — checked before scoring even starts | the original problem's |
| `warm-up` | an attempted topic at or above `WEAK_SCORE` | one tier **below** the working tier, floored at easy |
| `reinforce` | attempted and (weak, or failed last time, or overdue) | the working tier |
| `variation` | the topic's last result was a solve | the working tier |
| `level-up` | a tier was just completed and nothing is banked at the next one | the next tier |
| `new-pattern` | an **unattempted** topic with ≥1 prerequisite at the unlock tier (roots need none) | easy |

Candidates are scored, the top four are kept, and one is drawn by a seeded weighted
random (`mulberry32`) whose seed is derived from live state plus a 3-second time bucket —
varied between problems, but a pure function of that seed rather than `Math.random()`.
The topic just served is filtered out unless it is all there is.

`variation`, `level-up` and `new-pattern` always generate **fresh** (that is the point of
them); `warm-up` and `reinforce` reuse a banked problem when the slot has one, which is
why some problems appear instantly and some take 15–30s.

### The skill tree

`curriculum.ts` holds the prerequisite DAG for all 18 topics. Four roots have no
prerequisites and are open from the start: `arrays`, `hashing`, `math`,
`bit-manipulation`. Everything else names its parents — `sliding-window` needs `arrays`
and `two-pointer`; `graphs` needs `bfs-dfs`; `dynamic-programming` needs `backtracking`.

A topic becomes eligible for `new-pattern` once **at least one** prerequisite has
completed `UNLOCK_TIER`, which is `easy`. Not all of them — one is enough to have
something sensible to say about the new topic.

### The tier ladder

One rule, and it is countable:

> **A tier credit is one DISTINCT problem solved with ZERO hints.**
> `TIER_REQUIREMENT = 3` credits complete a tier. Tiers are cumulative:
> none → easy → medium → hard → expert.

Deduped by `problemId`, which is the whole point: re-submitting a solution that already
passes appends rows to `attempts` and earns nothing. That was a real exploit — it walked
a topic's `binary-search` difficulty up to medium for free.

This replaced a score, `solveRate*0.8 + recency*0.2 >= 0.6`. Grinding daily pins recency
near 1.0, so it collapsed to "solve rate ≥ 0.5" — a coin flip — it was polluted by
re-submits because it was a ratio, and it said nothing about difficulty: you could be
"mastered" having only ever seen easy problems.

The difficulty served is **derived** from the ladder, never read from a stored column, so
the scheduler cannot disagree with what the ladder says. Past the top tier it pins at
`expert` and the count keeps climbing (`expert ×7`) — the ladder never plateaus, it just
stops escalating. Nothing in the app is ever labelled "mastered".

There is a 0..1 display score (`levelIndex + towardNext/3`, over 4) so the bars and ramps
have something to render. It is display-only: unlocking, escalation and tree state all
compare **tiers**. The single exception is `WEAK_SCORE = 0.25`, the "reinforce this"
nudge, which is exactly `tier === 'none'`.

### Spaced repetition, in two places

**Per topic** (`skill_state`), on every submit:

| outcome | box | streak | ease | due |
|---|---|---|---|---|
| solved, no hints | +1 | +1 | +0.1 | now + the box interval |
| solved with hints | held | unchanged | −0.05 | now + the current box interval |
| failed | reset to 0 | 0 | −0.2 | **now** |

Box intervals are `[4h, 1d, 3d, 7d, 14d, 30d]` (`BOX_INTERVALS_MS`, `db.ts`); ease starts
at 2.5 and is clamped. An overdue topic gains score as a `reinforce` candidate.

**Per problem** (`review_queue`), the retrieval loop. A miss, a hinted solve or a revealed
answer queues the exact problem; a clean unaided solve clears it. A due item is re-served
**cold** — the same problem, not a variation, and nothing is regenerated. Each missed
re-attempt pushes it out along `REVIEW_LADDER_DAYS = [0, 2, 5, 10]`. Both review reads
join `problems` so a JavaScript problem can never surface mid-Python sitting.

---

## The sandbox

Every submission — yours, and the ones the app runs to verify its own problems — executes
in a throwaway container. There is no fallback that runs code in the server process.

```
sandbox.service.runTests({language, functionName, userCode, tests})
  └─ writes <id>.solution.<ext> and <id>.tests.json into $DATA_DIR/tmp
  └─ execFile bin/run-submission <language> <solution> <tests>     45s outer cap
       └─ mktemp -d under $CG_SCRATCH_DIR; chmod 0711 the dir, 0644 the files
       └─ timeout -k 3 <CG_TIMEOUT> docker run --rm --name codegrind-run-…
            --label codegrind.runner=1 --label codegrind.language=<lang>
            --network none --read-only --cap-drop=ALL --security-opt no-new-privileges
            --memory=<CG_MEMORY> --cpus=1 --pids-limit=<CG_PIDS> --tmpfs <CG_TMPFS>
            -v <host work dir>:/work:ro
            <CG_IMAGE> <CG_CMD> /work/<CG_SRCNAME> /work/tests.json
       └─ the harness prints ONE JSON object to stdout
  └─ toRunResult()   pure translation: harness JSON → typed RunResult
```

The per-language numbers live in `bin/lib/languages.sh` — in bash, because bash is what
invokes `docker` and two files that both own the run command will eventually disagree:

| | javascript | python | go |
|---|---|---|---|
| image | `codegrind-runner-javascript:latest` | `-python:latest` | `-go:latest` |
| memory | 256m | 256m | 512m |
| pids | 128 | 128 | 256 |
| tmpfs | `/tmp` | `/tmp` | `/tmp:exec` |
| outer `timeout` | 12s | 12s | 30s |

`/tmp:exec` is per-language on purpose. Docker mounts a `--tmpfs` `noexec` by default,
which is correct for an interpreted language — there is nothing to execute. A compiler
writes a linked binary and then runs it, and under `noexec` that is a permission-denied
that looks nothing like a compiler problem. `exec` is a real relaxation of the sandbox, so
the languages that do not need it do not get it, and a test asserts both directions.

The 0711/0644 `chmod` is not decoration. `mktemp -d` produces a 0700 directory owned by
uid 1000, which was invisibly fine for exactly one language — node's image user *is* uid
1000. The Python and Go images run as `nobody` (65534), could not traverse it, and every
submission in those languages failed with "could not read solution": a whole language
looking permanently broken, from a mode bit.

### The harness contract

Input is `{functionName, tests: [{name, args, expected}]}`. Output is one JSON object:

```
{ results: [{name, passed, expected, actual, stderr, stdout, timeMs}],
  passed, total,
  phase?: "compile" | "load" | "run",
  error?, stdout? }
```

`phase` is how a runner reports that nothing ever ran. It is what turns a JavaScript
`SyntaxError`, a Python `IndentationError` and a Go build diagnostic into one
`compile_error` verdict instead of the actively misleading "0 of 8 tests passed" — there
were no test outcomes, and the code has no behaviour to discuss.

Verdicts: `accepted`, `wrong_answer`, `runtime_error`, `compile_error`, `timeout`,
`error`.

Each runner hand-writes its own `deepEqual` and its own canonical serializer, because the
alternative is embedding a JS engine in the Python image. Hand-written comparators drift,
so `test-harness/conformance/equality-cases.json` is the one fixture all of them are
checked against by `<runner> --selftest`, which `bin/build-runner-image` runs as a
post-build gate. **An image that disagrees with the fixture is deleted, not published.**
The fixture pins what comparators reliably get wrong: the `{"$cg":"nan"|"inf"|"-inf"|"-zero"}`
sentinels, a float tolerance of `abs(a-b) <= max(1e-9, 1e-9*max(|a|,|b|))` that never
applies to two integers and never to a non-finite value, sorted-key serialization, array
order-sensitivity and dict key-order insensitivity.

### Budgets

The interpreted runners enforce **no internal budget at all**. A synchronous infinite loop
cannot be interrupted from inside a single-threaded JS or CPython process, so the outer
`timeout` around `docker run` owns wall-clock enforcement, and above it sits
`sandbox.service`'s own 45s `execFile` cap:

```
javascript / python:   CG_TIMEOUT 12s  →  execFile 45s
```

Go, being compiled, needs budgets of its own so that a wedged toolchain reports something
better than an opaque kill. They are in `runner.go` and they nest:

```
go:   per-test 2s  →  whole suite 10s  →  compile 10s  →  CG_TIMEOUT 30s  →  execFile 45s
```

Each must stay strictly inside the next. If an outer one fires first, the container dies
before printing its structured partial results and you see an opaque kill instead of "3 of
8 passed, then this one hung". `languages.test.ts` asserts `CG_TIMEOUT[go] > 23`, which is
compile + run + grace.

### Orphans

`bin/run-submission` force-removes its own container in an `EXIT` trap, which covers every
ordinary end including the timeout path. It cannot cover the script itself being SIGKILLed
— then a container is left spinning a full core with nobody to remove it. Two of those
once ran for **10 days**. `bin/reap-runners`, on a 5-minute timer, is the backstop; it
filters on `--label codegrind.runner=1` and never on `ancestor=`, because Docker resolves
`ancestor=<tag>` to an image ID at query time and a rebuild makes every already-running
container invisible — precisely the moment orphans exist.

---

## Run, Submit, and the assistance ledger

**Run** (`POST /api/run {problemId, code}`) executes the **sample** tests only. No model
call, nothing recorded, free. Sample tests are printed in the problem statement, so their
expected values stay fully visible — reading them is how you debug.

**Submit** (`POST /api/submit {problemId, code}`) executes the **hidden** tests, then
coaches, then records. Neither body carries a language: the server reads
`problem.language`. Handing Python source to the JavaScript harness is not unlikely, it is
unrepresentable.

The response is **NDJSON**, one event per line — `result` first, then `coaching`. It used
to be a single JSON body, which held a verdict that already existed behind a workhorse
call with adaptive thinking, budgeted at 180s on Anthropic and 300s on a local endpoint,
under one static line of UI. The sandbox run happens *before* the stream opens, so a
sandbox failure is still a real 500 with an explained body rather than a 200 carrying an
error event.

The side effects deliberately did not move: the attempt row, the skill/SRS update and the
review-queue move all still happen once, in that order, **after** coaching — because
`insertAttempt` stores `coaching.mistakeTags`, and recording early would write null tags
on every attempt. The accepted cost is that hitting **Next** instantly can out-race the
recording, so that one scheduler pick sees pre-submit state.

**Hidden tests never ship their expected values to the browser.** `redactHiddenExpected`
strips them from the wire, not merely from the UI — the values were visible in the network
response regardless of what the panel drew, which made the rule a decoration. The results
panel renders an explicit "— hidden —" rather than omitting the row, so it reads as a
policy instead of a bug. The coach still sees the real values, and `POST /api/ask`
re-attaches them server-side (`rehydrateExpected`, matched on test name) so the tutor can
answer "why did mine fail?" from evidence.

**The coaching brief** is a forced tool call (`emit_coaching`, 8000 tokens, adaptive
thinking) covering the approach, what was missed, the pattern you should have recognised,
your complexity against the optimal, one improvement, and machine-readable `mistakeTags`
drawn from a fixed set of 11. It is best-effort: if the call fails you get a brief that
says coaching is unavailable, and your run is not lost.

**Hints** are levelled 1–3 (`POST /api/hint`), a short forced tool call with thinking off.

**"Show me the answer"** (`POST /api/reveal`) is always available and never refused. The
price is recorded rather than charged at the door: the reveal is written to the
`revealed_solutions` ledger **before** the solution is returned, so the next submit counts
as assisted no matter what the client does. One reveal counts as one hint, which is enough
to disqualify the attempt from tier credit, from clearing a review and from the streak of
clean solves. A submit that passes also returns the reference solution in the
`result` event — the coach discusses it anyway, and withholding the text was the
infuriating part. It is still absent on every unsolved submit.

**Predict-before-solve** is a small gate over the editor asking for your approach and
complexity before you start. It is stored with the attempt and shown to the coach. It used
to open on every problem with no way out; it is now a persisted preference
(`codegrind.predict.gate`) that can be turned off and back on from the assistance popover.

**The assistance ladder** reconfigures the editor from a blank whiteboard (level 1, Raw) to
a full IDE (level 4, Assisted), with six individual toggles over the top. It mirrors
interview conditions; it does not affect grading.

---

## Study and Reflect

**Study** is a reading track alongside the grind, ordered against your actual mastery
rather than a fixed syllabus. `study.order.ts` is pure and deterministic — no database, no
model, no clock it cannot be handed — and plans a queue in phases:

- **Track lessons**, from a per-topic outline the model wrote once and cached forever.
  Topics are ordered along the same prerequisite spine the scheduler uses, with weak
  attempted topics pulled forward together with their prerequisites.
- **Personalized slots** generated from your own history: up to 5 `mistake` lessons (one
  per recurring mistake tag) and 5 `walkthrough` lessons (explaining a specific problem
  you attempted).
- **Re-reads**, up to 10, for lessons that have gone `REREAD_STALE_DAYS = 30` stale.

Six lesson kinds exist: `concept`, `template`, `pitfall`, `walkthrough`, `variation`,
`mistake`. The feed generates `PREFETCH_DEPTH = 3` slots ahead of the reader, after it has
already responded, so reading rarely waits on a model.

**Reflect** is what you have actually done: the skill tree, the tier ladder, a mistake
ledger, an 84-day activity heatmap and trend charts. On a fresh install it still renders
the whole dashboard — an empty skill tree is the map of everything that unlocks, and worth
seeing — but it is framed with a sentence saying what will appear and what fills it.
Freshness is derived from all-time counters rather than from the 84-day window, so someone
returning after three months is not greeted as a newcomer.

---

## What forks per language, and what does not

The one idea everything follows from:

> **Language is a property of the problem, not of the submission.**

A problem's `expected` values were produced by running its reference solution, so the test
data is bound to the language that produced it.

**Per language:** the problem bank, `skill_state`, tiers, unlocks, the skill tree, solved
counts, hint-free rate, and the review queue.

**Global:** your streak and your lessons-read count.

The bank forks with no cross-language fallback, so a new language starts empty and its
first problems are cold generates. `bin/seed-bank --language go` is the mitigation; the
fallback is not, because serving a JavaScript problem to a Go session would mean grading
Go source against JavaScript-derived `expected` values.

Skills fork and start cold on purpose. A tier means "3 distinct problems solved at this
difficulty with zero hints", and you have not done that in Go. Transferring the unlock
would serve a Go beginner expert-tier problems on day one. Nothing is deleted — your
JavaScript state is untouched and waiting.

The streak stays global because it is a habit metric: Python yesterday plus Go today is a
two-day streak, not two broken ones. Lessons stay shared because lesson prose is
language-free by construction — the prompt forbids fenced code in a lesson body and puts
code in a separate field — so only the **snippets** fork, through `code_translations`:
about 18 batched translation calls per language against the 90–180 generation calls
re-authoring the corpus would cost.

Switching language changes what gets served **next**, never what is on screen. The solve
surface shows a read-only language badge for exactly that reason, and a stale grind
snapshot in `localStorage` is dropped when its problem's language no longer matches.

---

## Which model does what

Every model call is one you triggered. Nothing warms in the background, nothing runs on a
timer, so an idle instance costs nothing.

There are eleven call sites, and ten of them are forced tool calls. They are routed by
**role**:

| role | calls | budget |
|---|---|---|
| `workhorse` | `generateProblem` (16000 tok), `coach` (8000), `translateSnippets` (8000) | 180s Anthropic / 300s local |
| `small` | `hint` (1000), `planSession` (800), `generatePrimer` (2500), `generateTrackOutline` (2500), `generateLessonBody` / `generateMistakeLesson` / `generateWalkthroughLesson` (3000 each) | 60s / 120s |
| `tutor` | `askFollowup` (8000) — the only prose call in the app | 180s / 300s |

`small` has no configuration of its own: `clientFor('small') === clientFor('workhorse')`,
and there is a test that says so. It exists so a 3-second classification and a 30-second
generation can have different timeouts without inventing a second model to configure.

Only two things are configurable, independently: **the workhorse** and **the tutor**. On
the Anthropic path their default models differ on purpose — `claude-sonnet-5` writes
problems, `claude-opus-5` answers the coach chat, because that is one call per question
you actually ask and it is the conversation you judge the app by. Settings names both by
the job they do and can pin the coach to the writer's model. On a local endpoint the tutor
inherits the workhorse's provider *and* model, so a local install stays local: no key, no
signup, no spend.

There is **no failover**. A configured endpoint that is down produces failures naming the
endpoint and the model. They never silently become Anthropic calls.

The seam that makes this possible — `llm.service` says *what*, `llm.client` says *who* —
is described in [architecture.md](architecture.md#who-answers--the-llm-seam).

---

## Why Java is missing

Java is in the language registry and has no `test-harness/java/`, so nothing could run a
Java submission. It is therefore not offered anywhere a language can be chosen: not in the
first-run wizard, not in the Manual or Settings picker, and `PUT /api/settings` and
`POST /api/setup/seed` both answer 400.

Every one of those surfaces derives that from `test-harness/java/Dockerfile` not existing
(`harness.service.ts`), rather than from a list somebody maintains — so the day the
harness lands they all start offering Java with no further edit.

The cost of getting this wrong is concrete, and it is why the gate is at both layers: the
pickers once mapped the raw registry, so picking Java spent `MAX_GEN_ATTEMPTS` generation
calls per problem against an image that was never built, had every test dropped by
canonicalization, and then reported *"the reference solution errored on too many of its
own test inputs"* — blaming the model for a missing build, with every subsequent problem
load failing the same way.

See [adding-a-language.md](adding-a-language.md) for what finishing it involves.

---

## What it costs

- **Idle:** nothing. Every call is user-initiated.
- **A banked problem:** nothing. A database read.
- **A fresh problem:** one generation call (occasionally up to 3 — `MAX_GEN_ATTEMPTS`)
  plus two sandbox runs.
- **A submit:** one coaching call. A **run** is free.
- **A question to the coach:** one call.
- **First-run seeding:** 2 problems × 4 root topics at easy = 8 generation calls. The
  wizard's server-side ceiling is `MAX_PER_SLOT = 3`, i.e. 12 problems, which is the most
  a single click can spend.
- **Warming the Study corpus:** 18 outlines plus the first lessons of each
  (`bin/warm-lessons`), and about 18 batched calls to translate the corpus into a second
  language (`bin/translate-corpus`).

On a local endpoint all of that is free and slower. `bin/dry-run-generate` is the honest
way to find out how slow: one attempt, scored by the stage that failed, storing nothing.
