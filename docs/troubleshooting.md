# Troubleshooting

Every failure here has been hit for real. Run `bin/status` first — it answers a third of
them in one line.

---

## Setup will not run

### Node 24 — the single most likely newcomer failure

`better-sqlite3` is a native module compiled against a specific V8 ABI
(`NODE_MODULE_VERSION`). Under a Node whose ABI does not match it does not degrade and it
does not warn: the process **hard-crashes at module load**, which means every script in
`bin/` dies before printing anything useful. Under Node 24 it is a segfault, not an
exception anything can catch.

Supported majors are **22 and 20**, and that list is the ones better-sqlite3 ^11 publishes
prebuilt binaries for *and* this app has actually run on. Adding one without testing it is
how you find out about an ABI break in production.

```bash
nvm install 22 && nvm use 22
bin/setup
```

`bin/setup` refuses an unsupported Node before it does anything else, and its advice
notices whether you already have nvm. The messier case is a *supported* Node where the
native module still will not load — a mismatched prebuild, a half-finished install — so
`bin/setup` proves it explicitly right after `npm install` (`node -e
'require("better-sqlite3")'`) rather than letting it surface as a segfault three steps
later. That failure ends with:

```
    Switch to Node 22 and re-run with --force:
        nvm use 22 && bin/setup --force
```

`--force` matters: the install is stamped by content hash **plus the Node version**, so a
plain re-run under a different Node reinstalls anyway — but `--force` also redoes the
build, which is what you want after an ABI change.

Note that `bin/lib/node.sh` will *find* a supported Node even if your shell has the wrong
one selected — the pinned install first, then `PATH`, then anything nvm has, newest first.
Only if there is none does setup stop.

### Docker is missing or its daemon is unreachable

There is no fallback that runs your code in-process, deliberately. Every submission —
yours, and the ones the app writes to verify its own problems — runs in a `--network none
--read-only --cap-drop=ALL` container.

```bash
docker info                      # the real error is here
sudo systemctl start docker      # not started
sudo usermod -aG docker $USER    # not in the group — then log out and back in
```

`bin/setup` only suggests the `usermod` line when you genuinely are not in the group.

### Not enough disk

The three sandbox images are ~3 GB together (Go's toolchain is most of it), plus layer
scratch while they build. Below 3 GB free on Docker's root directory, `bin/setup` stops;
below 6 GB it warns. Running out mid-build leaves a half-built image and an error about a
tar stream, which explains nothing.

```bash
docker system prune -a
```

### The port is busy

```
✗ port 9416 is already in use by something else
    Find it with:  ss -ltnp 'sport = :9416'   (or: lsof -i :9416)
    Then either stop it, or run codegrind somewhere else:
        bin/setup --port 9500
```

If the thing on the port *is* codegrind answering `/api/health`, that is not an error and
setup says so.

### A step failed and I want the detail

Every expensive step writes a log under `$DATA_DIR/.setup/` — `npm.log`, `build.log`,
`db.log`, `images.log` — and the error names the file. `bin/setup --check` re-runs the
preflight only and changes nothing.

### A sandbox image failed to build

An image whose comparator disagrees with `test-harness/conformance/equality-cases.json` is
**deleted rather than published**, so it can never grade a submission. Retry one at a time
to see which:

```bash
bin/build-runner-image go
```

---

## The app is running but does not work

### "the server did not come up"

```bash
tail -50 $DATA_DIR/server.log        # bin/start instance
bin/logs                             # systemd instance
```

The commonest cause after a fresh clone is a missing `dist/` — `bin/start` checks for it
and says so. Run `bin/setup` (or `bin/build`).

### `bin/stop` said "stopped" but the port is still busy

Fixed, but worth knowing why: `tsx` runs the server in a **child** process and that child
binds the port and opens the database. Signalling only the pidfile's process left it
orphaned and listening — `bin/stop` reported success, `bin/status` reported nothing
running, and the next `bin/setup` found the port busy *and serving codegrind*.
`bin/start` uses `setsid` so the pid is the process-group id, and `bin/stop` signals the
whole group. If you ever see the symptom again, `ss -ltnp 'sport = :9416'` finds the
survivor.

### `bin/start` refuses to start

If a systemd-managed codegrind is active **for this same directory**, a second copy would
give two processes the same SQLite file and the same port. Use `bin/restart`. A scratch
clone elsewhere on the same box is fine — the guard compares the unit's
`WorkingDirectory` with the repo root, not the unit name.

### The API key vanished from `.env`

**It must never be in `.env`.** `bin/inject` (the author's secret tooling) rewrites that
file with `O_TRUNC` from `.cush-secrets` on **every deploy and every `cd` into the
directory** (direnv), so a hand-added key there is destroyed silently and at an
unpredictable moment. The app simply stops working, with no edit to blame.

The key lives in the `settings` table, written by the first-run wizard and validated
against Anthropic before it is stored. Paste it into the setup screen.

**The environment still wins.** If `ANTHROPIC_API_KEY` is set in the process environment
it takes precedence over anything stored, and nothing the wizard writes can shadow it —
that is the compatibility guarantee for an existing deploy whose key arrives from a secret
manager via systemd's `EnvironmentFile`. `hydrate()` only publishes a stored key when the
environment has none.

This is also why the same file loses `PORT`/`HOST`/`DATA_DIR` on a box running
`bin/inject`: it writes *only* the manifest's secrets. Non-secret config belongs in code
defaults (which cover all three) or in the systemd unit.

### The setup wizard appears in front of a working app

It should not — `needed` is derived on every request, never stored as an "onboarded"
flag. It appears when either (a) there is no usable key, or (b) the **active** language has
zero servable problems, where servable means `used = 0 AND canonicalized = 1`. Note that a
bank full of already-solved problems is a non-zero bank with nothing to hand out. Check:

```bash
curl -s localhost:9416/api/setup/state | python3 -m json.tool
```

"Skip — generate as I go" writes `setup.dismissed`, which suppresses **only** the
empty-bank prompt. It cannot suppress the missing-key one, because there is nothing to
skip to.

### The key is rejected

The wizard validates against Anthropic's `models.list` (authenticated, costs no tokens,
`maxRetries: 0`) and distinguishes the cases, because they need completely different
advice:

| | |
|---|---|
| does not start `sk-ant-` | no network call is made |
| 401 / 403 | wrong or revoked key |
| 429 | real key, rate-limited right now |
| 400 mentioning credit/balance | valid key, no credit on the account |
| no status at all | this machine cannot reach the API |

Nothing is stored unless it validated.

### Seeding failed partway

Individual failures are amber log lines and the run **continues** — a partial bank is a
usable bank. "Stop and start grinding with what I have" stops *watching*; the generate
already in flight is paid for and will still be banked.

If a line reads `… run bin/build-runner-image <lang>`, the sandbox image for that language
is missing. That is the one seeding failure a first-run user is actually likely to hit, so
it is detected and rewritten into advice.

If every generation fails you can still proceed — a session-page latch stops the wizard
bouncing you back — but fix the sandbox first: `bin/status`, then
`bin/build-runner-image`.

---

## The database

### Never put it on mergerfs, NFS or NTFS

SQLite needs working `fcntl` locking. On a FUSE union filesystem (and doubly so on
FUSE-over-NTFS) it does not get it, and the database **corrupts**. This is not
theoretical — it has already destroyed a database on this server, in a different app, for
exactly this reason.

Put `DATA_DIR` on local NVMe/ext4. `bin/setup` says so in the failure text when it cannot
open the database, and it is the first thing to check if you see `database disk image is
malformed`.

### Always back up with `bin/backup-db`, never `cp`

The database is in WAL mode and the log has never been checkpointed — megabytes against a
sub-megabyte main file. `cp data/codegrind.db backup.db` copies the main file **without
the WAL**, silently loses most of your recent history, and exits 0 looking exactly like it
worked. `bin/backup-db` uses SQLite's online backup API, then re-opens the copy and
verifies every row count, `user_version` and `integrity_check`. See
[operations.md](operations.md#backups).

### The service is crash-looping after a schema change

That is the designed failure mode. The migration runs in one transaction with row-count
and content checks **inside** it, so a failure rolls back and the database is untouched;
the service then crash-loops loudly rather than starting against a half-migrated file. Do
not add a `--force` or a `--reset` that papers over it.

```bash
bin/migrate                      # the migration reported by the thing whose job it is
bin/verify-migration --db-only   # what actually moved
```

The one migration bug that has actually shipped is instructive: a content check drifted
into asserting "no `skill_state` row may ever be non-JavaScript", which was true only
while the app was JavaScript-only. The first Python submit wrote `('arrays','python')`,
and from then on every startup would have aborted its own migration against a database
that was in fact perfect. The check is now gated on the rebuild it is actually about.

---

## Running code

### A submission fails with "could not read solution"

Scratch-directory permissions. `mktemp -d` produces a 0700 directory owned by uid 1000,
which was invisibly fine for exactly one language: node's image user *is* uid 1000. The
Python and Go images run as `nobody` (65534), which cannot traverse it — so **every**
submission in those languages failed, and a whole language looked permanently broken from
a mode bit.

`bin/run-submission` chmods the work dir 0711 and its contents 0644, and any new language
inherits that. If you see this again, check those two `chmod` lines survived, and that
`CG_SCRATCH_DIR` is somewhere the image's user can reach.

### A runner container is spinning a core

```bash
docker ps --filter label=codegrind.runner=1
bin/reap-runners --dry-run
bin/reap-runners
```

`bin/run-submission` force-removes its own container in an `EXIT` trap, which covers the
normal timeout path; the timer covers the case it cannot — the script itself SIGKILLed.

**`bin/reap-runners` must filter by `--label codegrind.runner=1` and never by
`ancestor=`.** Docker resolves `ancestor=<tag>` to an image **ID** at query time, so
rebuilding the runner mints a new ID and every container started from the old image
instantly becomes invisible to the reaper — and a rebuild is exactly the moment long-lived
orphans exist. The reaper was blind to the containers it was written for. Two of them ran
for 10 days and burned two full cores. A label is attached to the container at creation and
nothing that happens to the image afterwards can invalidate it.

If the timer is not running: `bin/install-units`, then check `bin/status` reports
`reap timer: active`.

### A submission times out with no output at all

The budgets nest, and each must stay strictly inside the next: per-test (~2s) → run (~10s)
→ compile (~10s) → `CG_TIMEOUT` (12s interpreted, 30s compiled) → `sandbox.service`'s 45s
`execFile` cap. If an outer one fires first, the container dies before printing its
structured partial results and you get an opaque kill instead of "3 of 8 passed, then this
one hung." If you change any budget, check `CG_TIMEOUT` still clears the sum — a test
asserts this for Go.

### A correct answer is marked wrong

Almost always the equality spec. Run the gate:

```bash
bin/build-runner-image <lang>     # rebuilds, then --selftest against the fixture
```

The fixture (`test-harness/conformance/equality-cases.json`) pins the cases hand-written
comparators get wrong: NaN and the signed infinities via `{"$cg":…}` sentinels; a float
tolerance of `abs(a-b) <= max(1e-9, 1e-9*max(|a|,|b|))` that **never** applies when both
values are integers (a relative tolerance near 2^53 is an absolute slack of ~9 million,
which would silently accept a wrong count) and **never** when either value is non-finite
(`abs(inf - -inf) <= inf` is true, which would make the two infinities equal); sorted-key
serialization; array order-sensitivity; dict key-order insensitivity.

If your language genuinely cannot satisfy a case, the case does not belong in the fixture —
but note that Python and Go both landed against it **unmodified**.

### A problem seems unsolvable

Check `canonicalized`. Every `expected` value is supposed to be the output of really
running the reference solution in the sandbox; a problem stored without that may be
unsolvable, and it fails in the one way you cannot diagnose — by looking exactly like your
own mistake.

Un-canonicalized problems are never served again (`findUnusedProblem` filters
`canonicalized = 1`) but they stay in the table as evidence. Only JavaScript can produce
one at all — every other language throws at generation time rather than storing an
unverified problem.

### A Go problem fails to compile the moment I open it

Its `starterCode` predates the rule that a compiled language's starter must be a
**complete compilable file**. The candidate's file is compiled byte for byte under its own
name — which is the only reason a `compile_error` verdict can quote a meaningful line and
column — so a starter with no `package main` fails the instant it is submitted unchanged.

```bash
bin/fix-go-starters            # report
bin/fix-go-starters --apply    # write
```

---

## Languages and progress

### "Can I have more than one language, and is my progress saved?"

Yes, and yes — but not the same progress everywhere, on purpose.

**Per language:** the problem bank, `skill_state`, tiers, unlocks, the skill tree,
solved counts, hint-free rate and review queue.

**Global:** your streak and your lessons-read count.

Nothing is ever deleted by switching. Your JavaScript state sits exactly where you left it
and is waiting when you switch back.

**Why the skill state forks and starts cold.** A tier means "3 distinct problems solved at
this difficulty with zero hints." You have not done that in Go. Transferring the unlock
would serve a Go beginner expert-tier problems on day one. The cold-start path already
exists and works, and because `attempts.language` is recorded, pooling remains available
later as a query change rather than a migration — so this is reversible.

**Why the streak is global.** It is a habit metric. Python yesterday plus Go today is a
two-day streak.

**Why lessons stay shared.** Lesson prose is language-free by construction — the prompt
forbids fenced code in a body and puts code in a separate field — so only the snippet
forks, through `code_translations`. You have already read the lesson; re-reading it is not
the gap.

### My first problems in a new language are slow

A new language's bank starts empty, so every problem is a cold 15–30 second generate until
it fills. That is the honest cost of the hard language filter, and there is **deliberately
no cross-language fallback** — serving a JavaScript problem to a Go session would mean
grading Go source against JavaScript-derived `expected` values.

```bash
bin/seed-bank --language go --dry-run     # the plan, free
bin/seed-bank --language go               # 8 problems, a few minutes, a few cents
```

### I switched language and the problem on screen did not change

Correct. A language change affects the **next** problem served, never the one in front of
you — a problem's language is baked into its reference solution and every `expected` value
derived from it. That is why the solve surface shows a read-only badge instead of the
picker.

A session also keeps the language it *started* in: `POST /api/session/:id/next` reads it
off the session row rather than re-reading the setting, so flipping the picker mid-sitting
cannot serve a problem the plan was never built for. A stale grind snapshot in
`localStorage` is dropped when its problem's language no longer matches
(`staleForLanguage`), which is why a refresh after a switch can start you fresh.

### Java is missing from the language picker

It is not finished, and the app derives that from `test-harness/java/Dockerfile` not
existing rather than from a list anybody maintains. The wizard says "Java is not wired up
in this build yet"; `POST /api/setup/seed` refuses it with a 400 before spending anything.
See [adding-a-language.md](adding-a-language.md#what-java-still-owes).
