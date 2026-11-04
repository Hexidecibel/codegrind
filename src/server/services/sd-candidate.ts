// =============================================================================
// sd-candidate — what the interviewer knows about this candidate, and how to open
// =============================================================================
// Two parts. The FRAMEWORK is the method this app teaches and grades in (the
// rubric in sd-rubric.ts is written in the same words), so it is the same for
// everyone and lives here. Anything about the PERSON — their experience, honest
// gaps, how the last session went — is their own data and comes from the local
// candidate profile (candidate-profile.ts); without one the card says nothing
// is known and tells the interviewer not to assume.
//
// It goes into the interviewer's SYSTEM prompt, which is a constant: the same
// bytes for every mock, so the cached prefix is shared across mocks as well as
// across turns.

import { CANDIDATE_PROFILE, type CandidateProfile } from './candidate-profile.js';

export const SD_FRAMEWORK = `- Five steps: Clarify → Non-functional goals (rank the failures) → High-level design → Deep dive on two or three parts → Failure and operations.
- Seven clarifying questions: Who uses it, and how? What does it do (read, write, the three or four main operations)? How much (users, rps, data, growth)? How fresh can data be? How correct — do sources agree, who is the authority? Who is allowed to see what? What exists already?
- Six failures to rank: down (availability), wrong (consistency/correctness), stale (freshness), slow (latency), leaked (security/access), lost (durability). Also cost and how hard it is to operate.
- Ranking sentence: "The worst failure here is ___, so I'll design for that first. I'm willing to accept ___ to get it."
- Conflict move: name the conflict, pick one, say why.
- "How correct?" method: name the one central record, then ask whether it can be lost, doubled, changed, mislabelled or out of date. Fallback: "What's the mistake you'd most fear this system making?"
- Principal phrases: "The trade-off here is X against Y, and I'd choose X because…", "What I'd deliberately not build yet is…", "This fails when…, and we'd know because…", "I'd migrate to this incrementally, by…".`;

/** The card for a profile. Pure. */
export function renderCandidateCard(profile: CandidateProfile): string {
  const notes = profile.systemDesignNotes.trim();
  if (notes) {
    return `WHAT YOU KNOW ABOUT THIS CANDIDATE (from their own prep notes — use it, never quote it at them)

The framework they practise:
${SD_FRAMEWORK}

${notes}`;
  }
  return `WHAT YOU KNOW ABOUT THIS CANDIDATE (use it, never quote it at them)

The framework they practise:
${SD_FRAMEWORK}

Nothing else is known about their background. Learn it from what they say, and never assume experience or gaps they have not mentioned.`;
}

export const CANDIDATE_CARD = renderCandidateCard(CANDIDATE_PROFILE);

/**
 * The warm-up rule: start with something they can already do. Goes in the system prompt beside the card.
 */
export const WARM_UP_RULE = `OPENING (warm-up): Open with one or two sentences of framing and the brief, then invite them into requirements — the stage they are strongest at. Do not front-load constraints, numbers or twists; let them ask. For the first few turns, acknowledge what they do well before pushing (one short clause, not praise paragraphs). Hold the hard twists until they have drawn a happy path.`;
