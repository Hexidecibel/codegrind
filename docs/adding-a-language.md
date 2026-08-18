# Adding a language

Three languages exist and the machinery is pluggable on purpose. This is the contract.
Work top to bottom; the type checker and `src/shared/languages.test.ts` will tell you
what you have forgotten.

**Java is the known next one, and it is deliberately unfinished.** `LANGUAGE_PROFILES.java`
in `llm.language.ts` is authored — because `Record<Language, LanguageProfile>` is
exhaustive and a missing key is a compile error, which is precisely what stops a language
from being half-added — but **its parameter and return type allowlist is not
written**, and the `class Solution` contract is only half-stated — the signature and
reference rules name it, and the one line in `authoringRules` says out loud that the rest
lands with the harness. Its rows in `bin/lib/languages.sh` are real, measured-shaped
values rather than placeholders, and `test-harness/java/` does not exist, so nothing can
build or run it. Read [What Java still owes](#what-java-still-owes) before starting on it.

---

## Where a language is described

Four files, each owning a different **kind** of fact. The split is deliberate and the
rule is one sentence: *if the browser cannot use it, it does not belong in
`languages.ts`; if bash does not invoke it, it does not belong in `languages.sh`.*

| file | owns | example of why |
|---|---|---|
| `src/shared/languages.ts` | presentation + authoring facts, **shipped to the browser** | Monaco grammar id, indent width |
| `bin/lib/languages.sh` | the **Docker** facts | `CG_SRCNAME[java]=Solution.java` is a javac constraint and means nothing to an editor |
| `src/server/services/llm.language.ts` | the **prompt** facts — sentences that go to Claude | "unused imports are compile errors" is not a Docker flag |
| `test-harness/<lang>/` | the harness that actually runs code | — |

A four-way split has a four-way failure mode: a language half-added, which throws
nowhere. It serves an unhighlighted buffer, or expands to an empty image name, or falls
back to another language's grammar. `src/shared/languages.test.ts` is the seam that makes
that loud — **read it before you start, it is the checklist in executable form.**

---

## The checklist

### 1. `src/shared/languages.ts`

- Append to `LANGUAGES` (order is UI order; the picker renders this tuple).
- Add a `LANGUAGE_META` row: `displayName`, `monacoId`, `codeFence`, `fileExtension`,
  `indentSize`, `insertSpaces`, `commentPrefix`.

`displayName`, `codeFence` and `fileExtension` must be **distinct across languages** (a
test asserts it). `monacoId` must be an id monaco-editor really registers — `golang`
instead of `go` silently gives a plain buffer, and a test greps
`node_modules/monaco-editor/esm/vs/index.js` for it. If `insertSpaces` is false,
`indentSize` stops being a count of spaces and becomes the **display width of a tab**, so
it must be greater than 1.

No Docker facts here. Ever.

### 2. `bin/lib/languages.sh`

Add your language to `CG_LANGUAGES` — **in the same position as in `LANGUAGES`**, a test
compares the two lists including order — and a row to **every** table:

| table | what it is | how to pick it |
|---|---|---|
| `CG_IMAGE` | the tag | `codegrind-runner-<lang>:latest` |
| `CG_SRCNAME` | the filename **inside** the container | whatever the toolchain demands |
| `CG_CMD` | the command that starts the harness | space-separated, no element may contain a space |
| `CG_MEMORY` | `--memory` | 256m interpreted, 512m for a compiler/VM |
| `CG_PIDS` | `--pids-limit` | 128 interpreted, 256 for a compiler/VM |
| `CG_TIMEOUT` | the outer `timeout` around `docker run`, seconds | **strictly above** compile + run + grace |
| `CG_TMPFS` | the `--tmpfs` argument | `/tmp` interpreted, `/tmp:exec` compiled |

A missing row does not fail loudly: an associative-array miss expands to the empty string
even under `set -u`, and docker is handed a nonsense command line. A test asserts every
table has every key.

`CG_TMPFS` is per-language rather than global on purpose. Docker mounts a `--tmpfs`
`noexec` by default, which is right for an interpreted language — there is nothing to
execute. A compiler writes a binary and then runs it, and under `noexec` that is a
permission-denied that looks nothing like a compiler problem. `exec` is a real relaxation
of the sandbox; the languages that do not need it must not have it, and a test asserts
both directions.

`CG_TIMEOUT` must stay strictly above every budget the harness enforces for itself. If it
fires first, the container dies before it can print its structured partial results and the
caller sees an opaque timeout instead of "3 of 8 passed, then this one hung." Above it
sits `sandbox.service`'s own 45s `execFile` cap, which must also stay above yours.

### 3. `test-harness/<lang>/{Dockerfile,runner.*}`

**The build context is `test-harness/`, one level up.** Docker forbids `COPY ../…` and
every runner must bake in the same `conformance/` fixture, so a per-language context could
not reach it. Context up, `-f` down — `bin/build-runner-image` does exactly that, and it
picks up your language the moment the directory exists.

The Dockerfile must:

- copy `<lang>/runner.*` to `/app/` and `conformance/` to `/app/conformance/`;
- run as an **unprivileged user** — `node` in the node images, `nobody` everywhere else.
  Defense in depth alongside `--cap-drop=ALL --read-only --network none`;
- set `ENTRYPOINT []` and a `CMD` matching `CG_CMD`;
- be **hermetic**. No network exists at run time. Bake in any dependency, and any warm
  compiler cache, at image build time.

The runner must:

1. **Accept `--selftest [path]`** and check its own `deepEqual` + serializer against
   `/app/conformance/equality-cases.json`, exiting non-zero on any disagreement. This is
   the gate: `bin/build-runner-image` runs it immediately after the build, **with the same
   sandbox flags a real submission gets** (`cg_selftest_image` in `bin/lib/languages.sh`),
   and an image that fails is **deleted rather than published**, so it can never grade a
   submission. The same gate is what `bin/setup` and `bin/deploy` run against images that
   already exist — present is not the same as good — so put anything else your image must
   prove about itself in here too, the way Go's `--selftest` also forces a 24-hour-stale
   build-cache stamp and compiles for real. Do not try to share equality code across runtimes — three
   hand-written comparators checked against one fixture is the design, and the fixture is
   the reason it is safe.
2. Read `/work/tests.json` (`{functionName, tests: [{name, args, expected}]}`), load
   `/work/<CG_SRCNAME>`, call the named function once per test with **freshly re-parsed
   arguments** (isolation between tests), and print **one JSON object** to stdout:
   `{results:[{name, passed, expected, actual, stderr, stdout, timeMs}], passed, total,
   phase?, error?, stdout?}`.
3. **Capture stdout.** A user's `print`/`console.log` written straight to fd 1 corrupts
   the payload and surfaces as an unexplained `error` verdict. Buffer around load and
   around each test call, and attach it to the result rows.
4. Serialize **with sorted keys**, so identical values render identically, and use the
   `{"$cg":"nan"|"inf"|"-inf"|"-zero"}` sentinels — JSON cannot write NaN, and NaN is
   precisely the comparison every hand-written `deepEqual` gets wrong.
5. Report `phase: "compile" | "load" | "run"` so a failure that never reached your code
   becomes a `compile_error` verdict rather than "0 of 8 tests passed".
6. Refuse to emit an integer outside ±(2^53−1). Every `expected` round-trips through
   Node's `JSON.parse`; a value that does not survive it bakes a wrong answer into the
   problem permanently.

Do not modify `equality-cases.json` to make your runner pass. A case that cannot hold
across runtimes does not belong in it — and both Python and Go landed against it
**unmodified**, so the bar is known to be reachable.

### 4. `src/server/services/llm.language.ts`

Add a `LanguageProfile`. Every field is required, so the compiler lists them for you:
`displayName`, `promptFence`, `signatureRule`, `authoringRules[]`, `referenceRule`,
`starterCodeSchema`, `referenceSolutionSchema`, `integerRubric`, `starterStub()`,
`snippetRule`, `templateRule`, `snippetStyle`.

**Author these; do not derive them.** Substituting the language name works exactly where
it appears as a *name* ("a pure, deterministic Go function") and fails everywhere it
appears as a *constraint*: a substituted `- Use plain JS (no TypeScript types)` becomes
`- Use plain Python (no TypeScript types)`, which is noise at best.

Every rule in `authoringRules` should be a failure your harness can **actually produce**,
written as a rule an author can follow. The Go profile is the model to copy. Its three
load-bearing rules have no analogue in the interpreted profiles:

- **A type allowlist.** Arguments arrive as untyped JSON and are unmarshalled into
  whatever the user's own signature declares — that is what makes "no type metadata
  anywhere" work, and it means a parameter type JSON cannot fill is a problem nobody can
  solve. Unbriefed, the model invents a `TreeNode` for the trees topic and the problem is
  simply unrunnable. Enumerate the permitted types explicitly and forbid custom structs
  and classes, pointers, interfaces, generics and varargs by name.
- **One return value.** `(result, error)` is the most natural thing a Go author can write
  and there is nowhere for the error to go.
- **Anything that is a compile error and not a warning** — a leftover `import "sort"`
  after a rewrite fails the whole build, and it is the cheapest generation failure to
  prevent.

`starterCode` **for a compiled language must be a complete compilable file** — `package
main` and all. The user's file is compiled byte for byte under its own name, which is the
only reason a `compile_error` verdict can quote a line and column that mean anything. The
alternative — having the driver prepend the boilerplate — offsets every diagnostic by a
line and quietly makes the whole verdict a lie. (`bin/fix-go-starters` exists because Go's
first draft got this backwards.)

The system prompts are precomputed per language at module load by `perLanguage()`. They
carry `cache_control: ephemeral`, so building them per call would work right up until
somebody interpolated a topic or a timestamp into one, at which point every request is a
cache miss and nothing reports it.

### 5. The mobile editor

Add `@codemirror/lang-<lang>` to `package.json` and register it in `GRAMMARS` in
`src/client/components/CodeMirrorEditor.tsx`. Monaco costs nothing — its default ESM entry
already registers the grammar.

A missing CodeMirror grammar **degrades silently** to an unhighlighted buffer, which makes
a forgotten `npm install` the kind of bug that ships. A test asserts the dependency exists
for every buildable language.

### 6. Nothing in the schema, nothing in the db layer

`language` is already a column on `problems`, `attempts` and `sessions` and already part
of `skill_state`'s primary key. `functionName` already carries the entry point. **A new
language needs no migration.**

The rule you must not break while working here: **every language-partitioned db accessor
takes `language` as a required, leading, non-defaulted parameter.** An optional
`language?: Language = 'javascript'` would turn every missed call site into a silent
cross-language read that looks perfectly correct on a JavaScript-only machine. Required
means a missed site is a compile error. `getProblem(id)` is the exception — the id carries
its own language.

---

## Then verify, in this order

```bash
bin/build-runner-image <lang>        # builds, then gates on --selftest. Free.
npx vitest run                       # the four-way agreement tests. Free.
bin/seed-bank --language <lang> --dry-run    # the plan. Free.
bin/seed-bank --language <lang> --topic arrays --per-slot 1   # ONE problem. Costs money.
bin/smoke-e2e <lang>                 # generate → run → submit → coach → assert the DB
bin/smoke-isolation                  # the language partition really holds
bin/status                           # the image is where the app thinks it is
```

Then write `bin/smoke-<lang>`, the way `bin/smoke-python` and `bin/smoke-go` exist: one
script per language proving **that runtime's specific hazards**, at the layer each
actually bites. `smoke-e2e` asks "does the app drive this language end to end";
`smoke-<lang>` asks "does this runtime behave", and those are different questions with
different answers.

Watch the **generation success rate** — accepted problems ÷ generation calls. Go's was
8/10 = 1.25 and none of its two failures were Go-specific (both were tool-output
truncation): no allowlist violation, no `(result, error)`, no `func main`, and all 8
canonicalized on the first sandbox run. Above ~1.5 calls per accepted problem, harden the
type allowlist and add a signature pre-check **before** going further, not during.

Finally: **a new language's bank starts empty**, so every early problem is a cold 15–30s
generate. That is the honest cost of the hard language filter. The mitigation is seeding,
and deliberately **not** a cross-language fallback — serving a JavaScript problem to a
Python session would mean grading Python source against JavaScript-derived `expected`
values.

---

## Things that are already solved — port them, do not rediscover them

Go paid for most of what a compiled language needs.

**Dynamic dispatch, when the language has no `eval`.** Go has no dynamic loading, so the
harness cannot look a function up by name at run time. It does not have to: `functionName`
is known at *generation* time, so the driver writes a three-line `shim.go` beside the
user's file —

```go
package main
func cgEntry() any { return twoSum }
```

— and compiles them together. Java's analogue (`Class.forName("Solution").getMethod(…)`)
is easier, but **the validation around it ports verbatim**: an identifier regex and a
keyword set, because the name is interpolated into generated source.

**Types come from the user's own signature.** `reflect.Type.In(i)` + `reflect.New(t)` +
`json.Unmarshal`, with no type metadata authored anywhere. Java's is
`getGenericParameterTypes()` + `gson.fromJson(JsonElement, Type)`.

**The three-mode single binary**: `--selftest` (the fixture half needs no compile, so the
post-build gate stays fast; the build-cache probe after it does compile, once), DRIVER
(compile, then exec), HARNESS (reflect and grade).

**The payload goes to a FILE, not stdout.** Go needed this because package-level `var`
initializers run before `main`, so no in-process capture can exist yet. Java's static
initializers have exactly the same property.

**Namespace every top-level identifier in your runner.** `solution.go` compiles into the
*same package* as `runner.go`, so an unprefixed `serialize` or `deepEqual` helper would be
a redeclaration error blamed on the candidate's own file. Everything in Go's runner is
`cg`-prefixed; `main` is the one name that cannot be, which is why the authoring rules
forbid writing one.

**Scratch-dir permissions.** `mktemp -d` gives 0700 owned by uid 1000, which worked for
exactly one language because node's image user *is* uid 1000. `nobody` (65534) cannot
traverse it, and every Python submission failed with "could not read solution" — a whole
language looking permanently broken, from a mode bit. `bin/run-submission` now chmods
0711/0644 and any new language inherits the fix. Verify it rather than assuming it.

**A read-only compiler cache works — for writes. Not for the trim.** Go's 42MB `GOCACHE`
is baked into the image and stays read-only at run time. Cache *writes* really are
best-effort: a submission's own package fails to be stored, every stdlib package is still
a hit, and nothing complains. Measured inside the sandbox (`--read-only`, `--cpus=1`,
`USER nobody`), a never-before-seen `solution.go` builds in **0.32–0.36s** against the
baked cache, and **10.05s** with `GOCACHE` pointed at an empty tmpfs — which is not
"slow", it is over the harness's own 10s compile budget, i.e. failing rather than merely
late. So the warm read-only cache is what makes a compiled language fit in the sandbox at
all, with no tmpfs copy, no writable rootfs and none of the hardening given up.

**The cache TRIM is not best-effort, and it cost a day of the Go rollout.** Once every 24
hours `go build` calls `Trim()` on the way out, which rewrites `$GOCACHE/trim.txt`, and
the only caller does `base.Fatalf` when that write fails. The stamp was baked root-owned
into an image that runs as `nobody` on a read-only rootfs, so **every image worked for
exactly 24 hours and then failed every submission that COMPILES** with `go: failed to trim
cache: permission denied`. Submissions with compile *errors* kept working, because go
prints its diagnostics before it dies — so the symptom read as "only correct Go is
broken", which sounds like the model's fault rather than the sandbox's.

The fix is one symlink: `trim.txt` points at `/tmp`, the tmpfs every runner already has,
writable and fresh per container. The trim then succeeds at any image age (0.34s against
0.32s for one that skips it) while the cache entries stay exactly as read-only as before.
Two things that look like fixes and are not are documented in `test-harness/go/Dockerfile`
— a far-future stamp (go reads a stamp more than an hour ahead as corruption and trims
anyway) and a tmpfs `GOCACHE` (the 10.05s above).

**Whatever your language bakes into its image, assume it will be run when the image is
old.** Go's `--selftest` gate forces a 24h-stale stamp and compiles for real, and
`bin/setup` and `bin/deploy` re-gate images that already exist rather than accepting any
image whose tag is present — which is what lets a fix reach a box whose image predates it.
The unit suite said nothing about any of it, because none of its tests start a
container — which is the general lesson for a new language: the things that will bite you
live in the image, and only the gate and `bin/smoke-<lang>` go there.

**Watch the stack limit against the memory cap.** Go's default 1GB max stack is *above*
`--memory=512m`, so runaway recursion got OOM-killed ("signal: killed") instead of
reporting `stack overflow`; `debug.SetMaxStack(128MB)` fixed it. Python needed the
opposite — a thread with `threading.stack_size(64MB)` and
`sys.setrecursionlimit(30_000)`, because CPython's default 1000 frames kills a legitimate
DFS at the sizes the expert rubric asks for.

**Normalize the empty collection.** A nil Go slice renders as `null`, not `[]` — and
`var out []int` plus appends is *the* idiomatic accumulator, so an unnormalized encoder
fails correct code on every empty-input edge case.

---

## What Java still owes

Authored and ready: the `LanguageProfile` skeleton, the `bin/lib/languages.sh` rows
(`Solution.java`, `/tmp:exec`, 512m, 256 pids, 30s), the `LANGUAGE_META` row, and the
integer rubric — which is genuinely Java-specific and already written, because `int` wraps
silently at ±(2^31−1) while `long` reaches past what JSON survives, so **both** limits bind
at once.

Not written, and each is load-bearing:

- **The parameter and return type allowlist.** `LANGUAGE_PROFILES.java.authoringRules`
  currently contains one bullet, and it says so out loud: *"(Phase 5: the
  parameter/return type allowlist lands with the Java harness.)"* Without it the model
  invents `TreeNode` for the trees topic and the problem is unrunnable.
- **The fixed `class Solution` contract**, stated properly. Java is the one language that
  breaks "call a function by name", so the authoring shape is the contract: the class name
  is fixed, which fixes the filename, which is why `CG_SRCNAME[java]=Solution.java`.
  `functionName` becomes the method name — still no schema change. The starter must
  contain the **whole class**; Go has a `//line` escape hatch that would allow wrapping and
  **javac has no equivalent**, so do not design around one.
- **`test-harness/java/`** — the JDK image (~450MB, `eclipse-temurin:21-jdk`), gson baked
  in at build time (the "zero deps" property was about runtime and network-less execution,
  both preserved), the runner, and its own `deepEqual`/serializer against the fixture.
- **`InvocationTargetException` unwrapping** to `getCause()`, or every runtime error reads
  "InvocationTargetException" and teaches nothing.
- **`bin/smoke-java`**, using `bin/smoke-go` as the template.

Use `javax.tools.ToolProvider.getSystemJavaCompiler()` rather than shelling to `javac`:
in-process, structured `Diagnostic` objects with line and column, and it shares the warm
JVM — which also lets the driver and harness collapse into one process.

Until `test-harness/java/Dockerfile` exists, the app is honest about it in three places
without anybody maintaining a list: `cg_buildable_languages` skips it, so
`bin/build-runner-image` and `bin/deploy` cannot fail on it; `/api/setup/state` reports
`supported: false` and the wizard renders "Java is not wired up in this build yet";
and `POST /api/setup/seed` refuses it with a 400 before spending anything. On top of that,
`bank.service` throws for any non-JavaScript language whose canonicalization cannot run —
so even a hand-forced Java generate cannot store an unverified problem.
