// =============================================================================
// llm.debrief — the Today routine's one model call
// =============================================================================
// Same contract as llm.service.ts and llm.mock.ts (llm.structural.test.ts holds
// this file to it): a prompt and a schema in, a coerced answer out, and not one
// word about who answers.
//
//   runDebrief   once per local day: automatically when the day is settled
//                (Phase F, gated by the "AI reviews" toggle, at most twice on
//                failure), or on "Debrief me" / Regenerate. role `small`,
//                thinking OFF, forced tool `emit_debrief`, 1500 output tokens.
//                Cached per day in daily_sessions.
//
// The input is a compact digest of the day — never code, never transcripts —
// so a call is ~1-2k input tokens and a few hundred out.

import { TOPICS } from '../../shared/types.js';
import { MOCK_KINDS } from '../../shared/mock-kinds.js';
import { renderCarryBlock, type CarryNote, type Debrief } from '../../shared/today.js';
import { structured } from './llm.client.js';
import type { CallMeta, ToolSpec } from './llm.types.js';
import { coerceDebrief } from './today.compute.js';

export interface DebriefAttempt {
  title: string;
  pattern: string;
  difficulty: string;
  solved: boolean;
  hints: number;
  testsPassed: number;
  testsTotal: number;
  /** Was it a review re-solve (first attempted before today)? */
  review: boolean;
  predicted: { time: string; space: string; confidence: number | null } | null;
  mistakeTags: string[];
}

export interface DebriefInput {
  date: string;
  attempts: DebriefAttempt[];
  mock: { kind: string; verdict: string | null; summary: string; gaps: string[] } | null;
  skipped: string[];
  cards: { reviewed: number; got: number; shaky: number; missed: number };
  /** 7 days: attempts, solved, mean first-submit pass ratio, top mistake tags. */
  week: { activeDays: number; attempts: number; solved: number; firstSubmitPassPct: number | null; topMistakes: string[] };
  /** Today's step notes (Phase F). Absent/empty renders nothing, byte-identical to before. */
  stepNotes?: CarryNote[];
}

export const DEBRIEF_SYSTEM = `You are a blunt, specific interview-prep coach reviewing ONE day of practice for a candidate targeting Staff engineer roles. The day's routine: a warm-up of drill cards and review problems, two adaptive algorithm problems (predict complexity before solving), and one mock interview.

You get a compact digest of the day and the last seven days. Write a short debrief:
- verdict: one line, the honest headline of the day.
- wins: 0-3 specific things that went well, each pointing at evidence in the digest. No generic praise.
- fixes: 1-3 problems, each with a CONCRETE action: a named pattern to drill, a specific habit for the next problem, a mock concept to revisit. "Practice more" is not an action.
- tomorrowFocus.patterns: 0-3 topic ids, EXACTLY from this list: ${TOPICS.join(', ')}.
- tomorrowFocus.mockKind: one of ${MOCK_KINDS.join(', ')}, or null to keep the normal rotation.

Ground everything in the digest. If the day was thin (steps skipped, nothing attempted), say so plainly and keep it short. Call emit_debrief exactly once.`;

// Strict (exactSchema): every property required at every level, no extras —
// the endpoint guarantees the types. `mockKind` stays optional in effect by
// being nullable. The one-line `verdict` is LAST: the leak sink (ToolSpec.leakSink).
export const EMIT_DEBRIEF_TOOL: ToolSpec = {
  name: 'emit_debrief',
  description: 'Emit the end-of-day debrief.',
  exactSchema: true,
  leakSink: 'verdict',
  schema: {
    type: 'object',
    properties: {
      wins: { type: 'array', items: { type: 'string' }, description: '0-3 specific wins.' },
      fixes: {
        type: 'array',
        description: '1-3 fixes, each with a concrete action.',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'What went wrong, one line.' },
            action: { type: 'string', description: 'The concrete drill or action.' },
          },
          required: ['issue', 'action'],
          additionalProperties: false,
        },
      },
      tomorrowFocus: {
        type: 'object',
        properties: {
          patterns: { type: 'array', items: { type: 'string' }, description: '0-3 exact topic ids.' },
          mockKind: { type: ['string', 'null'], description: "Tomorrow's mock kind, or null for the rotation." },
        },
        required: ['patterns', 'mockKind'],
        additionalProperties: false,
      },
      verdict: { type: 'string', description: 'One-line headline of the day.' },
    },
    required: ['wins', 'fixes', 'tomorrowFocus', 'verdict'],
    additionalProperties: false,
  },
};

/** The digest as the model reads it. Pure; exported for tests and the fixture. */
export function renderDebriefInput(d: DebriefInput): string {
  const lines: string[] = [`Day: ${d.date}`, ''];
  lines.push('Problems today:');
  if (!d.attempts.length) lines.push('- none');
  for (const a of d.attempts) {
    const pred = a.predicted
      ? `predicted ${a.predicted.time || '?'} time / ${a.predicted.space || '?'} space${a.predicted.confidence ? `, confidence ${a.predicted.confidence}/5` : ''}`
      : 'no prediction';
    lines.push(
      `- ${a.review ? '[review] ' : ''}${a.title} (${a.pattern}, ${a.difficulty}): ${a.solved ? 'PASSED' : 'FAILED'} ${a.testsPassed}/${a.testsTotal} tests, ${a.hints} hints, ${pred}${a.mistakeTags.length ? `; mistakes: ${a.mistakeTags.join(', ')}` : ''}`
    );
  }
  lines.push('', 'Mock today:');
  if (!d.mock) lines.push('- none');
  else {
    lines.push(`- ${d.mock.kind}: ${d.mock.verdict ? `${d.mock.verdict} level` : 'not graded'}${d.mock.summary ? ` — ${d.mock.summary}` : ''}`);
    if (d.mock.gaps.length) lines.push(`- gaps: ${d.mock.gaps.join('; ')}`);
  }
  lines.push(
    '',
    `Drill cards graded today: ${d.cards.reviewed} (got ${d.cards.got}, shaky ${d.cards.shaky}, missed ${d.cards.missed})`,
    `Skipped steps: ${d.skipped.length ? d.skipped.join(', ') : 'none'}`,
    '',
    `Last 7 days: ${d.week.activeDays} active days, ${d.week.attempts} submits, ${d.week.solved} solved, first-submit pass ${
      d.week.firstSubmitPassPct === null ? 'n/a' : `${d.week.firstSubmitPassPct}%`
    }, top mistakes: ${d.week.topMistakes.length ? d.week.topMistakes.join(', ') : 'none'}`
  );
  return lines.join('\n') + renderCarryBlock(d.stepNotes ?? []);
}

export async function runDebrief(input: DebriefInput): Promise<{ debrief: Debrief; meta: CallMeta }> {
  const call = await structured({
    role: 'small',
    // A one-line verdict, a few bullets and a handful of ids; ~500 tokens of
    // answer. 1500 is headroom, not a target.
    maxTokens: 1500,
    // Off: the digest is short and the answer is a read of it, not a puzzle.
    thinking: 'off',
    system: DEBRIEF_SYSTEM,
    tool: EMIT_DEBRIEF_TOOL,
    messages: [{ role: 'user', content: renderDebriefInput(input) }],
  });
  return { debrief: coerceDebrief(call.input), meta: call.meta };
}
