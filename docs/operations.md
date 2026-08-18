# Operations

Everything operational is a script in `bin/`. There are no one-off `docker`/`sqlite3`
incantations to remember, and if you find yourself typing one, the fix is a script.

Every script's own header is the authoritative help; most also take `--help`. What
follows is when to reach for which.

**Before anything else:** `bin/` scripts that run Node pick their own Node through
`bin/lib/node.sh` — the pinned install first, then `PATH`, then anything nvm has, newest
first. Supported majors are **22 and 20** (`CG_NODE_MAJORS`); Node 24 hard-crashes
`better-sqlite3` at module load. If you are running `npx`/`node` by hand instead:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"    # or: nvm use 22
```

---

## Daily

| | |
|---|---|
| `bin/setup` | The front door. Preflight → `.env` → deps → build → migrate → images → start. Idempotent; a re-run finishes in about a second and says what it skipped. Flags: `--port N` (persists to `.env`), `--no-start`, `--force`, `--check`, `--help`. |
| `bin/start` | Start as a plain background process (`setsid` + `nohup` + a pidfile in `$DATA_DIR`), then wait for `/api/health`. `--quiet` speaks only on failure. **Refuses to run beside a systemd instance serving the same directory** — two processes, one SQLite file, one port. |
| `bin/stop` | Stop what `bin/start` started. Signals the whole **process group**: `tsx` runs the server in a child, and signalling only the pidfile's process leaves it orphaned and still holding the port. TERM, wait, then KILL. Refuses to touch a systemd-managed instance. |
| `bin/status` | Service state (pidfile first, then systemd), a health probe, one line per runner image, the reaper timer, and any runner containers in flight. Run this first, always. |
| `bin/logs` | Whichever log this instance actually has: `$DATA_DIR/server.log` for a `bin/start` instance, `journalctl -u codegrind` for the service. Detects in the same order `bin/status` does, and only claims the unit when its `WorkingDirectory` is this checkout. Defaults to following the last 200 lines. `-n N`, `--no-follow`, `--file`/`--systemd` to force. |
| `bin/build` | `tsc -b && vite build`, then precompress `dist/` into `.br`/`.gz` siblings (the server serves `dist/` with `precompressed: true`). Safe against a live install — the server only reads `dist/` per request. `SKIP_INSTALL=1` skips the npm step. |
| `bin/migrate` | Open and migrate the database, then report what it holds (`schema v3, N problems, N attempts, N lessons, N settings`). `--quiet` for that one line. Idempotent and self-healing. Its job is to make a migration failure be reported by the thing whose job that is, instead of arriving as "the server exited". |

### A second instance you cannot break anything with

| | |
|---|---|
| `bin/scratch` | The same checkout, a **different `DATA_DIR` and port**, so a new provider or a risky change can be exercised without touching a database full of real practice history. `start`, `stop`, `status`, `logs [-f]`, `reset` (delete its database and start over), `env` (print the environment it would use). It reads `.env.scratch` (gitignored, same format as `.env`) and it actively **unsets** `ANTHROPIC_API_KEY` unless `CG_SCRATCH_ALLOW_ANTHROPIC=1` — "works with no key at all" is the claim a local-provider run is meant to test, and a key quietly in the environment would prove nothing and could spend money. |

`bin/start` refuses a second copy out of a directory the systemd unit already owns — same
port, same SQLite file, two writers. `bin/scratch` is the one shape of "second copy" that
is safe.

---

## The sandbox

| | |
|---|---|
| `bin/build-runner-image [lang…]` | Builds every language that has a harness on disk, or just the ones named. Each image is then run with `--selftest` against `test-harness/conformance/equality-cases.json` **under the same sandbox flags a real submission gets**; an image that disagrees is deleted rather than published. `--no-selftest` for debugging only. |
| `bin/run-submission <lang> <src> <tests.json>` | The actual `docker run`. Called by `sandbox.service`, not by you — but it is the thing to run by hand when you want to see raw harness output. |
| `bin/reap-runners` | Kill orphaned runner containers and orphaned scratch directories older than `MAX_AGE` (300s — ten times the longest `CG_TIMEOUT` any language has, 30s). `--dry-run`, `--max-age SECONDS`. On a 5-minute timer in production. |

Built here, the three images measured **654 MB** together (Go 308 MB, JavaScript 227 MB,
Python 119 MB — Go's toolchain is most of it). `bin/setup` hard-stops below **3 GB** free
on Docker's root directory and warns below 6 GB, because a build needs layer scratch on
top of the finished images and running out mid-build leaves a half-built image and an
error about a tar stream, which explains nothing.

`bin/reap-runners` filters on `--label codegrind.runner=1`, **never `ancestor=`**. See
[troubleshooting.md](troubleshooting.md#a-runner-container-is-spinning-a-core).

---

## Spending money

These are the scripts that make real model calls. All are idempotent and resumable — a
re-run after a partial failure only pays for what is still missing — and all take
`--dry-run`.

| | |
|---|---|
| `bin/seed-bank` | Stock the problem bank. `--language <l>`, `--topic <t>` (repeatable), `--difficulty <d>` (repeatable), `--per-slot N` (default 2), `--dry-run`. Bare, it seeds the **active** language's four root topics (`arrays`, `hashing`, `math`, `bit-manipulation`) at `easy` — 8 problems. Those are the only slots the scheduler's cold-start path can reach before you have done anything, and so the only ones worth pre-paying for. Skip-if-exists uses `servableBankSize`, the same predicate that decides what gets served. |
| `bin/dry-run-generate` | **One** generation attempt, scored by the stage that failed — `generation`, `too-few-tests` or `sandbox`, which are three completely different problems. Writes nothing unless `--keep`. This is how you find out whether a local model is good enough before committing an evening to it; a missing runner image is never scored against the model, because that says nothing about it. `--language`, `--topic`, `--difficulty`, `--repeat N` (1–20), `--keep`, `--help`. |
| `bin/warm-lessons` | Pre-generate the Study reading tracks (18 outlines plus the first lessons of each) so the first reading session is not a series of 15s waits. `--dry-run`/`-n`, `--topic`/`-t` (repeatable), `--lessons N`. |
| `bin/translate-corpus` | Translate the shared corpus's **snippets** into another language — one batched call per topic, ~18 for the whole corpus, against the 90–180 generation calls re-authoring it per language would cost. `-L <lang>`, `-t <topic>`, `--limit N`, `--dry-run`. The Study feed does the same work lazily one topic ahead of the reader, through the same service call, so this is only the eager half. |

**A caveat on the last two.** `bin/seed-bank` and `bin/dry-run-generate` hydrate the
stored configuration before they run, so they use whatever the wizard configured and only
demand an Anthropic key when a role actually routes to Anthropic. `bin/warm-lessons` and
`bin/translate-corpus` do not: they check `ANTHROPIC_API_KEY` in the environment directly
and exit if it is unset. On an install configured entirely through the browser they will
refuse to run. Export the key for those two, or drive the same work through the app (the
Study feed generates lazily on its own).

Nothing warms automatically. Every model call in this app is user-initiated, which is what
keeps an idle instance at zero.

---

## Backups

**Always `bin/backup-db`. Never `cp`.**

```bash
bin/backup-db                # → $BACKUP_DIR/codegrind.<timestamp>.db
bin/backup-db pre-phase5     # → $BACKUP_DIR/codegrind.pre-phase5.<timestamp>.db
```

`BACKUP_DIR` defaults to `~/backups/codegrind` — deliberately not under `DATA_DIR`, since
a backup that lives inside the directory it is a backup of is not a backup. The path of
the last successful backup is written to `$BACKUP_DIR/.last-backup`, which is what
`bin/restore-db --latest` reads.

The database runs in WAL mode and the log has never been checkpointed — it is **megabytes
against a sub-megabyte main file**. `cp data/codegrind.db backup.db` copies the main file
only, silently produces a backup missing most of your recent history, and exits 0 looking
fine. `bin/backup-db` uses better-sqlite3's `db.backup()` — SQLite's online backup API,
which walks the pager, so it sees WAL frames and is safe against a live writer. **The app
can stay up.**

It then re-opens the copy and compares every table's row count, `user_version` and
`integrity_check` against the live database, and exits 1 on any mismatch. A backup nobody
counted is a backup nobody has.

Take a fresh backup before anything that touches the schema.

### Restoring

**`bin/restore-db`.** It encodes the procedure that used to live in a paragraph — stop the
server, move the file into place, delete the stale `-wal`/`-shm` siblings, migrate —
because every step of it was being done by hand, from memory, at the exact moment
something had already gone wrong.

```bash
bin/restore-db --list                  # what you have
bin/restore-db --latest --dry-run      # verify the backup, change nothing
bin/restore-db --latest                # prompts; type "restore"
bin/restore-db <file> --yes            # unattended
```

This is **the destructive one** — everything else in `bin/` reads or adds. So, in order:

1. **It refuses against a live server** — a systemd unit serving this directory, a live
   `bin/start` pidfile, or anything answering `/api/health` on `$PORT`. Overwriting the
   file under an open SQLite connection does not restore anything; it corrupts two
   databases.
2. **It verifies the backup before touching the live one**: magic bytes,
   `integrity_check`, the core tables (`problems`, `attempts`, `sessions`, `settings`), a
   refusal if every table is empty (the classic wrong file — the blank database
   `bin/migrate` creates), and a refusal if the backup's schema is *newer* than this
   checkout can migrate to. Then it prints the backup's row counts beside the current
   ones, so the loss is visible **before** it is agreed to. A restore that discovers the
   backup is bad after deleting the original has destroyed the last good copy in the
   building.
3. **It takes a safety backup of the current database first**, through `bin/backup-db` so
   the WAL comes with it, labelled `pre-restore`. That backup becomes the new
   `.last-backup` — so if the restore was itself the mistake, `bin/restore-db --latest`
   walks it back.
4. Only then does it replace the file, remove the stale sidecars, and run `bin/migrate`.

Without `--yes` it asks, and it will not accept a piped "y": no terminal and no `--yes` is
a refusal, because a destructive restore should not happen by accident in a pipeline.

---

## Migrations

The migration itself is not a command. Importing `db.ts` creates the schema and runs
`migrate()` inside one transaction, so the server can never run against an unmigrated
database. `bin/migrate` exists to be the thing that opens it *first*, so a failure is
reported as a migration failure rather than as "the server exited".

A failed migration rolls back and crash-loops against an **untouched** database. That is
the designed failure mode. Do not add a `--force` or a `--reset` that papers over it.

Around a schema change:

```bash
bin/backup-db pre-<change>
bin/capture-baseline                 # the service must be up
# … change and deploy …
bin/verify-migration                 # must PASS
```

| | |
|---|---|
| `bin/capture-baseline [dir]` | The "before" half. **Read-only**; GETs the live API and opens SQLite `readonly:true`. Captures `/api/reflect`, `/api/progress`, `/api/history`, `/api/study/index` and the clean-solves aggregation straight from SQL. The service **must be up** — a baseline captured from a down service is a file full of nothing that later "matches" anything. |
| `bin/verify-migration` | The "after" half. **Read-only.** Four layers, weakest first: row counts → clean-solves aggregation → tier credits and the multi-language invariants → API payloads byte-compared against the baseline. `--db-only` skips the API layer. Exit 0 = PASS, 1 = FAIL, 2 = INCOMPLETE. |

Layer 2 is the one that earns its keep: the tier ladder comes from a join of `attempts` to
`problems`, and a rebuild that writes the columns in the wrong order leaves both row
counts perfect.

---

## Smoke tests

| | |
|---|---|
| `bin/smoke-e2e <lang>` | Drive one language through the **live app**: set the language, get a problem, run it, submit the reference, get coaching, then assert what the database recorded. `--generate` forces a fresh generate; `--topic`/`--difficulty` pin the slot. **Not free and not read-only** — it records a real attempt, which moves `/api/reflect` and `skill_state`. Re-capture the baseline afterwards or the next `bin/verify-migration` reports the new rows as a regression. |
| `bin/smoke-python` | The four Python-specific hazards: deep recursion, a stray `print()`, `IndentationError` → the `compile_error` **verdict** (which lives in `sandbox.service`, above the runner, so it is proven through the live API), and float tolerance. Read-only w.r.t. the database; no model calls. |
| `bin/smoke-go` | The Go-specific hazards: compile diagnostics carrying the **line and column of the user's own file**, unused imports, deep recursion with no workaround, `(result, error)` refused with an authored message, float tolerance, the nil slice that must render `[]` and not `null`, and a forced 24-hour-stale build-cache stamp against the image on disk. |
| `bin/smoke-isolation` | Prove the language partition holds. Only meaningful in a slot **both** banks stock — asking for a Python problem when only Python problems exist proves nothing — so it picks such a slot and exits 2 rather than claiming a pass it did not earn. **Consumes one banked problem per language** and leaves the active language set to whatever it checked last; `--restore <lang>` puts it back. |

`bin/capture-llm-bodies` is the development counterpart: it re-captures
`src/server/services/__fixtures__/llm-request-bodies.json`, the frozen request body every
one of the eleven call sites sends, which `llm.golden.test.ts` asserts against. The
transport is faked, so it costs nothing, uses no key and never opens the database. Run it
deliberately, **never to make a red test go green** — a diff there means either you
changed a request on purpose or you changed one by accident, and only you know which.

---

## Repair

| | |
|---|---|
| `bin/restore-db` | Put a backup back, safely. The only destructive script in `bin/` — see [Backups](#backups). |
| `bin/reset-progress` | Wipe **learner** state (`attempts`, `sessions`, `review_queue`, `skill_state`) and free the whole bank (`used = 0`), keeping the generated problems and primers — a fresh start that reflects real performance without re-paying generation cost. |
| `bin/fix-go-starters` | Give every banked Go problem a `starterCode` that actually compiles. Reports by default; `--apply` writes. Idempotent — a starter that already declares a package is left alone. Exists because Go's first authoring rule was wrong; see [adding-a-language.md](adding-a-language.md). |

---

## Running it as a service

Entirely optional. Nothing in the first-run path (`bin/setup` → `bin/start`) touches
systemd, and on a laptop there is no reason to install units at all.

| | |
|---|---|
| `bin/install-units` | **Render** `deploy/*` for this machine and install the result into `/etc/systemd/system`, then enable the reaper timer. `--status` shows what is installed, whether it has drifted, and which drop-ins are present. `--print [unit]` renders to stdout and changes nothing — no sudo, no `/etc` — which is how you check what it would write. It rewrites the unit but does **not** restart, so a change to `codegrind.service` needs a `bin/restart` after. |
| `bin/restart` | `systemctl restart` + wait for health + `bin/status`. |
| `bin/deploy` | The full deploy: refresh `.env` through an optional external hook → `npm ci --include=dev` → `bin/build` → ensure every runner image passes its `--selftest` → `bin/install-units` → `systemctl restart` → wait for health → `bin/status`. **No arguments, no `--help`, and it restarts the system unit** — do not run it to "see what it does". On a machine without the units, the equivalent is `bin/build && bin/stop && bin/start`. |

Both wait for health on `$PORT` from `.env`, not a literal 9416.

`bin/deploy`'s first step runs whatever `CG_INJECT` points at — by default a `.env`
materializer that exists only on the author's machine. If that file is not executable the
step prints one line and carries on: it is not a failure and not a dependency. Nothing
else in the repo reads it. (`.cush-secrets` in the repo root belongs to that same tooling
and carries a header saying a fresh install neither needs nor uses it.)

### The three units

They live in `deploy/` and they are **templates, not units you can copy**.
`WorkingDirectory`, `User` and the pinned Node bin directory are `@CODEGRIND_REPO@`,
`@CODEGRIND_USER@` and `@CODEGRIND_NODE_BIN@`, filled in by `bin/install-units` from the
same three sources the rest of `bin/` uses: the script's own location,
`${SUDO_USER:-$(id -un)}`, and `bin/lib/node.sh`. Lines beginning `##` are notes to
whoever edits the template and are stripped on render; ordinary `#` comments are kept,
because several of them are incident reports. `src/shared/deploy-units.test.ts` asserts
both halves of that.

They used to be one machine's units, copied verbatim with `sudo install`, so anyone else
who cloned the repo and followed this file got three units pointing at a directory that
did not exist.

- **`codegrind.service`** — `Type=simple`, the invoking (unprivileged) user,
  `EnvironmentFile=.env`, `Restart=always`. Its `PATH` leads with the same Node bin
  directory as its `ExecStart`, and both are the Node `bin/lib/node.sh` picks — so the
  service and the CLI load the same `better-sqlite3` against the same ABI.
- **`codegrind-reap.service`** — `Type=oneshot`, same unprivileged user, runs
  `bin/reap-runners`. `TimeoutStartSec=120` so a Docker hiccup cannot wedge the timer.
- **`codegrind-reap.timer`** — `OnBootSec=2min`, `OnUnitActiveSec=5min`. It exists only
  for the case `bin/run-submission`'s `EXIT` trap cannot cover: the script itself
  SIGKILLed, leaving a container spinning a full core with nobody to remove it. Two of
  those once ran for 10 days.

**Host-local settings go in a drop-in, never in `deploy/`.** `bin/install-units` rewrites
the unit on every deploy, so an edit in `/etc/systemd/system/codegrind.service` is lost;
`/etc/systemd/system/codegrind.service.d/*.conf` is a separate file systemd merges over
the unit, and the installer never reads, writes or removes one (`--status` lists them, so
they are visible rather than invisible). `CODEGRIND_MODEL_DENY` is the canonical example:
the model ids it holds are facts about one machine's router, and they must not be in the
repo, where they would be noise in everybody else's install.

---

## Configuration

`.env` is read by `bin/start`, `bin/status`, `bin/stop`, `bin/migrate` and friends, and
handed to the service by systemd's `EnvironmentFile`. `bin/setup` writes one if it is
absent and **never touches an existing one**. `.env.example` documents every field with
its reasoning.

| variable | default | |
|---|---|---|
| `PORT` | `9416` | |
| `HOST` | `127.0.0.1` | |
| `DATA_DIR` | `./data` | database, scratch, pidfile, log, setup stamps |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | the workhorse: generation, coaching, translation — and, through the `small` role, hints, plans, primers and lessons |
| `ANTHROPIC_CHAT_MODEL` | `claude-opus-5` | the tutor chat only (`POST /api/ask`) |
| `ANTHROPIC_API_KEY` | unset | **optional.** If set, it wins over the stored key. If unset, the wizard's stored key is used. Do not hand-add it — see [troubleshooting.md](troubleshooting.md#the-api-key-vanished-from-env). |
| `ANTHROPIC_BASE_URL` | Anthropic's own | where the Anthropic adapter points (`llm.anthropic.ts`). For a proxy or a gateway that speaks the Anthropic wire format. Unrelated to `CODEGRIND_ENDPOINT`, which is the OpenAI-compatible one. |
| `CG_SCRATCH_DIR` | `$DATA_DIR/tmp` | where `bin/run-submission` and `bin/reap-runners` put and look for per-run work directories |
| `CG_HOST_SCRATCH_DIR` | = `CG_SCRATCH_DIR` | the same directory's path **on the Docker host**. Identical today; the two exist so containerizing the app is two environment variables and a shared volume rather than a rewrite. |
| `BACKUP_DIR` | `~/backups/codegrind` | read by `bin/backup-db` and `bin/restore-db` |

`$DATA_DIR/.setup/` holds `bin/setup`'s idempotency stamps and its logs — `npm.log`,
`build.log`, `db.log`, `images.log`. When a step fails, the error names the log.

### Running on something other than Claude

codegrind is provider-agnostic. Everything above keeps working unchanged; everything below
is opt-in, and all of it can be set from the browser instead (the first-run wizard, or
Settings → which model answers). **The environment wins, field by field**, and any field
the environment pins is rendered read-only in the browser rather than offered as a write
that would never take effect.

Two roles are routed independently: the **workhorse** (generation, coaching, translation,
and the cheap `small` calls that ride on its client — hints, plans, primers, lessons) and
the **tutor** (`POST /api/ask` only).

**How the tutor's default works, exactly**, because it differs by path and the difference
is the whole point:

- On an **OpenAI-compatible** endpoint an unset tutor inherits the workhorse's provider
  *and* model. That is what keeps a local install local — no key, no signup, no spend.
- On **Anthropic** an unset tutor gets `claude-opus-5` while the workhorse gets
  `claude-sonnet-5`. It has always worked that way, deliberately: the tutor is one call
  per question you actually ask. It is now named and priced on the Ready screen and in
  Settings, where the coach can be pinned to the writer's model instead.

Every variable below is read **once, at module load** (`llm.client.ts`), and a bad value
throws at boot rather than at 3am on the first generate.

| variable | default | |
|---|---|---|
| `CODEGRIND_PROVIDER` | `anthropic` | the workhorse's provider: `anthropic`, or `openai-compatible` for llama.cpp, llama-swap, vLLM, Ollama, LM Studio and anything else speaking `/v1/chat/completions`. Any other value is a boot error. |
| `CODEGRIND_MODEL` | provider default | the workhorse model id, provider-neutral spelling. On the Anthropic path `ANTHROPIC_MODEL` is read first; on any other path the vendor-named variable is deliberately **not** consulted, so a leftover `ANTHROPIC_MODEL` cannot be sent to a local endpoint. There is no default for a local endpoint and never will be — picking one for you is how a router hands the job to whatever is cheapest to load, which on some fleets is a CPU. |
| `CODEGRIND_CHAT_PROVIDER` | = workhorse's | the tutor's provider. Set it to keep the tutor on Claude while the rest runs locally, or the reverse. |
| `CODEGRIND_CHAT_MODEL` | see above | the tutor model id. `ANTHROPIC_CHAT_MODEL` is read first on the Anthropic path, same rule as above. |
| `CODEGRIND_ENDPOINT` | unset | the OpenAI-compatible base URL, **including the version segment** (`http://127.0.0.1:9600/v1`). Only meaningful for `openai-compatible`. |
| `QWEN_URL` | unset | fallback for `CODEGRIND_ENDPOINT`, for boxes that already export one. Read only when `CODEGRIND_ENDPOINT` is empty. |
| `CODEGRIND_API_KEY` | unset | bearer token for that endpoint, if it wants one. Most local servers do not. Write-only: it reaches the adapter and no `GET` ever returns it. |
| `CODEGRIND_MODEL_DENY` | empty | comma-separated model ids this install must **never** send work to. codegrind cannot know a router's topology — an id in `/v1/models` can be mapped onto a CPU on this very machine, where a big model will fight the rest of the box for cores. Denied ids are filtered out of the wizard's model list *and* refused at call time. |
| `CODEGRIND_MAX_OUTPUT_TOKENS` | `8000` | the ceiling on what any single call may ask a local endpoint for. The default is a measurement, not a guess: a real generated problem is 976–5337 output tokens, while a generation that degenerates into repetition runs to whatever budget it is handed (16000 tokens of loop took 293s; 8000 takes 144s, and the discarded problem is the same one). Raise it if your model genuinely writes bigger problems and you see good ones cut off; `0` removes the ceiling and sends each call site's own number. Anything that is not an integer ≥ 0 is a boot error. |
| `CODEGRIND_CORS_ORIGINS` | empty | extra browser origins allowed to call the API, comma-separated and matched exactly. Leave it empty. codegrind has no authentication of its own, so a request arriving with a foreign `Origin` is **refused with 403** rather than merely denied its response header — omitting the header only stops the page *reading* the reply, while a cross-origin `POST /api/problems` would still have run and spent your key. Same-origin is decided by comparing the `Origin`'s host against `Host`, not the full origin, so a TLS-terminating proxy in front does not 403 itself. Requests with no `Origin` at all (curl, healthchecks) are allowed. A literal `*` in this list is dropped, not honoured. |

There is **no failover**. If the configured endpoint is down, calls fail loudly, naming
the endpoint and the model; they never silently become Anthropic calls.

---

## Known rough edges

No script in `bin/` contains an absolute path into anybody's home directory, and that is
a property worth keeping: every one of them derives its repo root from its own location
(`REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"`), picks its Node through
`bin/lib/node.sh`, and reads `PORT`/`DATA_DIR` from `.env`. Several of them used to
hardcode one, and on any other machine they built, warmed or wiped the wrong tree. What is
left, deliberately:

- **`bin/deploy` calls `sudo` and restarts the system unit.** It is the one script in
  `bin/` that assumes an installed service.
- **`bin/warm-lessons` and `bin/translate-corpus` require `ANTHROPIC_API_KEY` in the
  environment**, and do not read the configuration the wizard stored. See
  [Spending money](#spending-money).
