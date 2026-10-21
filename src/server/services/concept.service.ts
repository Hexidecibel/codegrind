// =============================================================================
// concept.service — concept reps + the AI-systems track (Phase H3)
// =============================================================================
//   today     the day's pick (frozen on daily_sessions.conceptPick), its question,
//             and the teach-first primer when the concept is new           free
//   learn     primer acknowledged / lesson read → learnedAt                  free
//   grade     ONE workhorse call (Sonnet, adaptive thinking) on a dictated
//             answer; misses/shaky → a drill card on the gap-card ladder    ~$0.015
//   lesson    an AI-systems track lesson, generated ONCE per concept         ~$0.02 once
//   track     every concept's learning state + the AI-prompt gate           free
//
// Every model call here is user-initiated (a Submit / opening a lesson), with a
// single in-flight guard, a per-day call cap and a failure cooldown: nothing
// runs in the background and a broken model cannot become a retry loop.

import { isNoAnswer } from './llm.review.js';
import { conceptRubric, REP_CONCEPTS } from '../../shared/concept-rubrics.js';
import {
  KNOWN_AFTER_DAYS,
  MAX_GRADE_CALLS_PER_DAY,
  MAX_REPS_PER_DAY,
  AI_UNLOCK_KNOWN,
  aiPromptsUnlocked,
  categoryOf,
  knownAiCount,
  learningStates,
  pickConcept,
  type ConceptLesson,
  type ConceptPrimer,
  type ConceptRepView,
  type ConceptToday,
  type ConceptTrack,
  type RepFact,
} from '../../shared/concepts.js';
import { conceptLabel, isAiSdConcept, type SdConcept } from '../../shared/sd.js';
import { isDoubleGrade, type GapCardGrade } from '../../shared/gap-cards.js';
import { anyAiFocusedLoop, capDueAtIso } from '../../shared/loops.js';
import type { MockPickOptions } from '../../shared/mock-kinds.js';
import { costOf } from '../../shared/mock.js';
import { db, listLoops, loopDeadlineMs } from './db.js';
import { costOfMeta } from './ai-usage.service.js';
import { routingFor } from './llm.client.js';
import { generateConceptLesson, runConceptGrade } from './llm.concept.js';
import { CONCEPT_REPS_ANCHOR, ensureConceptRepsAnchor, insertGap, recentConceptSignals, recentTurnSignals } from './mock.store.js';
import { dayStartMs, localDay, todayTz } from './today.compute.js';
import * as store from './concept.store.js';

export class ConceptError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

function today(now: Date): { date: string; dayStart: string } {
  const tz = todayTz();
  const date = localDay(now.getTime(), tz);
  return { date, dayStart: new Date(dayStartMs(date, tz)).toISOString() };
}

/** Any upcoming loop is AI-focused. Never throws. */
export function aiFocusNow(now = new Date()): boolean {
  try {
    return anyAiFocusedLoop(listLoops(), today(now).date);
  } catch {
    return false;
  }
}

function states(): Record<string, ReturnType<typeof learningStates>[string]> {
  return learningStates(store.learnedMap(), store.repFacts());
}

/** What the system-design mock pick needs (the AI gate + the loop focus). Never throws. */
export function mockPickOptions(now = new Date()): MockPickOptions {
  try {
    return { aiUnlocked: aiPromptsUnlocked(states()), aiFocus: aiFocusNow(now) };
  } catch {
    return { aiUnlocked: false, aiFocus: false };
  }
}

/** A typical grade (~1.8k in, ~1k out incl. thinking; live 2026-10-21: $0.010-0.015) on the workhorse model. */
export function gradeEstimateUsd(): number | null {
  try {
    return costOf(routingFor('workhorse').model, { inputTokens: 1800, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  } catch {
    return null;
  }
}

function primerOf(concept: string): ConceptPrimer {
  const r = conceptRubric(concept)!;
  return { primer: r.primer, keyPoints: [...r.keyPoints], example: r.example, mistake: r.mistake };
}

function toView(r: store.ConceptRepRow): ConceptRepView {
  return {
    id: r.id,
    concept: r.concept as SdConcept,
    label: conceptLabel(r.concept as SdConcept),
    question: r.question,
    answer: r.answer,
    primed: r.primed,
    grade: r.grade,
    hit: r.result.hit,
    missed: r.result.missed,
    why: r.result.why,
    modelAnswer: r.result.modelAnswer,
    followUp: r.result.followUp,
    cardId: r.cardId,
    costUsd: r.costUsd,
    createdAt: r.createdAt,
  };
}

/** Pick (or re-pick) and freeze the day's concept. */
function freshPick(date: string, now: Date, exclude: string[]): store.StoredPick {
  const signals = [...recentConceptSignals('system-design', 10), ...recentTurnSignals('system-design', 200)];
  const p = pickConcept({
    now: now.getTime(),
    day: date,
    reps: store.repFacts(),
    learned: store.learnedMap(),
    signals,
    aiFocus: aiFocusNow(now),
    exclude,
  });
  const pick: store.StoredPick = { concept: p.concept, promptIdx: p.promptIdx, primed: p.state === 'new', why: p.why };
  store.setPick(date, pick, now);
  return pick;
}

/**
 * GET /api/concept/today[?next=1]. The pick is frozen for the day; `next` (only
 * once today's pick has been repped, and under the daily cap) picks another.
 */
export function conceptToday(opts: { next?: boolean } = {}, now = new Date()): ConceptToday {
  const { date } = today(now);
  const reps = store.repsOfDay(date);
  let pick = store.getPick(date);
  const doneConcepts = reps.map((r) => r.concept);
  if (!pick || !conceptRubric(pick.concept)) pick = freshPick(date, now, doneConcepts);
  else if (opts.next && doneConcepts.includes(pick.concept) && reps.length < MAX_REPS_PER_DAY) {
    pick = freshPick(date, now, doneConcepts);
  }
  const rubric = conceptRubric(pick.concept)!;
  const learned = store.learnedMap();
  const st = learningStates(learned, store.repFacts())[pick.concept];
  const concept = pick.concept as SdConcept;
  return {
    date,
    concept,
    label: conceptLabel(concept),
    category: categoryOf(concept),
    state: st,
    why: pick.why,
    question: rubric.prompts[pick.promptIdx % rubric.prompts.length],
    promptIdx: pick.promptIdx % rubric.prompts.length,
    // Teach-first: frozen at pick time, so acknowledging the primer (which sets
    // learnedAt) does not hide it mid-rep.
    primer: pick.primed ? primerOf(concept) : null,
    lessonHref: isAiSdConcept(concept) ? `/concepts/${concept}` : null,
    doneToday: reps.length,
    maxPerDay: MAX_REPS_PER_DAY,
    today: reps.map(toView),
    estimateUsd: gradeEstimateUsd(),
  };
}

/** POST /api/concept/learn {concept, via} — the primer was read, or the lesson. */
export function learn(body: unknown, now = new Date()): ConceptTrack {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.concept !== 'string' || !conceptRubric(b.concept)) throw new ConceptError('Unknown concept.', 400);
  store.markLearned(b.concept, b.via === 'lesson' ? 'lesson' : 'primer', now);
  return track(now);
}

const callsByDay = new Map<string, number>();
let gradeInFlight = false;

/** For tests: forget the in-memory call budget. */
export function resetConceptBudgetForTest(): void {
  callsByDay.clear();
  gradeInFlight = false;
  lessonFailures.clear();
}

/**
 * The card back for a rep miss: the concept in a sentence plus what the answer
 * left out. Pure; exported for tests.
 */
export function cardBackFor(concept: string, missed: readonly string[]): string {
  const r = conceptRubric(concept);
  const base = r ? r.primer : '';
  const miss = missed.slice(0, 3).map((m) => m.replace(/[.\s]+$/, ''));
  return [base, miss.length ? `A Staff answer also covers: ${miss.join('; ')}.` : ''].filter(Boolean).join(' ');
}

/** Whether a graded rep mints a card. Pure. */
export function mintsCard(grade: GapCardGrade): boolean {
  return grade === 'missed' || grade === 'shaky';
}

function openRepCard(concept: string): number | null {
  const r = db
    .prepare(`SELECT id FROM mock_gaps WHERE mockId = ? AND concept = ? AND retiredAt IS NULL ORDER BY id DESC LIMIT 1`)
    .get(CONCEPT_REPS_ANCHOR, concept) as { id: number } | undefined;
  return r?.id ?? null;
}

/**
 * A miss → a drill card on the existing ladder, due TOMORROW (you just read the
 * model answer; "now" would test memory of it), capped by the loop deadline.
 * One open card per concept: a repeat miss reuses it. Never throws.
 */
function mintCard(concept: string, question: string, grade: GapCardGrade, missed: string[], now: Date): number | null {
  try {
    const open = openRepCard(concept);
    if (open !== null) return open;
    ensureConceptRepsAnchor();
    const due = capDueAtIso(new Date(now.getTime() + DAY_MS).toISOString(), now.getTime(), loopDeadlineMs(now.getTime()));
    return insertGap(
      CONCEPT_REPS_ANCHOR,
      {
        seq: null,
        concept,
        type: 'skill',
        title: question,
        summary: `Concept rep, ${grade}: ${missed.slice(0, 3).join('; ') || 'the key points were thin'}`.slice(0, 400),
        answer: cardBackFor(concept, missed),
        source: 'rep',
      },
      now,
      due
    );
  } catch (err) {
    console.error('[concept] card mint failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** POST /api/concept/grade {concept, promptIdx, answer, primed}. */
export async function grade(body: unknown, now = new Date()): Promise<ConceptRepView> {
  const b = (body ?? {}) as Record<string, unknown>;
  const concept = typeof b.concept === 'string' ? b.concept : '';
  const rubric = conceptRubric(concept);
  if (!rubric) throw new ConceptError('Unknown concept.', 400);
  const answer = typeof b.answer === 'string' ? b.answer.trim().slice(0, 8000) : '';
  if (!answer) throw new ConceptError('Say (or type) your explanation first.', 400);
  const promptIdx = Number.isInteger(b.promptIdx) ? Math.abs(b.promptIdx as number) % rubric.prompts.length : 0;
  const question = rubric.prompts[promptIdx];
  const primed = b.primed === true;
  const { date } = today(now);
  const reps = store.repsOfDay(date);
  if (reps.length >= MAX_REPS_PER_DAY) throw new ConceptError(`That is ${MAX_REPS_PER_DAY} reps today — come back tomorrow.`, 409);
  if (isDoubleGrade(reps[reps.length - 1]?.createdAt, now)) throw new ConceptError('That one was just graded.', 409);
  if (gradeInFlight) throw new ConceptError('A rep is already being graded.', 429);
  const calls = callsByDay.get(date) ?? 0;
  if (calls >= MAX_GRADE_CALLS_PER_DAY) throw new ConceptError('Grading has failed too often today; try again tomorrow.', 429);
  if (primed) store.markLearned(concept, 'primer', now);

  let result: { grade: GapCardGrade; hit: string[]; missed: string[]; why: string; modelAnswer: string; followUp: string };
  let model = '';
  let costUsd: number | null = 0;
  if (isNoAnswer(answer)) {
    // "I don't know": missed, no call. The primer is the model answer.
    result = {
      grade: 'missed',
      hit: [],
      missed: [...rubric.keyPoints],
      why: 'No explanation given.',
      modelAnswer: `${rubric.primer} ${rubric.example}`,
      followUp: '',
    };
  } else {
    gradeInFlight = true;
    callsByDay.set(date, calls + 1);
    try {
      const { result: r, meta } = await runConceptGrade({
        label: conceptLabel(concept as SdConcept),
        question,
        rubric,
        primed,
        answer,
      });
      if (!r.why && !r.modelAnswer) throw new Error('empty concept grade');
      result = r;
      model = meta.servedModel;
      costUsd = costOfMeta(meta);
    } finally {
      gradeInFlight = false;
    }
  }
  const id = store.insertRep({
    day: date,
    concept,
    promptIdx,
    question,
    answer,
    primed,
    grade: result.grade,
    result: { hit: result.hit, missed: result.missed, why: result.why, modelAnswer: result.modelAnswer, followUp: result.followUp },
    cardId: null,
    model,
    costUsd,
    createdAt: now.toISOString(),
  });
  if (mintsCard(result.grade)) {
    const cardId = mintCard(concept, question, result.grade, result.missed, now);
    if (cardId !== null) store.setRepCard(id, cardId);
  }
  return toView(store.repsOfDay(date).find((r) => r.id === id)!);
}

/** GET /api/concept/track — every rep concept's state + the AI gate. */
export function track(now = new Date()): ConceptTrack {
  const facts = store.repFacts();
  const st = learningStates(store.learnedMap(), facts);
  const lessons = store.lessonConcepts();
  return {
    items: REP_CONCEPTS.map((c) => {
      const mine = facts.filter((f) => f.concept === c);
      return {
        concept: c,
        label: conceptLabel(c),
        category: categoryOf(c),
        state: st[c],
        lessonCached: lessons.has(c),
        lastGrade: mine[0]?.grade ?? null,
        reps: mine.length,
      };
    }),
    knownAi: knownAiCount(st),
    unlockAt: AI_UNLOCK_KNOWN,
    aiUnlocked: aiPromptsUnlocked(st),
    aiFocus: aiFocusNow(now),
  };
}

const lessonInFlight = new Set<string>();
const lessonFailures = new Map<string, number>();
const LESSON_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/** GET /api/concept/lesson/:concept — cached, or generated once (user-initiated). */
export async function lesson(concept: string, now = new Date()): Promise<ConceptLesson> {
  if (!isAiSdConcept(concept)) throw new ConceptError('The AI-systems track has no lesson for that concept.', 404);
  const cached = store.getLesson(concept);
  if (cached) return cached;
  if (lessonInFlight.has(concept)) throw new ConceptError('That lesson is being written — try again in a few seconds.', 429);
  const failedAt = lessonFailures.get(concept);
  if (failedAt && now.getTime() - failedAt < LESSON_FAILURE_COOLDOWN_MS) {
    throw new ConceptError('Writing that lesson just failed; try again in a few minutes.', 429);
  }
  const rubric = conceptRubric(concept)!;
  lessonInFlight.add(concept);
  try {
    const { result, meta } = await generateConceptLesson({ label: conceptLabel(concept), question: rubric.prompts[0], rubric });
    if (!result.card || !result.staffAnswer) throw new Error('empty concept lesson');
    const l: ConceptLesson = { concept, label: conceptLabel(concept), ...result, model: meta.servedModel, createdAt: now.toISOString() };
    store.putLesson(l);
    return l;
  } catch (err) {
    lessonFailures.set(concept, now.getTime());
    throw err;
  } finally {
    lessonInFlight.delete(concept);
  }
}

// -----------------------------------------------------------------------------
// What Today, the step review, the debrief and readiness read
// -----------------------------------------------------------------------------
/** Today's step: graded reps today and the last one. Never throws. */
export function todayConcept(now = new Date()): { doneToday: number; last: { label: string; grade: GapCardGrade } | null } {
  try {
    const reps = store.repsOfDay(today(now).date);
    const last = reps[reps.length - 1];
    return { doneToday: reps.length, last: last ? { label: conceptLabel(last.concept as SdConcept), grade: last.grade } : null };
  } catch {
    return { doneToday: 0, last: null };
  }
}

/** One line per rep today, for the step review and the debrief. Never throws. */
export function conceptDigest(now = new Date()): string[] {
  try {
    return store.repsOfDay(today(now).date).map(
      (r) =>
        `Concept rep "${conceptLabel(r.concept as SdConcept)}"${r.primed ? ' (first time, after a primer)' : ' (cold)'}: ${r.grade}` +
        (r.result.hit.length ? `; covered: ${r.result.hit.slice(0, 4).join('; ')}` : '') +
        (r.result.missed.length ? `; missed: ${r.result.missed.slice(0, 4).join('; ')}` : '')
    );
  } catch {
    return [];
  }
}

/** Cold reps since `since`, for the SD readiness signal. Never throws. */
export function readinessReps(sinceIso: string): RepFact[] {
  try {
    return store.repFacts().filter((r) => !r.primed && r.createdAt >= sinceIso);
  } catch {
    return [];
  }
}

export { KNOWN_AFTER_DAYS };
