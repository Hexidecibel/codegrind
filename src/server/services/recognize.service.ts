// =============================================================================
// recognize.service — the Recognize drill: serve, reveal, show code, check, grade
// =============================================================================
// Cost per card: one cached `small` check when "AI reviews" is on (Phase F:
// automatic on reveal; an identical answer is never re-paid), else $0. The reveal reads the topic's cached primer
// (cues / skeleton / pitfalls — the same card Grind and Study show) and the
// problem's cached note, if an earlier AI check left one. The only model calls
// reachable from here are:
//   * "AI check my approach" — on click, one `small` call; its key insight and
//     optimal complexity are cached on the problem (recognize_notes), so every
//     later reveal of that problem shows them for free;
//   * a topic with NO cached primer yet — generated once and cached in
//     pattern_primers, exactly like GET /api/primer (and then shared with
//     Grind/Study forever). On a seeded install every topic already has one.
//
// NOT A SOLVE. Nothing here writes attempts, skill_state, tier credit or
// review_queue. The one write outside recognize_* is the reveal ledger:
//
// THE LEDGER CHOICE. Showing the full reference CODE calls markSolutionRevealed,
// the same idempotent write /api/reveal makes. If the user later grinds that
// problem (a review, a manual pick, a stale unserved bank row), the submit is
// counted as assisted — they have seen the answer, and "I saw it in Recognize"
// must not be a side door around the honesty rule. Consequences, accepted:
//   * tier credit already banked is never clawed back (countCleanSolves dedupes
//     by problemId), so showing code for a problem you already solved is free;
//   * selection prefers problems whose code is "free" to show (already served,
//     attempted, or revealed), and the page warns before showing code for one
//     that is not;
//   * the statement, the primer skeleton and the cached note are NOT the
//     solution and do not touch the ledger — only the reference code does.
// `used` is deliberately left alone: the bank's stocking is Grind's business.

import { TOPICS, type Primer, type ProblemRecord, type Topic } from '../../shared/types.js';
import { createHash } from 'node:crypto';
import { costOf } from '../../shared/mock.js';
import { SMALL_CALL_SHAPES, aiReviewsEnabled, smallCallEstimateUsd } from './ai-usage.service.js';
import { isDoubleGrade, isGapCardGrade } from '../../shared/gap-cards.js';
import { dayStartMs, localDay, todayTz } from './today.compute.js';
import {
  DEFAULT_RECOGNIZE_SIZE,
  RECOGNIZE_SIZES,
  gradeFromVerdict,
  type RecognizeCard,
  type RecognizeCheck,
  type RecognizeCode,
  type RecognizeGradeRequest,
  type RecognizeGradeResponse,
  type RecognizeReveal,
  type RecognizeSession,
  type RecognizeStats,
  type TodayRecognize,
} from '../../shared/recognize.js';
import {
  getActiveLanguage,
  getPrimer,
  getProblem,
  getSkillState,
  insertPrimer,
  markSolutionRevealed,
} from './db.js';
import { generatePrimer } from './llm.service.js';
import { runRecognizeCheck } from './llm.recognize.js';
import {
  coerceVerdict,
  describeRecognizeOutcome,
  effectiveGrade,
  hashString,
  isPatternCorrect,
  isTopic,
  mulberry32,
  pickChoices,
  recentAccuracy,
  recognizeAdvice,
  scheduleRecognizeCard,
  selectSession,
  topicStats,
  topicWeakness,
} from './recognize.compute.js';
import * as store from './recognize.store.js';
import * as todayStore from './today.store.js';
import { RECOGNIZE_STOCK_PER_DAY, recognizeStockTopic } from './breadth.compute.js';
import { generateAndStore } from './bank.service.js';
import type { Language } from '../../shared/languages.js';

export class RecognizeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
  }
}

function requireProblem(problemId: unknown): ProblemRecord {
  const p = typeof problemId === 'string' && problemId ? getProblem(problemId) : null;
  if (!p) throw new RecognizeError('problem not found', 404);
  if (!isTopic(p.topic)) throw new RecognizeError('problem has no recognizable topic', 400);
  return p;
}

function sizeOf(n: unknown): number {
  const k = typeof n === 'string' ? Number(n) : n;
  return (RECOGNIZE_SIZES as readonly number[]).includes(k as number) ? (k as number) : DEFAULT_RECOGNIZE_SIZE;
}

/** The LOCAL day used to seed the choice shuffle, so a reload shows the same four. */
const seedDay = (now: Date) => localDay(now.getTime(), todayTz());

export function startSession(n: unknown, now = new Date()): RecognizeSession {
  const size = sizeOf(n);
  const language = getActiveLanguage();
  const rows = store.candidates().filter((r) => isTopic(r.topic));
  const statsByTopic = new Map(topicStats(store.allAttempts()).map((s) => [s.topic, s]));
  const skill = new Map(getSkillState(language).map((s) => [s.topic, s]));
  const weakness = new Map<string, number>(
    TOPICS.map((t) => [t, topicWeakness(skill.get(t), statsByTopic.get(t), now.getTime())])
  );
  // Prefer the active language: within one title, the active-language copy
  // wins the dedupe below (scores give it +0.2), so the code shown is in the
  // language the user is practising.
  const sel = selectSession({
    n: size,
    candidates: rows.map((r) => ({
      problemId: r.problemId,
      title: r.title,
      topic: r.topic as Topic,
      codeFree: r.used || r.attempted || r.revealed,
      activeLanguage: r.language === language,
      lastRecognizedAt: r.lastRecognizedAt,
    })),
    due: store.dueCards(now),
    weakness,
    now: now.getTime(),
    rng: mulberry32(hashString(`${seedDay(now)}:${size}:${rows.length}`)),
    todayStartMs: dayStartMs(seedDay(now), todayTz()),
  });

  const byId = new Map(rows.map((r) => [r.problemId, r]));
  const cards: RecognizeCard[] = [];
  for (const id of sel.ids) {
    const p = getProblem(id);
    const r = byId.get(id);
    if (!p || !r) continue;
    cards.push({
      problemId: p.id,
      prompt: p.prompt,
      examples: p.examples,
      constraints: p.constraints,
      difficulty: p.difficulty,
      choices: pickChoices(p.topic, mulberry32(hashString(`${p.id}:${seedDay(now)}`)), p.pattern),
      due: sel.dueIds.has(id),
      codeFree: r.used || r.attempted || r.revealed,
    });
  }
  stockEmptyTopic(rows, language, now);
  return { cards, dueLeft: sel.dueLeft };
}

// -----------------------------------------------------------------------------
// Phase H2 breadth floor: a topic with no bank problem never shows up here. A
// session start may stock ONE such topic per local day (breadth.compute
// RECOGNIZE_STOCK_PER_DAY): an easy problem through the normal generation path
// (leak filter included), in the background, unused (the grind can serve it).
// Bounded three ways: the day's budget is claimed on daily_sessions BEFORE the
// call (so a failure still spends it — no retries), one in flight at a time,
// and only with the "AI reviews" toggle on. No loop: one call, then done.
// -----------------------------------------------------------------------------
let stockInFlight: Promise<void> | null = null;

/** Exported for tests: resolves when a background stock call (if any) is done. */
export function recognizeStockIdle(): Promise<void> {
  return stockInFlight ?? Promise.resolve();
}

function stockEmptyTopic(rows: readonly { topic: string }[], language: Language, now: Date): void {
  try {
    if (stockInFlight || !aiReviewsEnabled()) return;
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.topic, (counts.get(r.topic) ?? 0) + 1);
    const topic = recognizeStockTopic(counts);
    if (!topic) return;
    const date = localDay(now.getTime(), todayTz());
    const day = todayStore.getDay(date);
    if (!day || day.recognizeStocked >= RECOGNIZE_STOCK_PER_DAY) return;
    todayStore.bumpRecognizeStocked(date, now);
    stockInFlight = generateAndStore(language, topic, 'easy')
      .then((p) => console.log(`[recognize] stocked ${topic}: "${p.title}"`))
      .catch((err) => console.error(`[recognize] stocking ${topic} failed:`, err instanceof Error ? err.message : err))
      .finally(() => {
        stockInFlight = null;
      });
  } catch (err) {
    console.error('[recognize] stock check failed:', err instanceof Error ? err.message : err);
  }
}

/** Primer generations in flight, per topic: concurrent reveals share one call. */
const primerInFlight = new Map<string, Promise<Primer | null>>();
/** Failed generations per topic: no retry inside PRIMER_FAILURE_COOLDOWN_MS. */
const primerFailedAt = new Map<string, number>();
export const PRIMER_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * The topic's primer: cached, or generated once and cached (as GET /api/primer
 * does). The generation is AUTOMATIC here (every reveal asks), so it obeys the
 * same rules as Phase F's automatic calls (Phase H): gated by the "AI reviews"
 * toggle, deduped while in flight, and a failure is not retried for
 * PRIMER_FAILURE_COOLDOWN_MS — a dead model costs one call per topic per half
 * hour, never one per reveal.
 */
async function primerFor(topic: Topic, now = Date.now()): Promise<Primer | null> {
  const language = getActiveLanguage();
  const cached = getPrimer(language, topic);
  if (cached) return cached;
  if (!aiReviewsEnabled()) return null;
  const failed = primerFailedAt.get(topic);
  if (failed !== undefined && now - failed < PRIMER_FAILURE_COOLDOWN_MS) return null;
  const running = primerInFlight.get(topic);
  if (running) return running;
  const job = (async () => {
    try {
      const fresh = await generatePrimer(topic);
      insertPrimer(fresh);
      primerFailedAt.delete(topic);
      return getPrimer(language, topic) ?? fresh;
    } catch (err) {
      // The reveal still works without it — the code and the topic are the answer.
      primerFailedAt.set(topic, Date.now());
      console.error('[recognize] primer generation failed:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      primerInFlight.delete(topic);
    }
  })();
  primerInFlight.set(topic, job);
  return job;
}

export async function reveal(problemId: unknown, picked: unknown): Promise<RecognizeReveal> {
  const p = requireProblem(problemId);
  const primer = await primerFor(p.topic);
  return {
    problemId: p.id,
    title: p.title,
    topic: p.topic,
    pattern: p.pattern,
    picked: isTopic(picked) ? picked : null,
    patternCorrect: isPatternCorrect(picked, p.topic, p.pattern),
    primer: primer
      ? { cues: primer.recognitionCues, skeleton: primer.template, pitfalls: primer.pitfalls, example: primer.example }
      : null,
    note: store.getNote(p.id),
    language: p.language,
    autoCheck: aiReviewsEnabled(),
    checkEstimateUsd: smallCallEstimateUsd(SMALL_CALL_SHAPES.recognizeCheck),
  };
}

/** The full reference code. Writes the reveal ledger FIRST — see the header. */
export function showCode(problemId: unknown): RecognizeCode {
  const p = requireProblem(problemId);
  markSolutionRevealed(p.id);
  return { problemId: p.id, language: p.language, referenceSolution: p.referenceSolution };
}

let checkInFlight = false;

/** The cache key: same problem, same pick, same answer (whitespace/case-insensitive) = same verdict. */
export function checkKey(problemId: string, picked: string | null, approach: string): string {
  const norm = approach.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${problemId}|${picked ?? ''}|${norm}`).digest('hex');
}

/**
 * The AI check: one small call, or a free read of the cached verdict for an
 * identical answer. Runs automatically on reveal when "AI reviews" is on (the
 * page calls it), else on click. Reading the reference solution into the
 * prompt is server-side only — nothing is shown, so no ledger write.
 */
export async function check(body: { problemId?: unknown; picked?: unknown; approach?: unknown }): Promise<RecognizeCheck> {
  const p = requireProblem(body.problemId);
  const approach = typeof body.approach === 'string' ? body.approach.slice(0, 1200) : '';
  if (!approach.trim()) throw new RecognizeError('Write your approach first — the check grades the idea.', 400);
  const picked = isTopic(body.picked) ? body.picked : null;
  const key = checkKey(p.id, picked, approach);
  const hit = store.getCheck<RecognizeCheck>(key);
  if (hit) return { ...hit, costUsd: 0, cached: true };
  if (checkInFlight) throw new RecognizeError('A check is already running.', 429);
  checkInFlight = true;
  try {
    const { result, meta } = await runRecognizeCheck({ problem: p, picked, approach });
    if (result.note.keyInsight) store.putNote(p.id, result.note, new Date());
    const out: RecognizeCheck = {
      verdict: result.verdict,
      missing: result.missing,
      edgeCaseThatBites: result.edgeCaseThatBites,
      oneLineFix: result.oneLineFix,
      note: result.note,
      suggested: gradeFromVerdict(result.verdict),
      costUsd: costOf(meta.servedModel, {
        inputTokens: meta.usage.inputTokens,
        outputTokens: meta.usage.outputTokens,
        cacheReadTokens: meta.usage.cachedInputTokens,
        cacheWriteTokens: meta.usage.cacheWriteInputTokens ?? 0,
      }),
    };
    store.putCheck(key, p.id, out, new Date());
    return out;
  } finally {
    checkInFlight = false;
  }
}

/** Record one graded card and move its schedule. Touches only recognize_*. */
export function grade(body: Partial<RecognizeGradeRequest>, now = new Date()): RecognizeGradeResponse {
  const p = requireProblem(body.problemId);
  if (!isGapCardGrade(body.selfGrade)) throw new RecognizeError('selfGrade must be got, shaky or missed', 400);
  // The double-grade guard: a second POST for the same card inside a few
  // seconds is a double tap, not a second answer (shared/gap-cards).
  if (isDoubleGrade(store.lastAttemptAt(p.id), now)) {
    throw new RecognizeError('That card was just graded.', 409);
  }
  const patternCorrect = isPatternCorrect(body.picked, p.topic, p.pattern);
  // The AI check's verdict, read from the server's own cache (never trusted
  // from the request body) for exactly this pick and approach.
  const approachText = typeof body.approach === 'string' ? body.approach.slice(0, 1200) : '';
  const picked = isTopic(body.picked) ? body.picked : null;
  const checked = approachText.trim() ? store.getCheck<RecognizeCheck>(checkKey(p.id, picked, approachText)) : null;
  const g = effectiveGrade(patternCorrect, body.selfGrade, checked?.verdict === 'correct');
  const card = store.getCard(p.id);
  const next = scheduleRecognizeCard(card, g, now);
  store.insertAttempt(
    {
      problemId: p.id,
      topic: p.topic,
      picked: isTopic(body.picked) ? body.picked : null,
      patternCorrect,
      approach: typeof body.approach === 'string' ? body.approach.slice(0, 2000) : '',
      selfGrade: body.selfGrade,
      grade: g,
      codeShown: body.codeShown === true,
      aiVerdict: body.aiVerdict ? coerceVerdict(body.aiVerdict) : null,
      durationMs: typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) ? Math.round(body.durationMs) : null,
    },
    now
  );
  if (next) store.putCard(p.id, p.topic, next, now);
  return { grade: g, outcome: describeRecognizeOutcome(card, g) };
}

export function stats(now = new Date()): RecognizeStats {
  const rows = store.allAttempts();
  const recent = recentAccuracy(rows);
  const counts = store.cardCounts(now);
  return {
    byTopic: topicStats(rows),
    recentAccuracy: recent.accuracy,
    recentN: recent.n,
    due: counts.due,
    upcoming: counts.upcoming,
    total: rows.length,
  };
}

/**
 * Today's Recognize add-on. Derived from rows like every other step: grind
 * attempts in the last 3 local days (`since3Days` = local midnight two days
 * ago), recognize accuracy, due cards, and cards graded since `dayStart`.
 */
export function todayRecognize(dayStart: string, since3Days: string, now: Date): TodayRecognize {
  const s = stats(now);
  const doneToday = store.attemptsSinceCount(dayStart);
  const advice = recognizeAdvice({
    grindAttemptsLast3Days: store.grindAttemptsSince(since3Days),
    recentAccuracy: s.recentAccuracy,
    recentN: s.recentN,
    due: s.due,
    doneToday,
  });
  return {
    ...advice,
    doneToday,
    done: doneToday >= DEFAULT_RECOGNIZE_SIZE,
    due: s.due,
    href: `/recognize?from=today&step=warmup&n=${DEFAULT_RECOGNIZE_SIZE}`,
  };
}
