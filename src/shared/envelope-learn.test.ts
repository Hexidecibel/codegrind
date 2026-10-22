// =============================================================================
// envelope-learn — guided step checkers, fading, quick drills, daily skill,
// speed scoring (Phase I). The slips are the user's real ones (2026-10-21).
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  ALL_KINDS,
  QUICK_KINDS,
  checkAnswer,
  dayToSec,
  formHint,
  gbpsToMBs,
  generateItem,
  itemFromKey,
  mbsToGbps,
  monthToSec,
  storageDayItem,
  bandwidthItem,
  ladderItem,
  seedItems,
  type EnvelopeItem,
} from './envelope.js';
import {
  ANCHOR_CARDS,
  DAILY_SKILLS,
  FADE_AFTER,
  SPEED_KINDS,
  anchorGrade,
  checkAnchor,
  checkFinalStep,
  checkStep,
  dailySkill,
  fadedTypes,
  guidedForToday,
  guidedPlan,
  parseSci,
  pickWeighted,
  practiceWeights,
  scoreSpeedRound,
  stepStreaks,
  unfadeOnMiss,
  type GuidedStep,
  type StepType,
} from './envelope-learn.js';
import { rng } from './envelope.js';

const plan = (item: EnvelopeItem) => guidedPlan(item)!;
const stepOf = (item: EnvelopeItem, type: StepType, nth = 0): GuidedStep => plan(item).filter((s) => s.type === type)[nth];

const PER_DAY_500M = dayToSec('t:500m', { n: 500e6, noun: 'requests' });
const PER_DAY_50M = dayToSec('t:50m', { n: 50e6, noun: 'requests' });
const PER_MONTH_2B = monthToSec('t:2b', { n: 2e9, noun: 'page views' });
const PHOTOS = storageDayItem('t:photos', { users: 500e6, perUser: 2, noun: 'photos', bytesEach: 200e3 });
const NIC = gbpsToMBs('t:nic', { gbps: 10 });
const REPL = mbsToGbps('t:repl', { mbs: 500 });
const BW = bandwidthItem('t:bw', { perSec: 1000, noun: 'images', bytesEach: 1e6 });

describe('guided plan', () => {
  it('walks direction → split per number → small → exponent → back → unit', () => {
    expect(plan(PER_DAY_50M).map((s) => s.type)).toEqual(['direction', 'split', 'split', 'small', 'exponent', 'back', 'unit']);
    expect(stepOf(PER_DAY_50M, 'split', 1).prompt).toBe('Write seconds in a day (rounded) as small × 10ⁿ.');
    expect(stepOf(PER_DAY_50M, 'exponent').answer).toBe('2');
    expect(stepOf(PER_DAY_50M, 'back').answer).toBe('500');
  });

  it('has a plan for every multi-step generated kind, none for quick kinds or base62', () => {
    for (const k of ALL_KINDS) {
      const item = generateItem(k, 3);
      const p = guidedPlan(item);
      if ((QUICK_KINDS as readonly string[]).includes(k) || k === 'id-space') expect(p, k).toBeNull();
      else expect(p?.length, k).toBeGreaterThanOrEqual(4);
    }
  });

  it('every step answer passes its own checker, across many seeds', () => {
    for (const k of ALL_KINDS) {
      for (let seed = 0; seed < 40; seed++) {
        const item = generateItem(k, seed);
        for (const s of guidedPlan(item) ?? []) {
          if (s.type === 'unit') {
            expect(checkFinalStep(item, s.answer.replace(/ \(exactly.*\)$/, ''))?.ok, `${item.key} final "${s.answer}"`).toBe(true);
          } else {
            expect(checkStep(s, s.answer).ok, `${item.key} ${s.type} "${s.answer}"`).toBe(true);
          }
        }
      }
    }
  });
});

describe('step checkers name the exact slip (the user’s 2026-10-21 slips)', () => {
  it('1. multiplied on per day → per second', () => {
    const r = checkStep(stepOf(PER_DAY_50M, 'direction'), 'multiply');
    expect(r).toMatchObject({ ok: false, slip: 'direction' });
    expect(r.feedback).toMatch(/divide/);
    expect(r.feedback).toMatch(/\$100k a year → per day/);
    expect(checkStep(stepOf(PER_DAY_50M, 'direction'), 'divide').ok).toBe(true);
    expect(checkStep(stepOf(PER_DAY_50M, 'direction'), '÷').ok).toBe(true);
  });

  it('2. dropped the front number’s own zeros: 500 million → 5 × 10⁶, 50 million → 5 × 10⁶, 200 KB → 2 × 10³', () => {
    let r = checkStep(stepOf(PER_DAY_500M, 'split'), '5 x 10^6');
    expect(r).toMatchObject({ ok: false, slip: 'own-zeros' });
    expect(r.feedback).toBe("You dropped 500's own zeros. Split it first: 500 = 5 × 10², and million = 10⁶, so 5 × 10² × 10⁶ = 5 × 10⁸.");
    r = checkStep(stepOf(PER_DAY_50M, 'split'), '5×10⁶');
    expect(r).toMatchObject({ ok: false, slip: 'own-zeros' });
    expect(r.feedback).toContain('5 × 10⁷');
    const kb = plan(PHOTOS).find((s) => s.type === 'split' && s.prompt.includes('200 kilobytes'))!;
    r = checkStep(kb, '2 x 10^3');
    expect(r).toMatchObject({ ok: false, slip: 'own-zeros' });
    expect(r.feedback).toContain('2 × 10⁵');
    expect(checkStep(stepOf(PER_DAY_500M, 'split'), '5 x 10^8').ok).toBe(true);
    expect(checkStep(stepOf(PER_DAY_500M, 'split'), '5e8').ok).toBe(true);
  });

  it('3. the 0 in "10" counted as a zero: a day as 10 × 10⁵; 5 × 10² read as 5,000', () => {
    let r = checkStep(stepOf(PER_DAY_50M, 'split', 1), '10 x 10^5');
    expect(r).toMatchObject({ ok: false, slip: 'ten-as-zero' });
    expect(r.feedback).toMatch(/little number is the total zero count/);
    r = checkStep(stepOf(PER_DAY_50M, 'back'), '5000');
    expect(r).toMatchObject({ ok: false, slip: 'ten-as-zero' });
    expect(r.feedback).toBe('10² is 1 followed by 2 zeros in total (the little number is the total zero count), so 5 × 10² = 500, not 5,000.');
    expect(checkStep(stepOf(PER_DAY_50M, 'split', 1), '10^5').ok).toBe(true);
  });

  it('4. small-number division under 1: 2 ÷ 2.5 answered 5', () => {
    const s = stepOf(PER_MONTH_2B, 'small');
    expect(s.prompt).toBe('Small numbers only: 2 ÷ 2.5 = ?');
    const r = checkStep(s, '5');
    expect(r).toMatchObject({ ok: false, slip: 'under-one' });
    expect(r.feedback).toMatch(/^2 ÷ 2\.5: the top number is smaller than the bottom, so the answer is under 1\. 2 ÷ 2\.5 = 0\.8/);
    expect(checkStep(s, '0.8').ok).toBe(true);
    expect(checkStep(s, '.8').ok).toBe(true);
    expect(checkStep(s, '1.25')).toMatchObject({ slip: 'under-one' });
  });

  it('5. bits vs bytes: × 8 going bits → bytes; stopping at GB/s when Gbps is asked', () => {
    const r = checkStep(stepOf(NIC, 'direction'), 'multiply');
    expect(r).toMatchObject({ ok: false, slip: 'bits-bytes' });
    expect(r.feedback).toMatch(/8 per byte.*÷ 8/);
    const f = checkFinalStep(BW, '1 GB/s')!;
    expect(f).toMatchObject({ ok: false, slip: 'bits-bytes', cause: 'bits-bytes' });
    expect(f.feedback).toMatch(/× 8 to get bits/);
    expect(checkFinalStep(BW, '8 Gbps')!.ok).toBe(true);
    expect(checkFinalStep(REPL, '0.5 GB/s')).toMatchObject({ ok: false, slip: 'bits-bytes' });
    expect(checkFinalStep(REPL, '4 Gbps')!.ok).toBe(true);
  });

  it('6. finishing in the asked unit: TB on a request count; the wrong period', () => {
    const r = checkFinalStep(PER_DAY_50M, '500 TB')!;
    expect(r).toMatchObject({ ok: false, slip: 'wrong-unit', cause: 'wrong-unit' });
    expect(r.feedback).toMatch(/count, not data/);
    expect(checkFinalStep(PER_DAY_50M, '500 per day')).toMatchObject({ ok: false, slip: 'wrong-period' });
    expect(checkFinalStep(PER_DAY_50M, '500 per second')!.ok).toBe(true);
    expect(checkFinalStep(PER_DAY_50M, '500')!.ok).toBe(true);
  });

  it('7. back up the ladder by commas', () => {
    const item = ladderItem('t:l', { n: 8000, fromExp: 9, toExp: 12 });
    const back = stepOf(item, 'back');
    expect(checkStep(back, '8').ok).toBe(true);
    expect(checkStep(back, '8 TB').ok).toBe(true);
    const photosBack = stepOf(PHOTOS, 'back');
    const r = checkStep(photosBack, '200000');
    expect(r).toMatchObject({ ok: false, slip: 'comma' });
    expect(r.feedback).toMatch(/Each comma knocked off = one unit up \(bytes → KB → MB → GB → TB\): knock off 4 → 200 TB/);
    expect(r.feedback).not.toMatch(/rung/i);
  });

  it('exponents: subtract when dividing', () => {
    const s = stepOf(PER_DAY_50M, 'exponent');
    expect(checkStep(s, '12')).toMatchObject({ ok: false, slip: 'add-subtract' });
    expect(checkStep(s, '10^2').ok).toBe(true);
    expect(checkStep(s, '2').ok).toBe(true);
  });

  it('parseSci keeps the front number as typed', () => {
    expect(parseSci('10 × 10⁵')).toMatchObject({ m: 10, e: 5, value: 1e6 });
    expect(parseSci('5x10^8')).toMatchObject({ m: 5, e: 8 });
    expect(parseSci('2.5e6')).toMatchObject({ m: 2.5, e: 6 });
    expect(parseSci('10^5')).toMatchObject({ m: 1, e: 5 });
    expect(parseSci('lots')).toBeNull();
  });
});

describe('faded scaffolding', () => {
  const rows = (type: StepType, oks: boolean[]) => oks.map((ok) => ({ type, ok }));
  it(`a step type fades after ${FADE_AFTER} right in a row, and a miss resets it`, () => {
    let s = stepStreaks(rows('split', [true, true, true, false, true]));
    expect(s.split).toBe(3);
    expect(fadedTypes(s).has('split')).toBe(true);
    s = stepStreaks(rows('split', [false, true, true, true]));
    expect(s.split).toBe(0);
    expect(fadedTypes(s).has('split')).toBe(false);
    s = stepStreaks([...rows('small', [true, true]), ...rows('direction', [true, true, true])]);
    expect([...fadedTypes(s)]).toEqual(['direction']);
  });

  it('the final answer never fades', () => {
    expect(fadedTypes(stepStreaks(rows('unit', [true, true, true, true]))).has('unit')).toBe(false);
  });

  it('a final miss brings back only the faded steps it points at', () => {
    const faded = new Set<StepType>(['direction', 'split', 'small', 'back']);
    expect(unfadeOnMiss('arithmetic', faded)).toEqual(['small']);
    expect(unfadeOnMiss('unit-ladder', faded)).toEqual(['back']);
    expect(unfadeOnMiss('zeros', faded)).toEqual(['split', 'back']);
    expect(unfadeOnMiss('bits-bytes', new Set<StepType>(['small']))).toEqual([]);
    expect(unfadeOnMiss(null, faded)).toEqual([]);
  });
});

describe('the new drill kinds', () => {
  const many = (k: (typeof QUICK_KINDS)[number]) => Array.from({ length: 200 }, (_, i) => generateItem(k, i));

  it('are deterministic and regenerate from their key', () => {
    for (const k of QUICK_KINDS) for (const item of many(k).slice(0, 20)) expect(itemFromKey(item.key)).toEqual(item);
  });

  it('words → small × 10ⁿ: the answer is right, and dropping own zeros is named', () => {
    for (const item of many('words-to-sci')) {
      expect(checkAnswer(item, item.answerText)?.ok, `${item.question} ${item.answerText}`).toBe(true);
      const m = /^(\d+) /.exec(item.question.replace(/^Write "?/, ''))!;
      const lead = Number(m[1]);
      const front = String(lead)[0];
      const correctExp = Math.floor(Math.log10(item.expected.value) + 1e-9);
      if (lead >= 10) {
        const wrong = `${front} x 10^${correctExp - String(lead).length + 1}`;
        expect(checkAnswer(item, wrong)?.cause, `${item.question} ${wrong}`).toBe('own-zeros');
      }
    }
    const fixture = generateItem('words-to-sci', 0);
    expect(fixture.split.small).toMatch(/Split the front number first|already small/);
  });

  it('words → small × 10ⁿ wants the 10ⁿ form', () => {
    const item = many('words-to-sci')[0];
    expect(formHint(item, '500000000')).toMatch(/small × 10ⁿ/);
    expect(formHint(item, '5 x 10^8')).toBeNull();
    expect(formHint(item, '5e8')).toBeNull();
  });

  it('divide or multiply: the word is graded, and the miss cause is direction', () => {
    for (const item of many('direction')) {
      expect(checkAnswer(item, item.answerText)?.ok).toBe(true);
      const other = item.answerText === 'divide' ? 'multiply' : 'divide';
      expect(checkAnswer(item, other)).toMatchObject({ ok: false, cause: 'direction' });
    }
    const perSec = many('direction').find((i) => i.question.includes('per day. You want it per second'))!;
    expect(perSec.answerText).toBe('divide');
  });

  it('10ⁿ → a normal number, and the comma ladder: exact answers, slips named', () => {
    for (const item of many('sci-to-number')) {
      expect(checkAnswer(item, item.answerText.replace(/ \(.*\)$/, ''))?.ok, `${item.question} ${item.answerText}`).toBe(true);
    }
    const five = many('sci-to-number').find((i) => i.question === 'Write 5 × 10² as a normal number.') ?? generateItem('sci-to-number', 0);
    if (five.question === 'Write 5 × 10² as a normal number.') {
      expect(checkAnswer(five, '5000')).toMatchObject({ ok: false, cause: 'zeros' });
      expect(checkAnswer(five, '500')?.ok).toBe(true);
    }
    const comma = many('sci-to-number').find((i) => i.inUnit && i.question.includes('GB is how many TB'))!;
    const n = Number(comma.question.split(' ')[0].replace(/,/g, '')) / 1000;
    expect(checkAnswer(comma, `${n}`)?.ok).toBe(true);
    expect(checkAnswer(comma, `${n} TB`)?.ok).toBe(true);
    expect(checkAnswer(comma, `${n * 1000} GB`)).toMatchObject({ ok: false, cause: 'wrong-unit' });
    expect(checkAnswer(comma, `${n * 1000}`)).toMatchObject({ ok: false, cause: 'unit-ladder' });
  });

  it('every quick item still reads its own answer after a JSON round-trip (cards store JSON)', () => {
    for (const k of QUICK_KINDS) {
      for (const item of many(k).slice(0, 30)) {
        const back = JSON.parse(JSON.stringify(item)) as EnvelopeItem;
        expect(checkAnswer(back, back.answerText.replace(/ \(.*\)$/, ''))?.ok).toBe(true);
      }
    }
  });
});

describe('anchor flashcards', () => {
  it('each card accepts its own answer and a 10 s window', () => {
    const answers: Record<string, string> = {
      day: '10^5', month: '2.5 x 10^6', year: '3e7', 'day-year': '400', 'byte-bits': '8', gbps: '125',
      'to-bytes': '÷ 8', 'to-bits': '× 8', k: '3', m: '6', b: '9', t: '12', 'pow-zeros': '5', 'pow-number': '10,000',
    };
    for (const c of ANCHOR_CARDS) expect(checkAnchor(c, answers[c.id]), c.id).toBe(true);
    expect(checkAnchor(ANCHOR_CARDS.find((c) => c.id === 'day')!, '86400')).toBe(true);
    expect(checkAnchor(ANCHOR_CARDS.find((c) => c.id === 'day')!, '10^6')).toBe(false);
    expect(checkAnchor(ANCHOR_CARDS.find((c) => c.id === 'to-bytes')!, '× 8')).toBe(false);
    expect(checkAnchor(ANCHOR_CARDS.find((c) => c.id === 'pow-number')!, '100000')).toBe(false);
    expect(anchorGrade(true, 6000)).toBe('got');
    expect(anchorGrade(true, 15000)).toBe('missed');
    expect(anchorGrade(false, 2000)).toBe('missed');
  });
});

describe('daily skill rotation', () => {
  it('one skill per day of practice, in the taught order, then around again', () => {
    expect([0, 1, 2, 3, 4].map((d) => dailySkill(d).id)).toEqual(['per-second', 'powers', 'bits-bytes', 'mixed', 'per-second']);
    expect(DAILY_SKILLS.every((s) => s.kinds.length > 0)).toBe(true);
  });

  it('guided while under 20 answers or under 70%', () => {
    expect(guidedForToday(5, 1)).toBe(true);
    expect(guidedForToday(25, 0.6)).toBe(true);
    expect(guidedForToday(25, 0.7)).toBe(false);
    expect(guidedForToday(25, null)).toBe(true);
  });
});

describe('speed round scoring', () => {
  it('one point per right answer inside 60 s; late answers do not count; no penalty', () => {
    const s = scoreSpeedRound([
      { ok: true, atMs: 3000 },
      { ok: true, atMs: 9000 },
      { ok: false, atMs: 15000 },
      { ok: true, atMs: 20000 },
      { ok: true, atMs: 30000 },
      { ok: true, atMs: 59_999 },
      { ok: true, atMs: 61_000 },
    ]);
    expect(s).toEqual({ score: 5, right: 5, attempted: 6, bestStreak: 3 });
    expect(scoreSpeedRound([])).toEqual({ score: 0, right: 0, attempted: 0, bestStreak: 0 });
  });

  it('draws only one-entry kinds', () => {
    for (const k of SPEED_KINDS) expect(guidedPlan(generateItem(k, 1)) === null || ['ladder', 'day-to-sec', 'gbps-to-mbs'].includes(k)).toBe(true);
  });
});

describe('endless practice weights', () => {
  it('weights the most-missed kinds and step types up', () => {
    const w = practiceWeights(
      [...Array(5)].map(() => ({ kind: 'gbps-to-mbs', ok: false })),
      [...Array(4)].map(() => ({ type: 'split', ok: false }))
    );
    expect(w['gbps-to-mbs']).toBe(5);
    expect(w['words-to-sci']).toBe(4);
    expect(w['sec-to-day']).toBe(1);
    const r = rng(1);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const k = pickWeighted(w, r);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts['gbps-to-mbs']).toBeGreaterThan(counts['sec-to-day'] * 3);
  });
});

describe('seed cards still plan', () => {
  it('the diagnostic cards have guided steps', () => {
    for (const item of seedItems()) expect(guidedPlan(item), item.key).not.toBeNull();
  });
});
