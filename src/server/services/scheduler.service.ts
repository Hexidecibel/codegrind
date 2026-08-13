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
import type { Language } from '../../shared/languages.js';
import {
  getSkillState,
  getCleanSolvesByTopic,
  getBankTitles,
  getRecentSolvedProblem,
  getDueReview,
  getProblem,
  getReviewDueCount,
  type SkillRow,
} from './db.js';
import {
  PREREQS,
  ROOT_TOPICS,
  FOUNDATIONAL_START,
  UNLOCK_TIER,
  WEAK_SCORE,
  easierDifficulty,
  emptyCleanSolves,
  levelAtLeast,
  tierProgress,
  type TierProgress,
} from './curriculum.js';

// -----------------------------------------------------------------------------
// Intent — what the scheduler decides to serve next.
// -----------------------------------------------------------------------------
export interface SchedulerIntent {
  kind: SchedulerIntentKind;
  /**
   * The language to serve in. Carried ON the intent rather than passed
   * alongside it, so `getAdaptiveProblem(intent)` cannot be handed a language
   * that disagrees with the state the intent was computed from.
   */
  language: Language;
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
  /**
   * REQUIRED and non-defaulted: everything below reads language-partitioned
   * state (skill rows, tier credits, the bank, the review queue), so a missing
   * language here has to be a compile error rather than a quiet default that
   * schedules a Python sitting off the JavaScript ladder.
   */
  language: Language;
  plan?: SessionPlan;
  /** Topic just served — the scheduler avoids repeating it back-to-back. */
  avoidTopic?: string;
}

// -----------------------------------------------------------------------------
// Skill tree — the prerequisite DAG and the tier ladder now live in
// ./curriculum.js so the Study ordering can import them without pulling in this
// module's `db.js` dependency. Re-exported here so existing importers of
// scheduler.service keep working unchanged.
// -----------------------------------------------------------------------------
export {
  PREREQS,
  ROOT_TOPICS,
  FOUNDATIONAL_START,
  UNLOCK_TIER,
  TIER_REQUIREMENT,
  WEAK_SCORE,
} from './curriculum.js';

// -----------------------------------------------------------------------------
// Per-topic view — skill row + derived tier/staleness, one per TOPIC.
// -----------------------------------------------------------------------------
interface TopicView {
  topic: Topic;
  attempts: number;
  solved: number;
  /** Display ordinal, 0..1 — see curriculum.masteryScore. */
  mastery: number;
  /** The whole tier picture: level, next tier, credits banked toward it. */
  tier: TierProgress;
  /** The difficulty to serve = the tier being worked on (derived, not stored). */
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

function buildViews(language: Language): TopicView[] {
  const skill = new Map<Topic, SkillRow>();
  for (const s of getSkillState(language)) skill.set(s.topic, s);

  // The tier ladder's only input: distinct problems solved with zero hints.
  const clean = getCleanSolvesByTopic(language);

  const now = Date.now();

  return TOPICS.map((topic): TopicView => {
    const s = skill.get(topic);
    const tier = tierProgress(clean.get(topic) ?? emptyCleanSolves());

    const dueAt = s?.dueAt ?? null;
    const overdue = dueAt ? new Date(dueAt).getTime() <= now : false;
    const staleDays = s?.lastSeenAt
      ? (now - new Date(s.lastSeenAt).getTime()) / DAY_MS
      : Infinity;

    return {
      topic,
      attempts: s?.attempts ?? 0,
      solved: s?.solved ?? 0,
      mastery: tier.score,
      tier,
      // Derived, so the scheduler can never disagree with the tier the ladder
      // says you are on — the stored column is only a cache of this.
      currentDifficulty: tier.working,
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

    // warm-up — a solid, known topic to get into flow (opener-ish). Served one
    // tier below the one being worked on, floored at easy: a warm-up is meant
    // to be comfortable, and "comfortable" moves up the ladder with you.
    if (v.attempts > 0 && v.mastery >= WEAK_SCORE) {
      out.push({
        kind: 'warm-up',
        topic: v.topic,
        difficulty: easierDifficulty(v.currentDifficulty),
        score: 0.3 + v.mastery * 0.4 + focusBias(v.topic, plan),
        rationale: `Warming up on ${v.topic}, one of your stronger areas.`,
      });
    }

    // reinforce — weak / failed-last / overdue topic (spaced repetition).
    if (v.attempts > 0 && (v.mastery < WEAK_SCORE || v.failedLast || v.overdue)) {
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

    // level-up — a tier was just completed and nothing has been banked at the
    // next one yet. THE TIER RULE, not a score: `v.tier.level` only moves on
    // TIER_REQUIREMENT distinct hint-free solves, so this cannot be triggered by
    // re-submitting a solution that already passes. It stops firing at the top
    // of the ladder (`next === null`) — but reinforce/variation keep serving
    // that tier forever, so there is always a next problem.
    if (v.tier.level !== 'none' && v.tier.next !== null && v.tier.towardNext === 0) {
      const nd = v.tier.next;
      out.push({
        kind: 'level-up',
        topic: v.topic,
        difficulty: nd,
        score: 0.7 + v.mastery * 0.6 + v.streak * 0.05 + focusBias(v.topic, plan),
        rationale: `You cleared the ${v.tier.level} tier on ${v.topic} — stepping it up to ${nd}.`,
      });
    }
  }

  // new-pattern — an unattempted topic with ≥1 prerequisite at the unlock tier.
  const atUnlockTier = (t: Topic): boolean =>
    levelAtLeast(byTopic.get(t)?.tier.level ?? 'none', UNLOCK_TIER);

  for (const v of views) {
    if (v.attempts > 0) continue;
    const prereqs = PREREQS[v.topic];
    if (prereqs.length === 0) {
      // Roots have no prerequisites, so they are unlocked from the very start —
      // but nothing else can reach them once the grind is under way. Cold-start
      // only fires while NOTHING has been practiced, and warm-up/reinforce both
      // require attempts > 0. Without this branch an untouched root (hashing,
      // math, bit-manipulation) is unreachable forever.
      out.push({
        kind: 'new-pattern',
        topic: v.topic,
        difficulty: 'easy',
        score: 0.75 + focusBias(v.topic, plan),
        rationale: `New pattern: ${v.topic} — a foundational topic you haven't touched yet.`,
      });
      continue;
    }
    const readyPrereq = prereqs.find(atUnlockTier);
    if (!readyPrereq) continue;
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

function toIntent(language: Language, c: Candidate): SchedulerIntent {
  const intent: SchedulerIntent = {
    kind: c.kind,
    language,
    topic: c.topic,
    difficulty: c.difficulty,
    rationale: c.rationale,
  };
  if (c.kind === 'variation' || c.kind === 'level-up' || c.kind === 'new-pattern') {
    const titles = getBankTitles(language, c.topic);
    if (titles.length) intent.avoidTitles = titles;
  }
  if (c.kind === 'variation') {
    const seed = getRecentSolvedProblem(language, c.topic);
    if (seed) intent.variationOfProblemId = seed.id;
  }
  return intent;
}

/**
 * Decide the next problem's intent from live skill state. Deterministic given a
 * seed; the seed folds in live state + a coarse time bucket so it feels fresh.
 */
export function nextIntent(opts: NextIntentOpts): SchedulerIntent {
  const { language } = opts;

  // Retrieval loop: a due review item outranks EVERYTHING — re-serve it cold.
  const due = getDueReview(language);
  if (due) {
    const p = getProblem(due.problemId);
    if (p) {
      return {
        kind: 'review',
        // From the PROBLEM, not from `language`. They agree today (getDueReview
        // filters on exactly this), and if they ever stop agreeing the problem
        // is the one telling the truth about which harness can run it.
        language: p.language,
        topic: p.topic,
        difficulty: p.difficulty,
        rationale: 'Review — you leaned on this before. Solve it cold, no hints.',
        reviewProblemId: p.id,
      };
    }
    // Problem vanished (deleted) — fall through to normal scheduling.
  }

  const views = buildViews(language);
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
      language,
      topic: FOUNDATIONAL_START,
      difficulty: 'easy',
      rationale: 'Warming up on the fundamentals.',
    };
  }

  const rng = mulberry32(seedFrom(views, opts.avoidTopic));
  return toIntent(language, pickWeighted(candidates, rng));
}

/**
 * Best-effort short label for the LIKELY next problem, for a UI "up next" peek.
 * Does not commit — reuses candidate logic against current state.
 */
export function peekUpNext(opts: NextIntentOpts): string {
  // A due review takes priority in the real pick, so surface it in the peek too.
  if (getReviewDueCount(opts.language) > 0) {
    return 'a review problem to solve cold';
  }
  const views = buildViews(opts.language);
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
