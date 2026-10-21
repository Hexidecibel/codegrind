// =============================================================================
// llm.forge — the story-forge coach (Phase H4)
// =============================================================================
// Same contract as llm.concept.ts (llm.structural.test.ts holds this file to
// it): a prompt and a schema in, a coerced answer out, and not one word about
// who answers. ONE call site, role `workhorse` (Sonnet 5), one call per answer
// the candidate dictates (at most FORGE_MAX_TURNS per session):
//
//   runForgeTurn  the conversation so far → which beats are covered, the
//                 pushback on the last answer, the updated STAR draft, and the
//                 next question. Thinking ADAPTIVE: spotting "we" hiding the
//                 candidate and judging Staff framing is judgement.
//
// THE NEVER-INVENT RULE lives in two places: the prompt (FORGE_SYSTEM) tells
// the coach to ask rather than fill in, and coerceForgeTurn enforces the part a
// machine can check — a number the candidate never said cannot stay in the
// draft (shared/story-forge.enforceSaidNumbers moves it to unconfirmed[]).

import {
  FORGE_BEATS,
  FORGE_BEAT_LABEL,
  PUSHBACK_KINDS,
  enforceSaidNumbers,
  type ForgeBeat,
  type ForgeTurn,
  type PushbackKind,
  type StoryDraft,
} from '../../shared/story-forge.js';
import { competencyLabel } from '../../shared/behavioral-questions.js';
import { clipAtBoundary } from '../../shared/clip.js';
import { structured } from './llm.client.js';
import { cutToolCallFraming, type CallMeta, type ToolSpec } from './llm.types.js';

export const FORGE_SYSTEM = `You are a Staff-level interview coach helping a candidate turn a real experience into a behavioral interview story. The candidate answers OUT LOUD by dictation — ignore filler words, false starts and transcription noise. You run a guided interview, ONE question per turn, through six beats in order:

${FORGE_BEATS.map((b, i) => `${i + 1}. ${b}: ${FORGE_BEAT_LABEL[b]}`).join('\n')}

THE NEVER-INVENT RULE — the most important rule here:
- Every fact in the draft must come from something the candidate SAID in this conversation (or from CONFIRMED material shown to you). Never invent, estimate, round up or "fill in" a number, a name, a team size, a duration, a mechanism or an outcome.
- When something is missing or unclear, ASK for it. If the candidate is unsure ("maybe", "I think", "something like", "roughly"), keep their hedge in the text AND add an item to unconfirmed[] naming exactly what needs confirming.
- unconfirmed[] items are open questions, never facts: never write them into situation, task, action or result as if true.
- Material listed under OPEN QUESTIONS in a seed story is NOT fact either.
- If you catch yourself writing a detail the candidate did not say, put it in unconfirmed[] as a question instead.

PUSH BACK on the candidate's LAST answer, in pushback[] (empty when the answer was solid), on:
- i-vs-we: "we" where their OWN part is unclear. Ask what THEY decided, wrote, proposed or changed.
- vague-scope: no sense of size — how many people, teams, users, dollars, how long.
- no-number: a result with no measurable outcome. Ask for the number; if they do not know it, ask how they would estimate it and mark it unconfirmed.
- staff-framing: the story stays inside one person's task. Probe for the Staff layer: who they had to influence without authority, what was ambiguous and how they framed it, which other teams were involved, what trade-off they made.
- hypothetical: "I would…" instead of what actually happened.
Pushback goes into your next question; do not lecture. NEVER ASK FOR THE SAME THING A THIRD TIME: once you have asked for a figure or detail twice and the candidate has not given it, put it in unconfirmed[] and move on to the next beat. Keep hedges ("maybe", "about", "I think") in the draft text exactly as the candidate hedged.

EACH TURN:
- covered: every beat the conversation has answered well enough so far.
- nextBeat: the beat your question targets — the earliest uncovered beat, unless the last answer needs a pushback follow-up on its own beat.
- draft: the WHOLE current STAR draft, rewritten from everything said so far, in the candidate's voice (first person, past tense, plain words):
  - title: a short, specific name for the story. question: the interviewer question it answers, starting "Tell me about a time you…".
  - situation, task (their role and what was asked of them), action (what THEY did — the longest field), result (the outcome, with their number), complication (the obstacle or pushback and how it was handled).
  - beats: exactly three short result-first beats for a 2-minute retell (1: the result and why it mattered; 2: the situation and their role; 3: the key actions and how they brought people along).
  - numbers: only figures the candidate said, each as a short phrase with its context. caveats: how the story must be told (approximations, things not to claim, "assigned, not self-initiated"). unconfirmed: open questions. fits: the kinds of interview question it answers.
  - Leave a field as an empty string when nothing has been said for it yet. Never pad.
- done: true only when all six beats are covered and the result has a number (or the number is explicitly unconfirmed), or the turn budget is spent.
- say: your next message — at most two short sentences of reaction (no praise padding), then ONE question. When done, say what is still unconfirmed and that they can save the draft.

Call emit_forge_turn exactly once.`;

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    question: { type: 'string', description: '"Tell me about a time you…"' },
    situation: { type: 'string' },
    task: { type: 'string' },
    action: { type: 'string' },
    result: { type: 'string' },
    complication: { type: 'string' },
    beats: { type: 'array', items: { type: 'string' }, description: 'Exactly three result-first retell beats.' },
    numbers: { type: 'array', items: { type: 'string' }, description: 'Only figures the candidate said.' },
    caveats: { type: 'array', items: { type: 'string' } },
    unconfirmed: { type: 'array', items: { type: 'string' }, description: 'Open questions, never facts.' },
    fits: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'question', 'situation', 'task', 'action', 'result', 'complication', 'beats', 'numbers', 'caveats', 'unconfirmed', 'fits'],
};

// Strict: every property required, no extras; `say` LAST — the leak sink.
export const EMIT_FORGE_TURN_TOOL: ToolSpec = {
  name: 'emit_forge_turn',
  description: 'Your next coaching turn: beats covered, pushback, the updated draft, and the next question.',
  exactSchema: true,
  leakSink: 'say',
  schema: {
    type: 'object',
    properties: {
      covered: { type: 'array', items: { type: 'string', enum: [...FORGE_BEATS] } },
      nextBeat: { type: 'string', enum: [...FORGE_BEATS] },
      pushback: {
        type: 'array',
        description: 'On the LAST answer only. Empty when it was solid.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...PUSHBACK_KINDS] },
            note: { type: 'string' },
          },
          required: ['kind', 'note'],
        },
      },
      draft: DRAFT_SCHEMA,
      done: { type: 'boolean' },
      say: { type: 'string', description: 'Your next message: a short reaction, then ONE question.' },
    },
    required: ['covered', 'nextBeat', 'pushback', 'draft', 'done', 'say'],
    additionalProperties: false,
  },
};

export interface ForgeTurnInput {
  competency: string;
  /** The seed, rendered (a candidate's note or an existing story with OPEN QUESTIONS separated). '' = none. */
  seed: string;
  /** The seed's CONFIRMED text only (never its open questions): its numbers count as said. */
  seedConfirmed: string;
  /** The confirmed-facts block (story-bank.CANDIDATE_KNOWN_FACTS). */
  knownFacts: string;
  turns: readonly Pick<ForgeTurn, 'role' | 'content'>[];
  answers: number;
  maxTurns: number;
}

export interface ForgeTurnResult {
  covered: ForgeBeat[];
  nextBeat: ForgeBeat;
  pushback: { kind: PushbackKind; note: string }[];
  draft: StoryDraft;
  done: boolean;
  say: string;
  /** Numbers the coach wrote that the candidate never said (moved to unconfirmed). */
  moved: string[];
}

/** The user message: the never-invent rule is restated next to the material it governs. */
export function renderForgeInput(i: ForgeTurnInput): string {
  const left = Math.max(0, i.maxTurns - i.answers);
  return [
    `Competency the story is for: ${i.competency} (${competencyLabel(i.competency)})`,
    '',
    i.knownFacts,
    '',
    i.seed
      ? `SEED (what the candidate's story bank already has — use only CONFIRMED material as fact; OPEN QUESTIONS are not facts):\n${i.seed}`
      : 'SEED: none — a new story from scratch.',
    '',
    `Answers so far: ${i.answers} of at most ${i.maxTurns}.${left <= 2 ? ' The budget is nearly spent: ask for what matters most (the result number, then what they would change), and set done when it runs out.' : ''}`,
    '',
    'CONVERSATION (coach = you; candidate = dictated answers):',
    ...i.turns.map((t) => `${t.role === 'coach' ? 'COACH' : 'CANDIDATE'}: ${t.content.trim()}`),
    '',
    'Remember: nothing goes into the draft that the candidate did not say. Ask; mark anything uncertain as unconfirmed.',
  ].join('\n');
}

const str = (x: unknown, max: number): string =>
  typeof x === 'string' ? clipAtBoundary(x.trim().replace(/[ \t]+/g, ' '), max) : '';
const list = (x: unknown, n: number, max = 300): string[] =>
  (Array.isArray(x) ? x : []).map((v) => str(v, max)).filter(Boolean).slice(0, n);
const isBeat = (x: unknown): x is ForgeBeat => typeof x === 'string' && (FORGE_BEATS as readonly string[]).includes(x);

export function coerceDraft(raw: unknown): StoryDraft {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    title: str(d.title, 140),
    question: str(d.question, 300),
    situation: str(d.situation, 1500),
    task: str(d.task, 1000),
    action: str(d.action, 3000),
    result: str(d.result, 1500),
    complication: str(d.complication, 1500),
    beats: list(d.beats, 3, 400),
    numbers: list(d.numbers, 10, 300),
    caveats: list(d.caveats, 10, 300),
    unconfirmed: list(d.unconfirmed, 12, 300),
    fits: list(d.fits, 8, 120),
  };
}

/** Whatever the model sent → a well-formed turn, with unsaid numbers moved out. Never throws. */
export function coerceForgeTurn(raw: unknown, answers: readonly string[]): ForgeTurnResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const covered = [...new Set((Array.isArray(o.covered) ? o.covered : []).filter(isBeat))];
  const nextBeat = isBeat(o.nextBeat) ? o.nextBeat : (FORGE_BEATS.find((b) => !covered.includes(b)) ?? 'change');
  const pushback = (Array.isArray(o.pushback) ? o.pushback : [])
    .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
    .filter((p) => (PUSHBACK_KINDS as readonly string[]).includes(p.kind as string) && str(p.note, 300))
    .slice(0, 4)
    .map((p) => ({ kind: p.kind as PushbackKind, note: str(p.note, 300) }));
  const { draft, moved } = enforceSaidNumbers(coerceDraft(o.draft), answers);
  return {
    covered: FORGE_BEATS.filter((b) => covered.includes(b)),
    nextBeat,
    pushback,
    draft,
    done: o.done === true,
    say: str(cutToolCallFraming(typeof o.say === 'string' ? o.say : ''), 1200),
    moved,
  };
}

export async function runForgeTurn(input: ForgeTurnInput): Promise<{ result: ForgeTurnResult; meta: CallMeta }> {
  const call = await structured({
    role: 'workhorse',
    // The whole draft is rewritten every turn (~400-700 words) plus thinking.
    maxTokens: 8000,
    // Adaptive: "we" hiding the candidate, Staff framing — judgement calls.
    thinking: 'adaptive',
    system: FORGE_SYSTEM,
    tool: EMIT_FORGE_TURN_TOOL,
    messages: [{ role: 'user', content: renderForgeInput(input) }],
  });
  const answers = [...input.turns.filter((t) => t.role === 'you').map((t) => t.content), input.seedConfirmed];
  return { result: coerceForgeTurn(call.input, answers), meta: call.meta };
}
