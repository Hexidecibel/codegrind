// =============================================================================
// envelope — back-of-the-envelope math reps (Phase G)
// =============================================================================
// The user is quick at mental math but loses track of ZEROS on big numbers.
// The fix taught here: write every number as a small number × 10^n, do the
// small-number math, ADD exponents to multiply and SUBTRACT them to divide, then
// convert back with the 3/6/9/12 ladder (thousand / million / billion /
// trillion, or K/M/G/T for bytes).
//
//   anchors   a day ≈ 10⁵ s · a month ≈ 2.5 × 10⁶ s · a year ≈ 3 × 10⁷ s
//             per day → per year: × 400 · 1 Gbps ≈ 125 MB/s · b = bits, B = bytes
//
// Everything in this file is pure and deterministic — no model, no clock, no
// randomness except the seeded PRNG — so the generator, the parser and the
// miss classifier are all unit-tested (envelope.test.ts). The server stores
// items as JSON on cards, so an item must survive JSON round-trips.

import type { StepTypeStat } from './envelope-learn.js';

// -----------------------------------------------------------------------------
// Quantities
// -----------------------------------------------------------------------------
export type Dim = 'count' | 'bytes' | 'bits';
export type Per = 's' | 'day' | 'month' | 'year';

/** A value in BASE units (1, bytes or bits), optionally per a time period. */
export interface Quantity {
  value: number;
  dim: Dim;
  per: Per | null;
}

/** Real seconds per period — what the EXACT answers use. */
export const SECONDS: Readonly<Record<Per, number>> = { s: 1, day: 86_400, month: 30 * 86_400, year: 365 * 86_400 };

/** The round anchors the method teaches. */
export const ANCHOR: Readonly<Record<Per, number>> = { s: 1, day: 1e5, month: 2.5e6, year: 3e7 };

export const ENVELOPE_TOLERANCE = 0.3;
export const DEFAULT_ENVELOPE_SIZE = 5;

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------
export const ENVELOPE_KINDS = [
  'day-to-sec',
  'month-to-sec',
  'sec-to-day',
  'sec-to-month',
  'day-to-year',
  'gbps-to-mbs',
  'mbs-to-gbps',
  'ladder',
  'qps',
  'storage',
  'storage-day',
  'bandwidth',
  'id-space',
] as const;

/**
 * Phase I quick-check kinds: one idea each, answered in one entry. Kept apart
 * from ENVELOPE_KINDS (the 13 interview-style kinds) so the mixed rounds and the
 * full-split guarantees stay as they were.
 *   words-to-sci   "500 million" → 5 × 10⁸; "200 KB" → 2 × 10⁵ bytes
 *   direction      "per day → per second: divide or multiply?"
 *   sci-to-number  5 × 10² → 500; 8,000 GB → 8 TB (the comma method)
 */
export const QUICK_KINDS = ['words-to-sci', 'direction', 'sci-to-number'] as const;
export const ALL_KINDS = [...ENVELOPE_KINDS, ...QUICK_KINDS] as const;
export type EnvelopeKind = (typeof ALL_KINDS)[number];

/** Plain names for the drill picker. */
export const KIND_LABEL: Readonly<Record<EnvelopeKind, string>> = {
  'day-to-sec': 'Per day → per second',
  'month-to-sec': 'Per month → per second',
  'sec-to-day': 'Per second → per day',
  'sec-to-month': 'Per second → per month',
  'day-to-year': 'Per day → per year',
  'gbps-to-mbs': 'Gbps → MB/s',
  'mbs-to-gbps': 'MB/s → Gbps',
  ladder: 'KB / MB / GB / TB',
  qps: 'Requests per second',
  storage: 'Storage over years',
  'storage-day': 'Storage per day',
  bandwidth: 'Bandwidth',
  'id-space': 'ID length',
  'words-to-sci': 'Words → small × 10ⁿ',
  direction: 'Divide or multiply?',
  'sci-to-number': '10ⁿ → normal number',
};

export const CONVERSION_KINDS: readonly EnvelopeKind[] = [
  'day-to-sec',
  'month-to-sec',
  'sec-to-day',
  'sec-to-month',
  'day-to-year',
  'gbps-to-mbs',
  'mbs-to-gbps',
  'ladder',
];
export const ESTIMATE_KINDS: readonly EnvelopeKind[] = ['qps', 'storage', 'storage-day', 'bandwidth', 'id-space'];

export function isEnvelopeKind(x: unknown): x is EnvelopeKind {
  return typeof x === 'string' && (ALL_KINDS as readonly string[]).includes(x);
}

/** The worked split every reveal shows. */
export interface EnvelopeSplit {
  /** Each number as small × 10^n, anchors included. */
  parts: string;
  /** The small-number arithmetic. */
  small: string;
  /** The exponent arithmetic. */
  zeros: string;
  /** Back to a readable number with the 3/6/9/12 ladder. */
  back: string;
  /** Does it make sense? */
  sanity: string;
}

/** The likely reason a miss happened. */
export const ENVELOPE_CAUSES = ['month-for-day', 'bits-bytes', 'unit-ladder', 'zeros', 'arithmetic', 'direction', 'own-zeros', 'wrong-unit'] as const;
export type EnvelopeCause = (typeof ENVELOPE_CAUSES)[number];

export const ENVELOPE_CAUSE_TEXT: Readonly<Record<EnvelopeCause, string>> = {
  'month-for-day': 'Looks like the month constant (2.5 × 10⁶ s) was used where a day (10⁵ s) belongs, or the other way round.',
  'bits-bytes': 'Off by about 8: a bits/bytes mix-up. Lowercase b is bits, uppercase B is bytes; 1 byte = 8 bits.',
  'unit-ladder': 'Off by an exact step of the 3/6/9/12 ladder: the digits are right, the unit (thousand/million/billion, or KB/MB/GB/TB) slipped.',
  zeros: 'Off by an exact power of ten: zeros were counted (or dropped) instead of adding and subtracting exponents.',
  arithmetic: 'The order of magnitude is close; the small-number math slipped.',
  direction: 'Divide and multiply got swapped. Ask first: will the answer be bigger or smaller? Spreading out (per day → per second) is divide.',
  'own-zeros': "The front number's own zeros were dropped. Split it first: 500 = 5 × 10², then add the word's zeros (million = 10⁶): 5 × 10⁸.",
  'wrong-unit': 'The answer is not in the unit the question asks for. Write the target unit first, then the number.',
};

export interface EnvelopeItem {
  /** `g:<kind>:<seed>` for a generated item; cards keep the key they were made with. */
  key: string;
  kind: EnvelopeKind;
  family: 'conversion' | 'estimate' | 'quick';
  /** Phrased the way an interviewer says it out loud. */
  question: string;
  /** The exact answer (real constants: 86,400 s a day, 365 days a year). */
  expected: Quantity;
  /** What the anchors give (10⁵ s a day, × 400 a year). Also accepted. */
  approx: number;
  /** How a bare number is read, and the unit the answer is shown in. */
  unit: { label: string; factor: number };
  /** Integer answers that must be exact or one more (base62 length). */
  exactInt?: boolean;
  /** "≈ 500 per second (exactly 579)". */
  answerText: string;
  split: EnvelopeSplit;
  /** Causes that make sense for this item (the classifier only names these). */
  traps: EnvelopeCause[];
  /**
   * Phase I. The chain the method walks (guided mode builds its steps from it)
   * and which way the conversion goes. Absent on items stored before Phase I.
   */
  factors?: Factor[];
  move?: Move;
  /**
   * Quick kinds: 'exact' = within 2% (a conversion, not an estimate);
   * 'direction' = the answer is the word divide or multiply.
   */
  answerForm?: 'exact' | 'direction';
  /** 'exact' items whose answer must be IN the item's unit (8 TB, not 8,000 GB). */
  inUnit?: boolean;
}

/** Which way a conversion goes ("per day → per second": divide). */
export interface Move {
  from: string;
  to: string;
  op: 'divide' | 'multiply';
}

// -----------------------------------------------------------------------------
// Number formatting
// -----------------------------------------------------------------------------
const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const UNSUP: Record<string, string> = Object.fromEntries(Object.entries(SUP).map(([k, v]) => [v, k]));

export function sup(n: number): string {
  return String(n).split('').map((c) => SUP[c] ?? c).join('');
}

export function pow10(e: number): string {
  return `10${sup(e)}`;
}

/** Round to `sig` significant digits, as a plain number. */
export function roundSig(x: number, sig = 3): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const d = Math.ceil(Math.log10(Math.abs(x)));
  const p = sig - d;
  const f = 10 ** p;
  return Math.round(x * f) / f;
}

/** 12345.6 → "12,346"; 2.5 → "2.5"; 0.125 → "0.125". */
export function fmt(x: number, sig = 3): string {
  const r = roundSig(x, sig);
  if (Math.abs(r) >= 1000) return Math.round(r).toLocaleString('en-US');
  return String(r);
}

/** x → { m in [1,10), e }. */
export function sci(x: number): { m: number; e: number } {
  if (x === 0) return { m: 0, e: 0 };
  let e = Math.floor(Math.log10(Math.abs(x)));
  let m = roundSig(x / 10 ** e, 3);
  if (Math.abs(m) >= 10) {
    m = roundSig(m / 10, 3);
    e += 1;
  }
  return { m, e };
}

export function fmtSci(x: number): string {
  const { m, e } = sci(x);
  if (e === 0) return fmt(m);
  return m === 1 ? pow10(e) : `${fmt(m)} × ${pow10(e)}`;
}

const COUNT_LADDER: readonly [number, string][] = [
  [12, 'trillion'],
  [9, 'billion'],
  [6, 'million'],
  [3, 'thousand'],
];
const BYTE_LADDER: readonly [number, string][] = [
  [15, 'PB'],
  [12, 'TB'],
  [9, 'GB'],
  [6, 'MB'],
  [3, 'KB'],
  [0, 'bytes'],
];
const BIT_LADDER: readonly [number, string][] = [
  [12, 'Tb'],
  [9, 'Gb'],
  [6, 'Mb'],
  [3, 'Kb'],
  [0, 'bits'],
];
const PER_TEXT: Readonly<Record<Per, string>> = { s: 'per second', day: 'a day', month: 'a month', year: 'a year' };

/** The ladder step for a value: the largest of 3/6/9/12 not above its exponent. */
function ladderOf(x: number, dim: Dim): { exp: number; name: string } | null {
  const e = sci(x).e;
  const ladder = dim === 'bytes' ? BYTE_LADDER : dim === 'bits' ? BIT_LADDER : COUNT_LADDER;
  for (const [exp, name] of ladder) if (e >= exp) return { exp, name };
  return null;
}

/** A readable quantity: "30 million a day", "8 TB", "125 MB per second", "500 per second". */
export function fmtQuantity(x: number, dim: Dim, per: Per | null, sig = 2): string {
  const step = ladderOf(x, dim);
  let core: string;
  if (dim === 'count') {
    core = step && x >= 1e4 ? `${fmt(x / 10 ** step.exp, sig)} ${step.name}` : fmt(x, sig);
  } else {
    core = step ? `${fmt(x / 10 ** step.exp, sig)} ${step.name}` : `${fmt(x, sig)} ${dim}`;
  }
  if (per === 's' && dim === 'bits' && step && step.exp > 0) return `${core}ps`;
  return per ? `${core} ${PER_TEXT[per]}` : core;
}

/** Spoken numbers for questions: 50000000 → "50 million"; 300 → "300"; 4000 → "4,000". */
export function spoken(x: number): string {
  if (x < 1e6) return fmt(x, 4);
  for (const [exp, name] of COUNT_LADDER) if (x >= 10 ** exp) return `${fmt(x / 10 ** exp, 3)} ${name}`;
  return fmt(x);
}

const BYTE_WORDS: readonly [number, string][] = [
  [15, 'petabytes'],
  [12, 'terabytes'],
  [9, 'gigabytes'],
  [6, 'megabytes'],
  [3, 'kilobytes'],
];
/** 2e5 bytes → "200 kilobytes" (questions spell units out). */
export function spokenBytes(x: number): string {
  for (const [exp, name] of BYTE_WORDS) {
    if (x >= 10 ** exp) {
      const n = x / 10 ** exp;
      return `${fmt(n, 3)} ${n === 1 ? name.slice(0, -1) : name}`;
    }
  }
  return `${fmt(x)} bytes`;
}

// -----------------------------------------------------------------------------
// The worked split
// -----------------------------------------------------------------------------
export interface Factor {
  /** "50 million requests" — what this number is. */
  label: string;
  /** Guided mode's prompt when the label gives the answer away ("seconds in a day"). */
  ask?: string;
  /** The number the METHOD uses (anchors rounded). */
  value: number;
  op: '×' | '÷';
}

/**
 * The small × 10^n walk over a chain of factors. Returns the approximate
 * result and the four lines of the split (sanity is the caller's).
 */
export function chain(factors: readonly Factor[], dim: Dim, per: Per | null): { approx: number; split: Omit<EnvelopeSplit, 'sanity'> } {
  const parts = factors.map((f) => `${f.label} = ${fmtSci(f.value)}`).join('; ');
  const ms = factors.map((f) => ({ ...sci(f.value), op: f.op }));

  let small = ms[0].m;
  let smallText = fmt(ms[0].m);
  let exp = ms[0].e;
  let zerosText = pow10(ms[0].e);
  let sumText = String(ms[0].e);
  for (const x of ms.slice(1)) {
    small = x.op === '×' ? small * x.m : small / x.m;
    smallText += ` ${x.op} ${fmt(x.m)}`;
    exp = x.op === '×' ? exp + x.e : exp - x.e;
    zerosText += ` ${x.op} ${pow10(x.e)}`;
    sumText += ` ${x.op === '×' ? '+' : '−'} ${x.e}`;
  }
  small = roundSig(small, 3);
  const approx = small * 10 ** exp;
  const norm = sci(approx);
  const smallLine = ms.length > 1 ? `${smallText} = ${fmt(small)}` : fmt(small);
  const zerosLine = ms.length > 1 ? `${zerosText} → ${sumText} = ${exp} → ${pow10(exp)}` : pow10(exp);

  const shifted = small === norm.m && exp === norm.e ? '' : ` = ${fmtSci(approx)}`;
  const step = ladderOf(approx, dim);
  const ladderNote =
    step && step.exp > 0 && norm.e !== step.exp && (dim !== 'count' || approx >= 1e4)
      ? ` (${pow10(step.exp)} = ${step.name}, so ${fmtSci(approx)} = ${fmt(approx / 10 ** step.exp, 3)} × ${pow10(step.exp)})`
      : '';
  const back = `${fmt(small)} × ${pow10(exp)}${shifted} = ${fmtQuantity(approx, dim, per, 3)}${ladderNote}`;
  return { approx, split: { parts, small: smallLine, zeros: zerosLine, back } };
}

// -----------------------------------------------------------------------------
// Builders — one per kind, parameters in, a whole item out
// -----------------------------------------------------------------------------
const DAY: Factor = { label: 'a day ≈ 10⁵ seconds', ask: 'seconds in a day (rounded)', value: ANCHOR.day, op: '÷' };
const MONTH: Factor = { label: 'a month ≈ 2.5 × 10⁶ seconds', ask: 'seconds in a month (rounded)', value: ANCHOR.month, op: '÷' };
const BITS: Factor = { label: '8 bits in a byte', ask: 'bits in a byte', value: 8, op: '÷' };
const YEAR_DAYS: Factor = { label: 'a year ≈ 400 days (365, rounded up for easy math)', ask: 'days in a year (rounded up for easy math)', value: 400, op: '×' };

function answerText(exact: number, approx: number, dim: Dim, per: Per | null): string {
  const a = fmtQuantity(approx, dim, per, 3);
  const x = fmtQuantity(exact, dim, per, 3);
  return a === x ? `≈ ${a}` : `≈ ${a} (exactly ${x})`;
}

interface ItemCore {
  key: string;
  kind: EnvelopeKind;
  question: string;
  expected: Quantity;
  unit: EnvelopeItem['unit'];
  factors: Factor[];
  sanity: string;
  traps: EnvelopeCause[];
  move: Move;
}

function finish(c: ItemCore): EnvelopeItem {
  const { approx, split } = chain(c.factors, c.expected.dim, c.expected.per);
  return {
    key: c.key,
    kind: c.kind,
    family: (ESTIMATE_KINDS as readonly string[]).includes(c.kind) ? 'estimate' : 'conversion',
    question: c.question,
    expected: c.expected,
    approx,
    unit: c.unit,
    answerText: answerText(c.expected.value, approx, c.expected.dim, c.expected.per),
    split: { ...split, sanity: c.sanity },
    traps: c.traps,
    factors: c.factors,
    move: c.move,
  };
}

const COUNT_UNIT = { label: '', factor: 1 };

export interface RateParams {
  n: number;
  /** "requests", "page views". */
  noun: string;
  /** Lead-in clause for the question ("Say your service handles"). */
  lead?: string;
}

export function dayToSec(key: string, p: RateParams): EnvelopeItem {
  return finish({
    key,
    kind: 'day-to-sec',
    question: `${p.lead ?? 'Say your service handles'} ${spoken(p.n)} ${p.noun} a day. Roughly how many is that per second?`,
    expected: { value: p.n / SECONDS.day, dim: 'count', per: 's' },
    unit: COUNT_UNIT,
    factors: [{ label: `${spoken(p.n)} ${p.noun}`, value: p.n, op: '×' }, DAY],
    sanity: `A day is about 10⁵ seconds, so a daily number loses five zeros. Per second must be far smaller than per day: ${spoken(p.n)} a day can never be ${spoken(p.n)} a second.`,
    traps: ['month-for-day', 'zeros', 'unit-ladder', 'arithmetic'],
    move: { from: 'per day', to: 'per second', op: 'divide' },
  });
}

export function monthToSec(key: string, p: RateParams): EnvelopeItem {
  return finish({
    key,
    kind: 'month-to-sec',
    question: `${p.lead ?? 'Say you get'} ${spoken(p.n)} ${p.noun} a month. Roughly how many is that per second?`,
    expected: { value: p.n / SECONDS.month, dim: 'count', per: 's' },
    unit: COUNT_UNIT,
    factors: [{ label: `${spoken(p.n)} ${p.noun}`, value: p.n, op: '×' }, MONTH],
    sanity: `A month is about 2.5 × 10⁶ seconds: divide by 2.5, then drop six zeros. Check: ${fmtQuantity(p.n / ANCHOR.month, 'count', null)} a second × 2.5 million seconds should give back ${spoken(p.n)}.`,
    traps: ['month-for-day', 'zeros', 'unit-ladder', 'arithmetic'],
    move: { from: 'per month', to: 'per second', op: 'divide' },
  });
}

export function secToDay(key: string, p: RateParams): EnvelopeItem {
  return finish({
    key,
    kind: 'sec-to-day',
    question: `${p.lead ?? 'Your API averages'} ${spoken(p.n)} ${p.noun} a second. About how many is that in a day?`,
    expected: { value: p.n * SECONDS.day, dim: 'count', per: 'day' },
    unit: COUNT_UNIT,
    factors: [{ label: `${spoken(p.n)} ${p.noun} a second`, value: p.n, op: '×' }, { ...DAY, op: '×' }],
    sanity: `Per second to per day adds five zeros, never more: ${spoken(p.n)} becomes ${spoken(p.n)} followed by 00000, so ${fmtQuantity(p.n * ANCHOR.day, 'count', null)}.`,
    traps: ['month-for-day', 'zeros', 'unit-ladder', 'arithmetic'],
    move: { from: 'per second', to: 'per day', op: 'multiply' },
  });
}

export function secToMonth(key: string, p: RateParams): EnvelopeItem {
  return finish({
    key,
    kind: 'sec-to-month',
    question: `${p.lead ?? 'Your queue takes in'} ${spoken(p.n)} ${p.noun} a second. Roughly how many is that over a month?`,
    expected: { value: p.n * SECONDS.month, dim: 'count', per: 'month' },
    unit: COUNT_UNIT,
    factors: [{ label: `${spoken(p.n)} ${p.noun} a second`, value: p.n, op: '×' }, { ...MONTH, op: '×' }],
    sanity: `A month multiplies by 2.5 and adds six zeros. Cross-check with a day: × 10⁵ for a day, then × 30 ≈ 3 × 10¹ for the month — the same exponent.`,
    traps: ['month-for-day', 'zeros', 'unit-ladder', 'arithmetic'],
    move: { from: 'per second', to: 'per month', op: 'multiply' },
  });
}

export interface VolumeParams {
  /** Bytes per day. */
  bytes: number;
  noun: string;
}

export function dayToYear(key: string, p: VolumeParams): EnvelopeItem {
  const step = ladderOf(p.bytes, 'bytes')!;
  return finish({
    key,
    kind: 'day-to-year',
    question: `Your ${p.noun} grow by about ${spokenBytes(p.bytes)} a day. How much is that over a year?`,
    expected: { value: p.bytes * 365, dim: 'bytes', per: null },
    // A bare number is read in the unit the question used.
    unit: { label: step.name, factor: 10 ** step.exp },
    factors: [
      { label: `${spokenBytes(p.bytes)} a day`, value: p.bytes, op: '×' },
      YEAR_DAYS,
    ],
    sanity: `Per day → per year is × 400: the small number × 4, plus two zeros. 1,000 GB is 1 TB, so a few thousand GB is a few TB.`,
    traps: ['unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'per day', to: 'per year', op: 'multiply' },
  });
}

export function gbpsToMBs(key: string, p: { gbps: number }): EnvelopeItem {
  return finish({
    key,
    kind: 'gbps-to-mbs',
    question: `Your servers have ${fmt(p.gbps)}-gigabit network cards. Roughly how many megabytes per second can one of them push?`,
    expected: { value: (p.gbps * 1e9) / 8, dim: 'bytes', per: 's' },
    unit: { label: 'MB', factor: 1e6 },
    factors: [
      { label: `${fmt(p.gbps)} gigabits per second`, ask: `${fmt(p.gbps)} gigabits, in bits`, value: p.gbps * 1e9, op: '×' },
      BITS,
    ],
    sanity: `Anchor: 1 Gbps ≈ 125 MB/s. Bits are lowercase b, bytes uppercase B; going bits → bytes the number gets 8× SMALLER.`,
    traps: ['bits-bytes', 'unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'bits', to: 'bytes', op: 'divide' },
  });
}

export function mbsToGbps(key: string, p: { mbs: number }): EnvelopeItem {
  return finish({
    key,
    kind: 'mbs-to-gbps',
    question: `A replication stream copies about ${fmt(p.mbs)} megabytes per second. How many gigabits per second of network does that need?`,
    expected: { value: p.mbs * 1e6 * 8, dim: 'bits', per: 's' },
    unit: { label: 'Gb', factor: 1e9 },
    factors: [
      { label: `${fmt(p.mbs)} megabytes per second`, ask: `${fmt(p.mbs)} megabytes, in bytes`, value: p.mbs * 1e6, op: '×' },
      { ...BITS, op: '×' },
    ],
    sanity: `Anchor: 125 MB/s ≈ 1 Gbps. Bytes → bits the number gets 8× BIGGER, then 10⁹ bits is a gigabit.`,
    traps: ['bits-bytes', 'unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'bytes', to: 'bits', op: 'multiply' },
  });
}

const LADDER_UNITS: readonly { exp: number; word: string; label: string }[] = [
  { exp: 3, word: 'kilobytes', label: 'KB' },
  { exp: 6, word: 'megabytes', label: 'MB' },
  { exp: 9, word: 'gigabytes', label: 'GB' },
  { exp: 12, word: 'terabytes', label: 'TB' },
  { exp: 15, word: 'petabytes', label: 'PB' },
];

export function ladderItem(key: string, p: { n: number; fromExp: number; toExp: number }): EnvelopeItem {
  const from = LADDER_UNITS.find((u) => u.exp === p.fromExp)!;
  const to = LADDER_UNITS.find((u) => u.exp === p.toExp)!;
  const bytes = p.n * 10 ** from.exp;
  const inTarget = p.n * 10 ** (from.exp - to.exp);
  const item = finish({
    key,
    kind: 'ladder',
    question: `If you have ${fmt(p.n, 4)} ${from.word} of data, how many ${to.word} is that?`,
    expected: { value: bytes, dim: 'bytes', per: null },
    unit: { label: to.label, factor: 10 ** to.exp },
    factors: [
      { label: `${fmt(p.n, 4)} ${from.word}`, value: p.n, op: '×' },
      { label: `${from.label} = ${pow10(from.exp)} bytes`, ask: `1 ${from.label}, in bytes`, value: 10 ** from.exp, op: '×' },
      { label: `${to.label} = ${pow10(to.exp)} bytes`, ask: `1 ${to.label}, in bytes`, value: 10 ** to.exp, op: '÷' },
    ],
    sanity: `Each ladder step (KB → MB → GB → TB → PB) is three zeros. ${from.label} → ${to.label} is ${Math.abs(p.fromExp - p.toExp) / 3} step${Math.abs(p.fromExp - p.toExp) === 3 ? '' : 's'}, so the number ${p.toExp > p.fromExp ? 'shrinks' : 'grows'} by ${pow10(Math.abs(p.fromExp - p.toExp))}.`,
    traps: ['unit-ladder', 'zeros', 'arithmetic'],
    move: { from: from.label, to: to.label, op: p.toExp > p.fromExp ? 'divide' : 'multiply' },
  });
  // The chain above counts in the TARGET unit; the expected value is bytes.
  return {
    ...item,
    approx: bytes,
    answerText: `${fmt(inTarget, 4)} ${to.label}`,
    split: { ...item.split, back: `${fmtSci(inTarget)} = ${fmt(inTarget, 4)} ${to.label}` },
  };
}

export function qpsItem(key: string, p: { users: number; perUser: number; noun: string }): EnvelopeItem {
  return finish({
    key,
    kind: 'qps',
    question: `Say you have ${spoken(p.users)} daily active users, and each one makes about ${fmt(p.perUser)} ${p.noun} a day. Roughly how many ${p.noun} per second is that on average?`,
    expected: { value: (p.users * p.perUser) / SECONDS.day, dim: 'count', per: 's' },
    unit: COUNT_UNIT,
    factors: [
      { label: `${spoken(p.users)} users`, value: p.users, op: '×' },
      { label: `${fmt(p.perUser)} ${p.noun} each`, value: p.perUser, op: '×' },
      DAY,
    ],
    sanity: `Users × actions gives the daily total; a day drops five zeros. Peak is usually 2-10× the average, so say both numbers.`,
    traps: ['month-for-day', 'zeros', 'unit-ladder', 'arithmetic'],
    move: { from: 'per day', to: 'per second', op: 'divide' },
  });
}

export function storageItem(key: string, p: { perDay: number; noun: string; bytesEach: number; copies: number; years: number }): EnvelopeItem {
  const total = p.perDay * p.bytesEach * p.copies * 365 * p.years;
  const unit = ladderOf(total, 'bytes')!;
  return finish({
    key,
    kind: 'storage',
    question: `Users upload ${spoken(p.perDay)} ${p.noun} a day, about ${spokenBytes(p.bytesEach)} each, and you keep ${p.copies} copies of everything. Roughly how much storage do you need for ${p.years} years?`,
    expected: { value: total, dim: 'bytes', per: null },
    unit: { label: unit.name, factor: 10 ** unit.exp },
    factors: [
      { label: `${spoken(p.perDay)} ${p.noun} a day`, value: p.perDay, op: '×' },
      { label: `${spokenBytes(p.bytesEach)} each`, value: p.bytesEach, op: '×' },
      { label: `${p.copies} copies`, value: p.copies, op: '×' },
      { label: 'a year ≈ 400 days', ask: 'days in a year (rounded up for easy math)', value: 400, op: '×' },
      { label: `${p.years} years`, value: p.years, op: '×' },
    ],
    sanity: `Do it per day first (count × size), then × copies, × 400 for a year, × years. Terabytes are 10¹², petabytes 10¹⁵.`,
    traps: ['unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'per day', to: 'several years, all copies', op: 'multiply' },
  });
}

export function storageDayItem(key: string, p: { users: number; perUser: number; noun: string; bytesEach: number }): EnvelopeItem {
  const total = p.users * p.perUser * p.bytesEach;
  const unit = ladderOf(total, 'bytes')!;
  return finish({
    key,
    kind: 'storage-day',
    question: `Say you have ${spoken(p.users)} users, and each one uploads ${fmt(p.perUser)} ${p.noun} a day at about ${spokenBytes(p.bytesEach)} each. Roughly how much new storage is that per day?`,
    expected: { value: total, dim: 'bytes', per: null },
    unit: { label: unit.name, factor: 10 ** unit.exp },
    factors: [
      { label: `${spoken(p.users)} users`, value: p.users, op: '×' },
      { label: `${fmt(p.perUser)} ${p.noun} each`, value: p.perUser, op: '×' },
      { label: `${spokenBytes(p.bytesEach)} each`, value: p.bytesEach, op: '×' },
    ],
    sanity: `Kilobytes are 10³ bytes, so ${spokenBytes(p.bytesEach)} is ${fmtSci(p.bytesEach)} bytes. Add the exponents, then read the result off the ladder: 10¹² is a terabyte, 10¹⁵ a petabyte.`,
    traps: ['unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'one file', to: 'everyone, all day', op: 'multiply' },
  });
}

export function bandwidthItem(key: string, p: { perSec: number; noun: string; bytesEach: number }): EnvelopeItem {
  return finish({
    key,
    kind: 'bandwidth',
    question: `At peak you serve ${spoken(p.perSec)} ${p.noun} a second, each about ${spokenBytes(p.bytesEach)}. How much outbound bandwidth is that, in gigabits per second?`,
    expected: { value: p.perSec * p.bytesEach * 8, dim: 'bits', per: 's' },
    unit: { label: 'Gb', factor: 1e9 },
    factors: [
      { label: `${spoken(p.perSec)} ${p.noun} a second`, value: p.perSec, op: '×' },
      { label: `${spokenBytes(p.bytesEach)} each`, value: p.bytesEach, op: '×' },
      { ...BITS, op: '×' },
    ],
    sanity: `Bytes per second × 8 = bits per second; network links are sold in bits (Gbps). Anchor: 125 MB/s ≈ 1 Gbps.`,
    traps: ['bits-bytes', 'unit-ladder', 'zeros', 'arithmetic'],
    move: { from: 'bytes', to: 'bits', op: 'multiply' },
  });
}

/** Base62 code length for `perMonth` ids a month over `years`. */
export function idSpaceItem(key: string, p: { perMonth: number; years: number; noun: string }): EnvelopeItem {
  const total = p.perMonth * 12 * p.years;
  let len = 1;
  while (62 ** len < total) len++;
  const powers = [4, 5, 6, 7, 8].map((k) => `62${sup(k)} ≈ ${fmtSci(62 ** k)}`).join(', ');
  const item = finish({
    key,
    kind: 'id-space',
    question: `You'll create about ${spoken(p.perMonth)} ${p.noun} a month and want the codes to last ${p.years} years. How many base62 characters does each code need?`,
    expected: { value: len, dim: 'count', per: null },
    unit: COUNT_UNIT,
    factors: [
      { label: `${spoken(p.perMonth)} ${p.noun} a month`, value: p.perMonth, op: '×' },
      { label: '12 months', value: 12, op: '×' },
      { label: `${p.years} years`, value: p.years, op: '×' },
    ],
    sanity: `Base62 powers: ${powers}. The smallest power above the total is the length: ${len} characters (one more is fine as headroom).`,
    traps: ['zeros', 'arithmetic'],
    move: { from: 'per month', to: 'all the years', op: 'multiply' },
  });
  return {
    ...item,
    exactInt: true,
    // Base62 length is not a small × 10ⁿ walk: no guided steps.
    factors: undefined,
    move: undefined,
    answerText: `${len} characters (62${sup(len)} ≈ ${fmtSci(62 ** len)} codes vs ≈ ${fmtSci(total)} needed)`,
    split: { ...item.split, back: `${item.split.back} codes needed; 62${sup(len)} ≈ ${fmtSci(62 ** len)} ≥ that, 62${sup(len - 1)} ≈ ${fmtSci(62 ** (len - 1))} is not` },
  };
}

// -----------------------------------------------------------------------------
// Quick-check builders (Phase I) — one idea per item, exact answers
// -----------------------------------------------------------------------------
const BYTE_UNIT_AT: Readonly<Record<number, string>> = { 0: 'bytes', 3: 'KB', 6: 'MB', 9: 'GB', 12: 'TB', 15: 'PB' };
const COUNT_WORD_AT: Readonly<Record<number, string>> = { 3: 'thousand', 6: 'million', 9: 'billion', 12: 'trillion' };
const commas = (x: number) => Math.round(x).toLocaleString('en-US');
const zerosWord = (n: number) => `${n} zero${n === 1 ? '' : 's'}`;

/** "500 million" → 5 × 10⁸; "200 KB" → 2 × 10⁵ bytes. */
export function wordsToSciItem(key: string, p: { lead: number; exp: number; dim: 'count' | 'bytes' }): EnvelopeItem {
  const value = p.lead * 10 ** p.exp;
  const lead = sci(p.lead);
  const total = lead.e + p.exp;
  const bytes = p.dim === 'bytes';
  const words = bytes ? `${fmt(p.lead)} ${BYTE_UNIT_AT[p.exp]}` : `${fmt(p.lead)} ${COUNT_WORD_AT[p.exp]}`;
  const scale = bytes ? `${BYTE_UNIT_AT[p.exp]} = ${pow10(p.exp)} bytes` : `${COUNT_WORD_AT[p.exp]} = ${pow10(p.exp)}`;
  return {
    key,
    kind: 'words-to-sci',
    family: 'quick',
    question: bytes ? `Write ${words} in bytes, as small × 10ⁿ.` : `Write "${words}" as small × 10ⁿ.`,
    expected: { value, dim: p.dim, per: null },
    approx: value,
    unit: bytes ? { label: 'bytes', factor: 1 } : COUNT_UNIT,
    answerText: `${fmtSci(value)}${bytes ? ' bytes' : ''}`,
    split: {
      parts: `Two pieces: the front number ${fmt(p.lead)}, and ${scale}.`,
      small: lead.e > 0 ? `Split the front number first: ${fmt(p.lead)} = ${fmt(lead.m)} × ${pow10(lead.e)} (its own ${zerosWord(lead.e)}).` : `${fmt(p.lead)} is already small.`,
      zeros: lead.e > 0 ? `${pow10(lead.e)} × ${pow10(p.exp)} → ${lead.e} + ${p.exp} = ${total} → ${pow10(total)}` : `Just the word's zeros: ${pow10(p.exp)}`,
      back: `${fmtSci(value)}${bytes ? ' bytes' : ''}`,
      sanity: `Written out it is ${commas(value)}: count every zero, ${total}.`,
    },
    traps: ['own-zeros', 'zeros'],
    answerForm: 'exact',
  };
}

export interface DirectionCase {
  from: string;
  to: string;
  op: 'divide' | 'multiply';
  /** A rate (per day) or a size unit (GB). */
  what: 'rate' | 'size';
  why: string;
}

export const DIRECTIONS: readonly DirectionCase[] = [
  { from: 'per day', to: 'per second', op: 'divide', what: 'rate', why: "A day is about 100,000 seconds. The day's total gets spread over all of them, so each second gets a smaller share: divide." },
  { from: 'per month', to: 'per second', op: 'divide', what: 'rate', why: 'A month is millions of seconds. Spreading the total out makes each second smaller: divide.' },
  { from: 'per year', to: 'per day', op: 'divide', what: 'rate', why: 'Like $100k a year → per day: the money is spread over the days, so each day gets less: divide.' },
  { from: 'per second', to: 'per day', op: 'multiply', what: 'rate', why: 'A day piles up about 100,000 seconds, so the total is bigger: multiply.' },
  { from: 'per day', to: 'per year', op: 'multiply', what: 'rate', why: 'A year piles up the days (about 400, rounded), so the total is bigger: multiply.' },
  { from: 'per second', to: 'per month', op: 'multiply', what: 'rate', why: 'A month piles up millions of seconds, so the total is bigger: multiply.' },
  { from: 'bits', to: 'bytes', op: 'divide', what: 'size', why: 'Bits are tiny pieces, 8 per byte. To bytes = fewer = ÷ 8.' },
  { from: 'bytes', to: 'bits', op: 'multiply', what: 'size', why: 'Bits are tiny pieces, 8 per byte. To bits = more = × 8.' },
  { from: 'GB', to: 'TB', op: 'divide', what: 'size', why: 'A TB is a bigger box (1,000 GB). Fewer big boxes hold the same data: divide.' },
  { from: 'TB', to: 'GB', op: 'multiply', what: 'size', why: 'A GB is a smaller box. It takes more of them for the same data: multiply.' },
  { from: 'KB', to: 'MB', op: 'divide', what: 'size', why: 'An MB is a bigger box (1,000 KB). Fewer big boxes: divide.' },
  { from: 'MB', to: 'KB', op: 'multiply', what: 'size', why: 'A KB is a smaller box. More small boxes: multiply.' },
];

/** "per day → per second: divide or multiply?" */
export function directionItem(key: string, c: DirectionCase): EnvelopeItem {
  const bigger = c.op === 'multiply';
  return {
    key,
    kind: 'direction',
    family: 'quick',
    question:
      c.what === 'rate'
        ? `You have a number ${c.from}. You want it ${c.to}. Divide or multiply?`
        : `You have a size in ${c.from}. You want it in ${c.to}. Divide or multiply?`,
    expected: { value: 1, dim: 'count', per: null },
    approx: 1,
    unit: COUNT_UNIT,
    answerText: c.op,
    split: {
      parts: `${c.from} → ${c.to}`,
      small: `Will the number get bigger or smaller? ${bigger ? 'Bigger' : 'Smaller'}.`,
      zeros: '',
      back: `Bigger means multiply, smaller means divide: ${c.op}.`,
      sanity: c.why,
    },
    traps: ['direction'],
    answerForm: 'direction',
    move: { from: c.from, to: c.to, op: c.op },
  };
}

/** 5 × 10² → 500. */
export function sciToNumberItem(key: string, p: { m: number; exp: number }): EnvelopeItem {
  const value = Math.round(p.m * 10 ** p.exp);
  const ten = 10 ** p.exp;
  return {
    key,
    kind: 'sci-to-number',
    family: 'quick',
    question: `Write ${fmt(p.m)} × ${pow10(p.exp)} as a normal number.`,
    expected: { value, dim: 'count', per: null },
    approx: value,
    unit: COUNT_UNIT,
    answerText: value >= 1e6 ? `${commas(value)} (${spoken(value)})` : commas(value),
    split: {
      parts: `${pow10(p.exp)} = 1 followed by ${zerosWord(p.exp)} = ${commas(ten)}`,
      small: `${fmt(p.m)} × ${commas(ten)}`,
      zeros: `${pow10(p.exp)}: the little number ${p.exp} is the TOTAL zero count`,
      back: `${fmt(p.m)} × ${commas(ten)} = ${commas(value)}`,
      sanity: `Not ${commas(value * 10)}: the 0 in "10" is not an extra zero.`,
    },
    traps: ['zeros', 'unit-ladder'],
    answerForm: 'exact',
  };
}

/** 8,000 GB → 8 TB: each comma knocked off = one unit up. */
export function commaItem(key: string, p: { n: number; fromExp: number; toExp: number }): EnvelopeItem {
  const from = BYTE_UNIT_AT[p.fromExp];
  const to = BYTE_UNIT_AT[p.toExp];
  const steps = (p.toExp - p.fromExp) / 3;
  const inTarget = p.n / 10 ** (p.toExp - p.fromExp);
  const path = Object.entries(BYTE_UNIT_AT)
    .map(([e, l]) => [Number(e), l] as const)
    .filter(([e]) => e >= p.fromExp && e <= p.toExp)
    .map(([, l]) => l)
    .join(' → ');
  return {
    key,
    kind: 'sci-to-number',
    family: 'quick',
    question: `${commas(p.n)} ${from} is how many ${to}?`,
    expected: { value: p.n * 10 ** p.fromExp, dim: 'bytes', per: null },
    approx: p.n * 10 ** p.fromExp,
    unit: { label: to, factor: 10 ** p.toExp },
    answerText: `${fmt(inTarget, 4)} ${to}`,
    split: {
      parts: `${commas(p.n)} ${from}`,
      small: `Commas to knock off: ${steps} (${path})`,
      zeros: `Each comma is 10³, one unit up: ${pow10(p.toExp - p.fromExp)} in all`,
      back: `${commas(p.n)} ${from} → ${fmt(inTarget, 4)} ${to}`,
      sanity: 'Each comma knocked off = one unit up: bytes → KB → MB → GB → TB.',
    },
    traps: ['unit-ladder', 'zeros'],
    answerForm: 'exact',
    inUnit: true,
  };
}

// -----------------------------------------------------------------------------
// The seeded generator
// -----------------------------------------------------------------------------
/** mulberry32: tiny, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const MANT = [1, 2, 3, 4, 5, 6, 8] as const;

const RATE_NOUNS = ['requests', 'API calls', 'page views', 'messages', 'searches', 'log lines', 'events'] as const;
const DAY_LEADS = ['Say your service handles', 'Say the app gets', 'Imagine the system sees'] as const;
const MONTH_LEADS = ['Say you get', 'Say the platform serves', 'Imagine you process'] as const;
const SEC_LEADS = ['Your API averages', 'Say the service takes', 'Imagine you ingest'] as const;
const VOLUME_NOUNS = ['logs', 'event tables', 'metrics', 'audit records'] as const;

/** One item of `kind` from a seed. Same (kind, seed) → same item, always. */
export function generateItem(kind: EnvelopeKind, seed: number): EnvelopeItem {
  const r = rng(seed * 7919 + ALL_KINDS.indexOf(kind) * 104729 + 1);
  const key = `g:${kind}:${seed}`;
  const big = (lo: number, hi: number) => pick(r, MANT) * 10 ** (lo + Math.floor(r() * (hi - lo + 1)));
  switch (kind) {
    case 'day-to-sec':
      return dayToSec(key, { n: big(6, 9), noun: pick(r, RATE_NOUNS), lead: pick(r, DAY_LEADS) });
    case 'month-to-sec':
      return monthToSec(key, { n: big(7, 10), noun: pick(r, RATE_NOUNS), lead: pick(r, MONTH_LEADS) });
    case 'sec-to-day':
      return secToDay(key, { n: big(1, 4), noun: pick(r, RATE_NOUNS), lead: pick(r, SEC_LEADS) });
    case 'sec-to-month':
      return secToMonth(key, { n: big(1, 4), noun: pick(r, RATE_NOUNS), lead: pick(r, SEC_LEADS) });
    case 'day-to-year':
      return dayToYear(key, { bytes: pick(r, [2, 5, 10, 20, 50, 200, 500]) * 10 ** pick(r, [6, 9]), noun: pick(r, VOLUME_NOUNS) });
    case 'gbps-to-mbs':
      return gbpsToMBs(key, { gbps: pick(r, [1, 10, 25, 40, 100]) });
    case 'mbs-to-gbps':
      return mbsToGbps(key, { mbs: pick(r, [50, 125, 250, 500, 800, 2000]) });
    case 'ladder': {
      const fromExp = pick(r, [6, 9, 12, 15]);
      const up = r() < 0.5;
      const toExp = up ? fromExp - 3 * pick(r, [1, 2]) : fromExp + 3;
      const safeTo = Math.min(15, Math.max(3, toExp));
      return ladderItem(key, { n: pick(r, [1.5, 2, 3.5, 4, 7, 40, 250, 600]), fromExp, toExp: safeTo === fromExp ? fromExp - 3 : safeTo });
    }
    case 'qps':
      return qpsItem(key, {
        users: big(6, 8),
        perUser: pick(r, [5, 10, 20, 30, 50, 100]),
        noun: pick(r, ['requests', 'page loads', 'searches', 'feed refreshes']),
      });
    case 'storage':
      return storageItem(key, {
        perDay: big(5, 7),
        noun: pick(r, ['photos', 'documents', 'voice notes', 'thumbnails']),
        bytesEach: pick(r, [1, 2, 5]) * 10 ** pick(r, [4, 5, 6]),
        copies: 3,
        years: pick(r, [2, 3, 5, 10]),
      });
    case 'storage-day':
      return storageDayItem(key, {
        users: big(6, 8),
        perUser: pick(r, [2, 3, 5]),
        noun: pick(r, ['photos', 'files', 'clips']),
        bytesEach: pick(r, [1, 2, 5]) * 10 ** pick(r, [4, 5, 6]),
      });
    case 'bandwidth':
      return bandwidthItem(key, {
        perSec: big(2, 4),
        noun: pick(r, ['video chunks', 'images', 'file downloads']),
        bytesEach: pick(r, [1, 2, 5]) * 10 ** pick(r, [5, 6]),
      });
    case 'id-space':
      return idSpaceItem(key, { perMonth: big(6, 9), years: pick(r, [5, 10, 20]), noun: pick(r, ['short links', 'invite codes', 'order numbers']) });
    case 'words-to-sci':
      return r() < 0.6
        ? wordsToSciItem(key, { lead: pick(r, [2, 3, 5, 8, 20, 30, 50, 200, 500]), exp: pick(r, [3, 6, 9, 12]), dim: 'count' })
        : wordsToSciItem(key, { lead: pick(r, [2, 5, 20, 50, 200, 500]), exp: pick(r, [3, 6, 9, 12]), dim: 'bytes' });
    case 'direction':
      return directionItem(key, pick(r, DIRECTIONS));
    case 'sci-to-number': {
      const v = r();
      if (v < 0.5) return sciToNumberItem(key, { m: pick(r, [1, 2, 3, 4, 5, 8, 2.5, 1.5]), exp: 1 + Math.floor(r() * 9) });
      const fromExp = pick(r, [0, 3, 6, 9]);
      const steps = pick(r, [1, 1, 2]);
      const toExp = Math.min(12, fromExp + 3 * steps);
      return commaItem(key, { n: pick(r, [2, 3, 5, 8, 25, 40, 250]) * 10 ** (toExp - fromExp), fromExp, toExp });
    }
  }
}

/** `g:<kind>:<seed>` → the item, or null for anything else. */
export function itemFromKey(key: string): EnvelopeItem | null {
  const m = /^g:([a-z-]+):(\d{1,10})$/.exec(key);
  if (!m || !isEnvelopeKind(m[1])) return null;
  return generateItem(m[1], Number(m[2]));
}

/**
 * `n` generated items from a seed: alternating conversions and estimates
 * (conversions first — they are the reps), no kind twice in a row.
 */
export function generateSet(seed: number, n: number): EnvelopeItem[] {
  const r = rng(seed);
  const out: EnvelopeItem[] = [];
  let last: EnvelopeKind | null = null;
  for (let i = 0; i < n; i++) {
    const pool = (i % 3 === 2 ? ESTIMATE_KINDS : CONVERSION_KINDS).filter((k) => k !== last);
    const kind = pick(r, pool);
    out.push(generateItem(kind, Math.floor(r() * 1e9)));
    last = kind;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Answer parsing
// -----------------------------------------------------------------------------
const MULT: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mil: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
};
const PREFIX: Readonly<Record<string, number>> = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 };
const PREFIX_WORD: Readonly<Record<string, string>> = { kilo: 'k', mega: 'm', giga: 'g', tera: 't', peta: 'p' };

export interface ParsedAnswer {
  /** The number as typed, times any million/billion word. */
  number: number;
  /** A data unit, when one was written. */
  dim: Dim | null;
  /** Multiplier from a data-unit prefix (K/M/G/T/P), 1 without. */
  prefix: number;
  per: Per | null;
  /** A ladder word or unit was written (million, M, GB…). */
  hadUnit: boolean;
}

function normalizeDigits(s: string): string {
  return s.replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => `^${m.split('').map((c) => UNSUP[c] ?? c).join('')}`);
}

/** Parse "30M", "3e7", "8 TB", "125MB/s", "~800", "5 × 10^7 per day". Null when no number. */
export function parseAnswer(text: string): ParsedAnswer | null {
  let s = normalizeDigits(text.trim())
    .replace(/[~≈]/g, ' ')
    .replace(/\b(about|around|roughly|approx(?:imately)?|ish|maybe)\b/gi, ' ')
    .trim();
  // 1,234,567 → 1234567 (a comma between digit groups only).
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const num = /(-?\d*\.?\d+)(?:\s*e\s*([+-]?\d+))?(?:\s*(?:x|×|\*)\s*10\s*\^?\s*([+-]?\d+))?/i.exec(s);
  if (!num) return null;
  let number = Number(num[1]);
  if (num[2]) number *= 10 ** Number(num[2]);
  if (num[3]) number *= 10 ** Number(num[3]);
  if (!Number.isFinite(number)) return null;
  let rest = s.slice(num.index + num[0].length).trim();
  let hadUnit = false;

  // A data unit: GB, Gb, gigabytes, Gbps, MB/s, megabits …
  let dim: Dim | null = null;
  let prefix = 1;
  const word = /^(kilo|mega|giga|tera|peta)?(bytes?|bits?)\b/i.exec(rest);
  const abbr = /^([kKmMgGtTpP]?)i?(B|b)(ps|it|its|yte|ytes)?(?![a-zA-Z])/.exec(rest);
  if (word && (word[1] || /^(bytes?|bits?)/i.test(rest))) {
    prefix = PREFIX[PREFIX_WORD[(word[1] ?? '').toLowerCase()] ?? ''] ?? 1;
    dim = /^bit/i.test(word[2]) ? 'bits' : 'bytes';
    rest = rest.slice(word[0].length).trim();
    hadUnit = true;
  } else if (abbr && !(abbr[1] === '' && !abbr[3])) {
    // "8TB", "125MB/s", "10Gbps". A lone "B"/"b" with no prefix is "billion" ("10B"), not bytes.
    prefix = PREFIX[abbr[1].toLowerCase()] ?? 1;
    // Bits only when the answer says so: "bit(s)", a rate in "bps", or the
    // conventional mixed case "Gb"/"Mb". All-lowercase "gb"/"tb" is how people
    // type bytes, and reading "8 tb" as terabits failed a right answer.
    const casualLower = abbr[1] !== '' && abbr[1] === abbr[1].toLowerCase() && !abbr[3];
    dim = /^it/.test(abbr[3] ?? '') ? 'bits' : abbr[2] === 'B' || casualLower ? 'bytes' : 'bits';
    if (abbr[3] === 'ps') rest = `/s ${rest.slice(abbr[0].length)}`;
    else rest = rest.slice(abbr[0].length);
    rest = rest.trim();
    hadUnit = true;
  } else {
    const mult = /^(thousand|million|billion|trillion|mil|bn|tn|mm|k|m|b|t)\b/i.exec(rest);
    if (mult) {
      number *= MULT[mult[1].toLowerCase()];
      rest = rest.slice(mult[0].length).trim();
      hadUnit = true;
      // "30 million bytes", "2 billion bits"
      const after = /^(bytes?|bits?)\b/i.exec(rest);
      if (after) {
        dim = /^bit/i.test(after[1]) ? 'bits' : 'bytes';
        rest = rest.slice(after[0].length).trim();
      }
    }
  }

  // A period: /s, per second, a day, /mo, rps, qps …
  let per: Per | null = null;
  const p = rest.toLowerCase();
  if (/^(\/\s*s(ec(ond)?)?\b|per\s+s(ec(ond)?)?\b|an?\s+second|each\s+second|ps\b|rps\b|qps\b|req(uest)?s?\s*(\/|per)\s*s)/.test(p)) per = 's';
  else if (/^(\/\s*d(ay)?\b|per\s+day|a\s+day|each\s+day|daily)/.test(p)) per = 'day';
  else if (/^(\/\s*mo(nth)?\b|per\s+month|a\s+month|monthly)/.test(p)) per = 'month';
  else if (/^(\/\s*y(ea)?r\b|per\s+year|a\s+year|yearly)/.test(p)) per = 'year';
  else {
    // "requests per second", "per second" after a noun.
    const tail = /(?:\/|per|a)\s*(s|sec|second|day|d|mo|month|yr|year)\b/.exec(p);
    if (tail) per = tail[1].startsWith('s') ? 's' : tail[1].startsWith('d') ? 'day' : tail[1].startsWith('m') ? 'month' : 'year';
  }
  return { number, dim, prefix, per, hadUnit };
}

/**
 * The typed answer as a value in the item's base unit and period. Converts
 * periods (30M a day for a per-second question), and bits ↔ bytes (a quantity
 * stated in the other unit is still that quantity). A bare number on a data
 * question is read in the question's unit.
 */
export function toItemValue(p: ParsedAnswer, item: EnvelopeItem): number {
  const want = item.expected;
  let v: number;
  if (want.dim === 'count') {
    v = p.number * p.prefix;
  } else if (p.dim === null) {
    v = p.number * item.unit.factor;
  } else {
    v = p.number * p.prefix;
    if (p.dim !== want.dim) v = p.dim === 'bytes' ? v * 8 : v / 8;
  }
  if (want.per && p.per && p.per !== want.per) v = (v * SECONDS[want.per]) / SECONDS[p.per];
  return v;
}

// -----------------------------------------------------------------------------
// Checking + the miss classifier
// -----------------------------------------------------------------------------
export interface EnvelopeVerdict {
  ok: boolean;
  /** The answer read back in the item's unit ("≈ 20 per second"). */
  read: string;
  given: number;
  /** log10(given / exact), 2 decimals. 0 = spot on. */
  orders: number;
  /** "Right — within 30%." / "Off by 10⁴, too high." / "About 2.3× too low." */
  verdict: string;
  cause: EnvelopeCause | null;
  causeText: string | null;
}

const near = (x: number, target: number, band = 1.35) => x >= target / band && x <= target * band;

/** Which known slip explains a ratio (given/exact). Pure; null when none fits. */
export function classifyMiss(ratio: number, item: Pick<EnvelopeItem, 'traps'>, p: Pick<ParsedAnswer, 'hadUnit'> | null): EnvelopeCause {
  const e = Math.log10(ratio);
  const k = Math.round(e);
  const traps = new Set(item.traps);
  // A month is 30 days exactly, 25 with the anchors: the slip lands near 1/27.5.
  if (traps.has('month-for-day') && (near(ratio, 1 / 27.5, 1.45) || near(ratio, 27.5, 1.45))) return 'month-for-day';
  if (traps.has('bits-bytes') && (near(ratio, 8, 1.3) || near(ratio, 1 / 8, 1.3))) return 'bits-bytes';
  const powerOfTen = Math.abs(e - k) < 0.16 && k !== 0;
  // A clean 10³/10⁶/10⁹ step: the digits were right and the unit slipped.
  void p;
  if (powerOfTen && k % 3 === 0 && traps.has('unit-ladder')) return 'unit-ladder';
  if (powerOfTen) return 'zeros';
  if (Math.abs(e) >= 0.5 && Math.abs(e - k) < 0.3 && k !== 0) return 'zeros';
  return 'arithmetic';
}

/**
 * "500 million" written 5 × 10⁶: too low by exactly the front number's own
 * zeros (500 → two). Only on words-to-sci, where the front number is known.
 */
function droppedOwnZeros(item: Pick<EnvelopeItem, 'kind' | 'expected'>, ratio: number): boolean {
  if (item.kind !== 'words-to-sci') return false;
  const leadZeros = sci(item.expected.value).e % 3;
  return leadZeros > 0 && Math.abs(Math.log10(ratio) + leadZeros) < 0.05;
}

const PER_WORD: Readonly<Record<Per, string>> = { s: 'per second', day: 'per day', month: 'per month', year: 'per year' };

/**
 * Why a conversion answer only restates the question (null when it does not):
 * its period, or its data unit (bits vs bytes), differs from the one asked for.
 * A total over a year (day-to-year) may say "a year"; nothing else may name
 * another period. Estimate items are left alone — there a stated unit is
 * converted, as before. Pure.
 */
export function restatesQuestion(p: Pick<ParsedAnswer, 'per' | 'dim'>, item: Pick<EnvelopeItem, 'family' | 'expected'>): string | null {
  if (item.family !== 'conversion') return null;
  const want = item.expected;
  if (p.per && p.per !== want.per && !(want.per === null && p.per === 'year')) {
    return `That is ${PER_WORD[p.per]} — the question asks ${want.per ? PER_WORD[want.per] : 'for the total'}. Do the conversion and answer in that.`;
  }
  if (p.dim && want.dim !== 'count' && p.dim !== want.dim) {
    return `That is in ${p.dim} — the question asks for ${want.dim}. Convert it (1 byte = 8 bits) and answer in ${want.dim}.`;
  }
  return null;
}

/** "divide" / "÷" / "/" → divide; "multiply" / "times" / "×" / "x" / "*" → multiply. */
export function parseDirection(text: string): 'divide' | 'multiply' | null {
  const t = text.trim().toLowerCase();
  if (/^(div|divide[sd]?|dividing|÷|\/)/.test(t) || /^(÷|\/)\s*\d/.test(t)) return 'divide';
  if (/^(mul|multipl\w*|times|×|x|\*)/.test(t)) return 'multiply';
  return null;
}

/**
 * Why an answer is not in the form a quick item asks for (null when it is).
 * The service answers 400 with this instead of grading: "500000000" for
 * "write it as small × 10ⁿ" is not wrong, it is the wrong exercise.
 */
export function formHint(item: Pick<EnvelopeItem, 'kind' | 'answerForm'>, text: string): string | null {
  if (item.answerForm === 'direction') return parseDirection(text) ? null : 'Type one word: divide or multiply.';
  if (item.kind === 'words-to-sci' && !/(10\s*\^|10[⁰¹²³⁴⁵⁶⁷⁸⁹]|\de\s*\d)/i.test(text)) return 'Write it as small × 10ⁿ, like 5 × 10^8.';
  return null;
}

function checkDirection(item: EnvelopeItem, text: string): EnvelopeVerdict | null {
  const d = parseDirection(text);
  if (!d || !item.move) return null;
  const ok = d === item.move.op;
  return {
    ok,
    read: d,
    given: ok ? 1 : 0,
    orders: 0,
    verdict: ok ? `Right: ${item.move.op}.` : `Not quite: this one is ${item.move.op}.`,
    cause: ok ? null : 'direction',
    causeText: ok ? null : item.split.sanity,
  };
}

/** The tolerance an item is graded at: 2% for quick (exact) items, else 30%. */
export function toleranceOf(item: Pick<EnvelopeItem, 'answerForm'>): number {
  return item.answerForm === 'exact' ? 0.02 : ENVELOPE_TOLERANCE;
}

export function checkAnswer(item: EnvelopeItem, text: string): EnvelopeVerdict | null {
  if (item.answerForm === 'direction') return checkDirection(item, text);
  // "8000 GB or 8 TB", "8000 GB = 8 TB": every alternative must be right, so a
  // hedge ("500 or 5000") still fails; the first wrong one is the verdict.
  const parts = text.split(/\s+or\s+|\s*=\s*/i).filter((t) => t.trim());
  if (parts.length > 1) {
    const verdicts = parts.map((t) => checkAnswer(item, t)).filter((v): v is EnvelopeVerdict => v !== null);
    if (verdicts.length) return verdicts.find((v) => !v.ok) ?? verdicts[0];
  }
  const p = parseAnswer(text);
  if (!p) return null;
  let given = toItemValue(p, item);
  const exact = item.expected.value;
  // A bare number on a data question is read in the question's unit — unless
  // it only makes sense as raw bytes/bits ("2e14" for 200 TB).
  if (p.dim === null && item.expected.dim !== 'count' && item.unit.factor !== 1) {
    const raw = p.number * p.prefix;
    if (Math.abs(Math.log10(raw / exact)) < Math.abs(Math.log10(given / exact)) && Math.abs(raw / exact - 1) <= ENVELOPE_TOLERANCE) given = raw;
  }
  const read = item.exactInt
    ? `${fmt(given)}`
    : item.kind === 'words-to-sci'
      ? `${fmtSci(given)}${item.expected.dim === 'bytes' ? ' bytes' : ''}`
      : item.kind === 'sci-to-number' && item.expected.dim === 'count'
        ? commas(given)
        : fmtQuantity(given, item.expected.dim, item.expected.per, 3);
  if (!(given > 0)) {
    return { ok: false, read, given, orders: 0, verdict: 'That is not a positive number.', cause: 'arithmetic', causeText: ENVELOPE_CAUSE_TEXT.arithmetic };
  }
  const ratio = given / exact;
  const orders = Math.round(Math.log10(ratio) * 100) / 100;
  // RESTATING THE QUESTION IS NOT AN ANSWER (Phase H). On a conversion item the
  // whole task is the change of unit or period, and toItemValue converts any
  // stated unit — so "50M a day" for a per-second question, or "1 Gbps" for a
  // megabytes-per-second one, read back as exactly right. An answer whose
  // period or data unit differs from the one asked for is rejected here.
  const restated = restatesQuestion(p, item);
  if (restated) {
    return { ok: false, read, given, orders, verdict: restated, cause: null, causeText: null };
  }
  // "8,000 GB is how many TB?" answered "8,000 GB" restates it too.
  if (item.inUnit && p.dim !== null && p.prefix !== item.unit.factor) {
    return {
      ok: false,
      read,
      given,
      orders,
      verdict: `Finish in ${item.unit.label}: the question asks how many ${item.unit.label}.`,
      cause: 'wrong-unit',
      causeText: ENVELOPE_CAUSE_TEXT['wrong-unit'],
    };
  }
  const tol = toleranceOf(item);
  const ok = item.exactInt
    ? given === exact || given === exact + 1
    : Math.abs(ratio - 1) <= tol || Math.abs(given / item.approx - 1) <= tol;
  if (ok) {
    return { ok, read, given, orders, verdict: item.exactInt || item.answerForm === 'exact' ? 'Right.' : 'Right — within 30%.', cause: null, causeText: null };
  }
  const e = Math.log10(ratio);
  const k = Math.round(e);
  const dir = ratio > 1 ? 'too high' : 'too low';
  const factor = ratio > 1 ? ratio : 1 / ratio;
  const verdict =
    item.exactInt && Math.abs(given - exact) <= 3
      ? `${given < exact ? 'Too short' : 'Longer than needed'}: ${fmt(exact)} characters is the answer.`
      : k !== 0 && (Math.abs(e - k) < 0.2 || factor >= 100)
        ? `Off by ${pow10(Math.abs(k))}, ${dir}.`
        : k === 0
          ? `About ${fmt(factor, 2)}× ${dir} — the right order of magnitude, but ${item.answerForm === 'exact' ? 'not exact' : 'outside 30%'}.`
          : `About ${fmt(factor, 2)}× ${dir}.`;
  const cause = droppedOwnZeros(item, ratio) ? 'own-zeros' : classifyMiss(ratio, item, p);
  return { ok, read, given, orders, verdict, cause, causeText: ENVELOPE_CAUSE_TEXT[cause] };
}

// -----------------------------------------------------------------------------
// Mock gaps → an Envelope card
// -----------------------------------------------------------------------------
/** Gap concepts that are about estimation. */
export const ESTIMATION_CONCEPTS: readonly string[] = ['capacity', 'scale-estimation'];

const ESTIMATION_WORDS = /\b(capacity|estimat\w*|per second|requests? a second|qps|rps|throughput|storage|bandwidth|seconds in a (day|month|year)|back[- ]of[- ](the[- ])?envelope)\b/i;

export function isEstimationGap(g: { concept: string; title: string; summary?: string }): boolean {
  return ESTIMATION_CONCEPTS.includes(g.concept) || ESTIMATION_WORDS.test(`${g.title} ${g.summary ?? ''}`);
}

const VOL = /(\d+(?:\.\d+)?)\s*(k|m|b|thousand|million|billion|trillion)?\s+([a-z][a-z ]{1,28}?)\s*(?:\/|per |a |each )\s*(day|month)\b/gi;

/**
 * The biggest "N things per day/month" in a gap's text, as an Envelope item
 * ("Say you get 10 billion redirects a month. Roughly how many is that per
 * second?"). Null when the text has no such volume.
 */
export function envelopeFromGapText(key: string, text: string): EnvelopeItem | null {
  let best: { n: number; noun: string; per: 'day' | 'month' } | null = null;
  for (const m of text.matchAll(VOL)) {
    const n = Number(m[1]) * (m[2] ? MULT[m[2].toLowerCase()] : 1);
    if (!(n >= 1e4)) continue;
    const noun = m[3].trim().replace(/\s+/g, ' ');
    if (/^(and|or|to|of|the|per)\b/.test(noun)) continue;
    const per = m[4].toLowerCase() as 'day' | 'month';
    if (!best || n > best.n) best = { n, noun, per };
  }
  if (!best) return null;
  return best.per === 'month'
    ? monthToSec(key, { n: best.n, noun: best.noun, lead: 'Say you get' })
    : dayToSec(key, { n: best.n, noun: best.noun, lead: 'Say you get' });
}

// -----------------------------------------------------------------------------
// The five seeded cards (the 2026-10-21 diagnostic)
// -----------------------------------------------------------------------------
export function seedItems(): EnvelopeItem[] {
  return [
    dayToSec('seed:50m-day-to-sec', { n: 50e6, noun: 'requests', lead: 'Say your service handles' }),
    monthToSec('seed:2b-month-to-sec', { n: 2e9, noun: 'page views', lead: 'Say you get' }),
    secToDay('seed:300-sec-to-day', { n: 300, noun: 'requests', lead: 'Your API averages' }),
    dayToYear('seed:20gb-day-to-year', { bytes: 20e9, noun: 'logs' }),
    storageDayItem('seed:500m-users-photos', { users: 500e6, perUser: 2, noun: 'photos', bytesEach: 200e3 }),
  ];
}

// -----------------------------------------------------------------------------
// Wire types
// -----------------------------------------------------------------------------
/** What the client is served before answering: no answer, no split. */
export interface EnvelopePrompt {
  key: string;
  kind: EnvelopeKind;
  family: EnvelopeItem['family'];
  question: string;
  /** The unit a bare number is read in ('' = a plain count). */
  unitHint: string;
  /** True when this is a due review card, not a fresh rep. */
  card: boolean;
  /** Guided mode can walk this one step by step (Phase I). */
  guided?: boolean;
}

export interface EnvelopeSession {
  items: EnvelopePrompt[];
  due: number;
  doneToday: number;
  daily: number;
  aiReviews: boolean;
}

export interface EnvelopeCheckResponse {
  attemptId: number;
  ok: boolean;
  read: string;
  orders: number;
  verdict: string;
  cause: EnvelopeCause | null;
  causeText: string | null;
  answerText: string;
  split: EnvelopeSplit;
  /** What happened to the card: "again tomorrow", "again in 2 days", "retired", "new review card". */
  schedule: string;
  /** The page should ask for the AI note (a miss, with AI reviews on). */
  noteAvailable: boolean;
  /** Guided mode: the step that broke first ("Small × 10ⁿ: asked …, typed …"). */
  failedStep?: string | null;
}

export interface EnvelopeNote {
  slip: string;
  fix: string;
  costUsd: number | null;
}

export interface EnvelopeStatsDay {
  date: string;
  n: number;
  accuracy: number;
  /** Mean |log10(given/exact)| that day. */
  meanAbsOrders: number;
}

export interface EnvelopeStats {
  total: number;
  recentAccuracy: number | null;
  recentMeanAbsOrders: number | null;
  recentN: number;
  byDay: EnvelopeStatsDay[];
  causes: { cause: EnvelopeCause; n: number }[];
  due: number;
  cards: number;
  /** Phase I: error rate per guided step type. */
  steps?: StepTypeStat[];
}

/** The Today warm-up's "Envelope ×5". */
export interface TodayEnvelope {
  daily: number;
  doneToday: number;
  correctToday: number;
  /** Cards due now. */
  due: number;
  /** What is left for the warm-up: max(due, daily - doneToday). */
  remaining: number;
  done: boolean;
  href: string;
  /** Phase I: the warm-up is guided while still learning (< 20 answers or < 70%). */
  guided?: boolean;
  /** Today's one skill while guided ("per day → per second"). */
  skill?: { id: string; label: string } | null;
  /** What the warm-up link adds ("&guided=1&skill=per-second"). */
  query?: string;
}

export function envelopeRemaining(daily: number, doneToday: number, due: number): number {
  return Math.max(due, Math.max(0, daily - doneToday));
}

export function toPrompt(item: EnvelopeItem, card: boolean): EnvelopePrompt {
  return {
    key: item.key,
    kind: item.kind,
    family: item.family,
    question: item.question,
    unitHint: item.unit.label,
    card,
  };
}
