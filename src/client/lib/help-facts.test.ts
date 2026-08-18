// =============================================================================
// The Help tab cannot drift away from the app it describes
// =============================================================================
// help-facts.ts mirrors a handful of constants that live where the browser
// cannot import them: `db.ts` opens SQLite at module scope, `bank.service.ts`
// pulls in the sandbox, and the docker budget is a bash associative array. Those
// mirrors are the only way the Help tab can print a real number — and they are
// exactly the kind of copy that goes stale silently, because prose does not
// typecheck.
//
// So every mirrored value is pinned here against the thing it mirrors, read from
// disk. Change `TIER_REQUIREMENT` to 4 and this file fails, which is the whole
// arrangement: the doc is allowed to hardcode precisely because a test is
// holding the other end of the string.
//
// Everything here is constant-reading and filesystem-reading. No database, no
// docker, no network — the same rule src/shared/languages.test.ts follows.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_REQUIREMENT, UNLOCK_TIER } from '@/server/services/curriculum';
import { LANGUAGES, type Language } from '@/shared/languages';
import { LEVEL_META } from '@/client/lib/assistance';
import { VERDICT_META } from '@/client/components/ResultsPanel';
import * as facts from './help-facts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function source(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** The string literals of a `export type X = | 'a' | 'b';` union, in order. */
function unionMembers(src: string, typeName: string): string[] {
  const block = new RegExp(`export type ${typeName} =([\\s\\S]*?);`, 'm').exec(src);
  if (!block) throw new Error(`no \`export type ${typeName}\` in the source`);
  return [...block[1].matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]);
}

/** The `[key]=value` pairs of a `declare -A NAME=( … )` bash table. */
function bashTable(src: string, name: string): Record<string, string> {
  const block = new RegExp(`declare -A ${name}=\\(([^)]*)\\)`, 'm').exec(src);
  if (!block) throw new Error(`no ${name} table in bin/lib/languages.sh`);
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/\[([a-z]+)\]=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

// =============================================================================
describe('the tier ladder Help describes is the one curriculum.ts implements', () => {
  // A real import, not a mirror: curriculum.ts is dependency-free on purpose
  // (see its header), so a test can pull the actual constants in. The mirror in
  // help-facts exists only because a BROWSER bundle should not reach across into
  // src/server at all — this assertion is what makes the mirror safe.
  it('mirrors TIER_REQUIREMENT', () => {
    expect(facts.TIER_REQUIREMENT).toBe(TIER_REQUIREMENT);
  });

  it('mirrors UNLOCK_TIER', () => {
    expect(facts.UNLOCK_TIER).toBe(UNLOCK_TIER);
  });

  it('measures the mastery bar in completed tiers, not in a literal 4', () => {
    // `curriculum.tierProgress` divides by `TIER_LEVELS.length - 1`. If a rung
    // is ever added to the ladder, "a quarter of the bar is one tier" stops
    // being true and this catches the sentence, not just the arithmetic.
    expect(facts.MASTERY_TIERS).toBe(facts.TIER_LADDER.length - 1);
    expect(facts.MASTERY_TIERS).toBe(facts.DIFFICULTY_LADDER.length);
  });

  it('starts the ladder at `none` and ends it at the top difficulty', () => {
    expect(facts.TIER_LADDER[0]).toBe('none');
    // No `.at()`: the build targets ES2020.
    expect(facts.TIER_LADDER[facts.TIER_LADDER.length - 1]).toBe(
      facts.DIFFICULTY_LADDER[facts.DIFFICULTY_LADDER.length - 1],
    );
  });
});

// =============================================================================
describe('the spaced-repetition numbers match db.ts', () => {
  const DB = source('src/server/services/db.ts');

  it('mirrors the per-problem review ladder', () => {
    const match = /const REVIEW_LADDER_DAYS = \[([^\]]*)\]/.exec(DB);
    expect(match, 'no REVIEW_LADDER_DAYS in db.ts').not.toBeNull();
    const days = match![1].split(',').map((n) => Number(n.trim()));
    expect(days).toEqual([...facts.REVIEW_LADDER_DAYS]);
  });

  it('mirrors the per-topic SRS boxes', () => {
    const match = /const BOX_INTERVALS_MS = \[([^\]]*)\]/.exec(DB);
    expect(match, 'no BOX_INTERVALS_MS in db.ts').not.toBeNull();
    // `4 * HOUR, 1 * DAY, …` — the units are local consts, so re-derive rather
    // than eval. HOUR and DAY are asserted below so the conversion cannot lie.
    const hours = [...match![1].matchAll(/(\d+)\s*\*\s*(HOUR|DAY)/g)].map(
      (m) => Number(m[1]) * (m[2] === 'DAY' ? 24 : 1),
    );
    expect(hours).toEqual([...facts.SRS_BOX_HOURS]);
  });

  it('still defines an hour as an hour and a day as 24 of them', () => {
    expect(DB).toContain('const HOUR = 60 * 60 * 1000');
    expect(DB).toContain('const DAY = 24 * HOUR');
  });

  it('phrases the review ladder without dropping a rung', () => {
    const phrase = facts.reviewLadderPhrase();
    for (const n of facts.REVIEW_LADDER_DAYS) expect(phrase).toContain(String(n));
  });

  it('humanises a box interval on both sides of a day', () => {
    expect(facts.boxIntervalLabel(4)).toBe('4 hours');
    expect(facts.boxIntervalLabel(24)).toBe('1 day');
    expect(facts.boxIntervalLabel(720)).toBe('30 days');
  });
});

// =============================================================================
describe('the generation numbers match bank.service.ts', () => {
  const BANK = source('src/server/services/bank.service.ts');

  it.each([
    ['MIN_SAMPLE_TESTS', facts.MIN_SAMPLE_TESTS],
    ['MIN_HIDDEN_TESTS', facts.MIN_HIDDEN_TESTS],
    ['MAX_GEN_ATTEMPTS', facts.MAX_GEN_ATTEMPTS],
  ])('mirrors %s', (name, mirrored) => {
    const match = new RegExp(`const ${name} = (\\d+)`).exec(BANK);
    expect(match, `no ${name} in bank.service.ts`).not.toBeNull();
    expect(Number(match![1])).toBe(mirrored);
  });

  it('still adopts the reference run as the ground truth, keeping args verbatim', () => {
    // The single most important claim the Help tab makes. If canonicalization
    // ever stops taking `expected` from the reference's own output, or starts
    // rewriting `args`, the paragraph explaining why the bank is trustworthy is
    // no longer true — so pin the shape of the line that makes it true.
    expect(BANK).toContain('out.push({ name: src.name, args: src.args, expected });');
    expect(BANK).toContain('if (r.stderr) return;');
  });

  it('still forces the problem call rather than parsing prose', () => {
    const LLM = source('src/server/services/llm.service.ts');
    expect(LLM).toContain("name: 'emit_problem'");
    expect(LLM).toContain('calling the emit_problem tool exactly once');
  });
});

// =============================================================================
describe('the hint ceiling matches the two places that enforce it', () => {
  it('is what the route clamps to', () => {
    const HINTS = source('src/server/routes/hints.ts');
    const match = /rawLevel > (\d+) \? \1/.exec(HINTS);
    expect(match, 'no upper clamp in routes/hints.ts').not.toBeNull();
    expect(Number(match![1])).toBe(facts.MAX_HINT_LEVEL);
  });

  it('is what the solve surface stops at', () => {
    const SOLVE = source('src/client/components/SolveSurface.tsx');
    expect(SOLVE).toContain(`hints.length >= ${facts.MAX_HINT_LEVEL}`);
  });
});

// =============================================================================
describe('the sandbox budget matches the bash that runs docker', () => {
  const SH = source('bin/lib/languages.sh');
  const RUN = source('bin/run-submission');

  it('mirrors the per-language wall-clock cap', () => {
    const table = bashTable(SH, 'CG_TIMEOUT');
    for (const l of LANGUAGES) {
      expect(Number(table[l]), `CG_TIMEOUT[${l}]`).toBe(facts.SANDBOX_TIMEOUT_SECONDS[l]);
    }
  });

  it('mirrors the per-language memory ceiling', () => {
    const table = bashTable(SH, 'CG_MEMORY');
    for (const l of LANGUAGES) {
      expect(table[l], `CG_MEMORY[${l}]`).toBe(facts.SANDBOX_MEMORY[l]);
    }
  });

  it('mirrors the CPU share', () => {
    const match = /^CG_CPUS=(\d+)$/m.exec(SH);
    expect(match, 'no CG_CPUS in bin/lib/languages.sh').not.toBeNull();
    expect(Number(match![1])).toBe(facts.SANDBOX_CPUS);
  });

  it('passes every containment flag Help claims it passes', () => {
    for (const flag of facts.SANDBOX_FLAGS) {
      expect(RUN, `bin/run-submission is missing ${flag}`).toContain(flag);
    }
  });

  it('still bind-mounts the work directory read-only and kills a runaway', () => {
    expect(RUN).toContain(':/work:ro');
    expect(RUN).toContain('timeout -k 3 "${HARD_TIMEOUT}"');
  });

  it('names exactly the languages this build has a harness for', () => {
    const built = LANGUAGES.filter((l: Language) =>
      fs.existsSync(path.join(REPO_ROOT, 'test-harness', l, 'Dockerfile')),
    );
    expect([...facts.SANDBOX_LANGUAGES]).toEqual(built);
  });
});

// =============================================================================
describe('the closed vocabularies Help enumerates are complete', () => {
  const TYPES = source('src/shared/types.ts');

  it('lists every verdict, and nothing that is not one', () => {
    // Two independent checks on purpose: the union is the contract, and
    // VERDICT_META is what the UI can actually draw a chip for. A verdict in
    // one and not the other is a bug either way.
    expect([...facts.VERDICTS].sort()).toEqual(unionMembers(TYPES, 'Verdict').sort());
    expect([...facts.VERDICTS].sort()).toEqual(Object.keys(VERDICT_META).sort());
  });

  it('keeps compile_error as its own verdict', () => {
    // The Help tab spends a paragraph on why this is separate from
    // runtime_error. If the distinction is ever collapsed, delete the paragraph.
    expect(facts.VERDICTS).toContain('compile_error');
    expect(facts.VERDICTS).toContain('runtime_error');
    expect(unionMembers(TYPES, 'RunPhase')).toContain('compile');
  });

  it('lists every scheduler intent kind', () => {
    expect([...facts.SCHEDULER_INTENT_KINDS].sort()).toEqual(
      unionMembers(TYPES, 'SchedulerIntentKind').sort(),
    );
  });

  it('lists every assistance rung with the app’s own label and blurb', () => {
    expect(facts.ASSISTANCE_LADDER.map((a) => a.level)).toEqual([1, 2, 3, 4]);
    for (const rung of facts.ASSISTANCE_LADDER) {
      expect(rung.label).toBe(LEVEL_META[rung.level].label);
      expect(rung.blurb).toBe(LEVEL_META[rung.level].blurb);
    }
  });
});

// =============================================================================
describe('the scheduler Help describes is still free', () => {
  it('makes no LLM call on the per-problem path', () => {
    const SCHED = source('src/server/services/scheduler.service.ts');
    // The claim "picking your next problem costs nothing" is load-bearing for
    // the cost section. It holds because this module imports the database and
    // the curriculum and nothing else — no llm.service, no provider client.
    expect(SCHED).not.toMatch(/from '\.\/llm\./);
  });

  it('serves a due review ahead of everything else', () => {
    const SCHED = source('src/server/services/scheduler.service.ts');
    expect(SCHED).toContain('a due review item outranks EVERYTHING');
  });
});
