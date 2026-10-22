// =============================================================================
// patterns.service — the /patterns page's state: recall cards + card views
// =============================================================================
// "Write it from memory": the template is hidden, the user types the skeleton,
// compares side by side and self-grades got / shaky / missed. The grade moves
// a spaced-repetition card on the gap-card ladder (shared/gap-cards
// scheduleGapCard). Free and deterministic — no model call anywhere here.

import {
  isPatternId,
  type PatternId,
  type PatternRecallCard,
  type PatternsState,
} from '../../shared/pattern-shapes.js';
import { isGapCardGrade, newCardSchedule, scheduleGapCard } from '../../shared/gap-cards.js';
import * as store from './patterns.store.js';

export class PatternsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404
  ) {
    super(message);
  }
}

export function patternsState(now = new Date()): PatternsState {
  const iso = now.toISOString();
  const cards: PatternRecallCard[] = store
    .recallCards()
    .filter((c) => isPatternId(c.id))
    .map((c) => ({
      id: c.id as PatternId,
      step: c.step,
      dueAt: c.dueAt,
      reps: c.reps,
      lastGrade: c.lastGrade,
      lastReviewedAt: c.lastReviewedAt,
      retired: !!c.retiredAt,
      due: !c.retiredAt && c.dueAt <= iso,
    }));
  const due = cards
    .filter((c) => c.due)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((c) => c.id);
  return { cards, due };
}

/** A pattern card was opened (Today's Re-learn step reads this). */
export function viewPattern(id: unknown, now = new Date()): PatternsState {
  if (!isPatternId(id)) throw new PatternsError('No such pattern.', 404);
  store.recordView(id, now);
  return patternsState(now);
}

/** Self-grade one "write it from memory" attempt. */
export function gradeRecall(id: unknown, body: { grade?: unknown; answer?: unknown }, now = new Date()): PatternsState {
  if (!isPatternId(id)) throw new PatternsError('No such pattern.', 404);
  if (!isGapCardGrade(body.grade)) throw new PatternsError('grade must be got, shaky or missed.', 400);
  const prev = store.getRecallCard(id);
  // A retired card graded again comes back onto the ladder from where it was.
  const base = prev ? { ...prev, retiredAt: null } : newCardSchedule(now);
  const next = scheduleGapCard(base, body.grade, now);
  store.putRecallCard(id, next, body.grade, typeof body.answer === 'string' ? body.answer : '', now);
  return patternsState(now);
}
