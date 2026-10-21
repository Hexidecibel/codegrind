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

import { newCardSchedule, describeOutcome, type GapCardGrade } from '../../shared/gap-cards.js';
import {
  DEFAULT_ENVELOPE_SIZE,
  ENVELOPE_CAUSES,
  checkAnswer,
  envelopeFromGapText,
  envelopeRemaining,
  generateSet,
  isEstimationGap,
  itemFromKey,
  seedItems,
  toPrompt,
  type EnvelopeCause,
  type EnvelopeCheckResponse,
  type EnvelopeItem,
  type EnvelopeNote,
  type EnvelopeSession,
  type EnvelopeStats,
  type EnvelopeStatsDay,
  type TodayEnvelope,
} from '../../shared/envelope.js';
import { getSetting } from './db.js';
import { aiReviewsEnabled, costOfMeta } from './ai-usage.service.js';
import { scheduleRecognizeCard } from './recognize.compute.js';
import { dayStartMs, localDay, todayTz } from './today.compute.js';
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
  if (card) return { item: card.item, card };
  const item = itemFromKey(key);
  if (!item) throw new EnvelopeError('No such envelope question.', 404);
  return { item, card: null };
}

/** GET /api/envelope/session?n= — due cards first, then fresh reps. */
export function startSession(nRaw: unknown, now = new Date()): EnvelopeSession {
  const n = Math.max(1, Math.min(20, Number(nRaw) || DEFAULT_ENVELOPE_SIZE));
  const due = store.dueCards(now);
  const cards = due.slice(0, Math.max(n, Math.min(due.length, 10)));
  const fresh = generateSet(now.getTime() % 2_147_483_647, Math.max(0, n - cards.length));
  const dayStart = dayStartIso(now);
  return {
    items: [...cards.map((c) => toPrompt(c.item, true)), ...fresh.map((i) => toPrompt(i, false))],
    due: due.length,
    doneToday: store.attemptsSince(dayStart).length,
    daily: envelopeDaily(),
    aiReviews: aiReviewsEnabled(),
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
  const v = checkAnswer(item, answer);
  if (!v) throw new EnvelopeError(`Couldn't read a number from "${answer}". Try "500", "30 million", "3e7" or "8 TB".`, 400);

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
      cause: v.cause,
    },
    now
  );

  return {
    attemptId,
    ok: v.ok,
    read: v.read,
    orders: v.orders,
    verdict: v.verdict,
    cause: v.cause,
    causeText: v.causeText,
    answerText: item.answerText,
    split: item.split,
    schedule,
    noteAvailable: !v.ok && aiReviewsEnabled(),
  };
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
  return computeEnvelopeStats(store.allAttempts(), todayTz(), store.cardCounts(now));
}

/** Today's "Envelope ×5" (a part of the warm-up). */
export function todayEnvelope(dayStart: string, now: Date): TodayEnvelope {
  const daily = envelopeDaily();
  const today = store.attemptsSince(dayStart);
  const due = store.cardCounts(now).due;
  const remaining = envelopeRemaining(daily, today.length, due);
  return {
    daily,
    doneToday: today.length,
    correctToday: today.filter((a) => a.ok).length,
    due,
    remaining,
    done: remaining === 0,
    href: `/envelope?from=today&step=warmup&n=${Math.max(remaining, 1)}`,
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
      if (store.insertCard({ key: item.key, item, source: 'mock', mockId }, newCardSchedule(now), now)) added++;
    }
  } catch (err) {
    console.error('[envelope] cards from mock gaps failed:', err instanceof Error ? err.message : err);
  }
  return added;
}
