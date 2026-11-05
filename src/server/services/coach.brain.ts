// =============================================================================
// coach.brain — what the coach wants you to do next, and why. PURE.
// =============================================================================
// Same contract as study.order.ts (read its header): every function here is a
// pure function over injected state. It imports ONLY shared types/constants,
// ./curriculum.js and ./study.order.js, and must never import ./db.js, directly
// or transitively. The stateful half (reading the tables) is coach.service.ts.
//
// The plan is a short list of CoachSteps, highest priority first:
//
//   FIX      — a slip tag you hit in the last SLIP_WINDOW_DAYS whose fix lesson
//              you have not read since; then topics whose last problem failed
//              or that are still below WEAK_SCORE.
//   DUE      — review problems that are due; lessons you marked fuzzy or that
//              have gone stale.
//   PRE-READ — the primer of the next unlocked topic you have not started.
//   PUSH     — only when nothing else applies: keep climbing a topic's tiers.
//
// Every step carries `then`: the problem set to practise after the read. The
// steps are consumed by the Learn feed (coachFeed), and are shaped for the
// Grind gate (grindGate) and the post-submit fix offer (fixOffer).
//
// Cost: nothing here generates anything. A FIX lesson that is not cached is
// returned with `cached: false`; the feed shows it as a stub and it is written
// only on an explicit click (POST /study/lesson/:id/write).

import type { Difficulty, LessonKind, TierLevel, Topic } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
import { fixTopic, tagInfo } from '../../shared/mistake-tags.js';
import {
  PREREQS,
  ROOT_TOPICS,
  UNLOCK_TIER,
  WEAK_SCORE,
  levelAtLeast,
  levelIndex,
  workingDifficulty,
} from './curriculum.js';
import {
  SEQ_MISTAKE,
  planTrackSlots,
  rereadSlots,
  studyQueue,
  topicOrder,
  type SlotSource,
  type StudyQueueState,
  type StudySkill,
  type StudySlot,
} from './study.order.js';

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------
/** A slip counts toward FIX for this long. */
export const SLIP_WINDOW_DAYS = 7;
/** fixOffer fires on the Nth slip of the same tag inside the window. */
export const FIX_OFFER_SLIPS = 2;
const MAX_SLIP_FIXES = 3;
const MAX_STRUGGLE_FIXES = 2;
const MAX_DUE_REVIEWS = 3;
const MAX_DUE_REREADS = 3;
const DEFAULT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL = levelIndex('expert');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------
export type CoachIntent = 'fix' | 'due' | 'pre-read' | 'push';

export interface CoachRead {
  lessonId: string;
  title: string;
  kind: LessonKind;
  /** False = not written yet; only an explicit click may write it. */
  cached: boolean;
  source: SlotSource;
  seq: number;
  /** Fix reads: the latest problem that carried the slip (grounds the lesson). */
  problemId?: string;
}

/** What to practise after the read (same shape as shared StudyPractice). */
export interface CoachThen {
  topic: Topic;
  difficulty: Difficulty;
  tag?: string;
  reviewProblemId?: string;
}

export interface CoachStep {
  /** Stable identity, e.g. `fix:search-boundary:binary-search`, `due:<problemId>`. */
  key: string;
  intent: CoachIntent;
  topic: Topic;
  tag?: string;
  read?: CoachRead;
  then: CoachThen;
  /** One line for the UI: "Because you slipped on search boundaries". */
  reason: string;
}

/** One tag on one tagged attempt. */
export interface CoachSlip {
  tag: string;
  /** The attempt's topic (may be stale or missing; fixTopic() falls back). */
  topic?: string | null;
  /** ISO timestamp of the attempt. */
  at: string;
  problemId?: string;
  problemTitle?: string;
}

export interface CoachSkill extends StudySkill {
  /** The most recent attempt on this topic did not pass. */
  lastFailed?: boolean;
}

export interface CoachReview {
  problemId: string;
  topic: Topic;
  difficulty: Difficulty;
  dueAt: string;
  title?: string;
}

export interface CoachState extends StudyQueueState {
  language: Language;
  skills: CoachSkill[];
  /** Tagged attempts, any order. Includes the attempt just submitted, if any. */
  slips: CoachSlip[];
  /** Completed tier per topic; missing = 'none'. */
  tiers: Map<Topic, TierLevel>;
  reviews: CoachReview[];
}

export interface CoachPlanOptions {
  limit?: number;
  /** Only steps for this topic (PUSH for it when nothing else applies). */
  topic?: Topic;
}

/** A feed position: a study slot plus why it is there and what follows it. */
export interface CoachFeedSlot extends StudySlot {
  intent: CoachIntent | 'ladder';
  reason: string;
  then: CoachThen;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
/** The fix lesson id: per (tag, topic), or per (tag, language) for language-scoped tags. */
export function fixLessonId(tag: string, topic: Topic, language: Language): string {
  return tagInfo(tag)?.scope === 'language' ? `fix:${tag}:${language}` : `fix:${tag}:${topic}`;
}

interface Ctx {
  state: CoachState;
  now: number;
  cachedIds: Set<string>;
  /** lessonId -> latest read time (ms). */
  readAt: Map<string, number>;
  skills: Map<Topic, CoachSkill>;
}

function ctx(state: CoachState): Ctx {
  const readAt = new Map<string, number>();
  for (const r of state.reads) {
    const t = Date.parse(r.readAt);
    if (!(readAt.get(r.lessonId)! >= t)) readAt.set(r.lessonId, t);
  }
  return {
    state,
    now: state.now ?? Date.now(),
    cachedIds: new Set(state.cached.map((m) => m.id)),
    readAt,
    skills: new Map(state.skills.map((s) => [s.topic, s])),
  };
}

function tierOf(c: Ctx, topic: Topic): TierLevel {
  return c.state.tiers.get(topic) ?? 'none';
}

function practise(c: Ctx, topic: Topic, extra: Partial<CoachThen> = {}): CoachThen {
  return { topic, difficulty: workingDifficulty(tierOf(c, topic)), ...extra };
}

function isUnlocked(c: Ctx, topic: Topic): boolean {
  if (ROOT_TOPICS.includes(topic)) return true;
  return PREREQS[topic].some((p) => levelAtLeast(tierOf(c, p), UNLOCK_TIER));
}

function readFromSlot(slot: StudySlot): CoachRead {
  return {
    lessonId: slot.id,
    title: slot.title,
    kind: slot.kind,
    cached: slot.cached,
    source: slot.source,
    seq: slot.seq,
  };
}

/** The first track slot of `topic` not read yet. */
function nextUnreadTrack(c: Ctx, topic: Topic): StudySlot | undefined {
  return planTrackSlots(topic, c.state.outlines.get(topic), c.cachedIds).find(
    (s) => !c.readAt.has(s.id)
  );
}

// -----------------------------------------------------------------------------
// FIX — slips
// -----------------------------------------------------------------------------
interface SlipGroup {
  key: string;
  tag: string;
  topic: Topic;
  count: number;
  latest: number;
  problemId?: string;
}

function slipGroups(c: Ctx): SlipGroup[] {
  const since = c.now - SLIP_WINDOW_DAYS * DAY_MS;
  const groups = new Map<string, SlipGroup>();
  for (const s of c.state.slips) {
    if (!tagInfo(s.tag)) continue; // closed vocabulary
    const at = Date.parse(s.at);
    if (!(at >= since) || at > c.now) continue;
    const topic = fixTopic(s.tag, s.topic);
    const key = fixLessonId(s.tag, topic, c.state.language);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, tag: s.tag, topic, count: 1, latest: at, problemId: s.problemId });
    } else {
      g.count++;
      if (at >= g.latest) {
        g.latest = at;
        g.topic = topic;
        g.problemId = s.problemId ?? g.problemId;
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.latest - a.latest || b.count - a.count || a.key.localeCompare(b.key)
  );
}

/** Cached legacy `mistake:<tag>:<n>` ids, lowest n first. */
function legacyIds(c: Ctx, tag: string): string[] {
  const prefix = `mistake:${tag}:`;
  return c.state.cached
    .filter((m) => m.id.startsWith(prefix))
    .map((m) => ({ id: m.id, n: Number(m.id.slice(prefix.length)) }))
    .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id))
    .map((x) => x.id);
}

function fixSatisfied(c: Ctx, g: SlipGroup): boolean {
  for (const id of [g.key, ...legacyIds(c, g.tag)]) {
    const t = c.readAt.get(id);
    if (t !== undefined && t >= g.latest) return true;
  }
  return false;
}

function slipStep(c: Ctx, g: SlipGroup): CoachStep {
  const info = tagInfo(g.tag)!;
  const meta = new Map(c.state.cached.map((m) => [m.id, m]));
  let read: CoachRead;
  const legacy = legacyIds(c, g.tag);
  if (c.cachedIds.has(g.key)) {
    const m = meta.get(g.key)!;
    read = { lessonId: g.key, title: m.title, kind: m.kind, cached: true, source: 'fix', seq: m.seq };
  } else if (legacy.length) {
    const m = meta.get(legacy[0])!;
    read = { lessonId: m.id, title: m.title, kind: m.kind, cached: true, source: 'mistake', seq: m.seq };
  } else {
    const where = info.scope === 'language' ? c.state.language : g.topic;
    read = {
      lessonId: g.key,
      title: `Fixing ${info.label.toLowerCase()} in ${where}`,
      kind: 'mistake',
      cached: false,
      source: 'fix',
      seq: SEQ_MISTAKE,
      problemId: g.problemId,
    };
  }
  return {
    key: g.key,
    intent: 'fix',
    topic: g.topic,
    tag: g.tag,
    read,
    then: practise(c, g.topic, { tag: g.tag }),
    reason: `Because you slipped on ${info.label.toLowerCase()}`,
  };
}

function slipFixes(c: Ctx): CoachStep[] {
  return slipGroups(c)
    .filter((g) => !fixSatisfied(c, g))
    .map((g) => slipStep(c, g));
}

// -----------------------------------------------------------------------------
// FIX — struggling topics
// -----------------------------------------------------------------------------
function struggleFixes(c: Ctx): CoachStep[] {
  const out: CoachStep[] = [];
  for (const topic of topicOrder(c.state.skills)) {
    const s = c.skills.get(topic);
    if (!s) continue;
    const failed = !!s.lastFailed;
    const shaky = s.attempts >= 1 && s.mastery < WEAK_SCORE;
    if (!failed && !shaky) continue;
    const slot = nextUnreadTrack(c, topic);
    if (!slot) continue;
    out.push({
      key: `struggle:${topic}`,
      intent: 'fix',
      topic,
      read: readFromSlot(slot),
      then: practise(c, topic),
      reason: failed
        ? `Because your last ${topic} problem didn't pass`
        : `Because ${topic} is still shaky`,
    });
    if (out.length >= MAX_STRUGGLE_FIXES) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// DUE
// -----------------------------------------------------------------------------
function dueReviews(c: Ctx): CoachStep[] {
  return c.state.reviews
    .filter((r) => Date.parse(r.dueAt) <= c.now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.problemId.localeCompare(b.problemId))
    .slice(0, MAX_DUE_REVIEWS)
    .map((r) => ({
      key: `due:${r.problemId}`,
      intent: 'due' as const,
      topic: r.topic,
      then: { topic: r.topic, difficulty: r.difficulty, reviewProblemId: r.problemId },
      reason: 'Due for a re-solve',
    }));
}

function dueRereads(c: Ctx): CoachStep[] {
  const fuzzy = new Set(c.state.reads.filter((r) => r.fuzzy).map((r) => r.lessonId));
  return rereadSlots(c.state.cached, c.state.reads, c.now)
    .slice(0, MAX_DUE_REREADS)
    .map((slot) => ({
      key: `reread:${slot.id}`,
      intent: 'due' as const,
      topic: slot.topic,
      read: readFromSlot(slot),
      then: practise(c, slot.topic),
      reason: fuzzy.has(slot.id) ? 'You marked this fuzzy' : 'Getting stale',
    }));
}

// -----------------------------------------------------------------------------
// PRE-READ and PUSH
// -----------------------------------------------------------------------------
function preRead(c: Ctx, only?: Topic): CoachStep[] {
  for (const topic of topicOrder(c.state.skills)) {
    if (only && topic !== only) continue;
    if (!isUnlocked(c, topic)) continue;
    if ((c.skills.get(topic)?.attempts ?? 0) > 0) continue;
    const slot = planTrackSlots(topic, c.state.outlines.get(topic), c.cachedIds)[0];
    if (c.readAt.has(slot.id)) continue;
    return [preReadStep(topic, slot)];
  }
  return [];
}

function preReadStep(topic: Topic, slot: StudySlot): CoachStep {
  return {
    key: `pre-read:${topic}`,
    intent: 'pre-read',
    topic,
    read: readFromSlot(slot),
    then: { topic, difficulty: 'easy' },
    reason: `Before your first ${topic} problem`,
  };
}

function push(c: Ctx, only?: Topic): CoachStep[] {
  for (const topic of topicOrder(c.state.skills)) {
    if (only && topic !== only) continue;
    if (!only && !isUnlocked(c, topic)) continue;
    if (!only && levelIndex(tierOf(c, topic)) >= TOP_LEVEL) continue;
    return [
      {
        key: `push:${topic}`,
        intent: 'push',
        topic,
        then: practise(c, topic),
        reason: `Keep climbing ${topic}`,
      },
    ];
  }
  return [];
}

// -----------------------------------------------------------------------------
// coachPlan — the ordered next steps.
// -----------------------------------------------------------------------------
function fullPlan(c: Ctx, only?: Topic): CoachStep[] {
  const steps = [
    ...slipFixes(c).slice(0, MAX_SLIP_FIXES),
    ...struggleFixes(c),
    ...dueReviews(c),
    ...dueRereads(c),
    ...preRead(c, only),
  ].filter((s) => !only || s.topic === only);
  const seen = new Set<string>();
  const out: CoachStep[] = [];
  for (const s of steps) {
    const id = s.read?.lessonId ?? s.key;
    if (seen.has(s.key) || seen.has(id)) continue;
    seen.add(s.key);
    seen.add(id);
    out.push(s);
  }
  return out.length ? out : push(c, only);
}

/** The coach's next steps, highest priority first. Deterministic for a given state. */
export function coachPlan(state: CoachState, opts: CoachPlanOptions = {}): CoachStep[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  return fullPlan(ctx(state), opts.topic).slice(0, Math.max(0, limit));
}

// -----------------------------------------------------------------------------
// coachFeed — the Learn feed in coach order.
// -----------------------------------------------------------------------------
function stepToSlot(step: CoachStep): CoachFeedSlot {
  const r = step.read!;
  return {
    id: r.lessonId,
    topic: step.topic,
    kind: r.kind,
    seq: r.seq,
    title: r.title,
    cached: r.cached,
    source: r.source,
    tag: step.tag,
    problemId: r.problemId,
    intent: step.intent,
    reason: step.reason,
    then: step.then,
  };
}

/** Why a plain studyQueue slot is where it is. */
export function annotateSlot(state: CoachState, slot: StudySlot): CoachFeedSlot {
  return annotate(ctx(state), slot);
}

function annotate(c: Ctx, slot: StudySlot): CoachFeedSlot {
  switch (slot.source) {
    case 'mistake':
    case 'fix': {
      const label = slot.tag ? (tagInfo(slot.tag)?.label ?? slot.tag).toLowerCase() : 'this';
      return {
        ...slot,
        intent: 'fix',
        reason: `Because you keep hitting ${label}`,
        then: practise(c, slot.topic, slot.tag ? { tag: slot.tag } : {}),
      };
    }
    case 'reread':
      return { ...slot, intent: 'due', reason: 'Worth a re-read', then: practise(c, slot.topic) };
    case 'walkthrough':
      return {
        ...slot,
        intent: 'ladder',
        reason: 'A walkthrough of a problem you attempted',
        then: practise(c, slot.topic),
      };
    default:
      return { ...slot, intent: 'ladder', reason: 'Up next in your ladder', then: practise(c, slot.topic) };
  }
}

/**
 * The whole Learn feed: FIX reads, then DUE re-reads, then the pre-read, then
 * the studyQueue spine. Each lesson id appears once. Uncached fix/mistake
 * slots are stubs for the client; nothing here causes generation.
 */
export function coachFeed(state: CoachState): CoachFeedSlot[] {
  const c = ctx(state);
  const head = [
    ...slipFixes(c).slice(0, MAX_SLIP_FIXES),
    ...struggleFixes(c),
    ...dueRereads(c),
    ...preRead(c),
  ].filter((s) => s.read);
  const out: CoachFeedSlot[] = [];
  const seen = new Set<string>();
  for (const step of head) {
    if (seen.has(step.read!.lessonId)) continue;
    seen.add(step.read!.lessonId);
    out.push(stepToSlot(step));
  }
  for (const slot of studyQueue(state)) {
    if (seen.has(slot.id)) continue;
    seen.add(slot.id);
    out.push(annotate(c, slot));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Grind hooks (consumed from Phase 3 on)
// -----------------------------------------------------------------------------
/**
 * Before the first problem in `topic`: read its primer. Null once the topic has
 * an attempt or its primer has been read. Advisory; the caller decides whether
 * it blocks.
 */
export function grindGate(state: CoachState, topic: Topic): CoachStep | null {
  const c = ctx(state);
  if ((c.skills.get(topic)?.attempts ?? 0) > 0) return null;
  const slot = planTrackSlots(topic, state.outlines.get(topic), c.cachedIds)[0];
  if (c.readAt.has(slot.id)) return null;
  return preReadStep(topic, slot);
}

/**
 * After a submit tagged `justTagged` in `topic`: the fix to offer, or null. It
 * fires when one of those tags has FIX_OFFER_SLIPS+ slips in the window (the
 * state's slips must include the attempt just submitted) and its fix has not
 * been read since the latest one.
 */
export function fixOffer(
  state: CoachState,
  justTagged: readonly string[],
  topic: Topic
): CoachStep | null {
  const c = ctx(state);
  const wanted = new Set(
    justTagged.filter((t) => tagInfo(t)).map((t) => fixLessonId(t, fixTopic(t, topic), state.language))
  );
  for (const g of slipGroups(c)) {
    if (!wanted.has(g.key) || g.count < FIX_OFFER_SLIPS || fixSatisfied(c, g)) continue;
    return slipStep(c, g);
  }
  return null;
}
