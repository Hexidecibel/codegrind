# shellcheck shell=bash
# =============================================================================
# codegrind — the EXECUTION facts about each language
# =============================================================================
# Sourced, never executed. `source "$(dirname "$0")/lib/languages.sh"`.
#
# This file is the single source of truth for everything docker needs to know
# about a language: which image runs it, what the source file must be called
# inside the container, the command that starts the harness, and the resource
# and time budgets that box it in.
#
# WHY BASH AND NOT TYPESCRIPT. `src/shared/languages.ts` is shared with the
# BROWSER. It deliberately carries only presentation and authoring facts —
# display name, Monaco grammar id, fence, extension, indent width — because the
# client has no business knowing an image tag, and because two files that both
# claim to own the run command will eventually disagree. Bash is what actually
# invokes `docker run`, so bash owns the docker facts. If you find yourself
# adding an image name to languages.ts, or an indent width here, you are putting
# it in the wrong file.
#
# The clearest example of why these facts cannot live in a UI module:
# CG_SRCNAME[java] is `Solution.java` because javac requires the filename to
# match the public class it declares. That is a compiler constraint, not a
# preference, and it has no meaning at all in a code editor.
#
# STATUS: javascript and python are wired up end to end. The java row is a real
# set of values, not placeholders — but nothing builds or runs it yet, because
# `test-harness/java/` does not exist. `cg_buildable_languages` is what keeps
# that honest: it reports what is on disk rather than what is in this table, so
# bin/build-runner-image cannot fail on a language that has not been written yet.
#
# The python row's numbers were measured, not guessed: 29 000 recursion frames
# complete inside `--memory=256m` (the harness reserves a 64 MB thread stack so
# a legitimate deep DFS is not killed at CPython's default depth of 1000), and
# 31 000 returns a clean RecursionError rather than a segfault. Raising the
# memory cap would not raise the depth — sys.setrecursionlimit is the binding
# constraint, and it lives in the harness.

# The order the rest of the tooling iterates in. Matches LANGUAGES in
# src/shared/languages.ts — the two lists are the same set, deliberately, so a
# language that exists to the app also exists to the build.
CG_LANGUAGES=(javascript python java)

# --- image ---------------------------------------------------------------
# One image per language, tagged with the language so `docker images` reads as
# an inventory. The tag is also what bin/reap-runners used to filter on, which
# is exactly the bug it no longer has: `--filter ancestor=<tag>` resolves the
# tag to an image ID at query time, so the first rebuild made every already
# running container invisible to the reaper. Containers now carry the label
# `codegrind.runner=1` (see CG_LABEL) and the reaper filters on that instead.
declare -A CG_IMAGE=(
  [javascript]=codegrind-runner-javascript:latest
  [python]=codegrind-runner-python:latest
  [java]=codegrind-runner-java:latest
)

# --- source filename inside the container ---------------------------------
# bin/run-submission copies the caller's file to this name under /work. The host
# filename is therefore irrelevant, which matters for java: the class is fixed
# to `Solution`, so the file MUST be `Solution.java` or javac refuses to compile
# it — a constraint the caller cannot be trusted to remember.
declare -A CG_SRCNAME=(
  [javascript]=solution.mjs
  [python]=solution.py
  [java]=Solution.java
)

# --- the command that starts the harness ----------------------------------
# Word-split on spaces by the caller (`read -r -a`), so no element may contain a
# space. The harness receives two more arguments appended by run-submission:
# the /work path of the source and of tests.json.
declare -A CG_CMD=(
  [javascript]="node /app/runner.mjs"
  [python]="python3 /app/runner.py"
  [java]="java -XX:TieredStopAtLevel=1 -cp /app:/app/gson.jar Runner"
)

# --- resource budget ------------------------------------------------------
# Java is not on the JS profile and never will be: a JVM plus javac needs both
# more memory and more threads than a Node process that runs one function.
declare -A CG_MEMORY=(
  [javascript]=256m
  [python]=256m
  [java]=512m
)

declare -A CG_PIDS=(
  [javascript]=128
  [python]=128
  [java]=256
)

# --- wall-clock cap, seconds ----------------------------------------------
# The OUTER cap, enforced by `timeout` around `docker run`. It must stay
# strictly above every budget the harness enforces for itself, or the container
# dies before it can print its structured partial results and the caller sees
# an opaque timeout instead of "3 of 8 passed, then this one hung".
#
# Java's 30 is the number bin/reap-runners' MAX_AGE is sized against.
declare -A CG_TIMEOUT=(
  [javascript]=12
  [python]=12
  [java]=30
)

# --- CPU share ------------------------------------------------------------
# Not per-language: one core is one core, and a submission that needs two is a
# submission with an infinite loop in it.
CG_CPUS=1

# --- the reaper's handle --------------------------------------------------
# Applied to every runner container by bin/run-submission and filtered on by
# bin/reap-runners. A label is attached to the CONTAINER, so unlike an image
# tag it survives a rebuild of the image the container was started from.
CG_LABEL="codegrind.runner=1"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

# True if $1 appears in CG_LANGUAGES.
cg_is_language() {
  local want="$1" l
  for l in "${CG_LANGUAGES[@]}"; do
    [ "$l" = "$want" ] && return 0
  done
  return 1
}

# Exit 2 with a usable message unless $1 is a known language. Every entry point
# that takes a language from an argument calls this first — an unknown language
# must fail loudly here rather than expand to an empty image name and hand
# docker a nonsense command line.
cg_require_language() {
  if ! cg_is_language "${1:-}"; then
    printf 'unknown language: %s (known: %s)\n' "${1:-<empty>}" "${CG_LANGUAGES[*]}" >&2
    exit 2
  fi
}

# The languages that actually have a harness on disk, in CG_LANGUAGES order.
# `$1` is the repo root. This is the list bin/build-runner-image builds: the
# table above describes three languages, but only the ones with a Dockerfile
# can be built, and a missing directory is a phase that has not landed yet
# rather than an error.
cg_buildable_languages() {
  local repo="$1" l
  for l in "${CG_LANGUAGES[@]}"; do
    [ -f "${repo}/test-harness/${l}/Dockerfile" ] && printf '%s\n' "$l"
  done
}
