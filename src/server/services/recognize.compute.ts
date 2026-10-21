// =============================================================================
// recognize.compute — the PURE brain behind the Recognize drill
// =============================================================================
// Distractors, session selection (weak/rusty bias + interleaving), the SRS
// wrapper, accuracy, and Today's "you're rusty" rule. No database, no clock it
// is not handed — like today.compute.ts, this must never import ./db.js — so
// every rule here is unit-tested on fixtures.

import { TOPICS, type Topic } from '../../shared/types.js';
import {
  GAP_CARD_LADDER_DAYS,
  describeOutcome,
  newCardSchedule,
  scheduleGapCard,
  type GapCardGrade,
  type GapCardSchedule,
} from '../../shared/gap-cards.js';
import type { RecognizeTopicStat, RecognizeVerdict } from '../../shared/recognize.js';

export function isTopic(x: unknown): x is Topic {
  return typeof x === 'string' && (TOPICS as readonly string[]).includes(x);
}

// -----------------------------------------------------------------------------
// Deterministic randomness — a card re-served on reload shows the same choices.
// -----------------------------------------------------------------------------
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// -----------------------------------------------------------------------------
// Distractors
// -----------------------------------------------------------------------------
/**
 * The patterns each topic is genuinely mistaken for. A distractor list drawn
 * from these makes the pick a real discrimination ("window or two pointers?")
 * instead of spot-the-odd-one-out ("trie or bit manipulation?").
 */
export const CONFUSABLE: Readonly<Record<Topic, readonly Topic[]>> = {
  arrays: ['hashing', 'two-pointer', 'sliding-window', 'greedy', 'math'],
  hashing: ['arrays', 'two-pointer', 'sliding-window', 'trie'],
  'two-pointer': ['sliding-window', 'binary-search', 'hashing', 'arrays', 'greedy'],
  'sliding-window': ['two-pointer', 'hashing', 'arrays', 'dynamic-programming'],
  'binary-search': ['two-pointer', 'greedy', 'math', 'heap'],
  stack: ['heap', 'two-pointer', 'linked-list', 'greedy'],
  'linked-list': ['two-pointer', 'stack', 'arrays', 'hashing'],
  trees: ['bfs-dfs', 'graphs', 'backtracking', 'trie'],
  graphs: ['bfs-dfs', 'trees', 'dynamic-programming', 'heap'],
  'bfs-dfs': ['graphs', 'trees', 'backtracking', 'dynamic-programming'],
  backtracking: ['dynamic-programming', 'bfs-dfs', 'greedy', 'trees'],
  'dynamic-programming': ['greedy', 'backtracking', 'math', 'sliding-window'],
  greedy: ['dynamic-programming', 'heap', 'intervals', 'two-pointer'],
  intervals: ['greedy', 'heap', 'arrays', 'two-pointer'],
  heap: ['greedy', 'binary-search', 'intervals', 'stack'],
  trie: ['hashing', 'trees', 'backtracking', 'bfs-dfs'],
  'bit-manipulation': ['math', 'hashing', 'arrays', 'dynamic-programming'],
  math: ['bit-manipulation', 'arrays', 'dynamic-programming', 'greedy'],
};

/**
 * Four shuffled choices: the answer and three distractors, preferring the
 * answer's confusables (up to all three), filling from the rest of TOPICS.
 * `alsoCorrect` (the problem's own pattern, when it is a different topic) is
 * never offered as a distractor — it would be a second right answer.
 */
export function pickChoices(answer: Topic, rng: () => number, alsoCorrect?: string): Topic[] {
  const banned = new Set<string>([answer, alsoCorrect ?? '']);
  const near = shuffle(CONFUSABLE[answer].filter((t) => !banned.has(t)), rng);
  const distractors: Topic[] = near.slice(0, 3);
  if (distractors.length < 3) {
    const rest = shuffle(
      TOPICS.filter((t) => !banned.has(t) && !distractors.includes(t)),
      rng
    );
    distractors.push(...rest.slice(0, 3 - distractors.length));
  }
  return shuffle([answer, ...distractors], rng);
}

/** Is a pick right? The topic, or the problem's own pattern when that is a topic. */
export function isPatternCorrect(picked: unknown, topic: string, pattern: string): boolean {
  if (!isTopic(picked)) return false;
  return picked === topic || (picked === pattern && isTopic(pattern));
}

// -----------------------------------------------------------------------------
// Weakness: which topics a session leans toward
// -----------------------------------------------------------------------------
export interface SkillLite {
  topic: string;
  attempts: number;
  solved: number;
  lastResult: string | null;
  lastSeenAt: string | null;
}

const DAY_MS = 86_400_000;

/**
 * 0..~3, higher = weaker/rustier. Never-grinded topics sit in the middle (0.8)
 * so a session still reaches them, but a topic you keep failing outranks them.
 *   + failure rate in grind (1 - solved/attempts)
 *   + 0.3 if the last grind result was a fail
 *   + rust: days since last seen / 14, capped at 1, halved
 *   + recognize misses: (1 - pattern accuracy) once there are 2+ cards
 */
export function topicWeakness(
  skill: SkillLite | undefined,
  stat: Pick<RecognizeTopicStat, 'n' | 'patternAccuracy'> | undefined,
  now: number
): number {
  let w = 0;
  if (!skill || skill.attempts === 0) w += 0.8;
  else {
    w += 1 - skill.solved / skill.attempts;
    if (skill.lastResult === 'fail') w += 0.3;
    if (skill.lastSeenAt) w += 0.5 * Math.min(1, (now - Date.parse(skill.lastSeenAt)) / (14 * DAY_MS));
  }
  if (stat && stat.n >= 2) w += 1 - stat.patternAccuracy;
  return w;
}

// -----------------------------------------------------------------------------
// Session selection
// -----------------------------------------------------------------------------
export interface RecognizeCandidate {
  problemId: string;
  title: string;
  topic: Topic;
  /** Served to grind before, attempted, or already revealed: showing its code costs nothing new. */
  codeFree: boolean;
  /** In the active language. Others only fill gaps. */
  activeLanguage: boolean;
  /** Last time this problem was a recognize card, or null. */
  lastRecognizedAt: string | null;
}

export interface DueCardLite {
  problemId: string;
  topic: Topic;
  dueAt: string;
}

export interface SelectInput {
  n: number;
  candidates: readonly RecognizeCandidate[];
  /** Due recognize cards, any order (sorted oldest-due first here). */
  due: readonly DueCardLite[];
  weakness: ReadonlyMap<string, number>;
  now: number;
  rng: () => number;
}

export interface Selection {
  /** Problem ids in serve order. */
  ids: string[];
  /** The subset that came from due cards. */
  dueIds: Set<string>;
  dueLeft: number;
}

/** At most this many cards of one topic per session — interleaving is the point. */
export function maxPerTopic(n: number): number {
  return Math.max(1, Math.ceil(n / 5));
}

/** Not re-served within this window unless due. */
export const RECENT_SKIP_DAYS = 3;

/**
 * Pick a session:
 *   1. due recognize cards first (oldest due), under the per-topic cap;
 *   2. fill by score = topic weakness (decayed each time the topic is picked)
 *      + 0.3 if the code is free to show + 0.2 active language + jitter,
 *      skipping problems seen in the last RECENT_SKIP_DAYS and duplicate titles;
 *   3. if the cap or the recency rule leaves the session short, relax them in
 *      that order rather than serve fewer cards than asked;
 *   4. order so no two neighbours share a topic (due cards still lead).
 */
export function selectSession(input: SelectInput): Selection {
  const { n, now, rng } = input;
  const cap = maxPerTopic(n);
  const byId = new Map(input.candidates.map((c) => [c.problemId, c]));
  const chosen: { id: string; topic: Topic; due: boolean }[] = [];
  const perTopic = new Map<string, number>();
  const titles = new Set<string>();
  const take = (id: string, topic: Topic, title: string, due: boolean) => {
    chosen.push({ id, topic, due });
    perTopic.set(topic, (perTopic.get(topic) ?? 0) + 1);
    titles.add(title.toLowerCase());
  };

  const due = [...input.due].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).filter((d) => byId.has(d.problemId));
  for (const d of due) {
    if (chosen.length >= n) break;
    if ((perTopic.get(d.topic) ?? 0) >= cap) continue;
    take(d.problemId, d.topic, byId.get(d.problemId)!.title, true);
  }
  const dueIds = new Set(chosen.map((c) => c.id));
  const dueLeft = due.filter((d) => !dueIds.has(d.problemId)).length;

  const recentCut = now - RECENT_SKIP_DAYS * DAY_MS;
  const jitter = new Map(input.candidates.map((c) => [c.problemId, rng() * 0.4]));
  const fill = (capLimit: number, respectRecent: boolean) => {
    while (chosen.length < n) {
      let best: RecognizeCandidate | null = null;
      let bestScore = -Infinity;
      for (const c of input.candidates) {
        if (chosen.some((x) => x.id === c.problemId)) continue;
        if (due.some((d) => d.problemId === c.problemId)) continue; // due-but-capped waits its turn
        if (titles.has(c.title.toLowerCase())) continue;
        if ((perTopic.get(c.topic) ?? 0) >= capLimit) continue;
        if (respectRecent && c.lastRecognizedAt && Date.parse(c.lastRecognizedAt) > recentCut) continue;
        const picks = perTopic.get(c.topic) ?? 0;
        const score =
          (input.weakness.get(c.topic) ?? 0.8) * Math.pow(0.5, picks) +
          (c.codeFree ? 0.3 : 0) +
          (c.activeLanguage ? 0.2 : 0) +
          (jitter.get(c.problemId) ?? 0);
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      if (!best) return;
      take(best.problemId, best.topic, best.title, false);
    }
  };
  fill(cap, true);
  fill(cap, false);
  fill(Infinity, false);

  return { ids: interleave(chosen).map((c) => c.id), dueIds, dueLeft };
}

/**
 * Reorder so no two neighbours share a topic when that is possible. Greedy:
 * at each slot take the first remaining item (due ones are first) whose topic
 * differs from the last — preferring the topic with the most items left, so a
 * 3-2 split comes out A B A B A rather than stranding two A's at the end.
 */
export function interleave<T extends { topic: string; due?: boolean }>(items: readonly T[]): T[] {
  const rest = [...items];
  const out: T[] = [];
  while (rest.length) {
    const prev = out[out.length - 1]?.topic;
    const counts = new Map<string, number>();
    for (const r of rest) counts.set(r.topic, (counts.get(r.topic) ?? 0) + 1);
    let idx = -1;
    let bestKey = -Infinity;
    rest.forEach((r, i) => {
      if (r.topic === prev) return;
      // due first, then the topic with the most left, then original order
      const key = (r.due ? 1000 : 0) + (counts.get(r.topic) ?? 0) * 10 - i * 0.001;
      if (key > bestKey) {
        bestKey = key;
        idx = i;
      }
    });
    if (idx < 0) idx = 0; // only one topic left: adjacency is unavoidable
    out.push(rest.splice(idx, 1)[0]);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Scheduling — the gap-card ladder, with a one-day floor
// -----------------------------------------------------------------------------
/**
 * The effective grade: a wrong pattern pick is a miss whatever the self-grade
 * says — the pick is the one part that is checked, not felt.
 */
export function effectiveGrade(patternCorrect: boolean, selfGrade: GapCardGrade): GapCardGrade {
  return patternCorrect ? selfGrade : 'missed';
}

/**
 * Reuses scheduleGapCard's [0,2,5,10] ladder verbatim, with one change: never
 * due sooner than tomorrow. A drill card answered "missed" comes back now on
 * purpose (it is a fact to re-read); a recognize card you just saw the answer
 * to would come back as a memory test, not a recognition one.
 *
 * `card` null = no card yet: a `got` creates nothing (it never needed drilling),
 * shaky/missed start one on the bottom rung.
 */
export function scheduleRecognizeCard(
  card: GapCardSchedule | null,
  grade: GapCardGrade,
  now: Date
): GapCardSchedule | null {
  if (!card && grade === 'got') return null;
  const next = scheduleGapCard(card ?? newCardSchedule(now), grade, now);
  const floor = now.getTime() + DAY_MS;
  if (!next.retiredAt && Date.parse(next.dueAt) < floor) next.dueAt = new Date(floor).toISOString();
  return next;
}

export function describeRecognizeOutcome(card: GapCardSchedule | null, grade: GapCardGrade): string {
  if (!card && grade === 'got') return 'not scheduled — you had it';
  if (!card) return 'again tomorrow';
  const words = describeOutcome(card, grade);
  return words === 'again now' ? 'again tomorrow' : words;
}

export { GAP_CARD_LADDER_DAYS };

// -----------------------------------------------------------------------------
// Accuracy
// -----------------------------------------------------------------------------
export interface RecognizeAttemptLite {
  topic: string;
  patternCorrect: boolean;
  grade: GapCardGrade;
  createdAt: string;
}

export const RECENT_WINDOW = 20;

export function topicStats(rows: readonly RecognizeAttemptLite[]): RecognizeTopicStat[] {
  const by = new Map<string, { n: number; ok: number; got: number }>();
  for (const r of rows) {
    const s = by.get(r.topic) ?? { n: 0, ok: 0, got: 0 };
    s.n += 1;
    if (r.patternCorrect) s.ok += 1;
    if (r.grade === 'got') s.got += 1;
    by.set(r.topic, s);
  }
  return [...by.entries()]
    .filter(([t]) => isTopic(t))
    .map(([topic, s]) => ({ topic: topic as Topic, n: s.n, patternAccuracy: s.ok / s.n, gotRate: s.got / s.n }))
    .sort((a, b) => a.patternAccuracy - b.patternAccuracy || b.n - a.n);
}

/**
 * Recent accuracy: a card counts as right when the pattern was right AND the
 * approach was not a miss. Over the newest RECENT_WINDOW cards; null with none.
 */
export function recentAccuracy(rows: readonly RecognizeAttemptLite[]): { accuracy: number | null; n: number } {
  const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_WINDOW);
  if (!recent.length) return { accuracy: null, n: 0 };
  const ok = recent.filter((r) => r.patternCorrect && r.grade !== 'missed').length;
  return { accuracy: ok / recent.length, n: recent.length };
}

// -----------------------------------------------------------------------------
// Today: is the user rusty?
// -----------------------------------------------------------------------------
export interface RustInput {
  /** Grind attempts since local midnight two days ago (= the last 3 local days). */
  grindAttemptsLast3Days: number;
  recentAccuracy: number | null;
  recentN: number;
  due: number;
  doneToday: number;
}

/** Below this recent accuracy (with enough cards to mean it), Recognize is recommended. */
export const RUSTY_ACCURACY = 0.6;
export const RUSTY_MIN_CARDS = 5;

export function recognizeAdvice(r: RustInput): { recommended: boolean; reason: string } {
  if (r.grindAttemptsLast3Days === 0) {
    return { recommended: true, reason: 'No grind in 3 days — reprime the patterns before you code.' };
  }
  if (r.recentAccuracy !== null && r.recentN >= RUSTY_MIN_CARDS && r.recentAccuracy < RUSTY_ACCURACY) {
    return {
      recommended: true,
      reason: `Recent recognize accuracy ${Math.round(r.recentAccuracy * 100)}% — worth a few more reps.`,
    };
  }
  if (r.due > 0) {
    return { recommended: true, reason: `${r.due} recognize card${r.due === 1 ? '' : 's'} due.` };
  }
  return { recommended: false, reason: 'Optional: read 5 problems, call the pattern, no code.' };
}

/** Coerce the AI check's verdict. */
export function coerceVerdict(x: unknown): RecognizeVerdict {
  return x === 'correct' || x === 'partly' || x === 'wrong' ? x : 'partly';
}
