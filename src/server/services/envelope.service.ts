// =============================================================================
// envelope.service — the Envelope math drill (Phase G)
// =============================================================================
//   session   due cards first, then fresh generated reps up to N       free
//   check     parse + classify + record + move the card                free
//   note      ONE small call on a miss, gated by "AI reviews"          ~$0.002
//   stats     accuracy and mean |orders of magnitude| over time        free
//
// The generator, parser and classifier are pure (shared/envelope.ts). Cards use
// the gap-card ladder [0,2,5,10] through recognize.compute's
// scheduleRecognizeCard: a miss comes back TOMORROW, not now — you just read the
// worked split, so "now" would test memory, not the method.

import { newCardSchedule, describeOutcome, isDoubleGrade, scheduleGapCard, type GapCardGrade } from '../../shared/gap-cards.js';
import {
  DEFAULT_ENVELOPE_SIZE,
  ENVELOPE_CAUSES,
  checkAnswer,
  envelopeFromGapText,
  envelopeRemaining,
  formHint,
  generateItem,
  generateSet,
  isEnvelopeKind,
  isEstimationGap,
  itemFromKey,
  rng,
  seedItems,
  toPrompt,
  type EnvelopeKind,
  type EnvelopePrompt,
  type EnvelopeCause,
  type EnvelopeCheckResponse,
  type EnvelopeItem,
  type EnvelopeNote,
  type EnvelopeSession,
  type EnvelopeStats,
  type EnvelopeStatsDay,
  type TodayEnvelope,
} from '../../shared/envelope.js';
import {
  ANCHOR_CARDS,
  ANCHOR_SECONDS,
  FADE_AFTER,
  GUIDED_DAILY,
  SPEED_KINDS,
  SPEED_ROUND_MS,
  STEP_LABEL,
  STEP_TYPES,
  anchorById,
  anchorGrade,
  checkAnchor,
  checkFinalStep,
  checkStep,
  dailySkill,
  fadedTypes,
  guidedForToday,
  guidedPlan,
  pickWeighted,
  practiceWeights,
  scoreSpeedRound,
  skillById,
  stepStreaks,
  unfadeOnMiss,
  type AnchorCheckResponse,
  type AnchorSession,
  type GuidedPlanResponse,
  type SpeedRoundResult,
  type SpeedRoundStart,
  type StepCheckResponse,
  type StepSlip,
  type StepTypeStat,
} from '../../shared/envelope-learn.js';
import { getSetting } from './db.js';
import { aiReviewsEnabled, costOfMeta } from './ai-usage.service.js';
import { scheduleRecognizeCard } from './recognize.compute.js';
import { dayStartMs, localDay, todayTz } from './today.compute.js';
import { ENVELOPE_CAUSE_TEXT } from '../../shared/envelope.js';
import { runEnvelopeNote } from './llm.envelope.js';
import * as store from './envelope.store.js';

export class EnvelopeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
  }
}

/** Settings key: Envelope reps in Today's warm-up (default 5; 0 turns it off). */
export const ENVELOPE_DAILY_KEY = 'envelope.daily';

export function envelopeDaily(): number {
  try {
    const v = getSetting<unknown>(ENVELOPE_DAILY_KEY);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(20, Math.round(v))) : DEFAULT_ENVELOPE_SIZE;
  } catch {
    return DEFAULT_ENVELOPE_SIZE;
  }
}

/** A key → its item: a card's stored item first, else a generated key. */
function resolveItem(key: unknown): { item: EnvelopeItem; card: store.EnvelopeCardRow | null } {
  if (typeof key !== 'string' || !key || key.length > 80) throw new EnvelopeError('key is required.', 400);
  const card = store.getCard(key);
  if (card) return { item: withSteps(card.item), card };
  const item = itemFromKey(key);
  if (!item) throw new EnvelopeError('No such envelope question.', 404);
  return { item, card: null };
}

/**
 * An item stored before Phase I has no factors (no guided steps). Seeded and
 * generated keys rebuild the same item, with them; others stay plain.
 */
function withSteps(item: EnvelopeItem): EnvelopeItem {
  if (item.factors) return item;
  const again = item.key.startsWith('seed:') ? seedItems().find((s) => s.key === item.key) : itemFromKey(item.key);
  return again && again.kind === item.kind ? again : item;
}

function prompt(item: EnvelopeItem, card: boolean): EnvelopePrompt {
  return { ...toPrompt(item, card), guided: guidedPlan(withSteps(item)) !== null };
}

export interface SessionOptions {
  /** One drill kind only (the picker); no due cards. */
  kind?: unknown;
  /** Today's skill: due cards first, then this skill's kinds. */
  skill?: unknown;
  /** 'endless': due cards first, then weighted to what is missed most. */
  mode?: unknown;
}

/** GET /api/envelope/session?n=&kind=&skill=&mode= — due cards first, then fresh reps. */
export function startSession(nRaw: unknown, now = new Date(), opts: SessionOptions = {}): EnvelopeSession {
  const n = Math.max(1, Math.min(20, Number(nRaw) || DEFAULT_ENVELOPE_SIZE));
  const seed = now.getTime() % 2_147_483_647;
  const dayStart = dayStartIso(now);
  const base = { doneToday: store.attemptsSince(dayStart).length, daily: envelopeDaily(), aiReviews: aiReviewsEnabled() };
  if (opts.kind !== undefined && opts.kind !== '') {
    if (!isEnvelopeKind(opts.kind)) throw new EnvelopeError('No such drill type.', 400);
    const kind = opts.kind;
    const items = Array.from({ length: n }, (_, i) => generateItem(kind, (seed + i * 7_919) % 1_000_000_000));
    return { ...base, items: items.map((i) => prompt(i, false)), due: store.cardCounts(now).due };
  }
  const due = store.dueCards(now);
  const cards = due.slice(0, Math.max(n, Math.min(due.length, 10)));
  const want = Math.max(0, n - cards.length);
  const skill = skillById(opts.skill);
  let fresh: EnvelopeItem[];
  if (skill) {
    const r = rng(seed);
    const kinds = skill.kinds as readonly EnvelopeKind[];
    const start = Math.floor(r() * kinds.length);
    fresh = Array.from({ length: want }, (_, i) => generateItem(kinds[(start + i) % kinds.length], Math.floor(r() * 1e9)));
  } else if (opts.mode === 'endless') {
    const r = rng(seed);
    const weights = practiceWeights(store.kindRows(), store.recentSteps());
    fresh = Array.from({ length: want }, () => generateItem(pickWeighted(weights, r), Math.floor(r() * 1e9)));
  } else {
    fresh = generateSet(seed, want);
  }
  return {
    ...base,
    items: [...cards.map((c) => prompt(c.item, true)), ...fresh.map((i) => prompt(i, false))],
    due: due.length,
  };
}

/** Local midnight, by the same tz rule Today uses. */
function dayStartIso(now: Date): string {
  const tz = todayTz();
  return new Date(dayStartMs(localDay(now.getTime(), tz), tz)).toISOString();
}

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.slice(0, max) : '');

/** POST /api/envelope/check — {key, answer, working?}. Free. */
export function check(body: unknown, now = new Date()): EnvelopeCheckResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const { item, card } = resolveItem(b.key);
  const answer = str(b.answer, 200).trim();
  const working = str(b.working, 4000).trim();
  if (!answer) throw new EnvelopeError('Type an answer first (a number, with a unit if it has one).', 400);
  const hint = formHint(item, answer);
  if (hint) throw new EnvelopeError(hint, 400);
  // A double tap on Check answers the same item twice and moves its card twice.
  const lastAt = store.lastAttemptAt(item.key);
  if (isDoubleGrade(lastAt, now)) throw new EnvelopeError('That one was just answered.', 409);
  const guided = b.mode === 'guided' && guidedPlan(item) !== null;
  const final = guided ? checkFinalStep(item, answer) : null;
  const v = final?.verdict ?? checkAnswer(item, answer);
  if (!v) throw new EnvelopeError(`Couldn't read a number from "${answer}". Try "500", "30 million", "3e7" or "8 TB".`, 400);
  const cause = final ? (final.cause ?? null) : v.cause;
  const failedStep = guided ? guidedFailedStep(item, answer, lastAt, final!, now) : null;

  const grade: GapCardGrade = v.ok ? 'got' : 'missed';
  let schedule: string;
  if (card && !card.retiredAt) {
    const next = scheduleRecognizeCard(card, grade, now)!;
    store.updateSchedule(card.key, next);
    schedule = next.retiredAt ? 'retired — answered right at the top of the ladder' : describeEnvelopeOutcome(card, grade);
  } else if (!v.ok) {
    const next = scheduleRecognizeCard(null, 'missed', now)!;
    store.insertCard({ key: item.key, item, source: 'miss' }, next, now);
    schedule = 'new review card — again tomorrow';
  } else {
    schedule = 'not scheduled — you had it';
  }

  const attemptId = store.insertAttempt(
    {
      itemKey: item.key,
      cardKey: card?.key ?? null,
      kind: item.kind,
      question: item.question,
      answer,
      working,
      expected: item.expected.value,
      given: v.given,
      ok: v.ok,
      orders: v.orders,
      cause,
      mode: guided ? 'guided' : 'plain',
      failedStep,
    },
    now
  );

  return {
    attemptId,
    ok: v.ok,
    read: v.read,
    orders: v.orders,
    verdict: final && !final.ok ? final.feedback : v.verdict,
    cause,
    causeText: cause ? ENVELOPE_CAUSE_TEXT[cause] : null,
    answerText: item.answerText,
    split: item.split,
    schedule,
    noteAvailable: !v.ok && aiReviewsEnabled(),
    failedStep,
  };
}

/**
 * Guided mode's bookkeeping at the final answer: record the final step, and on
 * a miss bring back the faded steps it points at. Returns the step that broke
 * first (for the AI note and the reveal), or null when every step was right.
 */
function guidedFailedStep(
  item: EnvelopeItem,
  answer: string,
  lastAt: string | null,
  final: NonNullable<ReturnType<typeof checkFinalStep>>,
  now: Date
): string | null {
  const plan = guidedPlan(item)!;
  const unit = plan[plan.length - 1];
  const faded = fadedTypes(stepStreaks(store.recentSteps()));
  store.insertStep(
    { itemKey: item.key, stepType: 'unit', stepIndex: plan.length - 1, prompt: unit.prompt, answer, ok: final.ok, slip: final.slip, feedback: final.feedback, counted: true },
    now
  );
  if (!final.ok) {
    for (const t of unfadeOnMiss(final.cause ?? null, faded)) {
      store.insertStep({ itemKey: item.key, stepType: t, stepIndex: -1, prompt: '(brought back after a miss)', answer: '', ok: false, slip: null, feedback: '', counted: false }, now);
    }
  }
  const since = lastAt ?? new Date(now.getTime() - 6 * 3_600_000).toISOString();
  const broke = store.itemStepsSince(item.key, since).find((s) => !s.ok);
  if (!broke) return null;
  const label = STEP_LABEL[broke.stepType as keyof typeof STEP_LABEL] ?? broke.stepType;
  return `${label}: asked "${broke.prompt}", typed "${broke.answer}". ${broke.feedback}`.slice(0, 500);
}

// -----------------------------------------------------------------------------
// Guided steps (Phase I)
// -----------------------------------------------------------------------------
/** GET /api/envelope/guided?key= — the item's steps; faded ones come filled in. */
export function guidedSteps(key: unknown): GuidedPlanResponse {
  const { item } = resolveItem(key);
  const plan = guidedPlan(item);
  if (!plan) throw new EnvelopeError('This one has no guided steps; answer it directly.', 409);
  const streaks = stepStreaks(store.recentSteps());
  const faded = fadedTypes(streaks);
  return {
    key: item.key,
    streaks,
    steps: plan.map((s, index) => {
      const auto = faded.has(s.type);
      return { index, type: s.type, label: STEP_LABEL[s.type], prompt: s.prompt, hint: s.hint, auto, answer: auto ? s.answer : null };
    }),
  };
}

/** POST /api/envelope/step — {key, index, answer}. One step, checked and recorded. Free. */
export function checkGuidedStep(body: unknown, now = new Date()): StepCheckResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const { item } = resolveItem(b.key);
  const plan = guidedPlan(item);
  if (!plan) throw new EnvelopeError('This one has no guided steps.', 409);
  const index = Number(b.index);
  const step = Number.isInteger(index) ? plan[index] : undefined;
  if (!step || step.type === 'unit') throw new EnvelopeError('No such step (the final answer goes to /check).', 400);
  const answer = str(b.answer, 120).trim();
  if (!answer) throw new EnvelopeError('Type an answer for this step first.', 400);
  const r = checkStep(step, answer);
  store.insertStep({ itemKey: item.key, stepType: step.type, stepIndex: index, prompt: step.prompt, answer, ok: r.ok, slip: r.slip, feedback: r.feedback, counted: true }, now);
  const streak = stepStreaks(store.recentSteps())[step.type];
  return { ok: r.ok, slip: r.slip, feedback: r.feedback, answer: step.answer, streak, fadesNow: r.ok && streak === FADE_AFTER };
}

/** Error rate per step type, from counted steps. Pure. */
export function computeStepStats(rows: readonly { type: string; ok: boolean; slip: string | null }[]): StepTypeStat[] {
  return STEP_TYPES.map((type) => {
    const mine = rows.filter((r) => r.type === type);
    const slips = new Map<string, number>();
    for (const r of mine) if (!r.ok && r.slip) slips.set(r.slip, (slips.get(r.slip) ?? 0) + 1);
    const top = [...slips.entries()].sort((a, b) => b[1] - a[1])[0];
    return { type, n: mine.length, missed: mine.filter((r) => !r.ok).length, topSlip: (top?.[0] as StepSlip | undefined) ?? null };
  }).filter((s) => s.n > 0);
}

// -----------------------------------------------------------------------------
// Anchor flashcards (Phase I)
// -----------------------------------------------------------------------------
/** GET /api/envelope/anchors — new and due anchor cards, up to 10. */
export function anchorSession(now = new Date()): AnchorSession {
  const rows = new Map(store.anchorRows().map((r) => [r.id, r]));
  const due = ANCHOR_CARDS.filter((c) => {
    const r = rows.get(c.id);
    return !r || (!r.retiredAt && Date.parse(r.dueAt) <= now.getTime());
  });
  return {
    cards: due.slice(0, 10).map((c) => ({ id: c.id, front: c.front, isNew: !rows.has(c.id) })),
    seconds: ANCHOR_SECONDS,
    total: ANCHOR_CARDS.length,
  };
}

/** POST /api/envelope/anchors/check — {id, answer, ms}. Right inside ~10 s = got. */
export function checkAnchorCard(body: unknown, now = new Date()): AnchorCheckResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const card = typeof b.id === 'string' ? anchorById(b.id) : null;
  if (!card) throw new EnvelopeError('No such anchor card.', 404);
  const ms = Math.max(0, Number(b.ms) || 0);
  const ok = checkAnchor(card, str(b.answer, 60));
  const grade: GapCardGrade = anchorGrade(ok, ms);
  const prev = store.getAnchor(card.id);
  if (prev && isDoubleGrade(prev.lastReviewedAt, now)) throw new EnvelopeError('That card was just answered.', 409);
  const next = scheduleGapCard(prev ?? newCardSchedule(now), grade, now);
  store.putAnchor(card.id, next, now);
  const words = prev ? describeOutcome(prev, grade) : grade === 'got' ? 'again in a few days' : 'again next time';
  return { ok, grade, back: card.back, schedule: ok && grade === 'missed' ? `right, but over ${ANCHOR_SECONDS} s: ${words}` : words };
}

// -----------------------------------------------------------------------------
// Speed round (Phase I)
// -----------------------------------------------------------------------------
/** GET /api/envelope/speed — 60 quick items (with answers: the page checks locally). */
export function speedStart(now = new Date()): SpeedRoundStart {
  const r = rng(now.getTime() % 2_147_483_647);
  const items = Array.from({ length: 60 }, () => generateItem(SPEED_KINDS[Math.floor(r() * SPEED_KINDS.length)], Math.floor(r() * 1e9)));
  return { items, ms: SPEED_ROUND_MS, best: store.speedBest(), history: store.speedHistory() };
}

/** POST /api/envelope/speed — {answers: [{key, answer, atMs}]}. Re-graded here; scored; saved. */
export function speedFinish(body: unknown, now = new Date()): SpeedRoundResult {
  const raw = (body as Record<string, unknown> | null)?.answers;
  if (!Array.isArray(raw)) throw new EnvelopeError('answers is required.', 400);
  const graded = raw.slice(0, 200).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const item = typeof o.key === 'string' && o.key.length <= 80 ? itemFromKey(o.key) : null;
    const text = str(o.answer, 120);
    const ok = !!item && !formHint(item, text) && checkAnswer(item, text)?.ok === true;
    return { ok, atMs: Number(o.atMs) };
  });
  const before = store.speedBest();
  const s = scoreSpeedRound(graded.filter((g) => Number.isFinite(g.atMs)));
  store.insertSpeedRound(s, now);
  return { ...s, best: Math.max(before ?? 0, s.score), newBest: before === null ? s.score > 0 : s.score > before };
}

function describeEnvelopeOutcome(card: store.EnvelopeCardRow, grade: GapCardGrade): string {
  const words = describeOutcome(card, grade);
  return words === 'again now' ? 'again tomorrow' : words;
}

const notesInFlight = new Set<number>();

/**
 * POST /api/envelope/note — {attemptId}. One `small` call on a miss, explaining
 * the slip from the typed working. Cached on the attempt; gated by the toggle.
 */
export async function note(body: unknown): Promise<EnvelopeNote> {
  const id = Number((body as Record<string, unknown> | null)?.attemptId);
  if (!Number.isInteger(id) || id <= 0) throw new EnvelopeError('attemptId is required.', 400);
  const a = store.getAttempt(id);
  if (!a) throw new EnvelopeError('No such attempt.', 404);
  if (a.aiNote) return a.aiNote;
  if (a.ok) throw new EnvelopeError('That answer was right — nothing to explain.', 409);
  if (!aiReviewsEnabled()) throw new EnvelopeError('AI reviews are off (Settings).', 409);
  if (notesInFlight.has(id)) throw new EnvelopeError('That note is already being written.', 429);
  const { item } = resolveItem(a.itemKey);
  const v = checkAnswer(item, a.answer);
  notesInFlight.add(id);
  try {
    const { result, meta } = await runEnvelopeNote({
      ...(a.mode === 'guided' && a.failedStep ? { step: a.failedStep } : {}),
      question: item.question,
      answer: item.answerText,
      split: [item.split.parts, item.split.small, item.split.zeros, item.split.back],
      given: a.answer,
      verdict: v?.verdict ?? '',
      cause: v?.causeText ?? '',
      working: a.working,
    });
    if (!result.slip) throw new Error('empty envelope note');
    const n: EnvelopeNote = { ...result, costUsd: costOfMeta(meta) };
    store.putNote(id, n);
    return n;
  } finally {
    notesInFlight.delete(id);
  }
}

/** Accuracy + mean |orders| per local day, and recent totals. Pure. */
export function computeEnvelopeStats(
  rows: readonly { ok: boolean; orders: number; cause: string | null; createdAt: string }[],
  tz: string,
  counts: { due: number; live: number },
  recentWindow = 20
): EnvelopeStats {
  const byDay = new Map<string, { n: number; ok: number; abs: number }>();
  for (const r of rows) {
    const d = localDay(Date.parse(r.createdAt), tz);
    const s = byDay.get(d) ?? { n: 0, ok: 0, abs: 0 };
    s.n += 1;
    if (r.ok) s.ok += 1;
    s.abs += Math.abs(r.orders);
    byDay.set(d, s);
  }
  const days: EnvelopeStatsDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([date, s]) => ({ date, n: s.n, accuracy: s.ok / s.n, meanAbsOrders: Math.round((s.abs / s.n) * 100) / 100 }));
  const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, recentWindow);
  const causes = ENVELOPE_CAUSES.map((cause) => ({ cause, n: rows.filter((r) => r.cause === cause).length })).filter((c) => c.n > 0);
  return {
    total: rows.length,
    recentN: recent.length,
    recentAccuracy: recent.length ? recent.filter((r) => r.ok).length / recent.length : null,
    recentMeanAbsOrders: recent.length ? Math.round((recent.reduce((s, r) => s + Math.abs(r.orders), 0) / recent.length) * 100) / 100 : null,
    byDay: days,
    causes: causes.sort((a, b) => b.n - a.n) as { cause: EnvelopeCause; n: number }[],
    due: counts.due,
    cards: counts.live,
  };
}

export function stats(now = new Date()): EnvelopeStats {
  return { ...computeEnvelopeStats(store.allAttempts(), todayTz(), store.cardCounts(now)), steps: computeStepStats(store.countedSteps()) };
}

/** Today's "Envelope ×5" (a part of the warm-up). */
export function todayEnvelope(dayStart: string, now: Date, maxDaily?: number): TodayEnvelope {
  // A "30-min day" (Phase H2) caps the reps; it never raises them.
  let daily = maxDaily === undefined ? envelopeDaily() : Math.min(envelopeDaily(), maxDaily);
  // Phase I: while still learning, the warm-up is guided and on ONE skill a
  // day. Guided items take longer, so fewer of them.
  const all = store.allAttempts();
  const before = all.filter((a) => a.createdAt < dayStart);
  const recent = before.slice(0, 20);
  const guided = daily > 0 && guidedForToday(before.length, recent.length ? recent.filter((a) => a.ok).length / recent.length : null);
  const tz = todayTz();
  const skill = guided ? dailySkill(new Set(before.map((a) => localDay(Date.parse(a.createdAt), tz))).size) : null;
  if (guided) daily = Math.min(daily, GUIDED_DAILY);
  const today = store.attemptsSince(dayStart);
  const due = store.cardCounts(now).due;
  const remaining = envelopeRemaining(daily, today.length, due);
  const query = guided && skill ? `&guided=1&skill=${skill.id}` : '';
  return {
    daily,
    doneToday: today.length,
    correctToday: today.filter((a) => a.ok).length,
    due,
    remaining,
    done: remaining === 0,
    href: `/envelope?from=today&step=warmup&n=${Math.max(remaining, 1)}${query}`,
    guided,
    skill: skill ? { id: skill.id, label: skill.label } : null,
    query,
  };
}

/** Today's envelope answers, for the warm-up's step review. */
export function envelopeDigest(dayStart: string): string[] {
  return store
    .attemptsSince(dayStart)
    .slice(-10)
    .map(
      (a) =>
        `Envelope "${a.question.slice(0, 120)}": answered ${a.answer} — ${a.ok ? 'right' : `MISS (${a.orders > 0 ? '+' : ''}${a.orders} orders of magnitude${a.cause ? `, likely ${a.cause}` : ''})`}`
    );
}

/** Seed the five diagnostic cards (2026-10-21). Idempotent. Returns how many were new. */
export function seedEnvelopeCards(now = new Date()): number {
  let added = 0;
  for (const item of seedItems()) {
    if (store.insertCard({ key: item.key, item, source: 'seed' }, newCardSchedule(now), now)) added++;
  }
  return added;
}

/**
 * A graded mock's estimation gaps → Envelope cards, phrased as an interviewer
 * would ask ("Say you get 10 billion redirects a month. Roughly how many is that
 * per second?"). Only gaps whose text carries a volume per day/month make one.
 * Idempotent per gap. Never throws — a card is a bonus, not part of the grade.
 */
export function envelopeCardsFromGaps(
  mockId: string,
  gaps: readonly { id: number; concept: string; title: string; summary: string; answer: string }[],
  now = new Date()
): number {
  let added = 0;
  try {
    for (const g of gaps) {
      if (!isEstimationGap(g)) continue;
      const item = envelopeFromGapText(`mock:${g.id}`, `${g.title} ${g.answer}`);
      if (!item) continue;
      // Due TOMORROW, not now (Phase H): a card born from today's mock that is
      // due at once reopened a finished warm-up and blocked the debrief.
      const schedule = { ...newCardSchedule(now), dueAt: new Date(now.getTime() + 86_400_000).toISOString() };
      if (store.insertCard({ key: item.key, item, source: 'mock', mockId }, schedule, now)) added++;
    }
  } catch (err) {
    console.error('[envelope] cards from mock gaps failed:', err instanceof Error ? err.message : err);
  }
  return added;
}
