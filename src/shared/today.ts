// =============================================================================
// today — the guided daily routine, as the client sees it
// =============================================================================
// One local day = five steps, in order:
//
//   warmup    clear the due pile: mock drill cards + due review-queue problems
//   problem1  an adaptive grind problem (Minimal editor, predict-before-solve)
//   problem2  another one
//   mock      one mock interview; the kind rotates daily over MOCK_KINDS
//   debrief   one short, user-initiated AI read of the day
//
// Step state is DERIVED server-side from real rows (attempts, mocks, cards, the
// review queue) on every GET, so it cannot drift from what actually happened.
// Only what cannot be derived is stored: skips, "end day early", the day's
// chosen mock kind, and the debrief itself (daily_sessions).

import type { MockKind } from './mock-kinds.js';
import type { Topic } from './types.js';
import type { TodayRecognize } from './recognize.js';

export const TODAY_STEPS = ['warmup', 'problem1', 'problem2', 'mock', 'debrief'] as const;
export type TodayStepId = (typeof TODAY_STEPS)[number];

export function isTodayStep(x: unknown): x is TodayStepId {
  return typeof x === 'string' && (TODAY_STEPS as readonly string[]).includes(x);
}

/** The steps a user may skip. The debrief is the end of the day, not a step to skip. */
export const SKIPPABLE_STEPS: readonly TodayStepId[] = ['warmup', 'problem1', 'problem2', 'mock'];

export const TODAY_STEP_LABEL: Readonly<Record<TodayStepId, string>> = {
  warmup: 'Warm-up',
  problem1: 'Problem 1',
  problem2: 'Problem 2',
  mock: 'Mock interview',
  debrief: 'Debrief',
};

/**
 *   todo         not started, not the current step
 *   current      the step to do next (exactly one, unless the day is complete)
 *   in-progress  started but not finished (an active mock) — also the current step
 *   done         finished; `result` says how it went
 *   skipped      skipped by hand, or swept up by "end day early"
 *   locked       the debrief, before the mock is done or skipped
 */
export type TodayStepStatus = 'todo' | 'current' | 'in-progress' | 'done' | 'skipped' | 'locked';

export interface TodayStep {
  id: TodayStepId;
  label: string;
  status: TodayStepStatus;
  /** Where Start / Continue goes. Carries `?from=today&step=<id>`. */
  href: string;
  /** One line under the label: what this step is, or how it went once done. */
  detail: string;
  /** Done steps: pass/fail, verdict, cards cleared. Null until there is one. */
  result: string | null;
  /** Done steps: did it go well? Drives the result's colour. Null = neutral. */
  ok: boolean | null;
}

/** One readiness area in the header strip. */
export interface ReadinessArea {
  id: 'algos' | 'system-design' | 'behavioral' | 'coding';
  label: string;
  /** 0..100, or null when there is no data yet ("not started"). */
  pct: number | null;
  /** A short explanation: "6/14 topics tiered", "last: at level". */
  note: string;
}

export interface DebriefFix {
  /** What went wrong, in one line. */
  issue: string;
  /** A concrete drill or action that fixes it. */
  action: string;
}

export interface Debrief {
  verdict: string;
  wins: string[];
  fixes: DebriefFix[];
  tomorrowFocus: {
    /** Curriculum topic ids; tomorrow's scheduler leans toward these. */
    patterns: Topic[];
    /** Tomorrow's mock kind, when the debrief has an opinion; null = rotation. */
    mockKind: MockKind | null;
  };
}

export interface DebriefUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Null when the model has no known price (a local endpoint). */
  costUsd: number | null;
}

export interface TodayState {
  /** The local calendar day, `YYYY-MM-DD`. */
  date: string;
  steps: TodayStep[];
  /** The current step id, or null once every step is done or skipped. */
  current: TodayStepId | null;
  /** Steps done or skipped, out of TODAY_STEPS.length. */
  completed: number;
  total: number;
  endedEarly: boolean;
  /** Consecutive local days with practice, today counting once it has any. */
  streak: number;
  /** The mock kind chosen for today. */
  mockKind: MockKind;
  readiness: ReadinessArea[];
  /** Problems attempted today, so the grind page can tell a finished problem. */
  attemptedProblemIds: string[];
  debrief: Debrief | null;
  debriefUsage: DebriefUsage | null;
  /** Yesterday's (or the last) debrief's focus, which today's scheduler leans on. */
  focus: Topic[];
  /** Typical cost of one debrief call, for the button. */
  debriefEstimateUsd: number;
  /**
   * The optional "Recognize ×5" add-on under the warm-up. Not a step: it never
   * blocks the day or counts toward `completed`; it is recommended when rusty.
   */
  recognize: TodayRecognize;
}
