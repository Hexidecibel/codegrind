// =============================================================================
// today — the guided daily routine, as the client sees it
// =============================================================================
// One local day = five steps, in order:
//
//   warmup    clear the due pile: mock drill cards + Envelope ×5 + due review-queue problems
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
import type { TodayEnvelope } from './envelope.js';

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
  /**
   * "Envelope ×5": back-of-the-envelope math reps, part of the warm-up (the
   * warm-up is not done until `remaining` is 0). Due envelope cards lead it.
   */
  envelope: TodayEnvelope;
  /**
   * Step reviews: one short AI note per finished step (what happened + one
   * thing to carry into the next step). Written automatically, server-side,
   * once per step per day, when "AI reviews" is on.
   */
  stepNotes: StepNotes;
  /** Reviews (and the auto debrief) being written right now — the page polls while non-empty. */
  aiPending: AiReviewTarget[];
  /** The Settings toggle "AI reviews" (default on). Off = no automatic calls. */
  aiReviews: boolean;
  /** AI spend from the usage ledger: every model call the app makes. */
  spend: AiSpend;
}

/** The finished things a step review can be written for. `recognize` is the add-on, not a step. */
export const STEP_NOTE_IDS = ['warmup', 'recognize', 'problem1', 'problem2', 'mock'] as const;
export type StepNoteId = (typeof STEP_NOTE_IDS)[number];
export type AiReviewTarget = StepNoteId | 'debrief';

export const STEP_NOTE_LABEL: Readonly<Record<StepNoteId, string>> = {
  warmup: 'Warm-up',
  recognize: 'Recognize',
  problem1: 'Problem 1',
  problem2: 'Problem 2',
  mock: 'Mock interview',
};

export interface StepNote {
  /** What happened, 2-3 lines. */
  note: string;
  /** One concrete thing to watch in the next step. */
  carry: string;
  at: string;
  model: string;
  costUsd: number | null;
  /** The mock note only: which kind of mock it reviewed (carry applicability). */
  kind?: string;
  /**
   * The warm-up note only: how many warm-up items were cleared when it was
   * written. A later count means it is stale and is rewritten (bounded).
   */
  evidence?: number;
  /** Times this note was rewritten because its evidence changed. */
  refreshes?: number;
}

export type StepNotes = Partial<Record<StepNoteId, StepNote>>;

export interface AiSpend {
  /** Dollars since local midnight; priced calls only. */
  todayUsd: number;
  /** Dollars since the 1st of the local month. */
  monthUsd: number;
  todayCalls: number;
  monthCalls: number;
}

/** One earlier step's note, as the next step's AI context reads it. */
export interface CarryNote {
  step: string;
  note: string;
  carry: string;
}

/** Today's notes in step order, as carry-forward context. */
export function carryNotesOf(notes: StepNotes): CarryNote[] {
  return STEP_NOTE_IDS.flatMap((id) => {
    const n = notes[id];
    return n && (n.note || n.carry) ? [{ step: STEP_NOTE_LABEL[id], note: n.note, carry: n.carry }] : [];
  });
}

/** The step each note's `carry` was written FOR (its NEXT step). */
export const CARRY_TARGET: Readonly<Record<StepNoteId, StepNoteId | 'debrief'>> = {
  warmup: 'problem1',
  recognize: 'problem1',
  problem1: 'problem2',
  problem2: 'mock',
  mock: 'debrief',
};

/** Mock kinds whose advice is not about writing algorithm code. */
const NON_ALGO_KINDS = new Set(['system-design', 'behavioral']);

/**
 * The earlier notes a consumer may read, with each `carry` kept ONLY where it
 * applies (Phase H: a warm-up "state the rps before coding" carry was judged
 * against Problem 1, became "skipped 3 times", and then the debrief's top fix):
 *
 *   for: a StepNoteId   the step review of that step. Notes of steps BEFORE it;
 *                       a carry only when it was written for this step.
 *   for: 'algorithm'    an algorithm-problem context (coaching a grind submit,
 *                       a coding mock's setup). Every note; a carry only when
 *                       it targets an algorithm step; a system-design or
 *                       behavioral mock contributes nothing — its advice is
 *                       not about code, and a behavioral note can carry story
 *                       facts that do not belong in a coding prompt.
 *   for: 'mock'         a non-coding mock's setup: notes only, no carries.
 *   for: 'debrief'      notes only. Carries are instructions, not facts — the
 *                       debrief must not repeat one as if it were evidence.
 */
export function applicableNotes(
  notes: StepNotes,
  target: StepNoteId | 'algorithm' | 'mock' | 'debrief'
): CarryNote[] {
  const order = STEP_NOTE_IDS as readonly StepNoteId[];
  const algoSteps = new Set<string>(['problem1', 'problem2']);
  return order.flatMap((id) => {
    const n = notes[id];
    if (!n || !(n.note || n.carry)) return [];
    let carry = '';
    if (target === 'debrief' || target === 'mock') {
      carry = '';
    } else if (target === 'algorithm') {
      if (id === 'mock' && n.kind && NON_ALGO_KINDS.has(n.kind)) return [];
      carry = algoSteps.has(CARRY_TARGET[id]) ? n.carry : '';
    } else {
      // A step review: only what came before this step in the day.
      if (order.indexOf(id) >= order.indexOf(target)) return [];
      carry = CARRY_TARGET[id] === target ? n.carry : '';
    }
    if (!n.note && !carry) return [];
    return [{ step: STEP_NOTE_LABEL[id], note: n.note, carry }];
  });
}

/**
 * The block appended to a prompt (coaching user message, mock context, debrief
 * digest). '' when there are no notes, so a call without them is byte-identical
 * to one made before carry-forward existed.
 */
export function renderCarryBlock(notes: readonly CarryNote[]): string {
  if (!notes.length) return '';
  const lines = notes.map((n) => `- ${n.step}: ${n.note}${n.carry ? ` Carry: ${n.carry}` : ''}`);
  return `\n\nEARLIER TODAY (the candidate's step notes from today's routine; connect to them where relevant, do not repeat them):\n${lines.join('\n')}`;
}
