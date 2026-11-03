// =============================================================================
// grind sprinkle — an unseen easy from a quiet topic, every few problems
// =============================================================================
// scheduler.sprinkleDue (the cadence), pickSprinkle / sprinkleIntent (which
// topic), and the REAL bank.getAdaptiveProblem serving it bank-first: with an
// unused easy banked, no generation call is made at all. Real db.ts against a
// throwaway DATA_DIR; the model and the sandbox are stubs that must not run.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Topic } from '../../shared/types.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-sprinkle-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) throw new Error('refusing to run outside tmpdir');
process.env.DATA_DIR = TEST_DATA_DIR;

const mocks = vi.hoisted(() => ({
  generateProblem: vi.fn(async () => {
    throw new Error('generation must not be reached');
  }),
  runTests: vi.fn(),
}));
vi.mock('./llm.service.js', () => ({ generateProblem: mocks.generateProblem }));
vi.mock('./llm.examples.js', () => ({ rewriteExampleExplanation: vi.fn() }));
vi.mock('./sandbox.service.js', () => ({ runTests: mocks.runTests }));

const db = await import('./db.js');
const scheduler = await import('./scheduler.service.js');
const bank = await import('./bank.service.js');

let seq = 0;
function bankEasy(topic: Topic, used = false, language: 'javascript' | 'python' = 'javascript'): string {
  const id = `p-${topic}-${seq++}`;
  db.insertProblem({
    id,
    language,
    title: `Easy ${id}`,
    prompt: 'Do the thing.',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic,
    pattern: 'p',
    starterCode: 'function f() {}',
    functionName: 'f',
    sampleTests: [{ name: 's', args: [1], expected: 1 }],
    hiddenTests: [{ name: 'h', args: [1], expected: 1 }],
    referenceSolution: 'function f(x){ return x; }',
    canonicalized: true,
    used,
    createdAt: new Date(Date.now() + seq).toISOString(),
  });
  return id;
}

/** n recorded attempts on a topic (skill_state.attempts is what ranks). */
function practise(topic: Topic, n: number): void {
  for (let i = 0; i < n; i++) db.updateSkillOnAttempt('javascript', topic, true, 0);
}

beforeEach(() => {
  for (const t of ['attempts', 'skill_state', 'problems', 'near_miss_holds']) db.db.prepare(`DELETE FROM ${t}`).run();
  mocks.generateProblem.mockClear();
});
afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('sprinkleDue — the cadence', () => {
  it('fixed slots at problems 4, 8, 12…; a slipped one does not push the rest back; never back to back', () => {
    expect(scheduler.SPRINKLE_CADENCE).toBe(4);
    // served = problems already served before this pick (so pick n has served n-1).
    expect([0, 1, 2, 3].map((s) => scheduler.sprinkleDue(s, null))).toEqual([false, false, false, true]);
    // On time at 4 → next at 8.
    expect([4, 5, 6, 7].map((s) => scheduler.sprinkleDue(s, 4))).toEqual([false, false, false, true]);
    // Slipped to 5 (a review took 4) → still next at 8, not 9.
    expect([5, 6, 7].map((s) => scheduler.sprinkleDue(s, 5))).toEqual([false, false, true]);
    // Slipped all the way to 7 → slot 8 is the very next pick: refused, goes at 9.
    expect(scheduler.sprinkleDue(7, 7)).toBe(false);
    expect(scheduler.sprinkleDue(8, 7)).toBe(true);
  });
});

describe('pickSprinkle — which topic', () => {
  it('the least-attempted topic that has an unused easy banked', () => {
    practise('arrays', 5);
    practise('hashing', 2);
    practise('trie', 1);
    bankEasy('arrays');
    bankEasy('hashing');
    bankEasy('trie');
    expect(scheduler.pickSprinkle('javascript')).toEqual({ topic: 'trie', banked: true });
  });

  it('skips untouched topics with nothing banked; ignores prerequisites', () => {
    practise('arrays', 5);
    bankEasy('arrays');
    bankEasy('dynamic-programming'); // deep in the tree, nothing unlocked
    expect(scheduler.pickSprinkle('javascript')).toEqual({ topic: 'dynamic-programming', banked: true });
  });

  it('ties on attempts go to the topic with fewer easys already served', () => {
    bankEasy('stack', true);
    bankEasy('stack');
    bankEasy('heap');
    expect(scheduler.pickSprinkle('javascript').topic).toBe('heap');
  });

  it('avoids the topic just served unless it is the only one', () => {
    bankEasy('trie');
    bankEasy('heap');
    expect(scheduler.pickSprinkle('javascript', 'heap').topic).toBe('trie');
    db.db.prepare(`DELETE FROM problems WHERE topic = 'trie'`).run();
    expect(scheduler.pickSprinkle('javascript', 'heap').topic).toBe('heap');
  });

  it('is language-scoped', () => {
    bankEasy('trie', false, 'python');
    bankEasy('heap');
    expect(scheduler.pickSprinkle('javascript').topic).toBe('heap');
  });

  it('with no unused easy anywhere, falls back to the least-attempted topic, unbanked', () => {
    practise('arrays', 3);
    bankEasy('arrays', true);
    const pick = scheduler.pickSprinkle('javascript');
    expect(pick.banked).toBe(false);
    expect(pick.topic).not.toBe('arrays');
  });
});

describe('sprinkleIntent → getAdaptiveProblem — bank first', () => {
  it('serves the banked easy and never calls the generator', async () => {
    practise('arrays', 4);
    const id = bankEasy('greedy');
    const intent = scheduler.sprinkleIntent('javascript');
    expect(intent).toMatchObject({ kind: 'sprinkle', topic: 'greedy', difficulty: 'easy' });
    expect(intent.rationale).toBe('Something new: a quick easy from greedy to keep things fresh.');
    const served = await bank.getAdaptiveProblem(intent);
    expect(served.id).toBe(id);
    expect(db.getProblem(id)!.used).toBe(true);
    expect(mocks.generateProblem).not.toHaveBeenCalled();
  });

  it('generates only when the bank has no unused easy for the language', async () => {
    const intent = scheduler.sprinkleIntent('javascript');
    await expect(bank.getAdaptiveProblem(intent)).rejects.toThrow();
    expect(mocks.generateProblem).toHaveBeenCalled();
    expect(mocks.generateProblem.mock.calls[0]).toEqual(
      expect.arrayContaining(['javascript', intent.topic, 'easy'])
    );
  });
});

describe('nextIntent / peekUpNext — ordering', () => {
  it('a due review outranks the sprinkle slot; with the review capped, the sprinkle goes out', () => {
    const rid = bankEasy('arrays', true);
    db.enqueueReview(rid, 'failed', Date.now() - 3 * 86_400_000);
    db.db.prepare(`UPDATE review_queue SET dueAt = ?`).run(new Date(Date.now() - 60_000).toISOString());
    bankEasy('trie');
    expect(scheduler.nextIntent({ language: 'javascript', allowReview: true, allowSprinkle: true }).kind).toBe('review');
    expect(scheduler.peekUpNext({ language: 'javascript', allowReview: true, allowSprinkle: true })).toBe(
      'a review problem to solve cold'
    );
    const s = scheduler.nextIntent({ language: 'javascript', allowReview: false, allowSprinkle: true });
    expect(s).toMatchObject({ kind: 'sprinkle', topic: 'trie' });
    expect(scheduler.peekUpNext({ language: 'javascript', allowReview: false, allowSprinkle: true })).toBe(
      'something new: a quick trie easy'
    );
  });

  it('without allowSprinkle (every non-grind caller) nothing changes', () => {
    bankEasy('trie');
    expect(scheduler.nextIntent({ language: 'javascript' }).kind).not.toBe('sprinkle');
  });
});
