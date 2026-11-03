// =============================================================================
// phone — which of today's steps a phone can do
// =============================================================================
// A phone is for studying, patterns, envelope math and drills: anything that is
// talked, tapped or typed in a line. Writing code is the iPad's. This sorts the
// day's steps between the two so the phone's Home can offer only what it can do.
//
// DISPLAY ONLY. Nothing here skips a step or changes server state: a step the
// phone sets aside is still the day's, waiting for the iPad.

import type { MockKind } from './mock-kinds.js';
import type { TodayStep, TodayStepId } from './today.js';

export type StepPlace = 'phone' | 'ipad';

const PHONE_STEPS: ReadonlySet<TodayStepId> = new Set<TodayStepId>([
  'warmup',
  'relearn',
  // The phone's recall is said out loud and self-graded (PatternsPage).
  'recall',
  'recognize',
  'concept',
  'debrief',
]);

/** Where a step is done. A mock is the phone's unless it is a coding mock. */
export function stepPlace(id: TodayStepId, mockKind: MockKind): StepPlace {
  if (id === 'mock') return mockKind === 'coding' ? 'ipad' : 'phone';
  return PHONE_STEPS.has(id) ? 'phone' : 'ipad';
}

/** Startable and not yet finished. A locked debrief is neither. */
export function isOpen(step: TodayStep): boolean {
  return step.status === 'todo' || step.status === 'current' || step.status === 'in-progress';
}

/** The first unfinished step a phone can do, or null when the phone is done for the day. */
export function phoneNext(steps: readonly TodayStep[], mockKind: MockKind): TodayStep | null {
  return steps.find((s) => isOpen(s) && stepPlace(s.id, mockKind) === 'phone') ?? null;
}

/** Split the day into the phone's steps and the iPad's, order kept. */
export function splitByPlace(steps: readonly TodayStep[], mockKind: MockKind): { phone: TodayStep[]; ipad: TodayStep[] } {
  const phone: TodayStep[] = [];
  const ipad: TodayStep[] = [];
  for (const s of steps) (stepPlace(s.id, mockKind) === 'phone' ? phone : ipad).push(s);
  return { phone, ipad };
}
