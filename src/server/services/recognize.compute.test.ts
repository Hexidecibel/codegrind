import { describe, it, expect } from 'vitest';
import { TOPICS, type Topic } from '../../shared/types.js';
import { newCardSchedule } from '../../shared/gap-cards.js';
import {
  CONFUSABLE,
  effectiveGrade,
  interleave,
  isPatternCorrect,
  maxPerTopic,
  mulberry32,
  pickChoices,
  recentAccuracy,
  recognizeAdvice,
  scheduleRecognizeCard,
  describeRecognizeOutcome,
  selectSession,
  topicStats,
  topicWeakness,
  type RecognizeCandidate,
} from './recognize.compute.js';

const NOW = Date.parse('2026-10-21T20:00:00.000Z');
const DAY = 86_400_000;

describe('pickChoices', () => {
  it('always four distinct topics including the answer, never the also-correct pattern', () => {
    for (const t of TOPICS) {
      for (let seed = 0; seed < 20; seed++) {
        const c = pickChoices(t, mulberry32(seed), 'hashing');
        expect(c).toHaveLength(4);
        expect(new Set(c).size).toBe(4);
        expect(c).toContain(t);
        if (t !== 'hashing') expect(c).not.toContain('hashing');
        for (const x of c) expect(TOPICS).toContain(x);
      }
    }
  });

  it('draws distractors from the confusables first', () => {
    const c = pickChoices('sliding-window', mulberry32(7));
    const distractors = c.filter((x) => x !== 'sliding-window');
    for (const d of distractors) expect(CONFUSABLE['sliding-window']).toContain(d);
  });

  it('is deterministic for a seed and shuffles the answer position', () => {
    expect(pickChoices('heap', mulberry32(3))).toEqual(pickChoices('heap', mulberry32(3)));
    const positions = new Set(Array.from({ length: 30 }, (_, s) => pickChoices('heap', mulberry32(s)).indexOf('heap')));
    expect(positions.size).toBeGreaterThan(1);
  });

  it('every confusable list names real topics, never itself', () => {
    for (const t of TOPICS) {
      expect(CONFUSABLE[t].length).toBeGreaterThanOrEqual(3);
      for (const x of CONFUSABLE[t]) {
        expect(TOPICS).toContain(x);
        expect(x).not.toBe(t);
      }
    }
  });
});

describe('isPatternCorrect / effectiveGrade', () => {
  it('accepts the topic, or the pattern when it is a topic', () => {
    expect(isPatternCorrect('arrays', 'arrays', 'hashing')).toBe(true);
    expect(isPatternCorrect('hashing', 'arrays', 'hashing')).toBe(true);
    expect(isPatternCorrect('greedy', 'arrays', 'hashing')).toBe(false);
    expect(isPatternCorrect('free text', 'arrays', 'free text')).toBe(false);
    expect(isPatternCorrect(null, 'arrays', 'arrays')).toBe(false);
  });

  it('a wrong pick is always a miss', () => {
    expect(effectiveGrade(false, 'got')).toBe('missed');
    expect(effectiveGrade(true, 'shaky')).toBe('shaky');
  });
});

function cand(id: string, topic: Topic, extra: Partial<RecognizeCandidate> = {}): RecognizeCandidate {
  return { problemId: id, title: `T ${id}`, topic, codeFree: true, activeLanguage: true, lastRecognizedAt: null, ...extra };
}

const bank = (): RecognizeCandidate[] => {
  const topics: Topic[] = ['arrays', 'hashing', 'two-pointer', 'binary-search', 'math', 'sliding-window'];
  return topics.flatMap((t) => [1, 2, 3, 4].map((i) => cand(`${t}-${i}`, t)));
};

describe('selectSession', () => {
  it('serves N, at most one per topic at N=5, no two neighbours alike', () => {
    const s = selectSession({ n: 5, candidates: bank(), due: [], weakness: new Map(), now: NOW, rng: mulberry32(1) });
    expect(s.ids).toHaveLength(5);
    const topics = s.ids.map((id) => id.replace(/-\d+$/, ''));
    expect(new Set(topics).size).toBe(5);
  });

  it('caps at 2 per topic at N=10 and still interleaves', () => {
    const s = selectSession({ n: 10, candidates: bank(), due: [], weakness: new Map(), now: NOW, rng: mulberry32(2) });
    expect(s.ids).toHaveLength(10);
    const topics = s.ids.map((id) => id.replace(/-\d+$/, ''));
    const counts = new Map<string, number>();
    for (const t of topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(maxPerTopic(10));
    for (let i = 1; i < topics.length; i++) expect(topics[i]).not.toBe(topics[i - 1]);
  });

  it('leans toward weak topics', () => {
    const weakness = new Map<string, number>([['math', 3], ['binary-search', 2.5]]);
    const s = selectSession({ n: 5, candidates: bank(), due: [], weakness, now: NOW, rng: mulberry32(3) });
    const topics = s.ids.map((id) => id.replace(/-\d+$/, ''));
    expect(topics).toContain('math');
    expect(topics).toContain('binary-search');
  });

  it('serves due cards first and counts the ones that did not fit', () => {
    const due = [
      { problemId: 'math-1', topic: 'math' as Topic, dueAt: new Date(NOW - 2 * DAY).toISOString() },
      { problemId: 'hashing-2', topic: 'hashing' as Topic, dueAt: new Date(NOW - DAY).toISOString() },
      { problemId: 'math-2', topic: 'math' as Topic, dueAt: new Date(NOW - DAY).toISOString() }, // capped at N=5
    ];
    const s = selectSession({ n: 5, candidates: bank(), due, weakness: new Map(), now: NOW, rng: mulberry32(4) });
    expect(s.ids.slice(0, 2).sort()).toEqual(['hashing-2', 'math-1']);
    expect([...s.dueIds].sort()).toEqual(['hashing-2', 'math-1']);
    expect(s.dueLeft).toBe(1);
    expect(s.ids).not.toContain('math-2');
  });

  it('skips problems recognized in the last 3 days, but relaxes rather than serve short', () => {
    const recent = new Date(NOW - DAY).toISOString();
    const cands = bank().map((c) => (c.topic === 'arrays' ? c : { ...c, lastRecognizedAt: recent }));
    const s = selectSession({ n: 5, candidates: cands, due: [], weakness: new Map([['arrays', 0]]), now: NOW, rng: mulberry32(5) });
    expect(s.ids).toHaveLength(5);
    expect(s.ids.filter((id) => id.startsWith('arrays'))).toHaveLength(1); // the fresh one comes first
  });

  it('relaxes the topic cap when the bank has too few topics', () => {
    const cands = [cand('a1', 'arrays'), cand('a2', 'arrays'), cand('a3', 'arrays'), cand('h1', 'hashing')];
    const s = selectSession({ n: 5, candidates: cands, due: [], weakness: new Map(), now: NOW, rng: mulberry32(6) });
    expect(s.ids).toHaveLength(4);
    expect(s.ids[1]).toBe('h1'); // A H A A: the one hashing card splits the run
  });

  it('dedupes by title (the same problem in two languages)', () => {
    const cands = [
      cand('js', 'arrays', { title: 'Same' }),
      cand('py', 'arrays', { title: 'Same', activeLanguage: false }),
      cand('h', 'hashing'),
    ];
    const s = selectSession({ n: 5, candidates: cands, due: [], weakness: new Map(), now: NOW, rng: mulberry32(7) });
    expect(s.ids.sort()).toEqual(['h', 'js']);
  });

  it('prefers problems whose code is free to show', () => {
    const cands = [cand('fresh', 'arrays', { codeFree: false }), cand('seen', 'arrays')];
    const s = selectSession({ n: 5, candidates: cands, due: [], weakness: new Map(), now: NOW, rng: mulberry32(8) });
    expect(s.ids[0]).toBe('seen');
  });
});

describe('interleave', () => {
  it('spreads a 3-2 split', () => {
    const out = interleave([{ topic: 'a' }, { topic: 'a' }, { topic: 'a' }, { topic: 'b' }, { topic: 'b' }]);
    expect(out.map((x) => x.topic).join('')).toBe('ababa');
  });
});

describe('scheduleRecognizeCard', () => {
  const now = new Date(NOW);
  it('a first-time got creates no card', () => {
    expect(scheduleRecognizeCard(null, 'got', now)).toBeNull();
    expect(describeRecognizeOutcome(null, 'got')).toMatch(/not scheduled/);
  });

  it('a first miss or shaky starts a card due tomorrow, not now', () => {
    for (const g of ['missed', 'shaky'] as const) {
      const c = scheduleRecognizeCard(null, g, now)!;
      expect(c.step).toBe(0);
      expect(Date.parse(c.dueAt)).toBe(NOW + DAY);
      expect(c.reps).toBe(1);
    }
  });

  it('climbs the [0,2,5,10] ladder on got, retires at the top', () => {
    let c = scheduleRecognizeCard(null, 'missed', now)!;
    c = scheduleRecognizeCard(c, 'got', now)!;
    expect(c.step).toBe(1);
    expect(Date.parse(c.dueAt)).toBe(NOW + 2 * DAY);
    c = scheduleRecognizeCard(c, 'got', now)!;
    c = scheduleRecognizeCard(c, 'got', now)!;
    expect(c.step).toBe(3);
    expect(Date.parse(c.dueAt)).toBe(NOW + 10 * DAY);
    c = scheduleRecognizeCard(c, 'got', now)!;
    expect(c.retiredAt).not.toBeNull();
  });

  it('a miss on a laddered card drops to the bottom, due tomorrow', () => {
    const c = scheduleRecognizeCard({ ...newCardSchedule(now), step: 2 }, 'missed', now)!;
    expect(c.step).toBe(0);
    expect(c.lapses).toBe(1);
    expect(Date.parse(c.dueAt)).toBe(NOW + DAY);
    expect(describeRecognizeOutcome({ ...newCardSchedule(now), step: 2 }, 'missed')).toBe('again tomorrow');
  });
});

describe('accuracy', () => {
  const rows = [
    { topic: 'arrays', patternCorrect: true, grade: 'got' as const, createdAt: '2026-10-20T00:00:00Z' },
    { topic: 'arrays', patternCorrect: false, grade: 'missed' as const, createdAt: '2026-10-20T00:01:00Z' },
    { topic: 'heap', patternCorrect: true, grade: 'missed' as const, createdAt: '2026-10-20T00:02:00Z' },
    { topic: 'heap', patternCorrect: true, grade: 'shaky' as const, createdAt: '2026-10-20T00:03:00Z' },
  ];
  it('per topic, worst first', () => {
    const s = topicStats(rows);
    expect(s[0]).toMatchObject({ topic: 'arrays', n: 2, patternAccuracy: 0.5, gotRate: 0.5 });
    expect(s[1]).toMatchObject({ topic: 'heap', n: 2, patternAccuracy: 1, gotRate: 0 });
  });
  it('recent = right pattern and not a missed approach', () => {
    expect(recentAccuracy(rows)).toEqual({ accuracy: 0.5, n: 4 });
    expect(recentAccuracy([])).toEqual({ accuracy: null, n: 0 });
  });
});

describe('topicWeakness', () => {
  it('ranks a failing topic above a never-seen one above a solid one', () => {
    const fail = topicWeakness(
      { topic: 'x', attempts: 4, solved: 1, lastResult: 'fail', lastSeenAt: new Date(NOW - 20 * DAY).toISOString() },
      undefined,
      NOW
    );
    const never = topicWeakness(undefined, undefined, NOW);
    const solid = topicWeakness(
      { topic: 'x', attempts: 5, solved: 5, lastResult: 'pass', lastSeenAt: new Date(NOW).toISOString() },
      undefined,
      NOW
    );
    expect(fail).toBeGreaterThan(never);
    expect(never).toBeGreaterThan(solid);
    expect(topicWeakness(undefined, { n: 3, patternAccuracy: 0 }, NOW)).toBeGreaterThan(never);
  });
});

describe('recognizeAdvice (Today)', () => {
  const base = { grindAttemptsLast3Days: 4, recentAccuracy: 0.9, recentN: 10, due: 0, doneToday: 0 };
  it('recommends when no grind in 3 days', () => {
    expect(recognizeAdvice({ ...base, grindAttemptsLast3Days: 0 }).recommended).toBe(true);
  });
  it('recommends when recent accuracy is under 60% with enough cards', () => {
    expect(recognizeAdvice({ ...base, recentAccuracy: 0.5 }).recommended).toBe(true);
    expect(recognizeAdvice({ ...base, recentAccuracy: 0.5, recentN: 3 }).recommended).toBe(false);
  });
  it('recommends when cards are due, otherwise optional', () => {
    expect(recognizeAdvice({ ...base, due: 2 }).reason).toMatch(/2 recognize cards due/);
    expect(recognizeAdvice(base)).toEqual({ recommended: false, reason: expect.stringMatching(/Optional/) });
  });
});
