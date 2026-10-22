// =============================================================================
// today-flow — the "Next: <step> →" rule every screen in the routine shares
// =============================================================================
// A screen opened from Today (`?from=today&step=<id>`) shows a prominent link
// onward once the server says the day has moved past it. Pure, so the rule is
// tested without a browser.

import { STEP_NOTE_IDS, STEP_NOTE_LABEL, TODAY_STEPS, isTodayStep, type StepNoteId, type TodayState, type TodayStepId } from '@/shared/today';

export interface TodayLink {
  label: string;
  href: string;
  /** The step it leads to; null = back to the Today page (day complete). */
  step: TodayStepId | null;
  /** The latest earlier step's AI carry ("Carry into Problem 2: …"), if any. */
  carry: { from: string; text: string } | null;
}

/** Where each noted thing sits in the day (recognize rides with the warm-up). */
const NOTE_ORDER: Readonly<Record<StepNoteId, number>> = { warmup: 0, recognize: 0.5, concept: 1, problem1: 2, problem2: 3, mock: 4 };

/** The carry from the latest note BEFORE `step`, or null. Pure. */
export function carryInto(state: Pick<TodayState, 'stepNotes'>, step: TodayStepId | null): TodayLink['carry'] {
  if (step === null || !state.stepNotes) return null;
  // A Pattern Refresh step: its notes target a normal day's steps, so no carry.
  const at = (TODAY_STEPS as readonly TodayStepId[]).indexOf(step);
  if (at < 0) return null;
  let best: TodayLink['carry'] = null;
  for (const id of STEP_NOTE_IDS) {
    const n = state.stepNotes[id];
    // A concept rep's carry is system-design advice: it only leads into the mock.
    if (id === 'concept' && step !== 'mock') continue;
    if (n?.carry && NOTE_ORDER[id] < at) best = { from: STEP_NOTE_LABEL[id], text: n.carry };
  }
  return best;
}

/** `?from=today&step=…` → the step, or null when the screen was not opened from Today. */
export function todayStepFrom(search: string): TodayStepId | null {
  const q = new URLSearchParams(search);
  if (q.get('from') !== 'today') return null;
  const step = q.get('step');
  return isTodayStep(step) ? step : null;
}

const pathOf = (href: string) => href.split(/[?#]/)[0];

/**
 * Where to go next from `here`, on the screen at `screenPath`.
 *
 * Null while this screen is still where the current step happens — the user
 * is not done here yet. Otherwise the current step (even the same step, when it
 * continues on another screen: cards on Mock, then reviews on Grind), or back
 * to Today once the day is complete.
 */
export function nextStepLink(state: TodayState, here: TodayStepId, screenPath: string): TodayLink | null {
  if (state.current === null) return { label: 'Day complete — back to Today', href: '/today', step: null, carry: null };
  const step = state.steps.find((s) => s.id === state.current)!;
  const sameScreen = pathOf(step.href).startsWith(screenPath) && screenPath !== '/today';
  if (state.current === here && sameScreen) return null;
  return {
    label: state.current === here ? `Continue: ${step.label}` : `Next: ${step.label}`,
    href: step.href,
    step: step.id,
    carry: carryInto(state, step.id),
  };
}

/** Does a link continue on the grind screen (so Grind can just serve the next problem)? */
export function isGrindLink(link: TodayLink | null): boolean {
  return !!link && pathOf(link.href) === '/grind';
}
