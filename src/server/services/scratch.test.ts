// =============================================================================
// The scratch directory is resolved TWICE, and the two must never disagree
// =============================================================================
// Per-run scratch has three writers and one cleaner:
//
//   bin/run-submission      mktemp -d's the bind-mounted work dir there
//   sandbox.service.ts      stages <id>.solution.<ext> / <id>.tests.json there
//   bin/reap-runners        deletes anything there older than --max-age
//
// The bug this pins: the server ignored CG_SCRATCH_DIR and hardcoded
// `$DATA_DIR/tmp`, while both scripts honoured it. Set CG_SCRATCH_DIR and the
// server's staging files land somewhere the reaper never looks — and because
// the normal path deletes them in a `finally`, the leak only shows up after a
// hard kill, on a machine configured differently from the author's, as a
// directory that slowly fills. Nothing fails; nothing logs.
//
// Bash cannot import TypeScript, and the server will not shell out at module
// load just to learn a path, so the rule exists twice: `cg_scratch_dir` in
// bin/lib/scratch.sh and `resolveScratchDir` in sandbox.service.ts. This file
// is what makes "twice" safe — it RUNS the shell one and compares. Editing
// either expression without the other fails here.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveScratchDir } from './sandbox.service.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRATCH_LIB = path.join(REPO_ROOT, 'bin/lib/scratch.sh');

/**
 * `cg_scratch_dir "$REPO_ROOT/data"` under a chosen environment.
 *
 * `env: {...}` REPLACES the environment rather than extending it, so a
 * CG_SCRATCH_DIR that happens to be set in the shell running vitest cannot
 * leak in and quietly make every case pass. PATH is put back because bash
 * needs it.
 */
function shellScratchDir(env: Record<string, string>): string {
  const out = execFileSync(
    'bash',
    ['-c', `source "${SCRATCH_LIB}"; cg_scratch_dir "${REPO_ROOT}/data"`],
    { encoding: 'utf8', cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? '', ...env } }
  );
  return out.trim();
}

/**
 * The TS half, resolved the way the shell half would be read: relative output
 * is relative to the caller's cwd, and both halves are run with cwd = the repo
 * root here (vitest's own cwd is the project root, which is why the fallback
 * cases below can be compared at all).
 */
function tsScratchDir(env: Record<string, string>): string {
  return resolveScratchDir(env as NodeJS.ProcessEnv);
}

// The environments worth pinning. DATA_DIR is set in every real invocation —
// bin/start absolutizes and exports it, the systemd unit carries it, and the
// .env bin/setup writes contains it — so these are the cases that occur.
const CASES: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['DATA_DIR absolute, no CG_SCRATCH_DIR', { DATA_DIR: '/srv/codegrind/data' }],
  ['DATA_DIR relative, no CG_SCRATCH_DIR', { DATA_DIR: './data' }],
  ['CG_SCRATCH_DIR absolute wins over DATA_DIR', { DATA_DIR: '/srv/codegrind/data', CG_SCRATCH_DIR: '/var/tmp/cg-scratch' }],
  ['CG_SCRATCH_DIR relative wins over DATA_DIR', { DATA_DIR: '/srv/codegrind/data', CG_SCRATCH_DIR: './scratch' }],
  ['CG_SCRATCH_DIR alone', { CG_SCRATCH_DIR: '/var/tmp/cg-scratch' }],
  ['CG_SCRATCH_DIR exported but EMPTY falls through', { DATA_DIR: '/srv/codegrind/data', CG_SCRATCH_DIR: '' }],
  ['DATA_DIR exported but EMPTY falls through', { DATA_DIR: '', CG_SCRATCH_DIR: '' }],
  ['neither set', {}],
];

describe('the shell and TypeScript scratch-dir rules agree', () => {
  it('bin/lib/scratch.sh exists and is the only place the shell expression lives', () => {
    expect(fs.existsSync(SCRATCH_LIB)).toBe(true);
    // The regression was three copies of the expression. Anything that still
    // spells it out inline is a fourth waiting to drift.
    const inlined = ['bin/run-submission', 'bin/reap-runners']
      .map((rel) => [rel, fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')] as const)
      .filter(([, src]) => /\$\{CG_SCRATCH_DIR:-/.test(src))
      .map(([rel]) => rel);
    expect(inlined).toEqual([]);
  });

  for (const [name, env] of CASES) {
    it(name, () => {
      // The shell prints a path as written; resolve it the way the process that
      // uses it would, from the same cwd the shell ran in.
      const fromShell = path.resolve(REPO_ROOT, shellScratchDir(env));
      expect(tsScratchDir(env)).toBe(fromShell);
    });
  }

  it('every resolution ends in a directory named tmp unless CG_SCRATCH_DIR says otherwise', () => {
    expect(tsScratchDir({ DATA_DIR: '/srv/codegrind/data' })).toBe('/srv/codegrind/data/tmp');
    expect(tsScratchDir({ CG_SCRATCH_DIR: '/var/tmp/x' })).toBe('/var/tmp/x');
  });
});
