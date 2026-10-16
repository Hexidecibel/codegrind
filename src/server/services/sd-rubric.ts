// =============================================================================
// sd-rubric — what a 1..4 looks like per stage, and what each LEVEL expects
// =============================================================================
// Two tables, because they answer different questions:
//
//   SCORE_ANCHORS   per stage, what a 1, 2, 3 and 4 answer looks like. Level-free:
//                   a 3 on requirements is the same answer whoever gives it.
//   LEVEL_BARS      per stage × level, the bar for "at level". This is where
//                   Staff differs from Senior — not in the score, in which score
//                   is enough, and in what the answer has to contain.
//
// The anchors are written in the candidate's own framework (resume-builder
// systemDesignCard: the seven questions, the six failures, the ranking sentence,
// the conflict move, the principal phrases), copied here on 2026-10-15. Grading
// in the vocabulary the candidate practises in is the point: "you listed the
// failures but did not rank them" is actionable for him; "weak NFRs" is not.
//
// Rendered to text ONCE per level at module load (RUBRIC_TEXT), so the grader's
// context is byte-stable for a given level.

import { SD_STAGES, SD_STAGE_META, MOCK_LEVELS, MOCK_LEVEL_LABEL, type MockLevel, type SdStage } from '../../shared/sd.js';

export const SCORE_ANCHORS: Readonly<Record<SdStage, readonly [string, string, string, string]>> = {
  requirements: [
    'Starts designing with no questions, or answers its own questions.',
    'Asks some of the seven questions (who, what, how much, how fresh, how correct, who is allowed, what exists) but skips freshness or correctness; lists failures without ranking them.',
    'Covers most of the seven questions in the one-breath shape ("[question]? I would assume X."), names the central record, and ranks the failures with the ranking sentence.',
    'All of 3, plus finds the second user / the other side, resolves a conflict between two failures out loud ("if X and Y conflict, X wins, because…"), and never gives up something the interviewer gave a number for.',
  ],
  capacity: [
    'No numbers, or numbers that drive nothing.',
    'Rough numbers stated but not used to make a decision.',
    'Back-of-envelope reads/writes per second and storage, and at least one design choice that follows from them.',
    'Numbers drive several choices, peaks are distinguished from averages, and growth changes the plan explicitly.',
  ],
  api: [
    'No interface, or a list of nouns.',
    'Main operations named but parameters and failure behaviour vague.',
    'The three or four main calls with their awkward parameters (pagination, idempotency keys, filters) and what they return on failure.',
    'All of 3, plus versioning or evolution, and which call is the expensive one and why.',
  ],
  'data-model': [
    'Tables with no keys or access patterns.',
    'Entities named; keys or the read path left implicit.',
    'The central record, its keys, the main access patterns, and a storage choice justified by them.',
    'All of 3, plus partitioning / tenancy, the hot key, and how the model survives the next requirement.',
  ],
  'high-level': [
    'Components with no flow, or a flow that does not serve the requirements.',
    'A plausible diagram, but the ranked failure is not visibly designed for.',
    'One clear pass through read and write paths, designed for the worst failure named earlier.',
    'All of 3, plus the abnormal flow walked through, not just the happy path.',
  ],
  'deep-dive': [
    'Stays at box level when pushed.',
    'Goes one level down on one part; failure modes hand-waved.',
    'Two parts taken down to mechanism, each with how it fails and how we would know.',
    'All of 3, driven by the candidate rather than the interviewer, with their own experience brought in at the right moment.',
  ],
  tradeoffs: [
    'No trade-offs named.',
    'Trade-offs named but not decided.',
    '"The trade-off is X against Y, and I would choose X because…" on the main decisions; cost and operability mentioned.',
    'All of 3, plus what was deliberately not built yet, how it would be migrated to incrementally, and "this fails when…, and we would know because…".',
  ],
};

export const LEVEL_BARS: Readonly<Record<SdStage, Readonly<Record<MockLevel, string>>>> = {
  requirements: {
    senior: 'Score 3. Asks before designing and ranks at least the top failure.',
    staff: 'Score 3, and the ranking is used to make a later decision. Conflicts between failures are resolved, not avoided.',
    principal: 'Score 4. Reframes the problem where the brief is wrong, and names what the organisation is really asking for.',
  },
  capacity: {
    senior: 'Score 2. Numbers are in the right order of magnitude.',
    staff: 'Score 3. At least one choice visibly follows from a number.',
    principal: 'Score 3, with cost as one of the numbers.',
  },
  api: {
    senior: 'Score 3.',
    staff: 'Score 3, with idempotency or ordering handled where the domain needs it.',
    principal: 'Score 3; at this level a terse API is fine if the reasoning elsewhere is strong.',
  },
  'data-model': {
    senior: 'Score 3.',
    staff: 'Score 3, with tenancy or partitioning addressed when scale demands it.',
    principal: 'Score 4.',
  },
  'high-level': {
    senior: 'Score 3.',
    staff: 'Score 3, and the abnormal flow is at least named.',
    principal: 'Score 4.',
  },
  'deep-dive': {
    senior: 'Score 2 on one part, 3 if pushed.',
    staff: 'Score 3. The candidate chooses which parts deserve depth and says why.',
    principal: 'Score 4. Depth includes operations: rollout, rollback, observability.',
  },
  tradeoffs: {
    senior: 'Score 2.',
    staff: 'Score 3. Decisions are made, not listed.',
    principal: 'Score 4. Sequencing and migration are part of the answer.',
  },
};

function renderRubric(level: MockLevel): string {
  const lines: string[] = [`RUBRIC — graded at ${MOCK_LEVEL_LABEL[level]} level.`, ''];
  for (const stage of SD_STAGES) {
    const [a1, a2, a3, a4] = SCORE_ANCHORS[stage];
    lines.push(
      `## ${stage} (${SD_STAGE_META[stage].label}) — ${SD_STAGE_META[stage].goal}`,
      `1: ${a1}`,
      `2: ${a2}`,
      `3: ${a3}`,
      `4: ${a4}`,
      `At ${MOCK_LEVEL_LABEL[level]}: ${LEVEL_BARS[stage][level]}`,
      ''
    );
  }
  return lines.join('\n').trimEnd();
}

/** Built once per level at module load — byte-stable, see the header. */
export const RUBRIC_TEXT: Readonly<Record<MockLevel, string>> = Object.fromEntries(
  MOCK_LEVELS.map((l) => [l, renderRubric(l)])
) as Record<MockLevel, string>;
