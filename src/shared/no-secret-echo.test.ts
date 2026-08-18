// =============================================================================
// No script in bin/ may print the VALUE of a secret
// =============================================================================
// This lives in src/shared/ for the same reason deploy-units.test.ts does: it
// asserts a fact that spans the repo rather than a module, and putting it where
// `tsc -b` and `vitest` already look is what stops it from quietly not running.
//
// THE BUG IT EXISTS FOR SHIPPED, in bin/scratch's `env` command:
//
//     # Presence only, never the value.
//     printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:+present}${ANTHROPIC_API_KEY:-absent}"
//
// That reads like a ternary and is not one. `${VAR:+word}` and `${VAR:-word}`
// are not mutually exclusive — they are two independent expansions concatenated,
// and when VAR is set and non-empty the FIRST yields `present` and the SECOND
// yields the value. So a machine with a key configured printed
// `ANTHROPIC_API_KEY=presentsk-ant-api03-…` from `bin/scratch env` and from
// `bin/scratch status`, into the terminal, into scrollback, and into any log
// capturing that output. On a machine with no key both halves collapse to
// `absent` and the line looks perfect, which is why it survived review and a
// comment claiming the opposite.
//
// Two properties are pinned, because either alone would have missed it:
//
//   1. BEHAVIOURAL. Run the command that prints configuration with a sentinel
//      secret in the environment and fail if the sentinel appears in the
//      output. This is the property that actually matters, and it is checked by
//      running the real script rather than by reading it.
//   2. STATIC, across all of bin/. The `:+`/`:-` pairing is an IDIOM — somebody
//      who wrote it once can write it again in a script that has no `env`
//      subcommand to run. Grepping for the shape catches the next one before it
//      is ever executed.
//
// Nothing here spends money, opens a database or starts a server: `bin/scratch
// env` only prints the environment it would use.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN_DIR = path.join(REPO_ROOT, 'bin');

/** Obvious enough to spot in a diff, and not a real key. */
const SENTINEL = 'sk-ant-api03-SENTINEL-must-never-be-printed';

/** Every executable shell script in bin/, including bin/lib/. */
function shellScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // .ts helpers in bin/ are run by tsx and are not shell.
      if (entry.name.endsWith('.ts')) continue;
      const head = fs.readFileSync(full, 'utf8').slice(0, 200);
      if (head.startsWith('#!') && /\b(ba)?sh\b/.test(head.split('\n')[0])) out.push(full);
      else if (/^# shellcheck shell=/m.test(head)) out.push(full);
    }
  };
  walk(BIN_DIR);
  return out.sort();
}

const SCRIPTS = shellScripts();

/**
 * `bin/scratch <cmd>` with a REPLACED environment.
 *
 * `env: {...}` replaces rather than extends, so a real ANTHROPIC_API_KEY in the
 * shell running vitest cannot make a leaking script look clean (or a clean one
 * look like it leaked). PATH and HOME are put back because bin/lib/node.sh
 * needs them. CG_SCRATCH_ENV points at /dev/null so the author's own
 * .env.scratch — which is gitignored and may hold anything — takes no part.
 */
function scratch(cmd: string, env: Record<string, string>): string {
  return execFileSync('bash', [path.join(BIN_DIR, 'scratch'), cmd], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CG_SCRATCH_ENV: '/dev/null',
      ...env,
    },
  });
}

describe('bin/scratch reports the key by presence, never by value', () => {
  // CG_SCRATCH_ALLOW_ANTHROPIC=1 is required: bin/scratch unsets the key
  // otherwise, and a test that let it do so would prove nothing — the leak only
  // exists on the path where the variable is actually set.
  const withKey = {
    ANTHROPIC_API_KEY: SENTINEL,
    CG_SCRATCH_ALLOW_ANTHROPIC: '1',
  };

  it('never prints the value from `env`', () => {
    const out = scratch('env', withKey);
    expect(out).not.toContain(SENTINEL);
    // Not merely "the whole value is absent": the original bug concatenated the
    // value onto `present`, so any fragment of it appearing is the same defect.
    expect(out).not.toContain('sk-ant-');
  });

  it('says `present` — exactly that, with nothing appended', () => {
    const line = scratch('env', withKey)
      .split('\n')
      .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    expect(line).toBe('ANTHROPIC_API_KEY=present');
  });

  it('says `absent` when there is no key', () => {
    const line = scratch('env', {})
      .split('\n')
      .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    expect(line).toBe('ANTHROPIC_API_KEY=absent');
  });

  it('does not leak it through `status` either, which reuses the same printer', () => {
    // `status` on a stopped instance prints "not running" and then the same
    // block. It is a separate entry point, and a fix applied to one printer and
    // not the other is exactly the kind of half-fix worth pinning.
    const out = scratch('status', withKey);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('ANTHROPIC_API_KEY=present');
  });
});

describe('no script in bin/ pairs ${VAR:+…} with ${VAR:-…}', () => {
  /**
   * The leaking shape, for ANY variable name: `${X:+a}` immediately followed by
   * `${X:-b}` for the same X. Written as a two-step match rather than one
   * back-reference regex so the failure message can name the variable.
   */
  const PLUS = /\$\{([A-Za-z_][A-Za-z0-9_]*):\+[^}]*\}\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}/g;

  it('finds at least one script to check (the walker is not silently empty)', () => {
    expect(SCRIPTS.length).toBeGreaterThan(10);
    expect(SCRIPTS.map((s) => path.basename(s))).toContain('scratch');
  });

  /**
   * Full-line comments removed, because a comment cannot leak anything and
   * bin/scratch deliberately QUOTES the old broken line in the comment that
   * explains it. Only whole-line comments are dropped — a trailing `#` inside a
   * string is not safely strippable without a shell parser, and leaving those
   * in only ever makes this stricter.
   */
  function code(text: string): string {
    return text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
  }

  it.each(SCRIPTS.map((s) => [path.relative(REPO_ROOT, s), s]))('%s', (_rel, file) => {
    const text = code(fs.readFileSync(file, 'utf8'));
    const offenders: string[] = [];
    for (const m of text.matchAll(PLUS)) {
      // Same variable on both sides is the leak. Different variables next to
      // each other is a legitimate (if dense) default chain, so it is allowed.
      if (m[1] === m[2]) offenders.push(m[0]);
    }
    expect(
      offenders,
      `${path.basename(file)} concatenates \${X:+…} with \${X:-…} for the same variable. ` +
        `Those are not exclusive: when X is set and non-empty BOTH expand, so the ` +
        `second one prints the value. Use an if.`
    ).toEqual([]);
  });
});
