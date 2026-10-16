// =============================================================================
// mock.state — the rules, and the one property that costs money when it breaks
// =============================================================================
// The prefix test is the important one. The conversation cache reads every
// earlier turn back at a tenth of the price ONLY if those turns serialize to the
// same bytes on every request. The most natural implementation — render the
// clock into each candidate turn at build time — re-renders every past turn on
// every request and never hits. These tests build a mock turn by turn the way
// the service does and assert each request's messages are a strict prefix of
// the next one's.

import { describe, it, expect } from 'vitest';
import {
  applyReply,
  buildContext,
  buildMessages,
  initialState,
  kindForMode,
  minutesElapsed,
  renderCandidateMessage,
  renderTranscript,
  turnAllowed,
  type InterviewerReply,
  type StoredTurn,
} from './mock.state.js';
import { SD_PROMPTS, pickPrompt, sdPrompt } from '../../shared/sd-prompts.js';
import { MOCK_TURN_CAP, MOCK_MINUTES, type MockTurn } from '../../shared/mock.js';
import type { SdStage } from '../../shared/sd.js';

const T0 = new Date('2026-10-15T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const PROMPT = sdPrompt('event-ticketing')!;

function reply(over: Partial<InterviewerReply> = {}): InterviewerReply {
  return {
    stage: 'requirements',
    stagesCovered: [],
    mode: 'interview',
    teach: null,
    resumePoint: '',
    say: 'Who uses it?',
    ...over,
  };
}

describe('the frozen context', () => {
  it('is deterministic for a prompt and level', () => {
    expect(buildContext(PROMPT, 'staff')).toBe(buildContext(PROMPT, 'staff'));
    expect(buildContext(PROMPT, 'staff')).not.toBe(buildContext(PROMPT, 'principal'));
  });

  it('names the level, the brief and the twists', () => {
    const ctx = buildContext(PROMPT, 'staff');
    expect(ctx).toContain('Staff');
    expect(ctx).toContain(PROMPT.brief);
    for (const t of PROMPT.twists) expect(ctx).toContain(t);
  });
});

describe('the prompt bank', () => {
  it('has unique ids and picks a familiar prompt for the very first mock', () => {
    expect(new Set(SD_PROMPTS.map((p) => p.id)).size).toBe(SD_PROMPTS.length);
    for (let i = 0; i < 10; i++) {
      expect(pickPrompt([], () => i / 10).familiar).toBe(true);
    }
  });

  it('avoids recently used prompts once there is history', () => {
    const recent = SD_PROMPTS.slice(0, 5).map((p) => p.id);
    for (let i = 0; i < 10; i++) {
      expect(recent).not.toContain(pickPrompt(recent, () => i / 10).id);
    }
  });
});

describe('the candidate message', () => {
  it('is the typed text plus a clock line', () => {
    const s = initialState(T0);
    const { rendered } = renderCandidateMessage({ content: 'Who are the users?', action: 'answer' }, s, at(3));
    expect(rendered.startsWith('Who are the users?')).toBe(true);
    expect(rendered).toContain(`[server: 3 of ${MOCK_MINUTES} min · candidate turn 1 of ${MOCK_TURN_CAP}`);
  });

  it('turns each button into a control note, and a button alone is still a message', () => {
    const s = { ...initialState(T0), pendingOffer: 'idempotency' as const };
    expect(renderCandidateMessage({ content: '', action: 'teach_me' }, s, T0).rendered).toMatch(
      /^\[control: TEACH ME[^\]]*about idempotency/
    );
    expect(renderCandidateMessage({ content: '', action: 'stuck' }, s, T0).rendered).toContain("I'M STUCK");
    expect(renderCandidateMessage({ content: '', action: 'move_on' }, s, T0).rendered).toContain('MOVE ON');
    expect(renderCandidateMessage({ content: '', action: 'keep_going' }, s, T0).rendered).toContain('KEEP GOING');
  });

  it('announces a pending skip', () => {
    const s = { ...initialState(T0), pendingSkipNote: ['capacity', 'api'] as SdStage[] };
    expect(renderCandidateMessage({ content: 'ok', action: 'answer' }, s, T0).rendered).toContain(
      '[server: stages skipped: capacity, api.'
    );
  });

  it('warns near the end and sends END exactly once', () => {
    const s = initialState(T0);
    expect(renderCandidateMessage({ content: 'x', action: 'answer' }, s, at(41)).rendered).toContain('nearly out of time');
    const end = renderCandidateMessage({ content: 'x', action: 'answer' }, s, at(MOCK_MINUTES));
    expect(end.endNote).toBe(true);
    expect(end.rendered).toContain('[control: END');
    const again = renderCandidateMessage({ content: 'x', action: 'answer' }, { ...s, endNoteSent: true }, at(50));
    expect(again.endNote).toBe(false);
    expect(again.rendered).not.toContain('[control: END');
  });

  it('sends END on the last allowed turn', () => {
    const s = { ...initialState(T0), candidateTurns: MOCK_TURN_CAP - 1 };
    expect(renderCandidateMessage({ content: 'x', action: 'answer' }, s, at(1)).endNote).toBe(true);
    expect(turnAllowed(s)).toBe(true);
    expect(turnAllowed({ ...s, candidateTurns: MOCK_TURN_CAP })).toBe(false);
  });
});

describe('applying a reply', () => {
  it('records covered stages as a union, in stage order', () => {
    let s = initialState(T0);
    s = applyReply(s, reply({ stagesCovered: ['requirements'] }), true, false);
    s = applyReply(s, reply({ stage: 'capacity', stagesCovered: ['capacity'] }), true, false);
    expect(s.covered).toEqual(['requirements', 'capacity']);
    expect(s.candidateTurns).toBe(2);
  });

  it('detects a forward jump past uncovered stages as a skip, and announces it once', () => {
    let s = applyReply(initialState(T0), reply({ stagesCovered: ['requirements'] }), true, false);
    s = applyReply(s, reply({ stage: 'high-level', stagesCovered: ['requirements'] }), true, false);
    expect(s.skipped).toEqual(['capacity', 'api', 'data-model']);
    expect(s.pendingSkipNote).toEqual(['capacity', 'api', 'data-model']);
    // The next reply clears the announcement but keeps the record.
    s = applyReply(s, reply({ stage: 'high-level' }), true, false);
    expect(s.pendingSkipNote).toEqual([]);
    expect(s.skipped).toEqual(['capacity', 'api', 'data-model']);
  });

  it('treats a backward move as a revisit, and a revisited stage stops being a skip', () => {
    let s = applyReply(initialState(T0), reply({ stage: 'api', stagesCovered: ['requirements'] }), true, false);
    expect(s.skipped).toEqual(['capacity']);
    s = applyReply(s, reply({ stage: 'capacity', stagesCovered: ['requirements', 'capacity'] }), true, false);
    expect(s.skipped).toEqual([]);
    expect(s.pendingSkipNote).toEqual([]);
  });

  it('holds an offer until answered and records each taught concept once', () => {
    let s = applyReply(
      initialState(T0),
      reply({ mode: 'offer_teach', teach: { concept: 'idempotency', gapSummary: 'g' } }),
      true,
      false
    );
    expect(s.pendingOffer).toBe('idempotency');
    s = applyReply(s, reply({ mode: 'teach', teach: { concept: 'idempotency', gapSummary: 'g' } }), true, false);
    s = applyReply(s, reply({ mode: 'teach', teach: { concept: 'idempotency', gapSummary: 'g' } }), true, false);
    expect(s.pendingOffer).toBeNull();
    expect(s.taught).toEqual(['idempotency']);
  });

  it('maps modes to stored kinds', () => {
    expect(kindForMode('interview')).toBe('question');
    expect(kindForMode('offer_teach')).toBe('offer');
    expect(kindForMode('teach')).toBe('teach');
    expect(kindForMode('wrap_up')).toBe('wrap_up');
    expect(kindForMode('nudge')).toBe('nudge');
  });

  it('counts the clock from the start', () => {
    expect(minutesElapsed(initialState(T0), at(12.9))).toBe(12);
  });
});

describe('buildMessages', () => {
  it('produces a byte-stable prefix from one turn to the next', () => {
    const context = buildContext(PROMPT, 'staff');
    const stored: StoredTurn[] = [{ seq: 1, role: 'interviewer', rendered: 'Opening question?' }];
    let state = applyReply(initialState(T0), reply(), false, false);
    let previous = JSON.stringify(buildMessages(context, stored));

    for (let i = 1; i <= 6; i++) {
      // Each turn is taken at a LATER time, so a build-time clock would change
      // every earlier candidate message.
      const { rendered } = renderCandidateMessage({ content: `answer ${i}`, action: 'answer' }, state, at(i * 4));
      const request = buildMessages(context, stored, rendered);
      const serialized = JSON.stringify(request);
      // Everything sent last time, minus the closing bracket, starts this request.
      expect(serialized.startsWith(previous.slice(0, -1))).toBe(true);

      const seq = stored.length;
      stored.push({ seq: seq + 1, role: 'candidate', rendered });
      stored.push({ seq: seq + 2, role: 'interviewer', rendered: `reply ${i}` });
      state = applyReply(state, reply({ say: `reply ${i}` }), true, false);
      previous = JSON.stringify(buildMessages(context, stored));
      expect(previous.startsWith(serialized.slice(0, -1))).toBe(true);
    }
  });

  it('starts with the context and alternates', () => {
    const msgs = buildMessages('CTX', [
      { seq: 2, role: 'candidate', rendered: 'b' },
      { seq: 1, role: 'interviewer', rendered: 'a' },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0].content).toBe('CTX');
  });

  it('refuses a transcript that does not alternate', () => {
    expect(() =>
      buildMessages('CTX', [
        { seq: 1, role: 'interviewer', rendered: 'a' },
        { seq: 2, role: 'interviewer', rendered: 'b' },
      ])
    ).toThrow(/does not alternate/);
    expect(() => buildMessages('CTX', [], 'x')).toThrow(/ends on a candidate turn/);
  });
});

describe('the transcript the grader reads', () => {
  it('marks taught, offered and nudged turns, and button presses', () => {
    const base = { createdAt: T0.toISOString(), stage: 'requirements' as const };
    const turns: MockTurn[] = [
      { ...base, seq: 1, role: 'interviewer', kind: 'question', content: 'Go.' },
      { ...base, seq: 2, role: 'candidate', kind: 'control', content: '', action: 'stuck' },
      { ...base, seq: 3, role: 'interviewer', kind: 'nudge', content: 'Think about retries.' },
      { ...base, seq: 4, role: 'candidate', kind: 'answer', content: 'Retries.' },
      {
        ...base,
        seq: 5,
        role: 'interviewer',
        kind: 'teach',
        content: 'Idempotency is…',
        teach: { concept: 'idempotency', gapSummary: 'g' },
        stage: 'api',
      },
    ];
    const text = renderTranscript(turns);
    expect(text).toContain('#2 CANDIDATE [pressed: stuck]: (no text)');
    expect(text).toContain('#3 INTERVIEWER [NUDGE]');
    expect(text).toContain('[TAUGHT: idempotency');
    expect(text).toContain('--- stage: api (API) ---');
  });
});
