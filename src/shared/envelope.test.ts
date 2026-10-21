// =============================================================================
// envelope — the generator, the parser and the miss classifier (Phase G)
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  ENVELOPE_KINDS,
  checkAnswer,
  classifyMiss,
  dayToSec,
  envelopeFromGapText,
  envelopeRemaining,
  gbpsToMBs,
  generateItem,
  generateSet,
  idSpaceItem,
  itemFromKey,
  parseAnswer,
  seedItems,
  type EnvelopeItem,
} from './envelope.js';

const SEEDS = seedItems();
const [PER_DAY, PER_MONTH, PER_SEC, GB_DAY, PHOTOS] = SEEDS;

/** Every generated question across many seeds, plus the seeds. */
const ALL: EnvelopeItem[] = [
  ...SEEDS,
  ...ENVELOPE_KINDS.flatMap((k) => Array.from({ length: 40 }, (_, i) => generateItem(k, i))),
];

describe('the generator', () => {
  it('is deterministic: same seed, same set; the key regenerates the item', () => {
    expect(generateSet(1234, 8)).toEqual(generateSet(1234, 8));
    expect(generateSet(1234, 8)).not.toEqual(generateSet(1235, 8));
    for (const item of generateSet(99, 10)) expect(itemFromKey(item.key)).toEqual(item);
    expect(itemFromKey('g:nope:1')).toBeNull();
    expect(itemFromKey('seed:x')).toBeNull();
  });

  it('mixes conversions and estimates, never the same kind twice in a row', () => {
    const set = generateSet(7, 12);
    expect(set.some((i) => i.family === 'estimate')).toBe(true);
    expect(set.some((i) => i.family === 'conversion')).toBe(true);
    for (let i = 1; i < set.length; i++) expect(set[i].kind).not.toBe(set[i - 1].kind);
  });

  it('every item carries an exact answer and a full worked split', () => {
    for (const item of ALL) {
      expect(item.expected.value, item.key).toBeGreaterThan(0);
      expect(Number.isFinite(item.expected.value), item.key).toBe(true);
      expect(item.answerText, item.key).toBeTruthy();
      for (const part of ['parts', 'small', 'zeros', 'back', 'sanity'] as const) expect(item.split[part], `${item.key} ${part}`).toBeTruthy();
      expect(item.split.zeros, item.key).toMatch(/10[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/);
    }
  });

  it("the method's answer (anchors) is itself accepted, and so is the exact one", () => {
    for (const item of ALL) {
      if (item.exactInt) continue;
      const exact = item.expected.dim === 'count' ? String(item.expected.value) : `${item.expected.value} ${item.expected.dim === 'bits' ? 'bits' : 'bytes'}`;
      expect(checkAnswer(item, exact)?.ok, `${item.key} exact`).toBe(true);
      const approx = item.expected.dim === 'count' ? String(item.approx) : `${item.approx} ${item.expected.dim === 'bits' ? 'bits' : 'bytes'}`;
      expect(checkAnswer(item, approx)?.ok, `${item.key} approx ${item.approx}`).toBe(true);
    }
  });
});

// The phrasing guard: questions are read cold, out loud, like an interviewer
// would ask them — never note-speak like "Capacity out loud: turn 100M new
// links/month … into rps".
describe('question phrasing reads like an interviewer talking', () => {
  const NOTE_SPEAK = [
    /\bout loud:/i,
    /^[A-Z][\w -]{0,40}:/, // a "Topic:" label in front
    /\b(rps|qps|dau|mau|tps)\b/i,
    /\b\d+(\.\d+)?\s*(k|m|b|bn|mm)\b/i, // 100M, 10B, 5k
    /\b\d+\s*(kb|mb|gb|tb|pb|gbps|mbps)\b/i,
    /\/(s|sec|day|month|mo|yr|year)\b/i,
    /→|=>/,
  ];
  it('no abbreviations, no labels, no arrows; a full sentence ending in a question mark', () => {
    for (const item of ALL) {
      for (const bad of NOTE_SPEAK) expect(item.question, `${item.key}: ${bad}`).not.toMatch(bad);
      expect(item.question, item.key).toMatch(/^[A-Z"]/);
      expect(item.question, item.key).toMatch(/\?$/);
      expect(item.question.split(' ').length, item.key).toBeGreaterThanOrEqual(7);
      expect(item.question, item.key).not.toMatch(/\b1 (photos|years|megabytes|kilobytes|gigabytes)\b/);
    }
  });

  it('the guard catches the exact card that tripped the user', () => {
    const bad = 'Capacity out loud: turn 100M new links/month and 10B redirects/month into rps, peak, storage, and the design consequence.';
    expect(NOTE_SPEAK.some((re) => re.test(bad))).toBe(true);
  });
});

describe('parseAnswer', () => {
  const v = (t: string) => parseAnswer(t);
  it('reads plain numbers, ladder words, exponents and approximations', () => {
    expect(v('500')).toMatchObject({ number: 500, dim: null, per: null });
    expect(v('500/s')).toMatchObject({ number: 500, per: 's' });
    expect(v('30M')).toMatchObject({ number: 30e6, hadUnit: true });
    expect(v('30 million')).toMatchObject({ number: 30e6 });
    expect(v('3e7')).toMatchObject({ number: 3e7 });
    expect(v('5 × 10^7')).toMatchObject({ number: 5e7 });
    expect(v('5×10⁷')).toMatchObject({ number: 5e7 });
    expect(v('~800')).toMatchObject({ number: 800 });
    expect(v('about 2.5 billion a month')).toMatchObject({ number: 2.5e9, per: 'month' });
    expect(v('1,200 requests per second')).toMatchObject({ number: 1200, per: 's' });
    expect(v('10B')).toMatchObject({ number: 10e9, dim: null });
    expect(v('nothing')).toBeNull();
  });

  it('reads data units, case-sensitively for bits vs bytes', () => {
    expect(v('8TB')).toMatchObject({ number: 8, prefix: 1e12, dim: 'bytes' });
    expect(v('8000 GB')).toMatchObject({ number: 8000, prefix: 1e9, dim: 'bytes' });
    expect(v('125MB/s')).toMatchObject({ number: 125, prefix: 1e6, dim: 'bytes', per: 's' });
    expect(v('10 Gbps')).toMatchObject({ number: 10, prefix: 1e9, dim: 'bits', per: 's' });
    expect(v('10Gb')).toMatchObject({ dim: 'bits' });
    expect(v('3 terabytes')).toMatchObject({ number: 3, prefix: 1e12, dim: 'bytes' });
    expect(v('4 gigabits per second')).toMatchObject({ dim: 'bits', per: 's' });
  });
});

describe('checkAnswer on the seeded cards (the 2026-10-21 diagnostic)', () => {
  it('accepts every spelling the spec lists, within ±30%', () => {
    for (const a of ['500', '500/s', '~500', '5e2', '578']) expect(checkAnswer(PER_DAY, a)?.ok, a).toBe(true);
    for (const a of ['800', '~800', '800/s', '770']) expect(checkAnswer(PER_MONTH, a)?.ok, a).toBe(true);
    for (const a of ['30M', '30 million', '3e7', '26 million a day', '300/s']) {
      // "300/s" restates the input in the question's own period: it IS 26 million a day.
      expect(checkAnswer(PER_SEC, a)?.ok, a).toBe(true);
    }
    for (const a of ['8000', '8TB', '8000 GB', '8 terabytes', '7.3 TB']) expect(checkAnswer(GB_DAY, a)?.ok, a).toBe(true);
    for (const a of ['200 TB', '200', '2e14', '0.2 PB']) expect(checkAnswer(PHOTOS, a)?.ok, a).toBe(true);
    expect(checkAnswer(PER_DAY, '1000')?.ok).toBe(false); // +73%
  });

  it('50M/day → 20: the month constant used for a day', () => {
    const r = checkAnswer(PER_DAY, '20')!;
    expect(r.ok).toBe(false);
    expect(r.cause).toBe('month-for-day');
    expect(r.verdict).toMatch(/too low/);
  });

  it('2B/month → 80: off by 10¹, a zeros slip', () => {
    const r = checkAnswer(PER_MONTH, '80')!;
    expect(r).toMatchObject({ ok: false, cause: 'zeros', verdict: 'Off by 10¹, too low.' });
    expect(r.orders).toBeCloseTo(-0.98, 2);
  });

  it('300/s → 300 billion: off by 10⁴, too high — zeros added instead of exponents', () => {
    const r = checkAnswer(PER_SEC, '300 billion')!;
    expect(r).toMatchObject({ ok: false, cause: 'zeros', verdict: 'Off by 10⁴, too high.' });
  });

  it('20GB/day → 8000 TB: a clean 10³ step is a unit-ladder slip', () => {
    expect(checkAnswer(GB_DAY, '8000 TB')).toMatchObject({ ok: false, cause: 'unit-ladder', verdict: 'Off by 10³, too high.' });
  });

  it('a period stated in the answer is converted (30M a day for a per-second question is wrong by the day)', () => {
    expect(checkAnswer(PER_DAY, '50 million a day')?.ok).toBe(true);
    expect(checkAnswer(PER_DAY, '50 million/s')?.ok).toBe(false);
  });

  it('an unreadable answer is null, not a miss', () => {
    expect(checkAnswer(PER_DAY, 'lots')).toBeNull();
  });
});

describe('the miss classifier', () => {
  const g = gbpsToMBs('t', { gbps: 1 });
  it('bits vs bytes: 1 Gbps answered as 1000 MB/s is the 8× slip', () => {
    expect(checkAnswer(g, '125MB/s')?.ok).toBe(true);
    expect(checkAnswer(g, '1 Gbps')?.ok).toBe(true); // the same quantity, in the other unit
    expect(checkAnswer(g, '1000 MB/s')?.cause).toBe('bits-bytes');
    expect(checkAnswer(g, '15 MB/s')?.cause).toBe('bits-bytes');
  });

  it('names only causes the item can have; arithmetic for a near miss', () => {
    expect(classifyMiss(1 / 28, { traps: ['month-for-day', 'zeros'] }, null)).toBe('month-for-day');
    expect(classifyMiss(1 / 28, { traps: ['zeros', 'arithmetic'] }, null)).toBe('arithmetic');
    expect(classifyMiss(8, { traps: ['zeros'] }, null)).toBe('zeros');
    expect(classifyMiss(1000, { traps: ['unit-ladder', 'zeros'] }, null)).toBe('unit-ladder');
    expect(classifyMiss(100, { traps: ['unit-ladder', 'zeros'] }, null)).toBe('zeros');
    expect(classifyMiss(1.8, { traps: ['unit-ladder', 'zeros', 'arithmetic'] }, null)).toBe('arithmetic');
  });

  it('a base62 length must be exact or one longer', () => {
    const item = idSpaceItem('t', { perMonth: 100e6, years: 10, noun: 'short links' });
    expect(item.expected.value).toBe(6); // 1.2e10 ids; 62^6 ≈ 5.7e10
    expect(checkAnswer(item, '6')?.ok).toBe(true);
    expect(checkAnswer(item, '7 characters')?.ok).toBe(true);
    expect(checkAnswer(item, '5')).toMatchObject({ ok: false, verdict: 'Too short: 6 characters is the answer.' });
  });
});

describe('the worked split', () => {
  it('shows the small numbers, the exponent sum, and the ladder back', () => {
    expect(PER_DAY.split).toMatchObject({
      parts: expect.stringContaining('5 × 10⁷'),
      small: '5 ÷ 1 = 5',
      zeros: '10⁷ ÷ 10⁵ → 7 − 5 = 2 → 10²',
      back: '5 × 10² = 500 per second',
    });
    expect(PER_SEC.split.back).toContain('30 million a day');
    expect(GB_DAY.answerText).toMatch(/^≈ 8 TB/);
    expect(PHOTOS.split.back).toContain('200 TB');
  });

  it('seeded questions are the diagnostic ones, phrased for an interview', () => {
    expect(SEEDS.map((s) => s.question)).toEqual([
      'Say your service handles 50 million requests a day. Roughly how many is that per second?',
      'Say you get 2 billion page views a month. Roughly how many is that per second?',
      'Your API averages 300 requests a second. About how many is that in a day?',
      'Your logs grow by about 20 gigabytes a day. How much is that over a year?',
      'Say you have 500 million users, and each one uploads 2 photos a day at about 200 kilobytes each. Roughly how much new storage is that per day?',
    ]);
    expect(new Set(SEEDS.map((s) => s.key)).size).toBe(5);
  });
});

describe('mock gap → envelope card', () => {
  it('turns the biggest monthly volume in a capacity gap into an interviewer question', () => {
    const item = envelopeFromGapText('mock:2', 'Capacity out loud: turn 100M new links/month and 10B redirects/month into rps, peak, storage.')!;
    expect(item.question).toBe('Say you get 10 billion redirects a month. Roughly how many is that per second?');
    expect(item.key).toBe('mock:2');
    expect(checkAnswer(item, '4000')?.ok).toBe(true);
  });
  it('null when there is no volume to convert', () => {
    expect(envelopeFromGapText('mock:3', 'Roughly how many seconds are there in a month?')).toBeNull();
  });
  it('per-day volumes convert by the day', () => {
    expect(envelopeFromGapText('k', 'about 50 million uploads a day at peak')?.kind).toBe('day-to-sec');
  });
});

describe('envelopeRemaining', () => {
  it('is the larger of the due pile and what is left of the daily reps', () => {
    expect(envelopeRemaining(5, 0, 0)).toBe(5);
    expect(envelopeRemaining(5, 3, 0)).toBe(2);
    expect(envelopeRemaining(5, 7, 0)).toBe(0);
    expect(envelopeRemaining(5, 7, 2)).toBe(2);
    expect(envelopeRemaining(0, 0, 0)).toBe(0);
  });
});

describe('dayToSec builder', () => {
  it('uses the lead it is given', () => {
    expect(dayToSec('k', { n: 2e6, noun: 'uploads', lead: 'Imagine the system sees' }).question).toBe(
      'Imagine the system sees 2 million uploads a day. Roughly how many is that per second?'
    );
  });
});
