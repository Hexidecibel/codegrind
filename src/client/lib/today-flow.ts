// =============================================================================
// today-flow — the "Next: <step> →" rule every screen in the routine shares
// =============================================================================
// A screen opened from Today (`?from=today&step=<id>`) shows a prominent link
// onward once the server says the day has moved past it. Pure, so the rule is
// tested without a browser.

import { TODAY_STEPS, type TodayState, type TodayStepId } from '@/shared/today';

export interface TodayLink {
  label: string;
  href: string;
  /** The step it leads to; null = back to the Today page (day complete). */
  step: TodayStepId | null;
}

/** `?from=today&step=…` → the step, or null when the screen was not opened from Today. */
export function todayStepFrom(search: string): TodayStepId | null {
  const q = new URLSearchParams(search);
  if (q.get('from') !== 'today') return null;
  const step = q.get('step');
  return (TODAY_STEPS as readonly string[]).includes(step ?? '') ? (step as TodayStepId) : null;
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
  if (state.current === null) return { label: 'Day complete — back to Today', href: '/today', step: null };
  const step = state.steps.find((s) => s.id === state.current)!;
  const sameScreen = pathOf(step.href).startsWith(screenPath) && screenPath !== '/today';
  if (state.current === here && sameScreen) return null;
  return {
    label: state.current === here ? `Continue: ${step.label}` : `Next: ${step.label}`,
    href: step.href,
    step: step.id,
  };
}

/** Does a link continue on the grind screen (so Grind can just serve the next problem)? */
export function isGrindLink(link: TodayLink | null): boolean {
  return !!link && pathOf(link.href) === '/grind';
}
