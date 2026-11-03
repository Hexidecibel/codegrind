// =============================================================================
// envelope-learn — guided steps, fading, anchors, daily skill, speed round (Phase I)
// =============================================================================
// Built for a true beginner: one idea per step, plain words, and feedback that
// names the exact slip. The slips below are the ones the user actually made on
// 2026-10-21, and the tests use them as fixtures:
//
//   direction   multiplied for per day → per second
//   own-zeros   "500 million" → 5 × 10⁶ (500's own two zeros dropped)
//   ten-as-zero 10 × 10⁵ for a day; 5 × 10² read as 5,000
//   under-one   2 ÷ 2.5 answered 5 (it is 0.8)
//   bits-bytes  × 8 going bits → bytes; stopped at GB/s when Gbps was asked
//   wrong-unit  "TB" on a request count
//   comma       the ladder back: each comma knocked off = one unit up
//
// Pure and deterministic, like envelope.ts: no clock, no model, seeded PRNG.

import {
  ALL_KINDS,
  CONVERSION_KINDS,
  checkAnswer,
  fmt,
  itemNumberTokens,
  keySeed,
  numberTokens,
  pickSafe,
  parseAnswer,
  pow10,
  roundSig,
  sci,
  sup,
  type EnvelopeCause,
  type EnvelopeItem,
  type EnvelopeKind,
  type EnvelopeVerdict,
  type Per,
} from './envelope.js';

// -----------------------------------------------------------------------------
// Step types
// -----------------------------------------------------------------------------
export const STEP_TYPES = ['direction', 'split', 'small', 'exponent', 'back', 'unit'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_LABEL: Readonly<Record<StepType, string>> = {
  direction: 'Divide or multiply?',
  split: 'Small × 10ⁿ',
  small: 'Small-number math',
  exponent: 'Exponents',
  back: 'Back to a normal number',
  unit: 'Unit check',
};

export function isStepType(x: unknown): x is StepType {
  return typeof x === 'string' && (STEP_TYPES as readonly string[]).includes(x);
}

/** The named slips a step check can find. */
export type StepSlip =
  | 'direction'
  | 'own-zeros'
  | 'ten-as-zero'
  | 'not-small'
  | 'zeros'
  | 'under-one'
  | 'decimal'
  | 'flipped'
  | 'add-subtract'
  | 'comma'
  | 'bits-bytes'
  | 'wrong-unit'
  | 'wrong-period'
  | 'other';

// -----------------------------------------------------------------------------
// The plan: an item → its steps
// -----------------------------------------------------------------------------
export type StepExpect =
  | { kind: 'direction'; op: 'divide' | 'multiply'; from: string; to: string; bits: boolean }
  | { kind: 'split'; value: number; m: number; e: number; lead: { n: number; zeros: number; word: string; wordExp: number } | null; anchor: boolean }
  | { kind: 'small'; value: number; pairs: { a: number; b: number; op: '×' | '÷' }[] }
  | { kind: 'exponent'; value: number; terms: { e: number; op: '×' | '÷' }[] }
  | {
      kind: 'back';
      /** The answer, in the unit it is asked in. */
      value: number;
      small: number;
      exp: number;
      unitLabel: string;
      unitExp: number;
      dim: EnvelopeItem['expected']['dim'];
      /** The chain already counts in the target unit (KB → GB ladder items). */
      inUnit: boolean;
    }
  | { kind: 'unit' };

/**
 * Help shown on request, BEFORE answering, in two levels. Neither ever
 * carries this question's numbers or the step's answer: the nudge is a
 * question or rule with no numbers from the item, the example is the same
 * move worked on different numbers.
 */
export interface StepHint {
  nudge: string;
  example: string;
}

export interface GuidedStep {
  type: StepType;
  /** One short question. */
  prompt: string;
  /** Nudge first, then a worked example on other numbers. */
  hint: StepHint;
  /** The answer box's placeholder: the format, on numbers this item does not use. */
  placeholder: string;
  /** The right answer, shown only after the step is tried. Never served for a faded step. */
  answer: string;
  expect: StepExpect;
}

const SCALE_WORDS: readonly [RegExp, number][] = [
  [/^(trillion)\b/i, 12],
  [/^(billion)\b/i, 9],
  [/^(million)\b/i, 6],
  [/^(thousand)\b/i, 3],
  [/^(petabytes?|PB)\b/, 15],
  [/^(terabytes?|TB)\b/, 12],
  [/^(gigabytes?|GB)\b/, 9],
  [/^(megabytes?|MB)\b/, 6],
  [/^(kilobytes?|KB)\b/, 3],
  [/^(gigabits?)\b/i, 9],
];

/** "500 million requests" → {n: 500, zeros: 2, word: 'million', wordExp: 6}. */
export function leadOf(text: string): { n: number; zeros: number; word: string; wordExp: number } | null {
  const m = /^(\d+(?:\.\d+)?)\s+(\S+)/.exec(text.trim().replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  for (const [re, exp] of SCALE_WORDS) {
    const w = re.exec(m[2]);
    if (w) return { n, zeros: n >= 1 ? sci(n).e : 0, word: w[1], wordExp: exp };
  }
  return null;
}

const ANCHOR_ASK = /seconds in a|bits in a byte|days in a year|^1 [KMGTP]B, in bytes/;

const PER_ASKED: Readonly<Record<Per, string>> = { s: 'per second', day: 'per day', month: 'per month', year: 'per year' };

/** What the final answer must be in: "per second", "in TB", "in Gbps". */
export function wantText(item: Pick<EnvelopeItem, 'expected' | 'unit'>): string {
  const { dim, per } = item.expected;
  if (dim === 'count') return per ? `a count ${PER_ASKED[per]} (no data unit)` : 'a plain count';
  const u = dim === 'bits' && per === 's' ? `${item.unit.label}ps` : item.unit.label;
  return `in ${u}${per && !(dim === 'bits' && per === 's') ? ` ${PER_ASKED[per]}` : ''}`;
}

function unitExpOf(item: EnvelopeItem): number {
  return Math.round(Math.log10(item.unit.factor));
}

/**
 * Guided steps for an item, in the order the user learns them:
 * direction → each number as small × 10ⁿ → small math → exponents → back to a
 * normal number (comma method) → final answer with its unit. Null for items
 * that are not a small × 10ⁿ walk (quick kinds, base62 length, old cards).
 */
export function guidedPlan(item: EnvelopeItem): GuidedStep[] | null {
  if (!item.factors?.length || !item.move || item.family === 'quick' || item.exactInt) return null;
  const steps: GuidedStep[] = [];
  const mv = item.move;
  const bits = /bits|bytes/.test(`${mv.from} ${mv.to}`);
  steps.push({
    type: 'direction',
    prompt: `${mv.from} → ${mv.to}. Will the number get bigger or smaller? Type divide or multiply.`,
    hint: NO_HINT,
    placeholder: '',
    answer: mv.op,
    expect: { kind: 'direction', op: mv.op, from: mv.from, to: mv.to, bits },
  });

  const ms = item.factors.map((f) => ({ f, ...sci(f.value) }));
  for (const { f, m, e } of ms) {
    const ask = f.ask ?? f.label;
    const lead = leadOf(f.label);
    const anchor = ANCHOR_ASK.test(ask);
    steps.push({
      type: 'split',
      prompt: `Write ${ask} as small × 10ⁿ.`,
      hint: NO_HINT,
      placeholder: '',
      answer: e === 0 ? fmt(m) : m === 1 ? pow10(e) : `${fmt(m)} × ${pow10(e)}`,
      expect: { kind: 'split', value: f.value, m, e, lead: lead && lead.zeros > 0 ? lead : null, anchor },
    });
  }

  // Small numbers, left to right, as the worked split does.
  let small = ms[0].m;
  let text = fmt(ms[0].m);
  let exp = ms[0].e;
  let zText = pow10(ms[0].e);
  const pairs: { a: number; b: number; op: '×' | '÷' }[] = [];
  const terms: { e: number; op: '×' | '÷' }[] = [{ e: ms[0].e, op: '×' }];
  for (const x of ms.slice(1)) {
    const op = x.f.op;
    pairs.push({ a: roundSig(small, 3), b: x.m, op });
    small = op === '×' ? small * x.m : small / x.m;
    text += ` ${op} ${fmt(x.m)}`;
    exp = op === '×' ? exp + x.e : exp - x.e;
    zText += ` ${op} ${pow10(x.e)}`;
    terms.push({ e: x.e, op });
  }
  small = roundSig(small, 3);
  if (ms.length > 1) {
    steps.push({
      type: 'small',
      prompt: `Small numbers only: ${text} = ?`,
      hint: NO_HINT,
      placeholder: '',
      answer: fmt(small),
      expect: { kind: 'small', value: small, pairs },
    });
    steps.push({
      type: 'exponent',
      prompt: `Exponents: ${zText} = 10 to the what? (type the little number)`,
      hint: NO_HINT,
      placeholder: '',
      answer: String(exp),
      expect: { kind: 'exponent', value: exp, terms },
    });
  }

  // Back to a normal number, in the unit the answer is shown in.
  const unitExp = item.expected.dim === 'count' ? 0 : unitExpOf(item);
  const dim = item.expected.dim;
  const base = dim === 'count' ? '' : ` ${dim}`;
  const inUnit = item.kind === 'ladder';
  const valueInUnit = inUnit ? small * 10 ** exp : (small * 10 ** exp) / 10 ** unitExp;
  steps.push({
    type: 'back',
    prompt:
      dim === 'count'
        ? `Write ${fmt(small)} × ${pow10(exp)} as a normal number.`
        : inUnit
          ? `Write ${fmt(small)} × ${pow10(exp)} as a normal number. That is how many ${item.unit.label}.`
          : `Write ${fmt(small)} × ${pow10(exp)}${base} in ${item.unit.label}.`,
    hint: NO_HINT,
    placeholder: '',
    answer: dim === 'count' ? commaNumber(valueInUnit) : `${fmt(valueInUnit, 3)} ${item.unit.label}`,
    expect: { kind: 'back', value: valueInUnit, small, exp, unitLabel: item.unit.label, unitExp, dim, inUnit },
  });

  steps.push({
    type: 'unit',
    prompt: `Final answer, ${wantText(item)}. Write the unit too.`,
    hint: NO_HINT,
    placeholder: '',
    answer: item.answerText.replace(/^≈ /, ''),
    expect: { kind: 'unit' },
  });
  return withHints(item, steps);
}

// -----------------------------------------------------------------------------
// Hints: a nudge, then a worked example on OTHER numbers
// -----------------------------------------------------------------------------
// The user is learning: a hint that does the step for them teaches nothing.
// The nudge names the move with no numbers from the item; the example works
// the same move on numbers picked (from a small bank) to differ from every
// number this item uses: its factors, its final answer and every step's answer.

const NO_HINT: StepHint = { nudge: '', example: '' };

/** Rates: hours, minutes, weeks and money, never the seconds/days/months/years the questions use. */
const RATE_EXAMPLES = [
  'Example: 3 km a minute → per hour. An hour piles up 60 minutes, so bigger: × 60.',
  'Example: $36k a year → per month. Spread over 12 months, so smaller: ÷ 12.',
  'Example: 5 km a day → per week. A week piles up 7 days, so bigger: × 7.',
  'Example: 120 km an hour → per minute. Spread over 60 minutes, so smaller: ÷ 60.',
  'Example: $70 a week → per day. Spread over 7 days, so smaller: ÷ 7.',
  'Example: 4 litres a minute → per hour. The minutes pile up, so bigger: × 60.',
];
/** Sizes: centimetres and dozens, never bits or bytes. */
const SIZE_EXAMPLES = [
  'Example: 300 cm → metres. A metre is a bigger box, so fewer of them: ÷ 100.',
  'Example: 4 metres → cm. A cm is a smaller box, so more of them: × 100.',
  'Example: 5 dozen eggs → eggs. An egg is a smaller box, so more of them: × 12.',
  'Example: 36 eggs → dozens. A dozen is a bigger box, so fewer of them: ÷ 12.',
];
const SPLIT_WORD_EXAMPLES = [
  'Example: 300 thousand. 300 = 3 × 10², thousand = 10³, so 3 × 10⁵.',
  'Example: 40 billion. 40 = 4 × 10¹, billion = 10⁹, so 4 × 10¹⁰.',
  'Example: 700 million. 700 = 7 × 10², million = 10⁶, so 7 × 10⁸.',
  'Example: 90 thousand. 90 = 9 × 10¹, thousand = 10³, so 9 × 10⁴.',
  'Example: 600 KB. 600 = 6 × 10², KB = 10³ bytes, so 6 × 10⁵ bytes.',
  'Example: 30 TB. 30 = 3 × 10¹, TB = 10¹² bytes, so 3 × 10¹³ bytes.',
  'Example: 80 million. 80 = 8 × 10¹, million = 10⁶, so 8 × 10⁷.',
  'Example: 70 GB. 70 = 7 × 10¹, GB = 10⁹ bytes, so 7 × 10¹⁰ bytes.',
  'Example: 900 MB. 900 = 9 × 10², MB = 10⁶ bytes, so 9 × 10⁸ bytes.',
  'Example: 7 billion. 7 is already small, billion = 10⁹, so 7 × 10⁹.',
  'Example: 4.5 million. 4.5 is already small, million = 10⁶, so 4.5 × 10⁶.',
];
const SPLIT_PLAIN_EXAMPLES = [
  'Example: 70,000 = 7 × 10⁴ (four zeros after the 7).',
  'Example: 3,000 = 3 × 10³ (three zeros after the 3).',
  'Example: 900 = 9 × 10² (two zeros after the 9).',
  'Example: 4,000,000 = 4 × 10⁶ (six zeros after the 4).',
  'Example: 45,000 = 4.5 × 10⁴ (four places after the 4).',
  'Example: 7.5 is already between 1 and 10, so it stays 7.5.',
];
const SPLIT_ANCHOR_EXAMPLES = [
  'Example: seconds in an hour = 3,600 ≈ 4 × 10³ (round it to keep the math easy).',
  'Example: inches in a foot = 12 = 1.2 × 10¹.',
  'Example: days in a week = 7, already between 1 and 10, so just 7.',
  'Example: minutes in a day = 1,440 ≈ 1.5 × 10³ (round it).',
];
const SMALL_TIMES_EXAMPLES = [
  'Example: 3 × 4 = 12.',
  'Example: 1.5 × 6 = 9.',
  'Example: 7 × 3 = 21.',
  'Example: 6 × 7 = 42.',
  'Example: 4.5 × 3 = 13.5.',
  'Example: 7 × 9 = 63.',
  'Example: 9 × 9 = 81.',
  'Example: 7 × 7 × 1.5 = 49 × 1.5 = 73.5.',
];
const SMALL_DIVIDE_EXAMPLES = [
  'Example: 9 ÷ 3 = 3.',
  'Example: 3 ÷ 4 = 0.75 (the top is smaller, so under 1).',
  'Example: 6 ÷ 1.5 = 4.',
  'Example: 1.5 ÷ 6 = 0.25 (the top is smaller, so under 1).',
  'Example: 7 × 3 ÷ 7 = 21 ÷ 7 = 3.',
  'Example: 9 ÷ 4.5 = 2.',
];
// Superscripts only: the worked sums never spell the step's answer in plain digits.
const EXP_TIMES_EXAMPLES = [
  'Example: 10⁴ × 10³ = 10⁴⁺³ = 10⁷.',
  'Example: 10⁶ × 10² = 10⁶⁺² = 10⁸.',
  'Example: 10³ × 10⁹ = 10³⁺⁹ = 10¹².',
  'Example: 10² × 10³ = 10²⁺³ = 10⁵.',
  'Example: 10⁷ × 10⁴ = 10⁷⁺⁴ = 10¹¹.',
  'Example: 10⁸ × 10⁹ = 10⁸⁺⁹ = 10¹⁷.',
  'Example: 10¹¹ × 10² = 10¹¹⁺² = 10¹³.',
  'Example: 10⁹ × 10⁷ = 10⁹⁺⁷ = 10¹⁶.',
];
const EXP_DIVIDE_EXAMPLES = [
  'Example: 10⁹ ÷ 10⁴ = 10⁹⁻⁴ = 10⁵.',
  'Example: 10⁸ ÷ 10³ = 10⁸⁻³ = 10⁵.',
  'Example: 10³ ÷ 10⁶ = 10³⁻⁶ = 10⁻³.',
  'Example: 10¹² ÷ 10⁴ = 10¹²⁻⁴ = 10⁸.',
  'Example: 10⁶ × 10³ ÷ 10⁴ = 10⁶⁺³⁻⁴ = 10⁵.',
  'Example: 10¹¹ ÷ 10⁷ = 10¹¹⁻⁷ = 10⁴.',
  'Example: 10⁹ ÷ 10² = 10⁹⁻² = 10⁷.',
  'Example: 10¹¹ ÷ 10⁹ = 10¹¹⁻⁹ = 10².',
  'Example: 10¹³ ÷ 10⁷ = 10¹³⁻⁷ = 10⁶.',
  'Example: 10² ÷ 10⁷ = 10²⁻⁷ = 10⁻⁵.',
  'Example: 10¹⁰ × 10² ÷ 10⁷ = 10¹⁰⁺²⁻⁷ = 10⁵.',
  'Example: 10¹⁴ ÷ 10¹¹ = 10¹⁴⁻¹¹ = 10³.',
];
const BACK_COUNT_EXAMPLES = [
  'Example: 7 × 10⁴ = 70,000.',
  'Example: 3.5 × 10³ = 3,500.',
  'Example: 4 × 10⁶ = 4,000,000 (4 million).',
  'Example: 9 × 10² = 900.',
  'Example: 0.3 × 10⁴ = 3,000.',
  'Example: 4.5 × 10⁻³ = 0.0045 (minus: move left).',
];
const BACK_BYTE_EXAMPLES = [
  'Example: 7 × 10⁶ bytes = 7,000,000 bytes. Two commas off: 7 MB.',
  'Example: 3 × 10⁹ bytes = 3,000,000,000 bytes. Three commas off: 3 GB.',
  'Example: 6 × 10⁵ bytes = 600,000 bytes. One comma off: 600 KB.',
  'Example: 4 × 10¹² bytes = 4,000,000,000,000 bytes. Four commas off: 4 TB.',
  'Example: 9 × 10¹⁰ bytes = 90,000,000,000 bytes. Three commas off: 90 GB.',
];
const BACK_BIT_EXAMPLES = [
  'Example: 7 × 10⁶ bits = 7,000,000 bits. Two commas off: 7 Mb.',
  'Example: 3 × 10⁹ bits = 3,000,000,000 bits. Three commas off: 3 Gb.',
  'Example: 5 × 10⁴ bits = 50,000 bits. One comma off: 50 Kb.',
  'Example: 6 × 10¹¹ bits = 600,000,000,000 bits. Three commas off: 600 Gb.',
];
const UNIT_COUNT_EXAMPLES = [
  'Example: asked for a count per second → "300 per second" (no bytes on a count).',
  'Example: asked for a count per day → "7 million a day".',
  'Example: asked for a plain count → "4,000" (no unit to add).',
];
const UNIT_BYTE_EXAMPLES = [
  'Example: asked in TB → "30 TB".',
  'Example: asked in MB per second → "70 MB per second".',
  'Example: asked in GB → "900 GB".',
  'Example: asked in PB → "7 PB".',
];
const UNIT_BIT_EXAMPLES = ['Example: asked in Gbps → "6 Gbps" (bits, not GB/s).', 'Example: asked in Mbps → "300 Mbps" (bits, not MB/s).'];

const STEP_PLACEHOLDERS: Readonly<Record<StepType, readonly string[]>> = {
  direction: ['divide or multiply'],
  split: ['e.g. 7 x 10^4', 'e.g. 3 x 10^6', 'e.g. 9 x 10^2', 'e.g. 4 x 10^11', 'e.g. 7 x 10^13'],
  small: ['e.g. 0.75', 'e.g. 4.5', 'e.g. 13.5', 'e.g. 0.25', 'e.g. 7.5'],
  exponent: ['the little number, e.g. 4', 'the little number, e.g. 7', 'the little number, e.g. 11', 'the little number, e.g. 6'],
  back: ['e.g. 70,000 or 3 TB', 'e.g. 4,000 or 6 GB', 'e.g. 900 or 7 MB', 'e.g. 60,000 or 9 TB'],
  unit: ['e.g. 300 per second, 7 TB, 9 Gbps', 'e.g. 40 per second, 3 TB, 6 Gbps', 'e.g. 900 a day, 5 GB, 7 Gbps', 'e.g. 70 per second, 9 TB, 4 Gbps'],
};
/** When every bank entry collides: the format in words, no numbers at all. */
const PLACEHOLDER_WORDS: Readonly<Record<StepType, string>> = {
  direction: 'divide or multiply',
  split: 'small x 10^n',
  small: 'a number',
  exponent: 'the little number',
  back: 'a normal number (a unit if asked)',
  unit: 'a number, then its unit',
};

const SIZE_UNIT = /\b(bits?|bytes?|[KMGTP]B|[KMGT]b)\b/;

/** The scale word a split's number is written with ("2 billion page views" → "billion"), if any. */
function scaleWord(s: GuidedStep): string | null {
  return leadOf(s.prompt.replace(/^Write /, ''))?.word ?? null;
}

function nudgeFor(s: GuidedStep): string {
  const x = s.expect;
  switch (x.kind) {
    case 'direction':
      if (x.bits) return 'Which piece is smaller, a bit or a byte? Smaller pieces → more of them. Bigger or smaller tells you which.';
      if (SIZE_UNIT.test(`${x.from} ${x.to}`)) return 'Is the unit you end in a bigger box or a smaller box? Bigger boxes → fewer of them.';
      return 'Are you spreading a total over more slices (each gets less), or piling slices up (more)? Bigger or smaller tells you which.';
    case 'split':
      if (x.anchor) return 'This is an anchor fact (see Anchor cards). Recall it, round it, then write it as small × 10ⁿ.';
      if (x.lead) return `Which part is the "${x.lead.word}"? Write the front number as small × 10ⁿ first, then add the little numbers.`;
      if (scaleWord(s)) return `Which part is the "${scaleWord(s)}"? Turn it into 10ⁿ, then put the front number in front.`;
      return 'Count all the zeros. Keep the front number between 1 and 10.';
    case 'small':
      return 'Just the front numbers, left to right; leave the 10ⁿ parts for the next step. Dividing by a bigger number gives under 1.';
    case 'exponent':
      return 'Look at each sign: × means add the little numbers, ÷ means subtract them.';
    case 'back':
      if (x.dim === 'count' || x.inUnit) return 'Move the decimal point right by the little number (left if it is minus), filling with zeros. Then add commas.';
      return `First write it out in plain ${x.dim}. Then knock off commas: each comma = one unit up (${x.dim === 'bits' ? 'bits → Kb → Mb → Gb' : 'bytes → KB → MB → GB → TB'}).`;
    case 'unit':
      return 'Read what the question asks for: per second? bytes or bits? a plain count? Number first, then that unit.';
  }
}

function exampleBank(s: GuidedStep): readonly string[] {
  const x = s.expect;
  switch (x.kind) {
    case 'direction':
      return x.bits || SIZE_UNIT.test(`${x.from} ${x.to}`) ? SIZE_EXAMPLES : RATE_EXAMPLES;
    case 'split':
      return x.anchor ? SPLIT_ANCHOR_EXAMPLES : x.lead || scaleWord(s) ? SPLIT_WORD_EXAMPLES : SPLIT_PLAIN_EXAMPLES;
    case 'small':
      return x.pairs.some((p) => p.op === '÷') ? SMALL_DIVIDE_EXAMPLES : SMALL_TIMES_EXAMPLES;
    case 'exponent':
      return x.terms.some((t) => t.op === '÷') ? EXP_DIVIDE_EXAMPLES : EXP_TIMES_EXAMPLES;
    case 'back':
      return x.dim === 'count' || x.inUnit ? BACK_COUNT_EXAMPLES : x.dim === 'bits' ? BACK_BIT_EXAMPLES : BACK_BYTE_EXAMPLES;
    case 'unit': {
      const dim = s.answer.match(/\b[KMGT]bps\b/) ? 'bits' : null;
      return dim === 'bits' ? UNIT_BIT_EXAMPLES : /\b(bytes?|[KMGTP]B)\b/.test(s.answer) ? UNIT_BYTE_EXAMPLES : UNIT_COUNT_EXAMPLES;
    }
  }
}

/**
 * Fill each step's hint and placeholder, avoiding every number the item and
 * its steps use. The direction step's answer is a word and the exponent's a
 * bare little number; those are avoided in their own step's help only.
 */
function withHints(item: EnvelopeItem, steps: GuidedStep[]): GuidedStep[] {
  const shared = itemNumberTokens(
    item,
    steps.filter((s) => s.type !== 'direction' && s.type !== 'exponent').map((s) => s.answer)
  );
  const exp = steps.find((s) => s.expect.kind === 'exponent')?.expect;
  if (exp?.kind === 'exponent') shared.push(...numberTokens(pow10(exp.value)));
  const seed = keySeed(item.key);
  return steps.map((s, i) => {
    const own = s.type === 'exponent' ? [...shared, ...numberTokens(s.answer)] : shared;
    const ok = (t: string) => (s.type === 'direction' ? !t.toLowerCase().includes(s.answer) : true);
    const example = pickSafe(exampleBank(s).filter(ok), own, seed + i);
    const placeholder = pickSafe(STEP_PLACEHOLDERS[s.type], own, seed + i) || PLACEHOLDER_WORDS[s.type];
    return { ...s, hint: { nudge: nudgeFor(s), example }, placeholder };
  });
}

/** 500 → "500"; 2.5e7 → "25,000,000 (25 million)". */
function commaNumber(x: number): string {
  const r = roundSig(x, 3);
  if (r >= 1e6) {
    const words: [number, string][] = [
      [1e12, 'trillion'],
      [1e9, 'billion'],
      [1e6, 'million'],
    ];
    const [d, w] = words.find(([d]) => r >= d)!;
    return `${Math.round(r).toLocaleString('en-US')} (${fmt(r / d, 3)} ${w})`;
  }
  return r >= 1000 ? Math.round(r).toLocaleString('en-US') : String(r);
}

// -----------------------------------------------------------------------------
// Step checkers
// -----------------------------------------------------------------------------
export interface StepResult {
  ok: boolean;
  slip: StepSlip | null;
  /** One or two short sentences naming the slip (or a short "yes"). */
  feedback: string;
  /** For the final step: the graded verdict and the attempt's cause. */
  verdict?: EnvelopeVerdict;
  cause?: EnvelopeCause | null;
}

/** "5 × 10^8", "5x10⁸", "5e8", "10^5", "500" → {m, e} as typed (m not normalized). */
export function parseSci(text: string): { m: number; e: number; value: number } | null {
  const t = text
    .trim()
    .replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (s) => `^${unsup(s)}`)
    .replace(/,(?=\d{3}\b)/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^(-?\d*\.?\d+)\s*(?:x|×|\*|·)?\s*10\s*\^\s*\(?(-?\d+)\)?$/i.exec(t))) return mk(Number(m[1]), Number(m[2]));
  if ((m = /^10\s*\^\s*\(?(-?\d+)\)?$/.exec(t))) return mk(1, Number(m[1]));
  if ((m = /^(-?\d*\.?\d+)\s*e\s*([+-]?\d+)$/i.exec(t))) return mk(Number(m[1]), Number(m[2]));
  if ((m = /^(-?\d*\.?\d+)$/.exec(t))) {
    const v = Number(m[1]);
    const s = sci(v);
    return { m: s.m, e: s.e, value: v };
  }
  return null;
  function mk(mm: number, e: number) {
    return Number.isFinite(mm) ? { m: mm, e, value: mm * 10 ** e } : null;
  }
}

const SUPS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const unsup = (s: string) => s.replace(/⁻/g, '-').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String(SUPS.indexOf(c)));

const close = (a: number, b: number, tol = 0.02) => b !== 0 && Math.abs(a / b - 1) <= tol;
const isPow10 = (x: number) => x > 0 && Math.abs(Math.log10(x) - Math.round(Math.log10(x))) < 1e-9;
const say = (s: { m: number; e: number }) => (s.m === 1 ? pow10(s.e) : `${fmt(s.m)} × ${pow10(s.e)}`);

const ONE = (op: 'divide' | 'multiply') => (op === 'divide' ? 'divide' : 'multiply');

function checkDirectionStep(x: Extract<StepExpect, { kind: 'direction' }>, text: string): StepResult {
  const t = text.trim().toLowerCase();
  const d = /^(div|÷|\/)/.test(t) ? 'divide' : /^(mul|times|×|x\b|\*)/.test(t) ? 'multiply' : null;
  if (!d) return { ok: false, slip: 'other', feedback: 'Type one word: divide or multiply.' };
  if (d === x.op) return { ok: true, slip: null, feedback: `Yes: ${ONE(x.op)}.` };
  if (x.bits) {
    return {
      ok: false,
      slip: 'bits-bytes',
      feedback:
        x.op === 'divide'
          ? 'Bits are tiny pieces, 8 per byte. Going to bytes means fewer of them, so ÷ 8 (not × 8).'
          : 'Bits are tiny pieces, 8 per byte. Going to bits means more of them, so × 8 (not ÷ 8).',
    };
  }
  return {
    ok: false,
    slip: 'direction',
    feedback:
      x.op === 'divide'
        ? `${x.from} → ${x.to} spreads the same total over many more slices, so each slice is smaller: divide. Like $100k a year → per day: divide.`
        : `${x.from} → ${x.to} piles many slices together, so the total is bigger: multiply. Like $300 a day → per year: multiply.`,
  };
}

function checkSplitStep(x: Extract<StepExpect, { kind: 'split' }>, text: string): StepResult {
  const p = parseSci(text);
  const right = say(x);
  if (!p) return { ok: false, slip: 'other', feedback: `Write it like 5 × 10^8. Here: ${right}.` };
  const valueOk = close(p.value, x.value);
  const smallOk = Math.abs(p.m) >= 1 && Math.abs(p.m) < 10;
  if (valueOk && smallOk) return { ok: true, slip: null, feedback: `Yes: ${right}.` };
  // "10 × 10⁵" for a day: the 0 in "10" counted as one more zero.
  if (isPow10(p.m) && p.m >= 10 && close(p.value, x.value * p.m)) {
    return {
      ok: false,
      slip: 'ten-as-zero',
      feedback: `The 0 in "10" is not an extra zero. 10ⁿ = 1 followed by n zeros in total, so the little number is the total zero count: ${right}.`,
    };
  }
  if (valueOk && !smallOk) {
    return {
      ok: false,
      slip: 'not-small',
      feedback: `Right size, but keep the front number between 1 and 10 (move its zeros into the little number): ${right}.`,
    };
  }
  // "500 million" → 5 × 10⁶: the front number's own zeros were dropped.
  if (x.lead && close(p.value * 10 ** x.lead.zeros, x.value)) {
    const l = x.lead;
    const ls = sci(l.n);
    return {
      ok: false,
      slip: 'own-zeros',
      feedback: `You dropped ${fmt(l.n)}'s own zeros. Split it first: ${fmt(l.n)} = ${fmt(ls.m)} × ${pow10(l.zeros)}, and ${l.word} = ${pow10(l.wordExp)}, so ${fmt(ls.m)} × ${pow10(l.zeros)} × ${pow10(l.wordExp)} = ${right}.`,
    };
  }
  const ratio = p.value / x.value;
  if (isPow10(ratio) || isPow10(1 / ratio)) {
    return {
      ok: false,
      slip: 'zeros',
      feedback: `Count the zeros again: ${Math.round(x.value).toLocaleString('en-US')} has ${x.e} zeros after the ${fmt(x.m)}, so it is ${right}.`,
    };
  }
  return { ok: false, slip: 'other', feedback: `Not quite: it is ${right}.` };
}

function checkSmallStep(x: Extract<StepExpect, { kind: 'small' }>, text: string): StepResult {
  const p = parseAnswer(text);
  const want = fmt(x.value);
  if (!p) return { ok: false, slip: 'other', feedback: `Type a number. It is ${want}.` };
  const g = p.number;
  if (close(g, x.value, 0.04)) return { ok: true, slip: null, feedback: `Yes: ${want}.` };
  // 2 ÷ 2.5 answered 5: a small number over a bigger one is under 1.
  const under = x.pairs.find((q) => q.op === '÷' && q.a < q.b);
  if (under && x.value < 1 && g >= 1) {
    return {
      ok: false,
      slip: 'under-one',
      feedback: `${fmt(under.a)} ÷ ${fmt(under.b)}: the top number is smaller than the bottom, so the answer is under 1. ${fmt(under.a)} ÷ ${fmt(under.b)} = ${fmt(roundSig(under.a / under.b, 3))} (${fmt(under.a)} dollars split ${fmt(under.b)} ways is less than a dollar each).`,
    };
  }
  if (close(g, 1 / x.value, 0.04) && x.pairs.some((q) => q.op === '÷')) {
    return { ok: false, slip: 'flipped', feedback: `That is the division upside down. Keep the order as written: it is ${want}.` };
  }
  if (close(g, x.value * 10, 0.04) || close(g, x.value / 10, 0.04)) {
    return { ok: false, slip: 'decimal', feedback: `The decimal point slipped one place: it is ${want}.` };
  }
  return { ok: false, slip: 'other', feedback: `Not quite: it is ${want}.` };
}

function checkExponentStep(x: Extract<StepExpect, { kind: 'exponent' }>, text: string): StepResult {
  // "2", "10^2", "10²" all mean the little number 2.
  const supers = /[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/.exec(text);
  const m = supers
    ? [unsup(supers[0])]
    : /-?\d+/.exec(text.replace(/^\s*10\s*\^\s*/, ''));
  if (!m) return { ok: false, slip: 'other', feedback: `Type the little number. It is ${x.value}.` };
  const g = Number(m[0]);
  if (g === x.value) return { ok: true, slip: null, feedback: `Yes: 10${sup(x.value)}.` };
  const allAdded = x.terms.reduce((s, t) => s + t.e, 0);
  const sums = x.terms.map((t, i) => `${i === 0 ? '' : t.op === '×' ? ' + ' : ' − '}${t.e}`).join('');
  if (g === allAdded && x.terms.some((t) => t.op === '÷')) {
    return { ok: false, slip: 'add-subtract', feedback: `Dividing means subtract the little numbers, not add: ${sums} = ${x.value}.` };
  }
  return { ok: false, slip: 'other', feedback: `Multiply → add, divide → subtract: ${sums} = ${x.value}.` };
}

const BYTE_UP = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
const BIT_UP = ['bits', 'Kb', 'Mb', 'Gb', 'Tb'];

function checkBackStep(x: Extract<StepExpect, { kind: 'back' }>, text: string): StepResult {
  const p = parseAnswer(text);
  const want = x.dim === 'count' ? commaNumber(x.value) : `${fmt(x.value, 3)} ${x.unitLabel}`;
  if (!p) return { ok: false, slip: 'other', feedback: `Type a number. It is ${want}.` };
  if (x.dim !== 'count' && p.dim && p.dim !== x.dim) {
    return { ok: false, slip: 'bits-bytes', feedback: `Stay in ${x.dim} here (the unit check comes next): ${want}.` };
  }
  // A typed unit prefix (8 TB, 8000 GB) is honored; a bare number is read in the target unit.
  const g = x.dim === 'count' ? p.number * p.prefix : p.dim ? (p.number * p.prefix) / 10 ** x.unitExp : p.number;
  if (close(g, x.value, 0.04)) return { ok: true, slip: null, feedback: `Yes: ${want}.` };
  const ratio = g / x.value;
  const k = Math.round(Math.log10(ratio));
  const clean = Math.abs(Math.log10(ratio) - k) < 0.02 && k !== 0;
  const raw = x.small * 10 ** x.exp;
  const rawUnit = x.dim === 'count' ? '' : x.inUnit ? ` ${x.unitLabel}` : ` ${x.dim}`;
  const rawText = (v: number) => (v >= 1 ? Math.round(v).toLocaleString('en-US') : fmt(v));
  // 5 × 10² read as 5,000: one zero too many (or too few).
  if (clean && Math.abs(k) <= 2) {
    return {
      ok: false,
      slip: 'ten-as-zero',
      feedback: `${pow10(x.exp)} is 1 followed by ${x.exp} zero${x.exp === 1 ? '' : 's'} in total (the little number is the total zero count), so ${fmt(x.small)} × ${pow10(x.exp)} = ${rawText(raw)}${rawUnit}, not ${rawText(raw * ratio)}.`,
    };
  }
  const baseValue = x.value * 10 ** x.unitExp;
  if (clean && k % 3 === 0) {
    const n = x.unitExp / 3;
    const ladder = x.dim === 'bits' ? BIT_UP : BYTE_UP;
    return {
      ok: false,
      slip: 'comma',
      feedback:
        x.dim === 'count'
          ? `Comma slip. Write it out: ${Math.round(raw).toLocaleString('en-US')}. Each comma is one word up (thousand → million → billion). It is ${want}.`
          : `Comma slip. Write it out: ${Math.round(baseValue).toLocaleString('en-US')} ${x.dim}. Each comma knocked off = one unit up (${ladder.slice(0, n + 1).join(' → ')}): knock off ${n} → ${want}.`,
    };
  }
  return { ok: false, slip: 'zeros', feedback: `Not quite: ${fmt(x.small)} × ${pow10(x.exp)} is ${want}.` };
}

/**
 * The last step: the answer itself. Graded by checkAnswer (so the attempt
 * agrees with the plain mode), plus the unit rules plain mode leaves to the
 * estimate: a count carries no TB, Gbps is not GB/s, and the period asked.
 */
export function checkFinalStep(item: EnvelopeItem, text: string): StepResult | null {
  const v = checkAnswer(item, text);
  const p = parseAnswer(text);
  if (!v || !p) return null;
  const want = item.expected;
  if (want.dim === 'count' && p.dim) {
    return {
      ok: false,
      slip: 'wrong-unit',
      feedback: `This is a count, not data, so no ${p.dim === 'bits' ? 'bits' : 'bytes/TB'} on it. Finish in what was asked: ${wantText(item)}.`,
      verdict: { ...v, ok: false },
      cause: 'wrong-unit',
    };
  }
  if (want.dim === 'bits' && p.dim === 'bytes') {
    return {
      ok: false,
      slip: 'bits-bytes',
      feedback: `The question asks for ${item.unit.label}ps (bits). You stopped at bytes: × 8 to get bits (to bits = more = × 8). Anchor: 1 Gbps ≈ 125 MB/s.`,
      verdict: { ...v, ok: false },
      cause: 'bits-bytes',
    };
  }
  if (want.dim === 'bytes' && p.dim === 'bits') {
    return {
      ok: false,
      slip: 'bits-bytes',
      feedback: `The question asks for bytes. Bits are 8 to a byte, so to bytes = fewer = ÷ 8.`,
      verdict: { ...v, ok: false },
      cause: 'bits-bytes',
    };
  }
  if (p.per && p.per !== want.per && !(want.per === null && p.per === 'year')) {
    return {
      ok: false,
      slip: 'wrong-period',
      feedback: `The question asks ${want.per ? PER_ASKED[want.per] : 'for the total'}. Finish there.`,
      verdict: { ...v, ok: false },
      cause: 'wrong-unit',
    };
  }
  if (v.ok) return { ok: true, slip: null, feedback: `Yes: ${item.answerText.replace(/^≈ /, '≈ ')}.`, verdict: v, cause: null };
  const slip: StepSlip = v.cause === 'bits-bytes' ? 'bits-bytes' : v.cause === 'unit-ladder' ? 'comma' : v.cause === 'zeros' ? 'zeros' : 'other';
  return {
    ok: false,
    slip,
    feedback: `${v.verdict} ${v.causeText ?? ''} The answer: ${item.answerText}.`.replace(/\s+/g, ' ').trim(),
    verdict: v,
    cause: v.cause,
  };
}

/** Check one non-final step. Pure. */
export function checkStep(step: GuidedStep, text: string): StepResult {
  const x = step.expect;
  switch (x.kind) {
    case 'direction':
      return checkDirectionStep(x, text);
    case 'split':
      return checkSplitStep(x, text);
    case 'small':
      return checkSmallStep(x, text);
    case 'exponent':
      return checkExponentStep(x, text);
    case 'back':
      return checkBackStep(x, text);
    case 'unit':
      return { ok: false, slip: 'other', feedback: 'The final step is graded with the item.' };
  }
}

/** A step slip → the attempt cause it is filed under (one vocabulary for Reflect). */
export const SLIP_CAUSE: Readonly<Record<StepSlip, EnvelopeCause>> = {
  direction: 'direction',
  'own-zeros': 'own-zeros',
  'ten-as-zero': 'zeros',
  'not-small': 'zeros',
  zeros: 'zeros',
  'under-one': 'arithmetic',
  decimal: 'arithmetic',
  flipped: 'arithmetic',
  'add-subtract': 'zeros',
  comma: 'unit-ladder',
  'bits-bytes': 'bits-bytes',
  'wrong-unit': 'wrong-unit',
  'wrong-period': 'wrong-unit',
  other: 'arithmetic',
};

// -----------------------------------------------------------------------------
// Faded scaffolding
// -----------------------------------------------------------------------------
/** A step type fades (you do it in your head) after this many right in a row; a miss brings it back. */
export const FADE_AFTER = 3;

/** Step types that can fade. The final answer is always asked. */
export const FADEABLE: readonly StepType[] = ['direction', 'split', 'small', 'exponent', 'back'];

/** Current right-in-a-row per step type; rows NEWEST FIRST. */
export function stepStreaks(rows: readonly { type: string; ok: boolean }[]): Record<StepType, number> {
  const out = Object.fromEntries(STEP_TYPES.map((t) => [t, 0])) as Record<StepType, number>;
  const closed = new Set<string>();
  for (const r of rows) {
    if (!isStepType(r.type) || closed.has(r.type)) continue;
    if (r.ok) out[r.type] += 1;
    else closed.add(r.type);
  }
  return out;
}

export function fadedTypes(streaks: Readonly<Record<StepType, number>>): Set<StepType> {
  return new Set(FADEABLE.filter((t) => streaks[t] >= FADE_AFTER));
}

/** The step types a final-answer miss points at. */
const CAUSE_STEPS: Readonly<Record<EnvelopeCause, StepType[]>> = {
  'month-for-day': ['split'],
  'bits-bytes': ['direction', 'split'],
  'unit-ladder': ['back'],
  zeros: ['split', 'exponent', 'back'],
  arithmetic: ['small'],
  direction: ['direction'],
  'own-zeros': ['split'],
  'wrong-unit': [],
};

/**
 * A final miss in guided mode: which faded step types come back. Only the
 * ones the miss points at; with no cause (a restated period), none.
 */
export function unfadeOnMiss(cause: EnvelopeCause | null, faded: ReadonlySet<StepType>): StepType[] {
  if (!cause) return [];
  return CAUSE_STEPS[cause].filter((t) => faded.has(t));
}

/**
 * The steps as served. Fading removes the help, not the work: a faded step
 * carries no answer, prompt, hint or placeholder (the `back` prompt alone is the final answer
 * in small × 10ⁿ form), only that it exists. A prompt still asked may show
 * values from faded steps; `back` is then all that stands before the answer.
 */
export function servedSteps(plan: readonly GuidedStep[], faded: ReadonlySet<StepType>): GuidedStepPrompt[] {
  return plan.map((s, index) => {
    const auto = faded.has(s.type);
    return {
      index,
      type: s.type,
      label: STEP_LABEL[s.type],
      prompt: auto ? '' : s.prompt,
      hint: auto ? null : s.hint,
      placeholder: auto ? '' : s.placeholder,
      auto,
    };
  });
}

/**
 * Does this step's right answer, revealed after a miss, hand over the final
 * number? `back` always does; `small` does when the exponent lands exactly on
 * the unit (2 × 8 = 16 → 16 Gbps).
 */
export function revealsFinal(step: GuidedStep, plan: readonly GuidedStep[]): boolean {
  if (step.expect.kind === 'back') return true;
  if (step.expect.kind !== 'small') return false;
  const back = plan.find((s) => s.expect.kind === 'back')?.expect;
  return back?.kind === 'back' && close(step.expect.value, back.value, 0.04);
}

// -----------------------------------------------------------------------------
// Anchor flashcards (~10 s each, SRS'd)
// -----------------------------------------------------------------------------
export const ANCHOR_SECONDS = 10;

export interface AnchorCard {
  id: string;
  front: string;
  /** Shown after answering. */
  back: string;
  /** A number within `tol`, or one of `words`. */
  value?: number;
  tol?: number;
  /** Extra numbers accepted (86,400 for a day). */
  also?: number[];
  words?: RegExp;
}

export const ANCHOR_CARDS: readonly AnchorCard[] = [
  { id: 'day', front: 'A day ≈ how many seconds?', back: '≈ 10⁵ (100,000; exactly 86,400)', value: 1e5, tol: 0.05, also: [86_400] },
  { id: 'month', front: 'A month ≈ how many seconds?', back: '≈ 2.5 × 10⁶ (2.5 million)', value: 2.5e6, tol: 0.05, also: [2.592e6, 2.6e6] },
  { id: 'year', front: 'A year ≈ how many seconds?', back: '≈ 3 × 10⁷ (30 million)', value: 3e7, tol: 0.06, also: [3.15e7, 3.2e7] },
  { id: 'day-year', front: 'Per day → per year: multiply by about…?', back: '× 400 (365, rounded up for easy math)', value: 400, tol: 0.01, also: [365] },
  { id: 'byte-bits', front: '1 byte = how many bits?', back: '8 bits', value: 8, tol: 0 },
  { id: 'gbps', front: '1 Gbps ≈ how many MB/s?', back: '≈ 125 MB/s (10⁹ bits ÷ 8)', value: 125, tol: 0.01 },
  { id: 'to-bytes', front: 'Bits → bytes: × 8 or ÷ 8?', back: '÷ 8 (to bytes = fewer)', words: /^(÷|\/|div)/i },
  { id: 'to-bits', front: 'Bytes → bits: × 8 or ÷ 8?', back: '× 8 (to bits = more)', words: /^(×|x|\*|mul|times)/i },
  { id: 'k', front: 'K / thousand = how many zeros?', back: '3 (10³ = 1,000)', value: 3, tol: 0 },
  { id: 'm', front: 'M / million = how many zeros?', back: '6 (10⁶ = 1,000,000)', value: 6, tol: 0 },
  { id: 'b', front: 'B / billion (G for bytes) = how many zeros?', back: '9 (10⁹)', value: 9, tol: 0 },
  { id: 't', front: 'T / trillion = how many zeros?', back: '12 (10¹²)', value: 12, tol: 0 },
  { id: 'pow-zeros', front: '10⁵ has how many zeros in total?', back: '5. 10ⁿ = 1 followed by n zeros total', value: 5, tol: 0 },
  { id: 'pow-number', front: 'Write 10⁴ as a normal number.', back: '10,000 (1 followed by 4 zeros)', value: 1e4, tol: 0 },
];

export function anchorById(id: string): AnchorCard | null {
  return ANCHOR_CARDS.find((c) => c.id === id) ?? null;
}

/** Right answer? Pure. */
export function checkAnchor(card: AnchorCard, text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (card.words) return card.words.test(t);
  if (card.value === undefined) return false;
  const s = parseSci(t);
  const p = s ? null : parseAnswer(t);
  if (!s && !p) return false;
  const g = s ? s.value : p!.number * p!.prefix;
  const tol = card.tol ?? 0;
  return [card.value, ...(card.also ?? [])].some((v) => (tol === 0 ? g === v : Math.abs(g / v - 1) <= tol));
}

/** Right AND inside ~10 s (a little grace for typing) = 'got'. */
export function anchorGrade(ok: boolean, ms: number): 'got' | 'missed' {
  return ok && ms <= (ANCHOR_SECONDS + 2) * 1000 ? 'got' : 'missed';
}

// -----------------------------------------------------------------------------
// Today's skill (one per day while learning)
// -----------------------------------------------------------------------------
export const DAILY_SKILLS = [
  { id: 'per-second', label: 'per day → per second', kinds: ['day-to-sec', 'direction', 'day-to-sec', 'month-to-sec', 'qps'] },
  { id: 'powers', label: 'words → small × 10ⁿ, and 10ⁿ → a normal number', kinds: ['words-to-sci', 'sci-to-number', 'words-to-sci', 'sci-to-number', 'ladder'] },
  { id: 'bits-bytes', label: 'bits and bytes', kinds: ['gbps-to-mbs', 'mbs-to-gbps', 'direction', 'bandwidth'] },
  { id: 'mixed', label: 'a mix of everything', kinds: [...CONVERSION_KINDS, 'qps', 'storage-day'] },
] as const satisfies readonly { id: string; label: string; kinds: readonly EnvelopeKind[] }[];
export type DailySkill = (typeof DAILY_SKILLS)[number];
export type DailySkillId = DailySkill['id'];

export function skillById(id: unknown): DailySkill | null {
  return DAILY_SKILLS.find((s) => s.id === id) ?? null;
}

/**
 * The skill for today: the order above, one step per DAY OF PRACTICE (days off
 * do not skip a skill). `practiceDays` = distinct earlier days with envelope work.
 */
export function dailySkill(practiceDays: number): DailySkill {
  const n = Math.max(0, Math.floor(practiceDays));
  return DAILY_SKILLS[n % DAILY_SKILLS.length];
}

/** Guided mode leads the warm-up while still learning: < 20 answers, or < 70% right. */
export const GUIDED_MIN_ATTEMPTS = 20;
export const GUIDED_UNTIL_ACCURACY = 0.7;
export function guidedForToday(total: number, recentAccuracy: number | null): boolean {
  return total < GUIDED_MIN_ATTEMPTS || recentAccuracy === null || recentAccuracy < GUIDED_UNTIL_ACCURACY;
}

/** Guided items take longer: the warm-up asks for at most this many. */
export const GUIDED_DAILY = 3;

// -----------------------------------------------------------------------------
// Speed round
// -----------------------------------------------------------------------------
export const SPEED_ROUND_MS = 60_000;
/** What a speed round draws from: one-entry conversions. */
export const SPEED_KINDS: readonly EnvelopeKind[] = ['words-to-sci', 'sci-to-number', 'direction', 'ladder', 'day-to-sec', 'gbps-to-mbs'];

export interface SpeedScore {
  score: number;
  right: number;
  attempted: number;
  bestStreak: number;
}

/**
 * One point per right answer submitted inside the 60 s; answers after the
 * buzzer do not count. No penalty for a miss (a beginner should guess).
 */
export function scoreSpeedRound(answers: readonly { ok: boolean; atMs: number }[], limitMs = SPEED_ROUND_MS): SpeedScore {
  const inTime = answers.filter((a) => a.atMs >= 0 && a.atMs <= limitMs).sort((a, b) => a.atMs - b.atMs);
  let streak = 0;
  let bestStreak = 0;
  for (const a of inTime) {
    streak = a.ok ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
  }
  const right = inTime.filter((a) => a.ok).length;
  return { score: right, right, attempted: inTime.length, bestStreak };
}

// -----------------------------------------------------------------------------
// Endless practice: weight to what is missed most
// -----------------------------------------------------------------------------
/** A step type's misses also make these kinds more likely. */
const STEP_KINDS: Readonly<Record<StepType, EnvelopeKind[]>> = {
  direction: ['direction', 'day-to-sec', 'sec-to-day'],
  split: ['words-to-sci', 'qps', 'storage-day'],
  small: ['month-to-sec', 'qps'],
  exponent: ['day-to-sec', 'month-to-sec', 'storage-day'],
  back: ['sci-to-number', 'ladder', 'day-to-year'],
  unit: ['gbps-to-mbs', 'mbs-to-gbps', 'bandwidth'],
};

const missRate = (rows: readonly { ok: boolean }[]) => (rows.length ? rows.filter((r) => !r.ok).length / rows.length : 0);

/**
 * Weight per kind: 1, + 4 × the kind's recent miss rate, + 3 × the miss rate
 * of each step type that points at it. Rows newest first; the last 20 count.
 */
export function practiceWeights(
  kindRows: readonly { kind: string; ok: boolean }[],
  stepRows: readonly { type: string; ok: boolean }[]
): Record<EnvelopeKind, number> {
  const w = Object.fromEntries(ALL_KINDS.map((k) => [k, 1])) as Record<EnvelopeKind, number>;
  for (const k of ALL_KINDS) w[k] += 4 * missRate(kindRows.filter((r) => r.kind === k).slice(0, 20));
  for (const t of STEP_TYPES) {
    const rate = missRate(stepRows.filter((r) => r.type === t).slice(0, 20));
    for (const k of STEP_KINDS[t]) w[k] += 3 * rate;
  }
  w['id-space'] *= 0.3; // base62 length is a side quest
  return w;
}

export function pickWeighted<K extends string>(weights: Readonly<Record<K, number>>, r: () => number): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((s, [, x]) => s + Math.max(0, x), 0);
  let at = r() * total;
  for (const [k, x] of entries) {
    at -= Math.max(0, x);
    if (at < 0) return k;
  }
  return entries[entries.length - 1][0];
}

// -----------------------------------------------------------------------------
// Wire types
// -----------------------------------------------------------------------------
/** A guided step as served: never its answer. */
export interface GuidedStepPrompt {
  index: number;
  type: StepType;
  label: string;
  prompt: string;
  /** Nudge, then a worked example on other numbers; null for a faded step. */
  hint: StepHint | null;
  placeholder: string;
  /** Faded: not asked and not shown (prompt empty, no hint); done in your head. */
  auto: boolean;
}

export interface GuidedPlanResponse {
  key: string;
  steps: GuidedStepPrompt[];
  /** Right-in-a-row per step type, for the "fades after 3" note. */
  streaks: Record<StepType, number>;
}

export interface StepCheckResponse {
  ok: boolean;
  slip: StepSlip | null;
  feedback: string;
  /** The right answer, to carry forward. */
  answer: string;
  streak: number;
  /** This step type has now faded. */
  fadesNow: boolean;
}

export interface AnchorPrompt {
  id: string;
  front: string;
  isNew: boolean;
}

export interface AnchorSession {
  cards: AnchorPrompt[];
  seconds: number;
  total: number;
}

export interface AnchorCheckResponse {
  ok: boolean;
  grade: 'got' | 'missed';
  back: string;
  schedule: string;
}

export interface SpeedRoundStart {
  /** Full items: the page checks each answer locally for instant feedback. */
  items: EnvelopeItem[];
  ms: number;
  best: number | null;
  history: { score: number; attempted: number; createdAt: string }[];
}

export interface SpeedRoundResult extends SpeedScore {
  best: number;
  newBest: boolean;
}

export interface StepTypeStat {
  type: StepType;
  n: number;
  missed: number;
  /** Most common slip on this step type. */
  topSlip: StepSlip | null;
}
