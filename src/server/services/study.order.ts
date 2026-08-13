// =============================================================================
// study.order — the deterministic, PURE ordering brain for the Study feed
// =============================================================================
// Everything in here is a pure function over injected state: no database, no
// LLM, no clock it cannot be handed. That is deliberate — it is the piece with
// all the interesting logic, so it has to be unit-testable in isolation.
//
// It imports ONLY shared types and ./curriculum.js (constants). It must never
// import ./db.js, directly or transitively: db.ts opens SQLite at module scope,
// which would make merely importing this module touch the live database and
// bind the test suite to a native-module ABI. The stateful half — reading these
// tables, generating lessons, prefetching — lives in ./study.service.ts.

import {
  TOPICS,
  MISTAKE_TAGS,
  type Topic,
  type Lesson,
  type LessonKind,
  type Primer,
  type TrackOutlineItem,
} from '../../shared/types.js';
import {
  PREREQS,
  ROOT_TOPICS,
  FOUNDATIONAL_START,
  WEAK_SCORE,
} from './curriculum.js';

// -----------------------------------------------------------------------------
// LessonMeta — the lightweight cached-lesson row the planner works from. Defined
// here rather than in db.ts so the pure layer owns its own input shape; db.ts
// re-exports it for its query helpers.
// -----------------------------------------------------------------------------
export interface LessonMeta {
  id: string;
  topic: Topic;
  kind: LessonKind;
  seq: number;
  title: string;
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------
/** A read lesson resurfaces for a re-read once it is this stale. */
const REREAD_STALE_DAYS = 30;
/** Caps on the personalized phase so the queue stays a sane length. */
const MAX_MISTAKE_SLOTS = 5;
const MAX_WALKTHROUGH_SLOTS = 5;
const MAX_REREAD_SLOTS = 10;
/** seq bands for the personalized phase (track lessons are 0..n). */
const SEQ_MISTAKE = 1000;
const SEQ_WALKTHROUGH = 1100;
/** How far ahead the prefetcher generates. */
export const PREFETCH_DEPTH = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// -----------------------------------------------------------------------------
// Slot — one planned position in the reading order. It may or may not have been
// written yet (`cached`); the feed only ever serves cached slots.
// -----------------------------------------------------------------------------
export type SlotSource = 'track' | 'mistake' | 'walkthrough' | 'reread';

export interface StudySlot {
  id: string;
  topic: Topic;
  kind: LessonKind;
  seq: number;
  title: string;
  cached: boolean;
  source: SlotSource;
  /** Outline one-liner, when the slot came from a generated track outline. */
  brief?: string;
  /** Mistake slots: the MISTAKE_TAGS tag this lesson is about. */
  tag?: string;
  /** Walkthrough slots: the problem to explain. */
  problemId?: string;
}

// -----------------------------------------------------------------------------
// Injected state — everything studyQueue() needs, and nothing it can't be given
// by a test literal.
// -----------------------------------------------------------------------------
export interface StudySkill {
  topic: Topic;
  attempts: number;
  /** Display ordinal 0..1, same scale as PatternStat.masteryScore. */
  mastery: number;
}

export interface StudyReadState {
  lessonId: string;
  readAt: string;
  fuzzy: boolean;
}

export interface StudyMistake {
  tag: string;
  count: number;
  topic: Topic;
  problemId?: string;
  problemTitle?: string;
}

export interface StudyWalkthrough {
  problemId: string;
  title: string;
  topic: Topic;
}

export interface StudyQueueState {
  /** Cached track outlines, keyed by topic. Topics without one plan seq 0 only. */
  outlines: Map<Topic, TrackOutlineItem[]>;
  /** Every lesson already written to the cache. */
  cached: LessonMeta[];
  reads: StudyReadState[];
  skills: StudySkill[];
  mistakes?: StudyMistake[];
  walkthroughs?: StudyWalkthrough[];
  /** Injectable clock so staleness is testable. Defaults to Date.now(). */
  now?: number;
}

// -----------------------------------------------------------------------------
// Rule 1 — the topological spine.
// -----------------------------------------------------------------------------
/**
 * Canonical tie-break order: the foundational start, then the other roots, then
 * everything else in the shared TOPICS order.
 */
const CANONICAL_ORDER: Topic[] = [
  FOUNDATIONAL_START,
  ...ROOT_TOPICS.filter((t) => t !== FOUNDATIONAL_START),
  ...TOPICS.filter((t) => !ROOT_TOPICS.includes(t)),
];

const CANONICAL_INDEX = new Map<Topic, number>(CANONICAL_ORDER.map((t, i) => [t, i]));

/** topic -> topics that list it as a prerequisite. */
function dependentsMap(): Map<Topic, Topic[]> {
  const deps = new Map<Topic, Topic[]>();
  for (const t of TOPICS) deps.set(t, []);
  for (const t of TOPICS) {
    for (const p of PREREQS[t]) deps.get(p)!.push(t);
  }
  return deps;
}

/** Rule 4's pull: weak + actually attempted outranks everything else. */
const WEAK_PULL = 2;
/** Keeps `arrays` ahead of the other roots at cold start. */
const START_BUMP = 0.5;

function basePriority(topic: Topic, skills: Map<Topic, StudySkill>): number {
  let p = topic === FOUNDATIONAL_START ? START_BUMP : 0;
  const s = skills.get(topic);
  if (s && s.attempts >= 1 && s.mastery < WEAK_SCORE) p += WEAK_PULL;
  return p;
}

/**
 * Reading order over the prerequisite DAG.
 *
 * Priority-aware Kahn: prerequisites ALWAYS precede their dependents (rule 1),
 * and among the topics that are currently unlocked we take the highest-priority
 * one. A weak topic's priority propagates up its whole prerequisite chain, so
 * "pull the weak topic forward" (rule 4) drags the chain that leads to it
 * forward too — without ever violating the DAG.
 */
export function topicOrder(skills: StudySkill[]): Topic[] {
  const byTopic = new Map<Topic, StudySkill>(skills.map((s) => [s.topic, s]));
  const deps = dependentsMap();

  // Effective priority = own base, raised by the strongest transitive dependent.
  const effective = new Map<Topic, number>();
  for (const t of TOPICS) {
    let best = basePriority(t, byTopic);
    const seen = new Set<Topic>([t]);
    const stack = [...deps.get(t)!];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      best = Math.max(best, basePriority(d, byTopic));
      stack.push(...deps.get(d)!);
    }
    effective.set(t, best);
  }

  const indegree = new Map<Topic, number>(TOPICS.map((t) => [t, PREREQS[t].length]));
  const ready = TOPICS.filter((t) => indegree.get(t) === 0);
  const out: Topic[] = [];

  while (ready.length) {
    ready.sort((a, b) => {
      const d = (effective.get(b) ?? 0) - (effective.get(a) ?? 0);
      if (d !== 0) return d;
      return (CANONICAL_INDEX.get(a) ?? 0) - (CANONICAL_INDEX.get(b) ?? 0);
    });
    const next = ready.shift()!;
    out.push(next);
    for (const d of deps.get(next)!) {
      const n = (indegree.get(d) ?? 0) - 1;
      indegree.set(d, n);
      if (n === 0) ready.push(d);
    }
  }

  // A cycle would strand topics; append them so nothing is ever lost.
  for (const t of CANONICAL_ORDER) if (!out.includes(t)) out.push(t);
  return out;
}

// -----------------------------------------------------------------------------
// Rule 2 — the slots inside one topic's track, ordered by seq.
// -----------------------------------------------------------------------------
/**
 * Slot 0 exists for every topic: it is derived from the cached Primer, free.
 *
 * The `seq >= 1` filter must mirror planTrackSlots' exactly. Slot 0 is
 * synthesized from the primer, so a stored outline item at seq 0 is a duplicate
 * and gets dropped there. Counting it here would inflate the denominator the
 * feed can never reach -- "lesson 6 of 7", forever. The LLM path can't emit one
 * today (generateTrackOutline renumbers from 1), so this only bites a
 * hand-written or migrated track_outlines row.
 */
export function trackSlotCount(outline: TrackOutlineItem[] | undefined): number {
  return 1 + (outline?.filter((item) => item.seq >= 1).length ?? 0);
}

export function planTrackSlots(
  topic: Topic,
  outline: TrackOutlineItem[] | undefined,
  cachedIds: ReadonlySet<string>
): StudySlot[] {
  const slots: StudySlot[] = [
    {
      id: `${topic}:0`,
      topic,
      kind: 'concept',
      seq: 0,
      title: `${topic} — recognize and apply`,
      cached: cachedIds.has(`${topic}:0`),
      source: 'track',
    },
  ];
  for (const item of outline ?? []) {
    if (item.seq < 1) continue; // seq 0 is always the primer-derived lesson
    const id = `${topic}:${item.seq}`;
    slots.push({
      id,
      topic,
      kind: item.kind,
      seq: item.seq,
      title: item.title,
      cached: cachedIds.has(id),
      source: 'track',
      brief: item.brief,
    });
  }
  return slots.sort((a, b) => a.seq - b.seq);
}

// -----------------------------------------------------------------------------
// Rule 5 — the personalized phase, in priority order.
// -----------------------------------------------------------------------------
const MISTAKE_TAG_SET = new Set<string>(MISTAKE_TAGS);

function mistakeSlots(
  mistakes: StudyMistake[],
  cachedIds: ReadonlySet<string>,
  readIds: ReadonlySet<string>
): StudySlot[] {
  const out: StudySlot[] = [];
  for (const m of mistakes) {
    if (!MISTAKE_TAG_SET.has(m.tag)) continue; // closed vocabulary
    // One unread lesson per tag at a time; the counter advances as they're read,
    // which is what makes the mistake generator cyclic rather than finite.
    let n = 1;
    while (readIds.has(`mistake:${m.tag}:${n}`)) n++;
    const id = `mistake:${m.tag}:${n}`;
    out.push({
      id,
      topic: m.topic,
      kind: 'mistake',
      seq: SEQ_MISTAKE + n,
      title: `Your recurring miss: ${m.tag}`,
      cached: cachedIds.has(id),
      source: 'mistake',
      tag: m.tag,
      problemId: m.problemId,
    });
    if (out.length >= MAX_MISTAKE_SLOTS) break;
  }
  return out;
}

function walkthroughSlots(
  walkthroughs: StudyWalkthrough[],
  cachedIds: ReadonlySet<string>,
  readIds: ReadonlySet<string>
): StudySlot[] {
  const out: StudySlot[] = [];
  for (const w of walkthroughs) {
    const id = `walkthrough:${w.problemId}`;
    if (readIds.has(id)) continue;
    out.push({
      id,
      topic: w.topic,
      kind: 'walkthrough',
      seq: SEQ_WALKTHROUGH + out.length,
      title: `Walkthrough: ${w.title}`,
      cached: cachedIds.has(id),
      source: 'walkthrough',
      problemId: w.problemId,
    });
    if (out.length >= MAX_WALKTHROUGH_SLOTS) break;
  }
  return out;
}

function rereadSlots(
  cached: LessonMeta[],
  reads: StudyReadState[],
  now: number
): StudySlot[] {
  const byId = new Map<string, LessonMeta>(cached.map((m) => [m.id, m]));
  const due = reads
    .filter((r) => byId.has(r.lessonId))
    .filter((r) => r.fuzzy || now - new Date(r.readAt).getTime() >= REREAD_STALE_DAYS * DAY_MS)
    // Fuzzy first ("didn't stick"), then oldest-read first.
    .sort((a, b) => {
      if (a.fuzzy !== b.fuzzy) return a.fuzzy ? -1 : 1;
      return a.readAt.localeCompare(b.readAt);
    })
    .slice(0, MAX_REREAD_SLOTS);

  return due.map((r) => {
    const meta = byId.get(r.lessonId)!;
    return {
      id: meta.id,
      topic: meta.topic,
      kind: meta.kind,
      seq: meta.seq,
      title: meta.title,
      cached: true,
      source: 'reread' as const,
    };
  });
}

// -----------------------------------------------------------------------------
// studyQueue — the whole reading order, front to back. PURE.
// -----------------------------------------------------------------------------
/**
 * The ordered list of everything left to read.
 *
 * 1. Topological spine from FOUNDATIONAL_START over PREREQS.
 * 2. Within a topic, lessons by seq (seq 0 = primer-derived).
 * 3. Anything already read is skipped (the re-read phase resurfaces it later).
 * 4. Weak + attempted topics (mastery < WEAK_SCORE — i.e. they have not
 *    completed even the easy tier) are pulled forward,
 *    prerequisite chain and all.
 * 5. Once the tracks run out: mistake lessons, then walkthroughs, then
 *    fuzzy/stale re-reads — the "never-ending" tail.
 *
 * Slots may be uncached; the caller decides what it can actually serve.
 */
export function studyQueue(state: StudyQueueState): StudySlot[] {
  const now = state.now ?? Date.now();
  const cachedIds = new Set(state.cached.map((m) => m.id));
  const readIds = new Set(state.reads.map((r) => r.lessonId));

  const out: StudySlot[] = [];
  for (const topic of topicOrder(state.skills)) {
    for (const slot of planTrackSlots(topic, state.outlines.get(topic), cachedIds)) {
      if (readIds.has(slot.id)) continue; // rule 3
      out.push(slot);
    }
  }

  out.push(...mistakeSlots(state.mistakes ?? [], cachedIds, readIds));
  out.push(...walkthroughSlots(state.walkthroughs ?? [], cachedIds, readIds));
  out.push(...rereadSlots(state.cached, state.reads, now));
  return out;
}

// -----------------------------------------------------------------------------
// primerToLesson — seq 0 of every track, DERIVED from the cached Primer.
// Pure, free, and it keeps the Library's existing content rather than paying to
// regenerate it. Only seq >= 1 ever costs an API call.
// -----------------------------------------------------------------------------
export function primerToLesson(primer: Primer): Lesson {
  const topic = primer.pattern as Topic;
  const cues = primer.recognitionCues.filter((c) => c.trim());
  const pitfalls = primer.pitfalls.filter((p) => p.trim());

  const sections: string[] = [];
  sections.push(
    `Before anything else, **${topic}** is a shape you learn to see. This first lesson is the recognition card — the cues, the skeleton, and the ways it goes wrong.`
  );

  if (cues.length) {
    sections.push(
      `## When to reach for it\n\n${cues.map((c) => `- ${c}`).join('\n')}`
    );
  }
  if (primer.template.trim()) {
    sections.push(
      `## The shape\n\nThe skeleton below is the one to have in muscle memory — fill the placeholders, don't rederive the frame.`
    );
  }
  if (pitfalls.length) {
    sections.push(
      `## Where it goes wrong\n\n${pitfalls.map((p) => `- ${p}`).join('\n')}`
    );
  }
  if (primer.example.title.trim() || primer.example.insight.trim()) {
    sections.push(
      `## Canonical example\n\n**${primer.example.title || topic}** — ${primer.example.insight}`
    );
  }

  const takeaway =
    primer.example.insight.trim() ||
    cues[0] ||
    `Recognize ${topic} from the prompt before you start writing.`;

  return {
    id: `${topic}:0`,
    topic,
    kind: 'concept',
    seq: 0,
    title: `${topic} — recognize and apply`,
    body: sections.join('\n\n'),
    code: primer.template.trim() || undefined,
    takeaway,
  };
}
