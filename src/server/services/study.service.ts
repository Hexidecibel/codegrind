// =============================================================================
// study.service — the stateful half of the Study feed (DB + LLM + prefetch)
// =============================================================================
// The ordering logic itself is pure and lives in ./study.order.js; this module
// is the part that touches the world. `buildStudyState()` reads the tables into
// the shape the planner consumes, and `warmAhead()` is the fire-and-forget
// prefetcher the feed route kicks off AFTER it has already responded.
//
// The pure layer is re-exported so existing importers (routes/study.ts) can keep
// treating study.service as the single entry point.

import { TOPICS, type Topic } from '../../shared/types.js';
import { FOUNDATIONAL_START, masteryScore } from './curriculum.js';
import {
  getAllTrackOutlines,
  getCachedLessonMeta,
  getLessonReads,
  getSkillState,
  getCleanSolvesByTopic,
  getPrimer,
  getPrimerPatterns,
  getLesson,
  insertLesson,
  insertPrimer,
  insertTrackOutline,
  getTrackOutline,
  getMistakeContexts,
  getWalkthroughCandidates,
  getProblem,
} from './db.js';
import {
  generateTrackOutline,
  generateLessonBody,
  generateMistakeLesson,
  generateWalkthroughLesson,
  generatePrimer,
} from './llm.service.js';
import {
  primerToLesson,
  PREFETCH_DEPTH,
  type StudySlot,
  type StudyQueueState,
  type StudySkill,
} from './study.order.js';

// Re-export the pure layer so `routes/study.ts` has one import site.
export {
  studyQueue,
  topicOrder,
  planTrackSlots,
  trackSlotCount,
  primerToLesson,
  PREFETCH_DEPTH,
} from './study.order.js';
export type {
  StudySlot,
  StudySkill,
  StudyReadState,
  StudyMistake,
  StudyWalkthrough,
  StudyQueueState,
  SlotSource,
  LessonMeta,
} from './study.order.js';

// -----------------------------------------------------------------------------
// buildStudyState — the thin DB wrapper. Everything above this line is pure.
// -----------------------------------------------------------------------------
/**
 * Materialize any seq-0 lessons that are derivable from an already-cached primer
 * but have no `lessons` row yet. Free (no API call), idempotent, and it makes
 * `cached` uniform so the planner never has to special-case seq 0.
 */
function materializeDerivedLessons(): void {
  for (const pattern of getPrimerPatterns()) {
    if (!(TOPICS as readonly string[]).includes(pattern)) continue;
    const id = `${pattern}:0`;
    if (getLesson(id)) continue;
    const primer = getPrimer(pattern);
    if (!primer) continue;
    insertLesson(primerToLesson({ ...primer, pattern }));
  }
}

/** Read live state out of SQLite into the shape `studyQueue()` consumes. */
export function buildStudyState(): StudyQueueState {
  materializeDerivedLessons();

  // One shared definition — see curriculum.masteryScore (the tier ladder's
  // display ordinal). The Study weakness bias compares it against WEAK_SCORE.
  const clean = getCleanSolvesByTopic();
  const skills: StudySkill[] = getSkillState().map((s) => ({
    topic: s.topic,
    attempts: s.attempts,
    mastery: masteryScore(clean.get(s.topic)),
  }));

  return {
    outlines: getAllTrackOutlines(),
    cached: getCachedLessonMeta(),
    reads: getLessonReads(),
    skills,
    mistakes: getMistakeContexts().map((m) => ({
      tag: m.tag,
      count: m.count,
      topic: (TOPICS as readonly string[]).includes(m.topic) ? m.topic : FOUNDATIONAL_START,
      problemId: m.problemId,
      problemTitle: m.problemTitle,
    })),
    walkthroughs: getWalkthroughCandidates().map((w) => ({
      problemId: w.problemId,
      title: w.title,
      topic: w.topic,
    })),
  };
}

// -----------------------------------------------------------------------------
// Prefetch — fire-and-forget generation, deduped by an in-flight map.
// A 15s stall mid-scroll would kill the feature, so the feed never awaits any of
// this: it responds with what is cached and warms the hole behind the response.
// -----------------------------------------------------------------------------
const inFlight = new Map<string, Promise<void>>();
/** Slots whose generation failed recently — the feed steps over them, not into them. */
const failed = new Map<string, number>();
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The in-flight/failure key for a slot. seq 0 is DERIVED from its topic's
 * primer rather than generated, so it shares the primer's key — otherwise a
 * failed primer call would never be recorded against the slot it blocks and the
 * feed would re-fire it on every single request.
 */
function slotKey(slot: StudySlot): string {
  return slot.source === 'track' && slot.seq === 0 ? `primer:${slot.topic}` : slot.id;
}

/** True when generation that would fill this slot is running right now. */
export function isSlotWarming(slot: StudySlot): boolean {
  return inFlight.has(slotKey(slot)) || inFlight.has(`outline:${slot.topic}`);
}

/** True when this key's last generation attempt failed inside the cooldown. */
function isRecentlyFailed(key: string): boolean {
  const at = failed.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > FAILURE_COOLDOWN_MS) {
    failed.delete(key);
    return false;
  }
  return true;
}

/**
 * True when this slot recently failed to generate. The feed steps OVER such a
 * slot instead of stalling on it forever, and the prefetcher leaves it alone
 * until the cooldown lapses — a dead topic must not turn a reading session into
 * a retry loop against the API.
 */
export function isSlotFailed(slot: StudySlot): boolean {
  return isRecentlyFailed(slotKey(slot));
}

/** Dedupe wrapper: only ever one concurrent generation per id. */
function once(id: string, work: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = work()
    .then(() => {
      failed.delete(id);
    })
    .catch((err) => {
      failed.set(id, Date.now());
      console.error('[study] generation failed', id, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      inFlight.delete(id);
    });
  inFlight.set(id, p);
  return p;
}

/** Ensure a topic has a cached primer (needed to derive seq 0 and to ground bodies). */
export function ensurePrimer(topic: Topic): Promise<void> {
  if (getPrimer(topic)) return Promise.resolve();
  return once(`primer:${topic}`, async () => {
    const primer = await generatePrimer(topic);
    insertPrimer(primer);
    insertLesson(primerToLesson(primer));
  });
}

/** Ensure a topic has a cached track outline (one cheap call, cached forever). */
export function ensureOutline(topic: Topic): Promise<void> {
  if (getTrackOutline(topic)) return Promise.resolve();
  return once(`outline:${topic}`, async () => {
    const outline = await generateTrackOutline(topic);
    if (outline.length) insertTrackOutline(topic, outline);
  });
}

/** Ensure one slot's lesson body exists. Cheap no-op when it is already cached. */
export function ensureLesson(slot: StudySlot): Promise<void> {
  if (slot.cached || getLesson(slot.id)) return Promise.resolve();

  // seq 0 is derived, never generated — it just needs its topic's primer.
  if (slot.source === 'track' && slot.seq === 0) return ensurePrimer(slot.topic);

  return once(slot.id, async () => {
    if (slot.source === 'mistake' && slot.tag) {
      const problem = slot.problemId ? getProblem(slot.problemId) : null;
      const lesson = await generateMistakeLesson(slot.tag, slot.topic, slot.seq, {
        problemTitle: problem?.title,
        prompt: problem?.prompt,
      });
      insertLesson({ ...lesson, id: slot.id });
      return;
    }

    if (slot.source === 'walkthrough' && slot.problemId) {
      const problem = getProblem(slot.problemId);
      if (!problem) throw new Error(`walkthrough problem ${slot.problemId} is gone`);
      const lesson = await generateWalkthroughLesson(problem, slot.seq);
      insertLesson({ ...lesson, id: slot.id });
      return;
    }

    // Track body: needs the outline item and the topic's primer for consistency.
    const outline = getTrackOutline(slot.topic);
    const item = outline?.find((o) => o.seq === slot.seq);
    if (!item) throw new Error(`no outline item for ${slot.id}`);
    let primer = getPrimer(slot.topic);
    if (!primer) {
      primer = await generatePrimer(slot.topic);
      insertPrimer(primer);
      insertLesson(primerToLesson(primer));
    }
    const lesson = await generateLessonBody(slot.topic, item, primer);
    insertLesson({ ...lesson, id: slot.id });
  });
}

/**
 * Fire-and-forget: warm the next few holes in the queue plus the outlines the
 * reader is about to need. NEVER awaited by a request handler.
 */
export function warmAhead(queue: StudySlot[], depth = PREFETCH_DEPTH): void {
  // Outlines for the topics the reader is in / heading into — without one, a
  // topic plans only its seq-0 slot and the feed looks shorter than it is.
  const topics: Topic[] = [];
  for (const slot of queue) {
    if (slot.source !== 'track') continue;
    if (!topics.includes(slot.topic)) topics.push(slot.topic);
    if (topics.length >= 2) break;
  }
  for (const t of topics) void ensureOutline(t);

  let warmed = 0;
  for (const slot of queue) {
    if (warmed >= depth) break;
    if (slot.cached) continue;
    if (isSlotFailed(slot)) continue;
    void ensureLesson(slot);
    warmed++;
  }
}
