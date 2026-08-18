# shellcheck shell=bash
# =============================================================================
# codegrind — where per-run scratch lives, stated ONCE for the shell side
# =============================================================================
# Sourced, never executed. `source "${REPO_DIR}/bin/lib/scratch.sh"`.
#
# THE RULE, AND WHY IT HAS TO BE ONE RULE. Three different things put files in
# this directory and one of them cleans it:
#
#   * bin/run-submission        mktemp -d's the bind-mounted work dir here
#   * sandbox.service.ts        stages <id>.solution.<ext> / <id>.tests.json here
#   * bin/reap-runners          sweeps anything here older than --max-age
#
# The sweep is age-based over the DIRECTORY, so a writer that resolves the
# directory differently from the reaper does not fail loudly — it leaks. The
# staging files are small, the failure is invisible on the box where every
# resolution happens to agree, and it only appears somewhere configured
# differently from the author's. That is exactly what happened: the server
# ignored CG_SCRATCH_DIR entirely while both scripts honoured it, so setting it
# stranded every staged solution outside the reaper's reach forever.
#
# WHY CG_SCRATCH_DIR EXISTS AT ALL (and its CG_HOST_SCRATCH_DIR twin, which
# lives in bin/run-submission because only the docker invocation needs it): see
# the block above the mktemp in bin/run-submission. Short version — the scratch
# dir moved out of /tmp and under DATA_DIR so that a containerized codegrind can
# hand the docker daemon a HOST path, and nothing sweeps DATA_DIR.
#
# THE TYPESCRIPT HALF is `resolveScratchDir()` in
# src/server/services/sandbox.service.ts. Two definitions, because bash cannot
# import TypeScript and the server will not shell out at module load just to
# learn a path. They are pinned to agree by src/server/services/scratch.test.ts,
# which runs THIS function and compares — change one and that test fails.

# Print the scratch directory. $1 is the data dir to fall back on when DATA_DIR
# is unset; every caller passes "${REPO_DIR}/data", because a script's cwd is
# whatever its caller had and a relative default would land somewhere else on
# every invocation.
cg_scratch_dir() {
  local fallback_data_dir="${1:?cg_scratch_dir <fallback-data-dir>}"
  # `:-` and not `-`: an EXPORTED-BUT-EMPTY CG_SCRATCH_DIR (trivially produced by
  # `CG_SCRATCH_DIR= bin/...`, or by an .env line with nothing after the `=`)
  # must fall through rather than resolve the whole thing to "/tmp".
  printf '%s\n' "${CG_SCRATCH_DIR:-${DATA_DIR:-${fallback_data_dir}}/tmp}"
}
