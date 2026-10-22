// =============================================================================
// refresh.compute — the PURE rules of Today's "Pattern refresh" mode
// =============================================================================
// A 9-day plan (shared/pattern-shapes REFRESH_PLAN): one pattern a day, then a
// mixed day. Same derived-steps architecture as today.compute: every step's
// state is read off real rows (attempts, pattern views, recall grades,
// Recognize); only what cannot be derived is stored (refresh.store):
//
//   * the progress setting  {on, completedThrough, startedAt, finishedAt}
//   * refresh_days          which refresh day each local date is (frozen on
//                           first touch) and the cold-review problem it chose
//
// THE DAY ADVANCES ONLY ON COMPLETION. A new local date gets refresh day
// completedThrough + 1, and completedThrough moves only when a day's core
// steps are done or skipped BY HAND (End day early's sweep does not count). So
// a missed calendar day — or a day ended early — never skips a pattern: the
// same pattern comes back, and its steps count everything done since that
// refresh day's first date. After day 9 the mode turns itself off.
//
// Never imports ./db.js (see today.compute's header).

import {
  REFRESH_DAYS,
  REFRESH_PLAN,
  REFRESH_TOPICS,
  patternShape,
  type RefreshDayPlan,
} from '../../shared/pattern-shapes.js';
import type { Topic } from '../../shared/types.js';
import {
  MIXED_STEPS,
  REFRESH_CORE_STEPS,
  REFRESH_STEPS,
  TODAY_STEP_LABEL,
  type TodayStep,
  type TodayStepId,
  type TodayStepStatus,
} from '../../shared/today.js';
import { warmupEntry, type BaseEntry, type DerivedSteps, type WarmupInput } from './today.compute.js';

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------
export interface RefreshProgress {
  on: boolean;
  /** Refresh days completed (core steps done or skipped by hand). 0..REFRESH_DAYS. */
  completedThrough: number;
  startedAt: string | null;
  /** Set when day REFRESH_DAYS completed and the mode turned itself off. */
  finishedAt: string | null;
}

export const REFRESH_OFF: RefreshProgress = { on: false, completedThrough: 0, startedAt: null, finishedAt: null };

/** Whatever the settings row holds → a well-formed progress. Never throws. */
export function coerceProgress(raw: unknown): RefreshProgress {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = typeof o.completedThrough === 'number' && Number.isFinite(o.completedThrough) ? Math.floor(o.completedThrough) : 0;
  return {
    on: o.on === true,
    completedThrough: Math.max(0, Math.min(REFRESH_DAYS, n)),
    startedAt: typeof o.startedAt === 'string' ? o.startedAt : null,
    finishedAt: typeof o.finishedAt === 'string' ? o.finishedAt : null,
  };
}

/**
 * The refresh day a NEW local date gets: the first one not yet completed.
 * Null = every day is done (the mode turns itself off).
 */
export function nextRefreshDay(completedThrough: number): number | null {
  const d = completedThrough + 1;
  return d > REFRESH_DAYS ? null : d;
}

/** Turning the toggle on: resume where it was, or start over after a finished run. */
export function turnOn(p: RefreshProgress, now: Date): RefreshProgress {
  const restart = p.completedThrough >= REFRESH_DAYS;
  return {
    on: true,
    completedThrough: restart ? 0 : p.completedThrough,
    startedAt: restart || !p.startedAt ? now.toISOString() : p.startedAt,
    finishedAt: null,
  };
}

/** A day's core steps just settled: latch it (never moves backwards). */
export function completeDay(p: RefreshProgress, day: number): RefreshProgress {
  return day > p.completedThrough ? { ...p, completedThrough: Math.min(REFRESH_DAYS, day) } : p;
}

export function planOf(day: number): RefreshDayPlan {
  return REFRESH_PLAN[Math.max(1, Math.min(REFRESH_DAYS, day)) - 1];
}

/** The pattern day before `day` (its topic is the cold review's), or null on day 1. */
export function previousPlan(day: number): RefreshDayPlan | null {
  if (day <= 1) return null;
  const p = planOf(day - 1);
  return p.topic ? p : null;
}

/**
 * The mixed day's three topics: distinct refresh topics, picked
 * deterministically from a seed (the day's first date) so a reload never
 * reshuffles them.
 */
export function mixedTopicsFor(seed: string): Topic[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const pool = [...REFRESH_TOPICS];
  const out: Topic[] = [];
  while (out.length < 3 && pool.length) {
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Step derivation
// -----------------------------------------------------------------------------
export interface RefreshAttempt {
  problemId: string;
  title: string;
  /** The problem's curriculum topic (null for a deleted problem). */
  topic: string | null;
  difficulty: string;
  solved: boolean;
  hintsUsed: number;
  createdAt: string;
}

export interface RefreshDeriveInput extends WarmupInput {
  day: number;
  /** ISO of local midnight of this refresh day's FIRST date: the core steps count activity since. */
  since: string;
  /** Attempts since `since`, oldest first. */
  refreshAttempts: RefreshAttempt[];
  /** Today's pattern card was opened since `since`. */
  viewed: boolean;
  /** Today's pattern was written from memory and self-graded since `since`. */
  recall: { grade: string } | null;
  /** The cold review's chosen problem (an older one of yesterday's topic), or null = bank/generate. */
  coldProblemId: string | null;
  /** The mixed day's topics (mixedTopicsFor). */
  mixedTopics: readonly Topic[];
  recognize: { done: boolean; doneToday: number };
  skips: readonly TodayStepId[];
  endedEarly: boolean;
  hasDebrief: boolean;
}

export interface RefreshDerived extends DerivedSteps {
  /** Every core step is done or skipped by hand: the day counts as complete. */
  coreSettled: boolean;
}

const from = (step: TodayStepId) => `from=today&step=${step}`;

interface Outcome {
  problemId: string;
  title: string;
  solved: boolean;
  submits: number;
  hints: number;
}

/** Attempts grouped per problem, in first-submit order. */
function outcomes(attempts: readonly RefreshAttempt[]): Outcome[] {
  const by = new Map<string, Outcome>();
  for (const a of [...attempts].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    const o = by.get(a.problemId);
    if (o) {
      o.solved ||= a.solved;
      o.submits += 1;
      o.hints = Math.max(o.hints, a.hintsUsed);
    } else by.set(a.problemId, { problemId: a.problemId, title: a.title, solved: a.solved, submits: 1, hints: a.hintsUsed });
  }
  return [...by.values()];
}

function outcomeResult(o: Outcome, reveal?: string): string {
  const extra = [o.submits > 1 ? `${o.submits} submits` : null, o.hints > 0 ? `${o.hints} hint${o.hints === 1 ? '' : 's'}` : 'no hints'].filter(Boolean);
  return `${o.solved ? 'Passed' : 'Failed'} · ${o.title}${reveal ? ` (${reveal})` : ''} · ${extra.join(', ')}`;
}

const GRADE_WORD: Record<string, string> = { got: 'Got it', shaky: 'Shaky', missed: 'Missed' };

/** A refresh day's steps. Pure. */
export function deriveRefreshSteps(input: RefreshDeriveInput): RefreshDerived {
  const skipped = new Set(input.skips);
  const plan = planOf(input.day);
  const mixed = !plan.pattern;
  const base = new Map<TodayStepId, BaseEntry & { off?: boolean }>();
  // The refresh warm-up: due cards + Envelope (+ due pattern recall); review
  // problems stay due — the cold review is the week's spaced re-solve.
  base.set('warmup', warmupEntry({ ...input, reviewsDue: 0, quick: true }, skipped));

  const status = (done: boolean, id: TodayStepId): BaseEntry['status'] => (done ? 'done' : skipped.has(id) ? 'skipped' : 'todo');

  if (!mixed) {
    const shape = patternShape(plan.pattern!);
    base.set('relearn', {
      status: status(input.viewed, 'relearn'),
      href: `/patterns?${from('relearn')}#${shape.id}`,
      detail: `Read the ${shape.title} card: the clues, the shape, the template, the trap · ~5 min`,
      result: input.viewed ? `Read · ${shape.title}` : null,
      ok: input.viewed ? true : null,
    });
    base.set('recall', {
      status: status(!!input.recall, 'recall'),
      href: `/patterns?${from('recall')}&recall=${shape.id}#${shape.id}`,
      detail: 'Template hidden: type the skeleton, compare side by side, grade yourself · free',
      result: input.recall ? `${GRADE_WORD[input.recall.grade] ?? input.recall.grade} · ${shape.title}` : null,
      ok: input.recall ? (input.recall.grade === 'got' ? true : input.recall.grade === 'missed' ? false : null) : null,
    });
    const mine = outcomes(input.refreshAttempts.filter((a) => a.topic === plan.topic));
    const p = mine[0];
    base.set('practice', {
      status: status(!!p, 'practice'),
      href: `/manual?topic=${plan.topic}&difficulty=easy&${from('practice')}`,
      detail: `1 Easy ${shape.title} problem — the pattern is named; use the shape on purpose`,
      result: p ? outcomeResult(p) : null,
      ok: p ? p.solved : null,
    });
    const prev = previousPlan(input.day);
    if (!prev) {
      base.set('cold', {
        status: 'skipped',
        off: true,
        href: '/today',
        detail: 'Off on day 1 — starts tomorrow with today’s pattern, unnamed.',
        result: null,
        ok: null,
      });
    } else {
      const c = outcomes(input.refreshAttempts.filter((a) => a.topic === prev.topic))[0];
      base.set('cold', {
        status: status(!!c, 'cold'),
        href: input.coldProblemId
          ? `/manual?problem=${encodeURIComponent(input.coldProblemId)}&hide=1&${from('cold')}`
          : `/manual?topic=${prev.topic}&difficulty=easy&hide=1&${from('cold')}`,
        detail: 'One problem of yesterday’s pattern, topic hidden — name the pattern yourself before you code',
        result: c ? outcomeResult(c, prev.label) : null,
        ok: c ? c.solved : null,
      });
    }
  } else {
    // Mixed day: the k-th distinct medium attempted since the day began fills slot k.
    const mediums = outcomes(input.refreshAttempts.filter((a) => a.difficulty === 'medium'));
    (['mixed1', 'mixed2', 'mixed3'] as const).forEach((id, i) => {
      const o = mediums[i];
      const topic = input.mixedTopics[i] ?? REFRESH_TOPICS[i];
      base.set(id, {
        status: status(!!o, id),
        href: `/manual?topic=${topic}&difficulty=medium&hide=1&${from(id)}`,
        detail: 'One medium, topic hidden — recognise the pattern, say its shape, then code',
        result: o ? outcomeResult(o) : null,
        ok: o ? o.solved : null,
      });
    });
  }

  base.set('recognize', {
    status: status(input.recognize.done, 'recognize'),
    href: `/recognize?${from('recognize')}&n=5`,
    detail: 'Five problems, mixed patterns: pick the pattern and the approach, no code · ~10 min',
    result: input.recognize.done ? `Done · ${input.recognize.doneToday} today` : null,
    ok: input.recognize.done ? true : null,
  });

  // Core settled BEFORE the end-early sweep: a day ended early does not advance.
  const order: readonly TodayStepId[] = mixed ? MIXED_STEPS : REFRESH_STEPS;
  const core = order.filter((id) => REFRESH_CORE_STEPS.includes(id));
  const coreSettled = core.every((id) => ['done', 'skipped'].includes(base.get(id)!.status));

  if (input.endedEarly) {
    for (const [id, s] of base) if (id !== 'debrief' && s.status !== 'done') s.status = 'skipped';
  }

  base.set('debrief', {
    status: input.hasDebrief ? 'done' : 'todo',
    href: '/today#debrief',
    detail: "One short AI read of the day: wins, fixes, tomorrow's focus.",
    result: input.hasDebrief ? 'Written — read it below' : null,
    ok: null,
  });

  let current: TodayStepId | null = null;
  const steps: TodayStep[] = order.map((id) => {
    const s = base.get(id)!;
    let st: TodayStepStatus = s.status;
    if (id === 'debrief' && st !== 'done' && !coreSettled && !input.endedEarly) {
      st = 'locked';
    } else if ((st === 'todo' || st === 'in-progress') && current === null) {
      current = id;
      if (st === 'todo') st = 'current';
    }
    return {
      id,
      label: s.label ?? TODAY_STEP_LABEL[id],
      status: st,
      href: s.href,
      detail: s.detail,
      result: s.result,
      ok: s.ok,
      ...(s.off ? { off: true } : {}),
    };
  });
  const completed = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { steps, current, completed, coreSettled };
}
