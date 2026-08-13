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
import type { Language } from '../../shared/languages.js';
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
  getCorpusSnippets,
  getTranslatedSourceIds,
  putCodeTranslations,
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
  translateSnippets,
} from './llm.service.js';
import { CORPUS_LANGUAGE } from './llm.language.js';
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
    // CORPUS_LANGUAGE, not the active language, on BOTH reads: this function
    // copies a primer's skeleton into a lessons row, and the lessons table is
    // the shared corpus. Reading the overlay here would write a translated
    // snippet into the corpus, where every other language would then inherit
    // it — a one-way corruption with no error anywhere.
    if (getLesson(CORPUS_LANGUAGE, id)) continue;
    const primer = getPrimer(CORPUS_LANGUAGE, pattern);
    if (!primer) continue;
    insertLesson(primerToLesson({ ...primer, pattern }));
  }
}

/**
 * Read live state out of SQLite into the shape `studyQueue()` consumes.
 *
 * `language` scopes the PERSONALIZATION only — which topics look weak, which
 * mistakes recur, which problems are worth a walkthrough. The lesson corpus
 * itself (outlines, bodies, read receipts) is deliberately SHARED: the prose is
 * language-free by construction (LESSON_SYSTEM forbids fenced code in bodies),
 * so only the snippet forks, via code_translations in Phase 4. That is what
 * keeps all 19 read receipts valid across a language switch.
 */
export function buildStudyState(language: Language): StudyQueueState {
  materializeDerivedLessons();

  // One shared definition — see curriculum.masteryScore (the tier ladder's
  // display ordinal). The Study weakness bias compares it against WEAK_SCORE.
  const clean = getCleanSolvesByTopic(language);
  const skills: StudySkill[] = getSkillState(language).map((s) => ({
    topic: s.topic,
    attempts: s.attempts,
    mastery: masteryScore(clean.get(s.topic)),
  }));

  return {
    outlines: getAllTrackOutlines(),
    cached: getCachedLessonMeta(),
    reads: getLessonReads(),
    skills,
    mistakes: getMistakeContexts(language).map((m) => ({
      tag: m.tag,
      count: m.count,
      topic: (TOPICS as readonly string[]).includes(m.topic) ? m.topic : FOUNDATIONAL_START,
      problemId: m.problemId,
      problemTitle: m.problemTitle,
    })),
    walkthroughs: getWalkthroughCandidates(language).map((w) => ({
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
  // CORPUS_LANGUAGE: this is a write path (the primer it reads becomes lesson
  // 0's snippet) and generatePrimer authors in the corpus language regardless.
  if (getPrimer(CORPUS_LANGUAGE, topic)) return Promise.resolve();
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
  // CORPUS_LANGUAGE everywhere in this function: it decides whether a lesson
  // needs WRITING, and writes the shared corpus row when it does. Existence is
  // language-free; only the snippet an already-written lesson serves is not.
  if (slot.cached || getLesson(CORPUS_LANGUAGE, slot.id)) return Promise.resolve();

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
    let primer = getPrimer(CORPUS_LANGUAGE, slot.topic);
    if (!primer) {
      primer = await generatePrimer(slot.topic);
      insertPrimer(primer);
      insertLesson(primerToLesson(primer));
    }
    const lesson = await generateLessonBody(slot.topic, item, primer);
    insertLesson({ ...lesson, id: slot.id });
  });
}

/** The in-flight/failure key for one topic's translation batch. */
function translationKey(language: Language, topic: Topic): string {
  return `translate:${language}:${topic}`;
}

/**
 * Ensure every snippet this topic owns exists in `language`.
 *
 * ONE batched call per topic — the primer skeleton plus each of the topic's
 * lesson snippets, in a single request. That is the economics of the whole
 * shared-corpus decision: ~18 calls translate the entire corpus, against the
 * 90-180 generation calls forking it would cost. A per-snippet loop would spend
 * an order of magnitude more AND lose the internal consistency a batch buys.
 *
 * It rides the same `once()` machinery as lesson generation, so it inherits the
 * in-flight dedupe and the failure cooldown for free; the cooldown check is
 * explicit here because nothing upstream knows a translation key exists.
 */
export function ensureTranslations(language: Language, topic: Topic): Promise<void> {
  // The corpus is already written in this language — there is nothing to fork.
  if (language === CORPUS_LANGUAGE) return Promise.resolve();

  const snippets = getCorpusSnippets(topic);
  if (!snippets.length) return Promise.resolve();

  const have = getTranslatedSourceIds(language);
  const missing = snippets.filter((s) => !have.has(s.sourceId));
  if (!missing.length) return Promise.resolve();

  const key = translationKey(language, topic);
  if (isRecentlyFailed(key)) return Promise.resolve();

  return once(key, async () => {
    // The WHOLE topic goes in the request even though only `missing` is stored,
    // so the model sees the snippets it is being asked to stay consistent with.
    const translated = await translateSnippets(
      snippets.map((s) => ({ id: s.sourceId, code: s.code })),
      CORPUS_LANGUAGE,
      language
    );
    const rows = missing
      .filter((s) => translated.has(s.sourceId))
      .map((s) => ({ sourceId: s.sourceId, code: translated.get(s.sourceId)! }));
    if (!rows.length) throw new Error(`no snippet of ${topic} came back in ${language}`);
    putCodeTranslations(language, rows);
  });
}

/**
 * Fire-and-forget: warm the next few holes in the queue plus the outlines the
 * reader is about to need. NEVER awaited by a request handler.
 *
 * `language` is what the reader is practicing in, and it steers ONLY the
 * translation job — outlines and lesson bodies are the shared corpus and are
 * warmed identically whatever language is active.
 */
export function warmAhead(language: Language, queue: StudySlot[], depth = PREFETCH_DEPTH): void {
  // Outlines for the topics the reader is in / heading into — without one, a
  // topic plans only its seq-0 slot and the feed looks shorter than it is.
  const topics: Topic[] = [];
  for (const slot of queue) {
    if (slot.source !== 'track') continue;
    if (!topics.includes(slot.topic)) topics.push(slot.topic);
    if (topics.length >= 2) break;
  }
  for (const t of topics) void ensureOutline(t);

  // Snippets for the topics about to be READ, which is not the same list: a
  // reread or a personalized slot has no outline to warm but its code still has
  // to be in the right language. Bounded by `depth` for the same reason the
  // body warm is — this is the reader's next few screens, not the corpus.
  const ahead: Topic[] = [];
  for (const slot of queue.slice(0, depth)) {
    if (!ahead.includes(slot.topic)) ahead.push(slot.topic);
  }
  for (const t of ahead) void ensureTranslations(language, t);

  let warmed = 0;
  for (const slot of queue) {
    if (warmed >= depth) break;
    if (slot.cached) continue;
    if (isSlotFailed(slot)) continue;
    void ensureLesson(slot);
    warmed++;
  }
}
