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

export interface GuidedStep {
  type: StepType;
  /** One short question. */
  prompt: string;
  /** One short nudge, shown on request. */
  hint: string;
  /** The right answer, as shown after the step (and when the step is auto-filled). */
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
    hint: bits
      ? 'Bits are tiny pieces, 8 per byte. To bits = more = × 8. To bytes = fewer = ÷ 8.'
      : 'Spreading out (per day → per second) makes each piece smaller: divide. Piling up makes it bigger: multiply.',
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
      hint: lead && lead.zeros > 0
        ? `Split the front number first: ${fmt(lead.n)} = ${fmt(sci(lead.n).m)} × ${pow10(lead.zeros)}. Then ${lead.word} = ${pow10(lead.wordExp)}. Add the little numbers.`
        : '10ⁿ means 1 followed by n zeros, in total. Keep the front number between 1 and 10.',
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
      hint: pairs.some((p) => p.op === '÷' && p.a < p.b)
        ? 'When the top number is smaller than the bottom one, the answer is under 1 (like 2 ÷ 2.5 = 0.8).'
        : 'Ignore the 10ⁿ parts. Just the front numbers.',
      answer: fmt(small),
      expect: { kind: 'small', value: small, pairs },
    });
    steps.push({
      type: 'exponent',
      prompt: `Exponents: ${zText} = 10 to the what? (type the little number)`,
      hint: 'Multiply → add the little numbers. Divide → subtract them.',
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
    hint:
      dim === 'count'
        ? `${pow10(exp)} = 1 followed by ${exp} zeros. Write it out with commas: each comma is one word up (thousand → million → billion).`
        : `Write it out with commas, then knock them off: each comma = one unit up (${dim === 'bits' ? 'bits → Kb → Mb → Gb' : 'bytes → KB → MB → GB → TB'}).`,
    answer: dim === 'count' ? commaNumber(valueInUnit) : `${fmt(valueInUnit, 3)} ${item.unit.label}`,
    expect: { kind: 'back', value: valueInUnit, small, exp, unitLabel: item.unit.label, unitExp, dim, inUnit },
  });

  steps.push({
    type: 'unit',
    prompt: `Final answer, ${wantText(item)}. Write the unit too.`,
    hint: 'Write the target unit first, then put the number in front of it.',
    answer: item.answerText.replace(/^≈ /, ''),
    expect: { kind: 'unit' },
  });
  return steps;
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
/** A step type is auto-filled after this many right in a row; a miss brings it back. */
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
/** A guided step as served: no answer unless the step is auto-filled. */
export interface GuidedStepPrompt {
  index: number;
  type: StepType;
  label: string;
  prompt: string;
  hint: string;
  /** Faded: shown filled in, not asked. */
  auto: boolean;
  answer: string | null;
}

export interface GuidedPlanResponse {
  key: string;
  steps: GuidedStepPrompt[];
  /** Right-in-a-row per step type, for the "auto-filled after 3" note. */
  streaks: Record<StepType, number>;
}

export interface StepCheckResponse {
  ok: boolean;
  slip: StepSlip | null;
  feedback: string;
  /** The right answer, to carry forward. */
  answer: string;
  streak: number;
  /** This step type is now auto-filled. */
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
