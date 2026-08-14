# shellcheck shell=bash
# =============================================================================
# codegrind — finding a Node that will not corrupt the database
# =============================================================================
# Sourced, never executed. `source "${REPO_DIR}/bin/lib/node.sh"`.
#
# THIS IS NOT A STYLE PREFERENCE. `better-sqlite3` is a native module compiled
# against a specific V8 ABI (NODE_MODULE_VERSION). Under a Node whose ABI does
# not match, it does not degrade or warn — the process HARD-CRASHES, and it does
# so at module load, which means every script in bin/ dies before printing
# anything useful. Under Node 24 in particular this is a segfault, not an
# exception you can catch.
#
# So every entry point that runs node picks its Node here, and the rules are:
#
#   1. If the pinned install exists, use it. On the author's box that is
#      /home/hexi/.nvm/versions/node/v22.22.0/bin, which is also what
#      deploy/codegrind.service puts on the service's PATH — so the CLI and the
#      service compile and load the same binary against the same ABI. Every
#      script used to hardcode this line; they now all get it from here.
#   2. Otherwise, if whatever is on PATH is a supported major, use it. This is
#      the path a newcomer with a system Node takes, and it costs nothing.
#   3. Otherwise, look through nvm's installs for a supported major, newest
#      first. This is the path where the user HAS a good Node and simply has not
#      selected it — which is the single most likely first-run failure, because
#      `nvm use` does not survive a new shell.
#   4. Otherwise fail, and say what to install.
#
# Supported majors are the ones better-sqlite3 ^11 publishes prebuilt binaries
# for and that this app has actually run on. Adding one here without testing it
# is how you find out about an ABI break in production.

CG_NODE_MAJORS=(22 20)
CG_NODE_PINNED="${CG_NODE_PINNED:-${HOME}/.nvm/versions/node/v22.22.0/bin}"

# The major of `$1` ("v22.22.0" -> "22"), or empty.
cg_node_major() {
  local v="${1#v}"
  printf '%s' "${v%%.*}"
}

# True if the version string in $1 is a major this app supports.
cg_node_supported() {
  local major m
  major="$(cg_node_major "${1:-}")"
  [ -n "${major}" ] || return 1
  for m in "${CG_NODE_MAJORS[@]}"; do
    [ "${major}" = "${m}" ] && return 0
  done
  return 1
}

# Put a supported Node first on PATH. Returns 0 on success, 1 if none was found.
# Sets CG_NODE_VERSION and CG_NODE_BIN on success.
cg_use_node() {
  local candidate dir version

  # 1. The pin. Identical to the line every bin/ script used to carry inline.
  if [ -x "${CG_NODE_PINNED}/node" ]; then
    PATH="${CG_NODE_PINNED}:${PATH}"
    export PATH
    CG_NODE_VERSION="$("${CG_NODE_PINNED}/node" -v 2>/dev/null)"
    CG_NODE_BIN="${CG_NODE_PINNED}/node"
    return 0
  fi

  # 2. Whatever the shell already has, if it is supported.
  if candidate="$(command -v node 2>/dev/null)"; then
    version="$("${candidate}" -v 2>/dev/null)"
    if cg_node_supported "${version}"; then
      CG_NODE_VERSION="${version}"
      CG_NODE_BIN="${candidate}"
      return 0
    fi
  fi

  # 3. Anything nvm has installed, newest first. `sort -V` so v9 does not beat
  #    v22, which a lexical sort would happily do.
  if [ -d "${HOME}/.nvm/versions/node" ]; then
    while read -r dir; do
      [ -x "${dir}/bin/node" ] || continue
      version="$("${dir}/bin/node" -v 2>/dev/null)"
      cg_node_supported "${version}" || continue
      PATH="${dir}/bin:${PATH}"
      export PATH
      CG_NODE_VERSION="${version}"
      CG_NODE_BIN="${dir}/bin/node"
      return 0
    done < <(find "${HOME}/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d | sort -Vr)
  fi

  return 1
}

# What to tell somebody who has no supported Node. Written to be actionable on a
# machine where the only Node is the wrong one, which is the common case.
cg_node_advice() {
  local found=""
  if command -v node >/dev/null 2>&1; then
    found="$(node -v 2>/dev/null)"
  fi
  if [ -n "${found}" ]; then
    printf 'found Node %s, which codegrind cannot use.\n' "${found}"
  else
    printf 'no Node found on PATH.\n'
  fi
  printf '\n'
  printf '      codegrind needs Node %s. This is not negotiable: its SQLite driver\n' \
    "$(printf '%s or ' "${CG_NODE_MAJORS[@]}" | sed 's/ or $//')"
  printf '      (better-sqlite3) is a native module and CRASHES the process outright\n'
  printf '      under a mismatched Node — most visibly on Node 24.\n'
  printf '\n'
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    printf '      You have nvm. Run:\n'
    printf '          nvm install 22 && nvm use 22\n'
    printf '      then re-run bin/setup.\n'
  else
    printf '      Install Node 22 — https://nodejs.org, or via nvm:\n'
    printf '          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash\n'
    printf '          nvm install 22\n'
    printf '      then re-run bin/setup.\n'
  fi
}
