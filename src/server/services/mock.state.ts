// =============================================================================
// mock.state — the mock interview as pure functions
// =============================================================================
// No database, no model, no clock of its own (`now` is always passed in). Every
// rule that decides what the interviewer is told lives here, so it is tested
// directly rather than through a route with a fake model behind it.
//
// THE ONE PROPERTY THAT COSTS MONEY WHEN IT BREAKS: `buildMessages` must produce
// a byte-identical PREFIX from one turn to the next. The conversation cache
// (llm.types.cacheConversation) reads turns 1..N back at a tenth of the input
// price only if turns 1..N serialize exactly as they did last time. So nothing
// in a message is computed at build time: a candidate turn's control notes — the
// clock, the skip notice, the button that was pressed — are rendered ONCE, when
// the turn is taken, stored as `rendered`, and replayed verbatim forever after.
// The clock in particular would otherwise re-render every past turn on every
// request and the cache would never hit. mock.state.test.ts pins this.
//
// KINDS. Every function that needs the kind's stages, clock or labels takes a
// `kind`, defaulting to system design — the kind every stored mock before the
// registry was. The text each one renders for system design is unchanged.

import type { GapType, InterviewerMode } from '../../shared/sd.js';
import {
  mockKindInfo,
  type MockConcept,
  type MockKind,
  type MockStage,
} from '../../shared/mock-kinds.js';
import {
  MOCK_WARN_MINUTES,
  type MockAction,
  type MockState,
  type MockTurn,
  type MockTurnKind,
} from '../../shared/mock.js';
import type { LlmMessage } from './llm.types.js';
import { mockKindSpec } from './mock-kinds/index.js';

/** The system-design setup message. Other kinds build theirs through their spec. */
export { buildSdContext as buildContext } from './mock-kinds/system-design.js';

export function initialState(now: Date, kind: MockKind = 'system-design'): MockState {
  return {
    stage: mockKindInfo(kind).stages[0],
    covered: [],
    skipped: [],
    startedAt: now.toISOString(),
    candidateTurns: 0,
    pendingOffer: null,
    taught: [],
    pendingSkipNote: [],
    endNoteSent: false,
  };
}

export function minutesElapsed(state: MockState, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(state.startedAt).getTime()) / 60_000));
}

// -----------------------------------------------------------------------------
// The candidate's message, rendered once
// -----------------------------------------------------------------------------

export interface CandidateInput {
  content: string;
  action: MockAction;
  /** teach_me only: the concept to teach, when the client knows it. */
  concept?: MockConcept | null;
}

const ACTION_NOTE: Record<
  Exclude<MockAction, 'answer'>,
  (concept: MockConcept | null, label: (c: MockConcept) => string) => string
> = {
  teach_me: (c, label) =>
    `[control: TEACH ME — the candidate pressed "Teach me"${
      c ? ` about ${label(c)}` : ''
    }. Switch to teach mode: explain ${
      c ? 'it' : 'the concept they most recently struggled with (or the one they just named)'
    } plainly, with one concrete example, then end with "Back to the interview:" and the resume point.]`,
  stuck: () =>
    `[control: I'M STUCK — the candidate pressed "I'm stuck". Give one nudge (a question that points the way, not the answer). If they have already been nudged on this, offer to teach instead.]`,
  move_on: () =>
    `[control: MOVE ON — the candidate wants to move to the next stage. Acknowledge briefly and move on; do not re-ask what is unfinished.]`,
  keep_going: () =>
    `[control: KEEP GOING — the candidate declined the lesson. Continue the interview from where it was.]`,
};

/**
 * The exact user-message text for a candidate turn, notes included. Computed
 * once and stored — see the header for why it must never be recomputed.
 */
export function renderCandidateMessage(
  input: CandidateInput,
  state: MockState,
  now: Date,
  kind: MockKind = 'system-design'
): { rendered: string; endNote: boolean } {
  const spec = mockKindSpec(kind);
  const { minutes: MINUTES, turnCap: TURN_CAP } = spec.info;
  const parts: string[] = [];
  const text = input.content.trim();
  if (text) parts.push(text);

  if (state.pendingSkipNote.length) {
    parts.push(
      `[server: stage${state.pendingSkipNote.length > 1 ? 's' : ''} skipped: ${state.pendingSkipNote.join(
        ', '
      )}. The grader will see this. Carry on from where you are unless the candidate goes back.]`
    );
  }

  if (input.action !== 'answer') {
    const concept = input.action === 'teach_me' ? input.concept ?? state.pendingOffer : null;
    parts.push(ACTION_NOTE[input.action](concept ?? null, spec.info.conceptLabel));
  }

  const minutes = minutesElapsed(state, now);
  const turn = state.candidateTurns + 1;
  parts.push(
    `[server: ${minutes} of ${MINUTES} min · candidate turn ${turn} of ${TURN_CAP} · stage: ${state.stage} · covered: ${
      state.covered.length ? state.covered.join(', ') : 'none yet'
    }]`
  );

  const timeUp = minutes >= MINUTES || turn >= TURN_CAP;
  const endNote = timeUp && !state.endNoteSent;
  if (endNote) {
    parts.push(
      `[control: END — time is up. Reply in wrap_up mode: one or two sentences closing the interview. Do not ask another question.]`
    );
  } else if (!timeUp && (minutes >= MINUTES - MOCK_WARN_MINUTES || turn >= TURN_CAP - 4)) {
    parts.push(spec.nearlyOutNote);
  }
  return { rendered: parts.join('\n\n'), endNote };
}

// -----------------------------------------------------------------------------
// The interviewer's reply, applied to the state
// -----------------------------------------------------------------------------

export interface InterviewerReply {
  stage: MockStage;
  stagesCovered: MockStage[];
  mode: InterviewerMode;
  teach: { concept: MockConcept; gapSummary: string } | null;
  resumePoint: string;
  /**
   * Every fact or reasoning move the interviewer handed over in THIS reply —
   * taught, explained in answer to a question, or given away in a nudge. Each
   * becomes a gap and a drill card. Optional so a hand-built reply (tests, the
   * dry run) need not spell out an empty list.
   */
  gaps?: SuppliedGap[];
  say: string;
}

export interface SuppliedGap {
  concept: MockConcept;
  type: GapType;
  /** The card front: a self-contained question. */
  title: string;
  /** The card back: 2–4 sentences, including why it matters to the design. */
  answer: string;
}

/**
 * The gaps to store for one interviewer reply. The supplied list is the
 * source; a teach turn that forgot to list its own lesson still records it
 * (as a skill, the Phase 1 behaviour) so teaching never goes unrecorded.
 */
export function gapsForReply(
  reply: InterviewerReply,
  seq: number
): { seq: number; concept: MockConcept; type: GapType; title: string; summary: string; answer: string }[] {
  const out = (reply.gaps ?? []).map((g) => ({
    seq,
    concept: g.concept,
    type: g.type,
    title: g.title,
    summary: reply.mode === 'teach' && reply.teach?.concept === g.concept ? reply.teach.gapSummary : g.title,
    answer: g.answer,
  }));
  if (reply.mode === 'teach' && reply.teach && !out.some((g) => g.concept === reply.teach!.concept)) {
    out.push({
      seq,
      concept: reply.teach.concept,
      type: 'skill',
      title: '',
      summary: reply.teach.gapSummary,
      answer: '',
    });
  }
  return out;
}

/**
 * Fold one interviewer reply into the state.
 *
 * SKIP DETECTION: moving FORWARD past a stage nobody covered is a skip. It is
 * recorded (the grader is told) and announced once, on the next user message —
 * never silently corrected, because a deliberate skip ("let's assume the API is
 * obvious") is legitimate and the interviewer should hear that the server
 * noticed rather than be overruled. Moving backward is a revisit and is free.
 */
export function applyReply(
  state: MockState,
  reply: InterviewerReply,
  candidateTookTurn: boolean,
  endNoteSent: boolean,
  kind: MockKind = 'system-design'
): MockState {
  const stages = mockKindInfo(kind).stages;
  const stageIndex = (s: MockStage) => stages.indexOf(s);
  const covered = stages.filter(
    (s) => state.covered.includes(s) || reply.stagesCovered.includes(s)
  );
  const from = stageIndex(state.stage);
  const to = stageIndex(reply.stage);
  const newlySkipped: MockStage[] = [];
  if (to > from) {
    for (let i = from; i < to; i++) {
      const s = stages[i];
      if (!covered.includes(s) && !state.skipped.includes(s)) newlySkipped.push(s);
    }
  }
  // A stage that later got covered (a revisit) stops being a skip.
  const skipped = [...state.skipped, ...newlySkipped].filter((s) => !covered.includes(s));
  const taught =
    reply.mode === 'teach' && reply.teach && !state.taught.includes(reply.teach.concept)
      ? [...state.taught, reply.teach.concept]
      : state.taught;
  return {
    ...state,
    stage: reply.stage,
    covered,
    skipped,
    candidateTurns: state.candidateTurns + (candidateTookTurn ? 1 : 0),
    pendingOffer: reply.mode === 'offer_teach' && reply.teach ? reply.teach.concept : null,
    taught,
    // Announced on the NEXT candidate message, then cleared there (see clearSkipNote).
    pendingSkipNote: newlySkipped,
    endNoteSent: state.endNoteSent || endNoteSent,
  };
}

/** The interviewer turn's stored kind, from its mode. */
export function kindForMode(mode: InterviewerMode): MockTurnKind {
  switch (mode) {
    case 'nudge':
      return 'nudge';
    case 'offer_teach':
      return 'offer';
    case 'teach':
      return 'teach';
    case 'wrap_up':
      return 'wrap_up';
    default:
      return 'question';
  }
}

/** Is another candidate turn allowed? */
export function turnAllowed(state: MockState, kind: MockKind = 'system-design'): boolean {
  return state.candidateTurns < mockKindInfo(kind).turnCap;
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

/** A stored turn as buildMessages needs it: the bytes that were sent. */
export interface StoredTurn {
  seq: number;
  role: 'interviewer' | 'candidate';
  /** Interviewer: what it said. Candidate: the rendered message, notes included. */
  rendered: string;
}

/**
 * The conversation, in the order the model sees it.
 *
 *   user       the frozen context (mocks.context)
 *   assistant  interviewer, seq 1
 *   user       candidate, seq 2 (rendered)
 *   …
 *   user       `next` — the candidate turn being taken now, if any
 *
 * Throws on a transcript that does not alternate: a malformed history is a bug
 * to surface, not something to paper over by merging turns (which would also
 * move every byte after it).
 */
export function buildMessages(
  context: string,
  turns: readonly StoredTurn[],
  next?: string
): LlmMessage[] {
  const out: LlmMessage[] = [{ role: 'user', content: context }];
  const ordered = [...turns].sort((a, b) => a.seq - b.seq);
  for (const t of ordered) {
    const role = t.role === 'interviewer' ? 'assistant' : 'user';
    if (out[out.length - 1].role === role) {
      throw new Error(`mock transcript does not alternate at seq ${t.seq} (${t.role} after ${role})`);
    }
    out.push({ role, content: t.rendered });
  }
  if (next !== undefined) {
    if (out[out.length - 1].role === 'user') {
      throw new Error('mock transcript ends on a candidate turn; cannot append another');
    }
    out.push({ role: 'user', content: next });
  }
  return out;
}

// -----------------------------------------------------------------------------
// The transcript, as the grader reads it
// -----------------------------------------------------------------------------

/**
 * Plain text with every teach turn marked, so the grader can do the one thing
 * the rubric depends on: not score an answer the interviewer just taught.
 */
export function renderTranscript(turns: readonly MockTurn[], kind: MockKind = 'system-design'): string {
  const meta = mockKindInfo(kind).stageMeta;
  const lines: string[] = [];
  let lastStage: MockStage | null = null;
  for (const t of [...turns].sort((a, b) => a.seq - b.seq)) {
    if (t.stage !== lastStage) {
      lines.push(`--- stage: ${t.stage} (${meta[t.stage]?.label ?? t.stage}) ---`);
      lastStage = t.stage;
    }
    if (t.role === 'interviewer') {
      const tag =
        t.kind === 'teach' && t.teach
          ? ` [TAUGHT: ${t.teach.concept} — anything the candidate says about this afterwards is not evidence they knew it]`
          : t.kind === 'offer' && t.teach
            ? ` [OFFERED TO TEACH: ${t.teach.concept}]`
            : t.kind === 'nudge'
              ? ' [NUDGE]'
              : '';
      lines.push(`#${t.seq} INTERVIEWER${tag}: ${t.content}`);
    } else {
      const button = t.action && t.action !== 'answer' ? ` [pressed: ${t.action}]` : '';
      lines.push(`#${t.seq} CANDIDATE${button}: ${t.content || '(no text)'}`);
    }
  }
  return lines.join('\n');
}
