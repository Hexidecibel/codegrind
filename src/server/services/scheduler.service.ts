// =============================================================================
// scheduler.service — deterministic, free, per-problem intent picker + skill tree
// =============================================================================
// Given per-topic skill state (spaced repetition) and derived mastery, this
// emits a SchedulerIntent { kind, topic, difficulty, ... } for the NEXT problem.
// No LLM calls — this is the cheap "coach brain" that runs every problem. The
// session planner (llm.service.planSession) only nudges it via `plan.focus`.

import {
  TOPICS,
  type Topic,
  type Difficulty,
  type SchedulerIntentKind,
  type SessionPlan,
} from '../../shared/types.js';
import {
  getSkillState,
  getProgress,
  getBankTitles,
  getRecentSolvedProblem,
  getDueReview,
  getProblem,
  getReviewDueCount,
  type SkillRow,
} from './db.js';

// -----------------------------------------------------------------------------
// Intent — what the scheduler decides to serve next.
// -----------------------------------------------------------------------------
export interface SchedulerIntent {
  kind: SchedulerIntentKind;
  topic: Topic;
  difficulty: Difficulty;
  /** Short human "why this one" string, surfaced to the player. */
  rationale: string;
  /** For `variation`: the solved problem this drills a fresh shape of. */
  variationOfProblemId?: string;
  /** Titles the generator must not reuse (variation/level-up/new-pattern). */
  avoidTitles?: string[];
  /** For `review`: the exact problem to re-serve cold (retrieval loop). */
  reviewProblemId?: string;
}

export interface NextIntentOpts {
  plan?: SessionPlan;
  /** Topic just served — the scheduler avoids repeating it back-to-back. */
  avoidTopic?: string;
}

// -----------------------------------------------------------------------------
// Skill tree — prerequisites-of each topic. Roots (empty) are available from the
// start. A topic is eligible for `new-pattern` once ≥1 prerequisite is mastered.
// -----------------------------------------------------------------------------
export const PREREQS: Record<Topic, Topic[]> = {
  // roots
  arrays: [],
  hashing: [],
  math: [],
  'bit-manipulation': [],
  // built on arrays
  'two-pointer': ['arrays'],
  'sliding-window': ['arrays', 'two-pointer'],
  'binary-search': ['arrays'],
  intervals: ['arrays', 'two-pointer'],
  stack: ['arrays'],
  'linked-list': ['arrays'],
  greedy: ['arrays', 'intervals'],
  // structural
  trees: ['linked-list'],
  'bfs-dfs': ['trees'],
  graphs: ['bfs-dfs'],
  backtracking: ['trees'],
  'dynamic-programming': ['backtracking'],
  heap: ['trees'],
  trie: ['trees'],
};

const ROOT_TOPICS: Topic[] = ['arrays', 'hashing', 'math', 'bit-manipulation'];
const FOUNDATIONAL_START: Topic = 'arrays';

// A topic counts as "mastered" (for progression/tree unlock) at/above this.
const MASTERY_THRESHOLD = 0.6;
// A topic counts as "weak" (reinforce candidate) below this.
const WEAK_THRESHOLD = 0.5;

const DIFF_ORDER: Difficulty[] = ['easy', 'medium', 'hard'];
function nextDifficulty(d: Difficulty): Difficulty {
  return DIFF_ORDER[Math.min(DIFF_ORDER.indexOf(d) + 1, DIFF_ORDER.length - 1)];
}

// -----------------------------------------------------------------------------
// Per-topic view — skill row + derived mastery/staleness, one per TOPIC.
// -----------------------------------------------------------------------------
interface TopicView {
  topic: Topic;
  attempts: number;
  solved: number;
  mastery: number; // 0..1
  currentDifficulty: Difficulty;
  box: number;
  streak: number;
  lastResult: SkillRow['lastResult'];
  lastSeenAt: string | null;
  dueAt: string | null;
  overdue: boolean;
  staleDays: number;
  failedLast: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function buildViews(): TopicView[] {
  const skill = new Map<Topic, SkillRow>();
  for (const s of getSkillState()) skill.set(s.topic, s);

  // Supplementary weakness signal from the pattern-keyed progress table: when a
  // pattern tag happens to match a topic name, fold its mastery in.
  const progressByName = new Map<string, number>();
  for (const p of getProgress()) progressByName.set(p.pattern, p.masteryScore);

  const now = Date.now();

  return TOPICS.map((topic): TopicView => {
    const s = skill.get(topic);
    const attempts = s?.attempts ?? 0;
    const solved = s?.solved ?? 0;

    let mastery = 0;
    if (s && attempts > 0) {
      const solveRate = solved / attempts;
      let recency = 0;
      if (s.lastSeenAt) {
        const ageDays = (now - new Date(s.lastSeenAt).getTime()) / DAY_MS;
        recency = Math.max(0, 1 - ageDays / 30);
      }
      mastery = solveRate * 0.8 + recency * 0.2;
    }
    // Blend in same-named pattern mastery if present (never lowers below skill).
    const byName = progressByName.get(topic);
    if (byName !== undefined) mastery = Math.max(mastery, (mastery + byName) / 2);

    const dueAt = s?.dueAt ?? null;
    const overdue = dueAt ? new Date(dueAt).getTime() <= now : false;
    const staleDays = s?.lastSeenAt
      ? (now - new Date(s.lastSeenAt).getTime()) / DAY_MS
      : Infinity;

    return {
      topic,
      attempts,
      solved,
      mastery,
      currentDifficulty: s?.currentDifficulty ?? 'easy',
      box: s?.box ?? 0,
      streak: s?.streak ?? 0,
      lastResult: s?.lastResult ?? null,
      lastSeenAt: s?.lastSeenAt ?? null,
      dueAt,
      overdue,
      staleDays,
      failedLast: s?.lastResult === 'failed',
    };
  });
}

// -----------------------------------------------------------------------------
// Seeded RNG — varied but not Math.random. Seed derived from live state so the
// pick feels fresh across problems yet stays a pure function of that seed.
// (Time is folded in so identical state on two different problems still varies.)
// -----------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seedFrom(views: TopicView[], avoidTopic?: string): number {
  let base = 0;
  for (const v of views) base = (base + v.attempts * 31 + v.solved * 17 + v.box * 7) | 0;
  base ^= avoidTopic ? hashString(avoidTopic) : 0;
  // Coarse time bucket (per 3s) keeps repeated calls fresh without being random.
  base ^= Math.floor(Date.now() / 3000);
  return base >>> 0;
}

// -----------------------------------------------------------------------------
// Candidate scoring
// -----------------------------------------------------------------------------
interface Candidate {
  kind: SchedulerIntentKind;
  topic: Topic;
  difficulty: Difficulty;
  score: number;
  rationale: string;
}

function focusBias(topic: Topic, plan?: SessionPlan): number {
  return plan?.focus?.includes(topic) ? 0.5 : 0;
}

function buildCandidates(views: TopicView[], plan?: SessionPlan): Candidate[] {
  const out: Candidate[] = [];
  const byTopic = new Map<Topic, TopicView>();
  for (const v of views) byTopic.set(v.topic, v);

  const anyPracticed = views.some((v) => v.attempts > 0);

  // Cold start: nothing practiced → warm up on a foundational root at easy.
  if (!anyPracticed) {
    for (const t of ROOT_TOPICS) {
      out.push({
        kind: 'warm-up',
        topic: t,
        difficulty: 'easy',
        score: (t === FOUNDATIONAL_START ? 1.0 : 0.6) + focusBias(t, plan),
        rationale:
          t === FOUNDATIONAL_START
            ? 'Starting with the fundamentals to get warmed up.'
            : `Warming up on ${t} fundamentals.`,
      });
    }
    return out;
  }

  for (const v of views) {
    const staleBoost = Number.isFinite(v.staleDays) ? Math.min(v.staleDays / 14, 0.6) : 0.3;

    // warm-up — a solid, known topic to get into flow (opener-ish).
    if (v.attempts > 0 && v.mastery >= WEAK_THRESHOLD) {
      out.push({
        kind: 'warm-up',
        topic: v.topic,
        difficulty: v.currentDifficulty === 'hard' ? 'medium' : 'easy',
        score: 0.3 + v.mastery * 0.4 + focusBias(v.topic, plan),
        rationale: `Warming up on ${v.topic}, one of your stronger areas.`,
      });
    }

    // reinforce — weak / failed-last / overdue topic (spaced repetition).
    if (v.attempts > 0 && (v.mastery < WEAK_THRESHOLD || v.failedLast || v.overdue)) {
      let reason = 'it is one of your weaker areas';
      if (v.failedLast) reason = 'you missed it last time';
      else if (v.overdue) reason = 'it is due for review';
      out.push({
        kind: 'reinforce',
        topic: v.topic,
        difficulty: v.currentDifficulty,
        score:
          0.8 +
          (1 - v.mastery) * 1.2 +
          (v.failedLast ? 0.8 : 0) +
          (v.overdue ? 0.5 : 0) +
          staleBoost * 0.3 +
          focusBias(v.topic, plan),
        rationale: `Reinforcing ${v.topic} — ${reason}.`,
      });
    }

    // variation — same technique as a recently-solved problem, new shape.
    if (v.lastResult === 'solved' || v.lastResult === 'solved-hinted') {
      out.push({
        kind: 'variation',
        topic: v.topic,
        difficulty: v.currentDifficulty,
        score: 0.6 + v.mastery * 0.3 + Math.max(0, 0.4 - v.staleDays * 0.1) + focusBias(v.topic, plan),
        rationale: `A fresh ${v.topic} variation to drill the same technique in a new shape.`,
      });
    }

    // level-up — mastered topic, bump difficulty.
    if (v.mastery >= MASTERY_THRESHOLD && v.box >= 2 && v.currentDifficulty !== 'hard') {
      const nd = nextDifficulty(v.currentDifficulty);
      out.push({
        kind: 'level-up',
        topic: v.topic,
        difficulty: nd,
        score: 0.7 + v.mastery * 0.6 + v.streak * 0.05 + focusBias(v.topic, plan),
        rationale: `You've been crushing ${v.topic} — stepping it up to ${nd}.`,
      });
    }
  }

  // new-pattern — an unattempted topic whose ≥1 prerequisite is mastered.
  for (const v of views) {
    if (v.attempts > 0) continue;
    const prereqs = PREREQS[v.topic];
    if (prereqs.length === 0) continue; // roots handled via cold-start/warm-up
    const unlocked = prereqs.some((p) => (byTopic.get(p)?.mastery ?? 0) >= MASTERY_THRESHOLD);
    if (!unlocked) continue;
    const readyPrereq =
      prereqs.find((p) => (byTopic.get(p)?.mastery ?? 0) >= MASTERY_THRESHOLD) ?? prereqs[0];
    out.push({
      kind: 'new-pattern',
      topic: v.topic,
      difficulty: 'easy',
      score: 0.75 + focusBias(v.topic, plan),
      rationale: `New pattern: ${v.topic}, now that you've got ${readyPrereq} down.`,
    });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Selection — weighted-random among the top candidates (fresh but directed).
// -----------------------------------------------------------------------------
function pickWeighted(cands: Candidate[], rng: () => number): Candidate {
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const pool = sorted.slice(0, Math.min(4, sorted.length));
  const total = pool.reduce((s, c) => s + Math.max(c.score, 0.01), 0);
  let r = rng() * total;
  for (const c of pool) {
    r -= Math.max(c.score, 0.01);
    if (r <= 0) return c;
  }
  return pool[0];
}

function toIntent(c: Candidate): SchedulerIntent {
  const intent: SchedulerIntent = {
    kind: c.kind,
    topic: c.topic,
    difficulty: c.difficulty,
    rationale: c.rationale,
  };
  if (c.kind === 'variation' || c.kind === 'level-up' || c.kind === 'new-pattern') {
    const titles = getBankTitles(c.topic);
    if (titles.length) intent.avoidTitles = titles;
  }
  if (c.kind === 'variation') {
    const seed = getRecentSolvedProblem(c.topic);
    if (seed) intent.variationOfProblemId = seed.id;
  }
  return intent;
}

/**
 * Decide the next problem's intent from live skill state. Deterministic given a
 * seed; the seed folds in live state + a coarse time bucket so it feels fresh.
 */
export function nextIntent(opts: NextIntentOpts = {}): SchedulerIntent {
  // Retrieval loop: a due review item outranks EVERYTHING — re-serve it cold.
  const due = getDueReview();
  if (due) {
    const p = getProblem(due.problemId);
    if (p) {
      return {
        kind: 'review',
        topic: p.topic,
        difficulty: p.difficulty,
        rationale: 'Review — you leaned on this before. Solve it cold, no hints.',
        reviewProblemId: p.id,
      };
    }
    // Problem vanished (deleted) — fall through to normal scheduling.
  }

  const views = buildViews();
  let candidates = buildCandidates(views, opts.plan);

  // "Don't repeat the topic just served" guard — drop it unless it's all we have.
  if (opts.avoidTopic) {
    const filtered = candidates.filter((c) => c.topic !== opts.avoidTopic);
    if (filtered.length) candidates = filtered;
  }

  if (candidates.length === 0) {
    // Absolute fallback — should only happen with a corrupt/empty tree.
    return {
      kind: 'warm-up',
      topic: FOUNDATIONAL_START,
      difficulty: 'easy',
      rationale: 'Warming up on the fundamentals.',
    };
  }

  const rng = mulberry32(seedFrom(views, opts.avoidTopic));
  return toIntent(pickWeighted(candidates, rng));
}

/**
 * Best-effort short label for the LIKELY next problem, for a UI "up next" peek.
 * Does not commit — reuses candidate logic against current state.
 */
export function peekUpNext(opts: NextIntentOpts = {}): string {
  // A due review takes priority in the real pick, so surface it in the peek too.
  if (getReviewDueCount() > 0) {
    return 'a review problem to solve cold';
  }
  const views = buildViews();
  let candidates = buildCandidates(views, opts.plan);
  if (opts.avoidTopic) {
    const filtered = candidates.filter((c) => c.topic !== opts.avoidTopic);
    if (filtered.length) candidates = filtered;
  }
  if (candidates.length === 0) return 'more practice';
  const top = [...candidates].sort((a, b) => b.score - a.score)[0];
  switch (top.kind) {
    case 'variation':
      return `a ${top.topic} variation`;
    case 'level-up':
      return `${top.topic} stepped up to ${top.difficulty}`;
    case 'new-pattern':
      return `a new pattern: ${top.topic}`;
    case 'reinforce':
      return `more ${top.topic} to reinforce it`;
    default:
      return `a ${top.topic} warm-up`;
  }
}
