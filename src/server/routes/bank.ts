// =============================================================================
// bank — what can be served right now, and what a miss will cost
// =============================================================================
// One read-only endpoint answering the question every "loading…" spinner in this
// app was guessing at: is the next problem a database row or a model call?
//
// It exists because two separate defects had the same root cause — the client
// could not tell a free bank hit from a paid cold generation, so it rendered the
// same four words for both:
//
//   - /manual defaulted to `two-pointer`/`easy` and auto-loaded on mount, but
//     seeding only stocks `easy` x the four ROOT_TOPICS. `two-pointer` is not a
//     root topic, so that slot is empty BY CONSTRUCTION and a brand-new user's
//     first click paid a full generation under the words "Loading problem…".
//     `suggested` fixes it as a QUERY, not as a second hardcoded topic: a
//     hardcoded `arrays` would be right today and wrong the first time the seed
//     plan changes.
//   - "Next problem" in grind said "Loading next…" for the 15-30s (Claude) or
//     95s+ (local model) a generating intent actually takes. `generationSeconds`
//     is what lets it say so, with a real number.
//
// Free to call: three indexed COUNT queries and two settings reads, no LLM.

import { Hono } from 'hono';
import type { BankStatus, Difficulty, Topic } from '../../shared/types.js';
import { DIFFICULTIES } from '../../shared/types.js';
import { getActiveLanguage, servableBankTotal, servableSlots } from '../services/db.js';
import { readGenerationPace } from '../services/pace.service.js';
import { ROOT_TOPICS, FOUNDATIONAL_START } from '../services/curriculum.js';
import { errorBody } from '../services/explain.service.js';

export const bankRoutes = new Hono();

/**
 * Which stocked slot to open a fresh workspace on.
 *
 * Ordered by what a newcomer should meet first rather than by what happens to
 * have the most rows: the easiest difficulty wins, then a curriculum ROOT_TOPIC
 * (the ones seeding fills and the ones with no prerequisites), then the deepest
 * slot so the second click is also free. `arrays` is preferred among the roots
 * because it is FOUNDATIONAL_START — the same first step the study track takes.
 */
export function pickSuggested(
  slots: Array<{ topic: Topic; difficulty: Difficulty; servable: number }>
): { topic: Topic; difficulty: Difficulty } | null {
  const stocked = slots.filter((s) => s.servable > 0);
  if (stocked.length === 0) return null;
  const rank = (s: (typeof stocked)[number]) => [
    DIFFICULTIES.indexOf(s.difficulty), // easy first
    s.topic === FOUNDATIONAL_START ? 0 : ROOT_TOPICS.includes(s.topic) ? 1 : 2,
    -s.servable, // deepest slot last-resort tiebreak, so the next click is free too
  ];
  const best = [...stocked].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] !== rb[i]) return ra[i] - rb[i];
    }
    return a.topic.localeCompare(b.topic); // stable, so the answer never flickers
  })[0];
  return { topic: best.topic, difficulty: best.difficulty };
}

// GET /api/bank — servable slots for the ACTIVE language, plus the measured pace.
//
// The language is the server-side setting rather than a query parameter for the
// same reason it is everywhere else: a bank is per-language, and a client that
// could ask about one language while being served another would be reading a
// different bank than the one its next click hits.
bankRoutes.get('/bank', (c) => {
  try {
    const language = getActiveLanguage();
    const slots = servableSlots(language);
    const pace = readGenerationPace();
    const payload: BankStatus = {
      language,
      servableTotal: servableBankTotal(language),
      slots,
      suggested: pickSuggested(slots),
      generationSeconds: pace?.seconds ?? null,
      generationSource: pace?.source ?? null,
    };
    return c.json(payload);
  } catch (err) {
    return c.json(errorBody('bank', err), 500);
  }
});
