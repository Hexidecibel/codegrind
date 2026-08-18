# Operations

Everything operational is a script in `bin/`. There are no one-off `docker`/`sqlite3`
incantations to remember, and if you find yourself typing one, the fix is a script.

Every script's own header is the authoritative help; most also take `--help`. What
follows is when to reach for which.

**Before anything else:** `bin/` scripts that run Node pick their own Node via
`bin/lib/node.sh` (the pinned v22 install, else any supported major on `PATH`, else
anything nvm has). If you are running `npx`/`node` by hand instead:

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"    # or: nvm use 22
```

---

## Daily

| | |
|---|---|
| `bin/setup` | The front door. Preflight → deps → build → migrate → images → start. Idempotent; a re-run finishes in under a second and says what it skipped. Flags: `--port N` (persists to `.env`), `--no-start`, `--force`, `--check`, `--help`. |
| `bin/start` | Start as a plain background process (setsid + nohup + pidfile in `$DATA_DIR`), wait for `/api/health`. `--quiet` speaks only on failure. **Refuses to run beside a systemd instance serving the same directory** — two processes, one SQLite file, one port. |
| `bin/stop` | Stop what `bin/start` started. Signals the whole **process group**: `tsx` runs the server in a child, and signalling only the pidfile's process leaves it orphaned and still holding the port. TERM, wait, then KILL. |
| `bin/status` | Service state (pidfile first, then systemd), health probe, one line per runner image, reaper timer, and any runner containers currently in flight. Run this first, always. |
| `bin/logs` | Whichever log this instance actually has: `$DATA_DIR/server.log` for a `bin/start` instance, `journalctl -u codegrind` for the service. Detects in the same order `bin/status` does, and only claims the unit when its `WorkingDirectory` is this checkout. `-n N`, `--no-follow`, `--file`/`--systemd` to force. |
| `bin/build` | `tsc -b && vite build`, then precompress `dist/` to `.br`/`.gz`. Safe against a live install — the server only reads `dist/` per request. `SKIP_INSTALL=1` skips the npm step. |
| `bin/migrate` | Open and migrate the database, then report what it holds. `--quiet` for one line. Idempotent and self-healing. Its job is to make a migration failure be reported by the thing whose job that is, instead of arriving as "the server exited". |

## Installed as a service (the author's box)

| | |
|---|---|
| `bin/deploy` | The full deploy: refresh `.env` via cush-tools `inject` (skipped harmlessly if absent; `CG_INJECT` overrides where it looks) → `npm ci --include=dev` → `bin/build` → ensure every runner image → `bin/install-units` → `systemctl restart` → wait for health → `bin/status`. **No arguments, no `--help`, and it restarts the system unit** — do not run it to "see what it does". |
| `bin/restart` | `systemctl restart` + wait for health + `bin/status`. |

Both wait for health on `$PORT` from `.env`, not a literal 9416.
| `bin/install-units` | **Render** `deploy/*` for this machine and install the result into `/etc/systemd/system`, then enable the reaper timer. `--status` shows what is installed, whether it has drifted, and which drop-ins are present. `--print [unit]` renders to stdout and changes nothing — no sudo, no `/etc`, which is how you check what it would write. Rewrites the unit but does **not** restart, so a change to `codegrind.service` needs a `bin/restart` after. |

Three units live in `deploy/`:

They are **templates**, not units you can copy: `WorkingDirectory`, `User` and the
pinned Node bin directory are `@CODEGRIND_REPO@`, `@CODEGRIND_USER@` and
`@CODEGRIND_NODE_BIN@`, filled in by `bin/install-units` from the same three sources the
rest of `bin/` uses — the script's own location, `${SUDO_USER:-$(id -un)}`, and
`bin/lib/node.sh`. Lines beginning `##` are notes to whoever edits the template and are
stripped on render; ordinary `#` comments are kept, because several of them are incident
reports. `src/shared/deploy-units.test.ts` asserts both halves of that.

- **`codegrind.service`** — `Type=simple`, the invoking (unprivileged) user,
  `EnvironmentFile=.env`, `Restart=always`. Its `PATH` leads with the same Node bin
  directory as its `ExecStart`, and both are the Node `bin/lib/node.sh` picks — so the
  service and the CLI load the same `better-sqlite3` against the same ABI.
- **`codegrind-reap.service`** — `Type=oneshot`, same unprivileged user, runs
  `bin/reap-runners`. `TimeoutStartSec=120` so a Docker hiccup cannot wedge the timer.
- **`codegrind-reap.timer`** — every 5 minutes. It exists only for the case
  `bin/run-submission`'s `EXIT` trap cannot cover: the script itself SIGKILLed, leaving a
  container spinning a full core with nobody to remove it. Two of those once ran for 10
  days.

**Host-local settings go in a drop-in, never in `deploy/`.** `bin/install-units` rewrites
the unit on every deploy, so an edit in `/etc/systemd/system/codegrind.service` is lost;
`/etc/systemd/system/codegrind.service.d/*.conf` is a separate file systemd merges over
the unit, and the installer never reads, writes or removes one (`--status` lists them, so
they are visible rather than invisible). This machine uses
`codegrind.service.d/model-deny.conf` for `CODEGRIND_MODEL_DENY` — model ids that exist
only on this box's LLM router, one of which starved the Plex transcoder. That list must
not be in the repo, where it would be noise in everyone else's install.

## The sandbox

| | |
|---|---|
| `bin/build-runner-image [lang…]` | Builds every language with a harness on disk, or just the ones named. Each image is immediately run with `--selftest` against the conformance fixture, **with the same sandbox flags a real submission gets**; an image that disagrees is deleted rather than published. `--no-selftest` for debugging only. |
| `bin/run-submission <lang> <src> <tests.json>` | The actual `docker run`. Called by `sandbox.service`, not by you — but it is the thing to run by hand when you want to see raw harness output. |
| `bin/reap-runners` | Kill orphaned runner containers and orphaned scratch dirs older than `MAX_AGE` (300s; the longest legitimate submission is 30s). `--dry-run`, `--max-age SECONDS`. On a timer in production. |

`bin/reap-runners` filters on `--label codegrind.runner=1`, **never `ancestor=`**. See
[troubleshooting.md](troubleshooting.md#a-runner-container-is-spinning-a-core).

## Spending money

Every one of these makes real Claude calls. All are idempotent and resumable — a re-run
after a partial failure only pays for what is still missing — and all take `--dry-run`.

| | |
|---|---|
| `bin/seed-bank` | Stock the problem bank. `--language <l>`, `--topic <t>` (repeatable), `--difficulty <d>` (repeatable), `--per-slot N`, `--dry-run`. Bare, it seeds the **active** language's root topics (`arrays`, `hashing`, `math`, `bit-manipulation`) at `easy` — the only slots the scheduler's cold-start path can reach before you have done anything, and so the only ones worth pre-paying for. Skip-if-exists is `servableBankSize`, the same predicate that decides what gets served. |
| `bin/warm-lessons` | Pre-generate the Study reading tracks (18 outlines + the first lessons of each) so the first bedtime session is not a series of 15s waits. `--dry-run`/`-n`, `--topic`/`-t` (repeatable), `--lessons N`. |
| `bin/translate-corpus` | Translate the shared corpus's **snippets** into another language — one batched call per topic, ~18 for the whole corpus, against the 90–180 generation calls re-authoring it per language would cost. `-L <lang>`, `-t <topic>`, `--limit N`, `--dry-run`. The Study feed does the same work lazily one topic ahead of the reader, through the same service call, so this is only the eager half. |

Nothing warms automatically. Every LLM call in this app is user-initiated, which is what
keeps an idle instance at $0.

## Backups

**Always `bin/backup-db`. Never `cp`.**

```bash
bin/backup-db                # → $BACKUP_DIR/codegrind.<timestamp>.db
bin/backup-db pre-phase5     # → $BACKUP_DIR/codegrind.pre-phase5.<timestamp>.db
```

`BACKUP_DIR` defaults to `~/backups/codegrind`. The path of the last successful backup is
written to `$BACKUP_DIR/.last-backup`, which is what `bin/restore-db --latest` reads.

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

**`bin/restore-db`.** It encodes the procedure that used to live in this paragraph — stop
the server, move the file into place, delete the stale `-wal`/`-shm` siblings, migrate —
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
2. **It verifies the backup before touching the live one**: magic bytes, `integrity_check`,
   the core tables (`problems`, `attempts`, `sessions`, `settings`), a refusal if every
   table is empty (the classic wrong file — the blank database `bin/migrate` creates), and
   a refusal if the backup's schema is *newer* than this checkout can migrate to. Then it
   prints backup row counts beside current ones, so the loss is visible **before** it is
   agreed to. A restore that discovers the backup is bad after deleting the original has
   destroyed the last good copy in the building.
3. **It takes a safety backup of the current database first**, through `bin/backup-db` so
   the WAL comes with it, labelled `pre-restore`. That backup becomes the new
   `.last-backup` — so if the restore was itself the mistake, `bin/restore-db --latest`
   walks it back.
4. Only then does it replace the file, remove the stale sidecars, and run `bin/migrate`.

Without `--yes` it asks, and it will not accept a piped "y": no terminal and no `--yes` is
a refusal, because a destructive restore should not happen by accident in a pipeline.

## Migration safety net

| | |
|---|---|
| `bin/capture-baseline [dir]` | The "before" half. **Read-only**; GETs the live API and opens SQLite `readonly:true`. Captures `/api/reflect`, `/api/progress`, `/api/history`, `/api/study/index` and the clean-solves aggregation straight from SQL. The service **must be up** — a baseline captured from a down service is a file full of nothing that later "matches" anything. |
| `bin/verify-migration` | The "after" half. **Read-only.** Four layers, weakest first: row counts → clean-solves aggregation → tier credits + multi-language invariants → API payloads byte-compared against the baseline. `--db-only` skips the API layer. Exit 0 = PASS, 1 = FAIL, 2 = INCOMPLETE. |

Layer 2 is the one that earns its keep: the tier ladder comes from a join of `attempts` to
`problems`, and a rebuild that writes the columns in the wrong order leaves both row
counts perfect.

The whole sequence around a schema change:

```bash
bin/backup-db pre-<change>
bin/capture-baseline                 # service must be up
# … change and deploy …
bin/verify-migration                 # must PASS
```

## Smoke tests

| | |
|---|---|
| `bin/smoke-e2e <lang>` | Drive one language through the **live app**: set the language, get a problem, run it, submit the reference, get coaching, then assert what the database recorded. `--generate` forces a fresh generate; `--topic`/`--difficulty` pin the slot. **Not free and not read-only** — it records a real attempt, which moves `/api/reflect` and `skill_state`. Re-capture the baseline afterwards or the next `bin/verify-migration` reports the new rows as a regression. |
| `bin/smoke-python` | The four Python-specific hazards: deep recursion, stray `print()`, `IndentationError` → the `compile_error` **verdict** (which lives in `sandbox.service`, above the runner, so it is proven through the live API), and float tolerance. Read-only w.r.t. the database; no LLM calls. |
| `bin/smoke-go` | The Go-specific hazards: compile diagnostics carrying the **line and column of the user's own file**, unused imports, deep recursion with no workaround, `(result, error)` refused with an authored message, float tolerance, and the nil slice that must render `[]` and not `null`. |
| `bin/smoke-isolation` | Prove the language partition holds. Only meaningful in a slot **both** banks stock — asking for a Python problem when only Python problems exist proves nothing — so it picks such a slot and exits 2 rather than claiming a pass it did not earn. **Consumes one banked problem per language** and leaves the active language set to whatever it checked last; `--restore <lang>` puts it back. |

## Repair

| | |
|---|---|
| `bin/restore-db` | Put a backup back, safely. The only destructive script in `bin/` — see [Backups](#backups). |
| `bin/reset-progress` | Wipe **learner** state (`attempts`, `sessions`, `review_queue`, `skill_state`) and free the whole bank (`used = 0`), keeping the generated problems and primers — a fresh start that reflects real performance without re-paying generation cost. |
| `bin/fix-go-starters` | Give every banked Go problem a `starterCode` that actually compiles. Reports by default; `--apply` writes. Idempotent — a starter that already declares a package is left alone. Exists because Go's first authoring rule was wrong; see [adding-a-language.md](adding-a-language.md). |

## Configuration

`.env` is read by `bin/start`, `bin/status`, `bin/stop`, `bin/migrate` and friends, and
handed to the service by systemd's `EnvironmentFile`. `bin/setup` writes one if it is
absent and **never touches an existing one**.

| variable | default | |
|---|---|---|
| `PORT` | `9416` | |
| `HOST` | `127.0.0.1` | |
| `DATA_DIR` | `./data` | database, scratch, pidfile, log, setup stamps |
| `ANTHROPIC_MODEL` | see `.env.example` | the workhorse: generation, hints, plans, primers, lessons, coaching |
| `ANTHROPIC_CHAT_MODEL` | see `.env.example` | the tutor chat only (`POST /api/ask`) |
| `ANTHROPIC_API_KEY` | unset | **optional.** If set, it wins over the stored key. If unset, the wizard's stored key is used. Do not hand-add it — see [troubleshooting.md](troubleshooting.md#the-api-key-vanished-from-env). |
| `ANTHROPIC_BASE_URL` | Anthropic's own | where the Anthropic adapter points (`llm.anthropic.ts`). For a proxy or a gateway that speaks the Anthropic wire format. Unrelated to `CODEGRIND_ENDPOINT`, which is the OpenAI-compatible one. |
| `CG_SCRATCH_DIR` | `$DATA_DIR/tmp` | where submissions are staged |
| `CG_HOST_SCRATCH_DIR` | = `CG_SCRATCH_DIR` | the same directory's path **on the Docker host**. Identical today; the two exist so containerizing the app is two environment variables and a shared volume rather than a rewrite. |

### Running on something other than Claude

codegrind is provider-agnostic. Everything above keeps working unchanged; everything
below is opt-in, and all of it can be set from the in-app wizard instead (Settings →
which model answers) — **the environment wins, field by field**, and any field the
environment pins is rendered read-only in the browser rather than offered as a write
that would never take effect.

Two roles are routed independently: the **workhorse** (generation, hints, plans,
primers, lessons, coaching) and the **tutor** (`POST /api/ask` only). The tutor
inherits the workhorse's provider *and* model unless told otherwise, which is what
keeps a local install local — an unset tutor is never a silent Anthropic bill.

Every one of these is read **once, at module load** (`llm.client.ts`), and a bad value
throws at boot rather than at 3am on the first generate.

| variable | default | |
|---|---|---|
| `CODEGRIND_PROVIDER` | `anthropic` | the workhorse's provider: `anthropic`, or `openai-compatible` for llama.cpp, llama-swap, vLLM, Ollama, LM Studio and anything else speaking `/v1/chat/completions`. Any other value is a boot error. |
| `CODEGRIND_MODEL` | provider default | the workhorse model id, provider-neutral spelling. On the Anthropic path `ANTHROPIC_MODEL` is read first; on any other path the vendor-named variable is deliberately **not** consulted, so a leftover `ANTHROPIC_MODEL` cannot be sent to a local endpoint. There is no default for a local endpoint and never will be — picking one for you is how a router hands the job to whatever is cheapest to load, which on some fleets is a CPU. |
| `CODEGRIND_CHAT_PROVIDER` | = workhorse's | the tutor's provider. Set it to keep the tutor on Claude while the rest runs locally, or the reverse. |
| `CODEGRIND_CHAT_MODEL` | = workhorse's | the tutor model id. `ANTHROPIC_CHAT_MODEL` is read first on the Anthropic path, same rule as above. |
| `CODEGRIND_ENDPOINT` | unset | the OpenAI-compatible base URL, **including the version segment** (`http://127.0.0.1:9600/v1`). Only meaningful for `openai-compatible`. |
| `QWEN_URL` | unset | fallback for `CODEGRIND_ENDPOINT`, for boxes that already export one. Read only when `CODEGRIND_ENDPOINT` is empty. |
| `CODEGRIND_API_KEY` | unset | bearer token for that endpoint, if it wants one. Most local fleets do not. Write-only: it reaches the adapter and no `GET` ever returns it. |
| `CODEGRIND_MODEL_DENY` | empty | comma-separated model ids this install must **never** send work to. codegrind cannot know a router's topology — an id in `/v1/models` can be mapped onto a CPU on this very machine, where a big model will fight the rest of the box for cores. Denied ids are filtered out of the wizard's model list *and* refused at call time. |
| `CODEGRIND_MAX_OUTPUT_TOKENS` | `8000` | the ceiling on what any single call may ask a local endpoint for. The default is a measurement, not a guess: a real generated problem is 976–5337 output tokens, while a generation that degenerates into repetition runs to whatever budget it is handed. Raise it if your model genuinely writes bigger problems and you see good ones cut off; `0` removes the ceiling and sends each call site's own number. Not an integer ≥ 0 is a boot error. |

There is **no failover**. If the configured endpoint is down, calls fail loudly, naming
the endpoint and the model; they never silently become Anthropic calls.

`$DATA_DIR/.setup/` holds `bin/setup`'s idempotency stamps and its logs — `npm.log`,
`build.log`, `db.log`, `images.log`. When a step fails, the error names the log.

## Known rough edges

`grep -rn '/home/hexi' bin/` returns nothing, and that is a property worth keeping: every
script derives its repo root from its own location (`REPO="$(cd "$(dirname
"${BASH_SOURCE[0]}")/.." && pwd)"`), picks its Node through `bin/lib/node.sh`, and reads
`PORT`/`DATA_DIR` from `.env`. What is left, deliberately:

- **`deploy/*` no longer hardcodes anything** — it did, and that was the hole in the
  check above: `bin/install-units` copied one machine's `WorkingDirectory`, `User` and
  pinned Node straight into `/etc`. The units are templates now and the installer renders
  them. Nothing in the first-run path (`setup` → `start`) touches systemd at all, so
  running codegrind as a service remains entirely optional.
- **`bin/deploy` restarts the system unit and calls `sudo`.** It is the author's deploy,
  and it is the one script in `bin/` that assumes an installed service. On any other
  machine the equivalent is `bin/build && bin/stop && bin/start`.
- **`BACKUP_DIR` defaults under `$HOME`, not under `DATA_DIR`.** A backup that lives inside
  the directory it is a backup of is not a backup.
