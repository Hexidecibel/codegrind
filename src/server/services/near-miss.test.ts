// =============================================================================
// near-miss forgiveness — a near miss fixed the same day is not a lapse
// =============================================================================
// db.updateSkillOnAttempt resets box + streak and dings ease on a failed
// submit. When that failure was a near miss (shared/closeness) and the player
// solves the SAME problem the SAME day, the pre-miss numbers come back and the
// solve is applied on top. Real db.ts against a throwaway DATA_DIR.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-nearmiss-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) throw new Error('refusing to run outside tmpdir');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'UTC';

const db = await import('./db.js');

const T0 = Date.parse('2026-11-03T09:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => vi.setSystemTime(ms);

const skill = () => db.getSkillForTopic('javascript', 'arrays')!;
const near = (problemId = 'p1') => ({ problemId, testsPassed: 11, testsTotal: 12 });
const far = (problemId = 'p1') => ({ problemId, testsPassed: 3, testsTotal: 12 });
const pass = (problemId = 'p1') => ({ problemId, testsPassed: 12, testsTotal: 12 });

/** Three clean solves on other problems: box 3, streak 3, ease 2.8. */
function warmUp(): void {
  for (let i = 0; i < 3; i++) {
    at(T0 - (3 - i) * DAY);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass(`w${i}`));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const t of ['skill_state', 'near_miss_holds', 'attempts']) db.db.prepare(`DELETE FROM ${t}`).run();
  warmUp();
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('near-miss forgiveness (db.updateSkillOnAttempt)', () => {
  it('starts from box 3 / streak 3', () => {
    expect(skill()).toMatchObject({ box: 3, streak: 3 });
    expect(skill().ease).toBeCloseTo(2.8);
  });

  it('a near miss still records as a lapse at the time — nobody knows yet whether it gets fixed', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    expect(skill()).toMatchObject({ box: 0, streak: 0, lastResult: 'failed' });
  });

  it('near miss → near miss → clean solve, same problem, same day: as if the misses never happened', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    at(T0 + 10 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass());
    const s = skill();
    expect(s).toMatchObject({ box: 4, streak: 4, lastResult: 'solved' });
    expect(s.ease).toBeCloseTo(2.9);
    expect(s.attempts).toBe(6); // the attempts themselves still count
  });

  it('a hinted solve after a near miss restores, then holds (no streak gain)', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 1, pass());
    expect(skill()).toMatchObject({ box: 3, streak: 3, lastResult: 'solved-hinted' });
  });

  it('the lapse stands when the fix comes on a later day', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    at(T0 + DAY);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass());
    expect(skill()).toMatchObject({ box: 1, streak: 1 });
  });

  it('the lapse stands for a real miss (below the threshold), even if fixed the same day', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, far());
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass());
    expect(skill()).toMatchObject({ box: 1, streak: 1 });
  });

  it('a real miss after the near miss cancels the forgiveness', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near());
    at(T0 + 2 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, far());
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass());
    expect(skill()).toMatchObject({ box: 1, streak: 1 });
  });

  it('solving a DIFFERENT problem in the topic does not cash in the hold', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0, near('p1'));
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass('p2'));
    expect(skill()).toMatchObject({ box: 1, streak: 1 });
    // …and the hold is gone: coming back to p1 later does not restore either.
    at(T0 + 10 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0, pass('p1'));
    expect(skill()).toMatchObject({ box: 2, streak: 2 });
  });

  it('callers that pass no attempt details keep the old behaviour', () => {
    at(T0);
    db.updateSkillOnAttempt('javascript', 'arrays', false, 0);
    at(T0 + 5 * MIN);
    db.updateSkillOnAttempt('javascript', 'arrays', true, 0);
    expect(skill()).toMatchObject({ box: 1, streak: 1 });
  });
});
