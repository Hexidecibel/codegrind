// =============================================================================
// mock.service — start, take a turn, end, abandon
// =============================================================================
// The orchestration between the pure rules (mock.state), the store
// (mock.store) and the two model calls (llm.mock). Routes stay HTTP-shaped.
//
// THREE GUARANTEES, each with the failure it exists to prevent:
//
//   * A FAILED MODEL CALL STORES NOTHING. The candidate's message is written
//     only together with the reply to it (appendExchange). Otherwise a 502 would
//     leave the transcript ending on a user turn, every retry would append a
//     second one, and the cached prefix would be broken for the rest of the mock.
//   * ONE CALL PER MOCK AT A TIME. A double-click, or two tabs, would otherwise
//     run two interviewer calls against the same history and store both. The
//     lock is in-process — this app is one process — and a busy mock is a 429.
//   * `expectedSeq` MUST MATCH. A client that is behind (another tab advanced
//     the mock) gets a 409 and re-reads, rather than answering a question it
//     never saw.

import { nanoid } from 'nanoid';
import { DEFAULT_MOCK_LEVEL, isMockLevel, type MockLevel } from '../../shared/sd.js';
import { renderCarryBlock } from '../../shared/today.js';
import { todayCarryNotes } from './today.service.js';
import { aiReviewsEnabled, costOfMeta } from './ai-usage.service.js';
import { envelopeCardsFromGaps } from './envelope.service.js';
import { isNoAnswer, runCardCheck } from './llm.review.js';
import {
  DEFAULT_MOCK_KIND,
  MOCK_KINDS,
  isMockConcept,
  isMockKind,
  mockKindInfo,
  type MockKind,
} from '../../shared/mock-kinds.js';
import {
  MOCK_ACTIONS,
  MOCK_MAX_ANSWER_CHARS,
  costOf,
  type MockAction,
  type MockCodeResult,
  type MockEndEvent,
  type MockRunSummary,
  type MockState,
  type MockGrade,
  type MockPlanPreview,
  type MockTurnRequest,
  type MockUsage,
  type MockView,
} from '../../shared/mock.js';
import { MOCK_MAX_CODE_CHARS } from '../../shared/coding-mock.js';
import type { RunResult } from '../../shared/types.js';
import {
  gapKey,
  isDoubleGrade,
  isGapCardGrade,
  scheduleGapCard,
  type GapCard,
  type GapCardsResponse,
  type GapCardCheck,
} from '../../shared/gap-cards.js';
import { db, enqueueReview, getActiveLanguage, getProblem, getSkillState, loopDeadlineMs } from './db.js';
import { capDueAtIso } from '../../shared/loops.js';
import { getNextProblem } from './bank.service.js';
import { runTests } from './sandbox.service.js';
import type { CallMeta } from './llm.types.js';
import { gradeMock, interviewerTurn } from './llm.mock.js';
import { mockKindSpec } from './mock-kinds/index.js';
import { coerceRunSummary, toCodeResult, weakestTopicOf } from './mock-kinds/coding.js';
import { errorBody } from './explain.service.js';
import {
  applyReply,
  buildMessages,
  gapsForReply,
  initialState,
  kindForMode,
  renderCandidateMessage,
  renderTranscript,
  turnAllowed,
} from './mock.state.js';
import {
  appendExchange,
  deleteMock,
  cardCounts,
  dueCards,
  emptyUsage,
  gapKeys,
  getCard,
  getGaps,
  getGrade,
  insertGap,
  getMock,
  getTurns,
  insertMock,
  putGrade,
  recentConceptSignals,
  recentPlannedQuestionIds,
  recentPromptIds,
  toStoredTurns,
  logCardReview,
  updateCardSchedule,
  updateMock,
  type MockRow,
  type NewTurn,
  type StoredMockTurn,
} from './mock.store.js';

/** A failure with an HTTP status the route can pass straight through. */
export class MockError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
    this.name = 'MockError';
  }
}

// -----------------------------------------------------------------------------
// Usage
// -----------------------------------------------------------------------------

/** Fold one call's meta into a running usage record. Pure. */
export function addUsage(usage: MockUsage, meta: CallMeta): MockUsage {
  const tokens = {
    inputTokens: meta.usage.inputTokens,
    outputTokens: meta.usage.outputTokens,
    cacheReadTokens: meta.usage.cachedInputTokens,
    cacheWriteTokens: meta.usage.cacheWriteInputTokens ?? 0,
  };
  const cost = costOf(meta.servedModel, tokens);
  return {
    calls: usage.calls + 1,
    inputTokens: usage.inputTokens + tokens.inputTokens,
    outputTokens: usage.outputTokens + tokens.outputTokens,
    cacheReadTokens: usage.cacheReadTokens + tokens.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens + tokens.cacheWriteTokens,
    // Once any call is unpriced, the total is unknown — not "a bit low".
    costUsd: usage.costUsd === null || cost === null ? null : usage.costUsd + cost,
    models: usage.models.includes(meta.servedModel) ? usage.models : [...usage.models, meta.servedModel],
  };
}

function callUsage(meta: CallMeta) {
  return {
    model: meta.servedModel,
    in: meta.usage.inputTokens,
    out: meta.usage.outputTokens,
    cacheRead: meta.usage.cachedInputTokens,
    cacheWrite: meta.usage.cacheWriteInputTokens ?? 0,
    ms: meta.latencyMs,
  };
}

// -----------------------------------------------------------------------------
// The lock
// -----------------------------------------------------------------------------

const busy = new Set<string>();

async function withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (busy.has(id)) {
    throw new MockError('The interviewer is still answering your last message.', 429);
  }
  busy.add(id);
  try {
    return await work();
  } finally {
    busy.delete(id);
  }
}

/** Test seam: whether a mock is mid-call. */
export function isBusy(id: string): boolean {
  return busy.has(id);
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

function toView(m: MockRow, turns: StoredMockTurn[], grade: MockGrade | null): MockView {
  const info = mockKindInfo(m.kind);
  return {
    id: m.id,
    kind: m.kind,
    level: m.level,
    promptId: m.promptId,
    prompt: m.prompt,
    status: m.status,
    // graderContext (the story bank, for the grader) stays server-side.
    state: publicState(m.state),
    usage: m.usage,
    // `rendered` and `observations` stay server-side: the control notes are
    // instructions to the model, not something to show the candidate.
    turns: turns.map(({ rendered: _r, observations: _o, editor: _e, ...t }) => t),
    grade,
    gaps: getGaps(m.id),
    createdAt: m.createdAt,
    endedAt: m.endedAt,
    limits: { turnCap: info.turnCap, minutes: info.minutes },
  };
}

function publicState(s: MockRow['state']): MockRow['state'] {
  if (s.graderContext === undefined) return s;
  const { graderContext: _g, ...rest } = s;
  return rest;
}

export function getMockView(id: string): MockView {
  const m = getMock(id);
  if (!m) throw new MockError('No such mock.', 404);
  return toView(m, getTurns(id), getGrade(id));
}

function lastSeq(turns: StoredMockTurn[]): number {
  return turns.length ? turns[turns.length - 1].seq : 0;
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

/** A `kind` from a request: absent is system design, anything unknown is a 400. */
export function parseKind(raw: unknown): MockKind {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MOCK_KIND;
  if (!isMockKind(raw)) throw new MockError(`kind must be one of: ${MOCK_KINDS.join(', ')}.`, 400);
  return raw;
}

/** The planner's inputs from this kind's history. */
function prepareArgs(kind: MockKind, level: MockLevel, requested: unknown, options?: unknown) {
  return {
    level,
    requested,
    history: recentConceptSignals(kind),
    recentQuestionIds: recentPlannedQuestionIds(kind),
    options,
    // Coding: the bank (which may generate — a model call that belongs to the
    // bank, not the spec) and the skill state, in the active language.
    coding: {
      weakestTopic: () => weakestTopicOf(getSkillState(getActiveLanguage())),
      fetchProblem: (topic: Parameters<typeof getNextProblem>[1], difficulty: Parameters<typeof getNextProblem>[2]) =>
        getNextProblem(getActiveLanguage(), topic, difficulty),
    },
  };
}

/** Test seam: replace the hidden-test runner the coding mock uses (the sandbox needs Docker). */
let runHidden = async (problemId: string, code: string): Promise<RunResult> => {
  const problem = getProblem(problemId);
  if (!problem) throw new Error('The mock’s problem is no longer in the bank.');
  return runTests({ language: problem.language, functionName: problem.functionName, userCode: code, tests: problem.hiddenTests });
};
export function setHiddenRunnerForTest(fn: typeof runHidden): void {
  runHidden = fn;
}

/**
 * GET /api/mock/plan?kind= — what a planned kind would ask about, for the start
 * card. Free: no model call (behavioral reads the story bank over localhost).
 * The questions are not shown; the start request sends the concepts back.
 */
export async function previewPlan(kindRaw: unknown, levelRaw?: unknown): Promise<MockPlanPreview> {
  const kind = parseKind(kindRaw);
  const spec = mockKindSpec(kind);
  // Only PLANNED kinds preview: coding's prepare fetches (maybe generates) a problem.
  if (!spec.prepare || !spec.info.planned) return { kind, concepts: [], reasons: {}, storyBank: null };
  const level: MockLevel = isMockLevel(levelRaw) ? levelRaw : DEFAULT_MOCK_LEVEL;
  const prep = await spec.prepare(prepareArgs(kind, level, undefined));
  const concepts = prep.plan?.items.map((i) => i.concept) ?? [];
  return {
    kind,
    concepts,
    reasons: Object.fromEntries(concepts.map((c) => [c, prep.reasons[c] ?? []])),
    storyBank: prep.plan?.storyBank ?? null,
  };
}

export async function startMock(body: {
  kind?: unknown;
  level?: unknown;
  promptId?: unknown;
  plan?: unknown;
  coding?: unknown;
}): Promise<MockView> {
  const kind = parseKind(body.kind);
  const spec = mockKindSpec(kind);
  if (body.level !== undefined && !isMockLevel(body.level)) {
    throw new MockError('level must be senior, staff or principal.', 400);
  }
  const level: MockLevel = isMockLevel(body.level) ? body.level : DEFAULT_MOCK_LEVEL;
  let prompt;
  if (body.promptId !== undefined && body.promptId !== null && body.promptId !== '') {
    prompt = typeof body.promptId === 'string' ? spec.info.promptById(body.promptId) : null;
    if (!prompt) throw new MockError('Unknown prompt.', 400);
  } else {
    prompt = spec.info.pickPrompt(recentPromptIds(kind));
  }

  // Planned kinds read what they need (behavioral: the story bank) BEFORE the
  // row exists; the result is frozen into the context and the state, so every
  // later request and the grade see exactly what the mock started with.
  const prep = spec.prepare ? await spec.prepare(prepareArgs(kind, level, body.plan, body.coding)) : undefined;
  const now = new Date();
  const id = nanoid();
  const state: MockState = {
    ...initialState(now, kind),
    ...(prep?.plan ? { plan: prep.plan } : {}),
    ...(prep ? { graderContext: prep.graderContext } : {}),
    ...(prep?.coding ? { coding: prep.coding } : {}),
  };
  // Phase F carry-forward: today's step notes, FROZEN into the context at
  // start like everything else in it, so the per-mock cached prefix is stable.
  // No notes → '' → the context is byte-identical to before.
  // Filtered for what applies to THIS kind (shared/today.applicableNotes).
  const context =
    spec.buildContext(prompt, level, prep) + renderCarryBlock(todayCarryNotes(now, kind === 'coding' ? 'algorithm' : 'mock'));
  const row: MockRow = {
    id,
    kind,
    level,
    promptId: prep?.brief ? null : prompt.id,
    prompt: prep?.brief ?? prompt.brief,
    status: 'active',
    context,
    digest: null,
    state,
    usage: emptyUsage(),
    turnCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    endedAt: null,
  };
  // Stored first so the lock and the 404 path have something to refer to; it
  // is deleted again if the opening call fails, so a failed start leaves no
  // empty mock behind in the list.
  insertMock(row);
  try {
    return await withLock(id, async () => {
      const { reply, observations, meta } = await interviewerTurn(buildMessages(context, []), state.stage, kind);
      const next = applyReply(state, reply, false, false, kind);
      const usage = addUsage(row.usage, meta);
      const turn: NewTurn = {
        seq: 1,
        role: 'interviewer',
        kind: kindForMode(reply.mode),
        content: reply.say,
        rendered: reply.say,
        stage: reply.stage,
        meta: { mode: reply.mode, teach: reply.teach, gaps: reply.gaps ?? [], observations, call: callUsage(meta) },
      };
      appendExchange({ ...row, state: next, usage, turnCount: 1 }, [turn], gapsForReply(reply, 1));
      return getMockView(id);
    });
  } catch (err) {
    deleteMock(id);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// A turn
// -----------------------------------------------------------------------------

/** `concept` is checked against the mock's kind later, once the mock is read. */
function parseTurn(
  body: unknown
): Omit<MockTurnRequest, 'concept' | 'lastRun'> & { action: MockAction; concept?: unknown; lastRun: MockRunSummary | null } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(b.expectedSeq)) throw new MockError('expectedSeq is required.', 400);
  const action = (b.action ?? 'answer') as MockAction;
  if (!(MOCK_ACTIONS as readonly string[]).includes(action)) throw new MockError('Unknown action.', 400);
  const content = typeof b.content === 'string' ? b.content : '';
  if (content.length > MOCK_MAX_ANSWER_CHARS) {
    throw new MockError(`That answer is over ${MOCK_MAX_ANSWER_CHARS} characters — split it up.`, 400);
  }
  if (action === 'answer' && !content.trim()) throw new MockError('Say something first.', 400);
  if (b.code !== undefined && typeof b.code !== 'string') throw new MockError('code must be a string.', 400);
  if (typeof b.code === 'string' && b.code.length > MOCK_MAX_CODE_CHARS) {
    throw new MockError(`The editor is over ${MOCK_MAX_CODE_CHARS} characters.`, 400);
  }
  return {
    expectedSeq: b.expectedSeq as number,
    content,
    action,
    concept: b.concept,
    ...(typeof b.code === 'string' ? { code: b.code } : {}),
    lastRun: coerceRunSummary(b.lastRun),
  };
}

/**
 * Fields a mock Submit may have written WHILE this turn's model call was in
 * flight (routes/submit.ts mock mode does not take the lock — the hidden tests
 * should not wait on the interviewer). Folded back so the turn's write does not
 * erase them.
 */
function keepConcurrentSubmit(next: MockState, id: string): MockState {
  const fresh = getMock(id)?.state.coding;
  if (!next.coding || !fresh) return next;
  return { ...next, coding: { ...next.coding, submits: fresh.submits, lastSubmit: fresh.lastSubmit } };
}

export async function takeTurn(id: string, body: unknown): Promise<MockView> {
  const req = parseTurn(body);
  return withLock(id, async () => {
    const m = getMock(id);
    if (!m) throw new MockError('No such mock.', 404);
    if (m.status !== 'active') throw new MockError(`This mock is ${m.status.replace('_', ' ')}.`, 409);
    if (!turnAllowed(m.state, m.kind)) {
      throw new MockError(`That was the last of ${mockKindInfo(m.kind).turnCap} turns — press End & grade.`, 409);
    }
    // An unknown concept is dropped, not refused: the button still means "teach me".
    const concept = isMockConcept(m.kind, req.concept) ? req.concept : null;
    const turns = getTurns(id);
    const seq = lastSeq(turns);
    if (req.expectedSeq !== seq) {
      throw new MockError('This mock moved on in another tab — reloading it.', 409);
    }

    const now = new Date();
    const { rendered, endNote, coding, editor } = renderCandidateMessage(
      { content: req.content, action: req.action, concept, code: req.code, lastRun: req.lastRun },
      m.state,
      now,
      m.kind
    );
    const messages = buildMessages(m.context, toStoredTurns(turns), rendered);
    const { reply, observations, meta } = await interviewerTurn(messages, m.state.stage, m.kind);

    let next = applyReply(m.state, reply, true, endNote, m.kind);
    if (coding && next.coding) next = keepConcurrentSubmit({ ...next, coding: { ...next.coding, ...coding } }, id);
    const usage = addUsage(m.usage, meta);
    const candidate: NewTurn = {
      seq: seq + 1,
      role: 'candidate',
      kind: req.action === 'answer' || req.content.trim() ? 'answer' : 'control',
      content: req.content.trim(),
      rendered,
      stage: m.state.stage,
      meta: { action: req.action, ...(editor ? { editor } : {}) },
    };
    const interviewer: NewTurn = {
      seq: seq + 2,
      role: 'interviewer',
      kind: kindForMode(reply.mode),
      content: reply.say,
      rendered: reply.say,
      stage: reply.stage,
      meta: { mode: reply.mode, teach: reply.teach, gaps: reply.gaps ?? [], observations, call: callUsage(meta) },
    };
    // Every fact or move the interviewer handed over is a gap — and a drill card.
    const gaps = gapsForReply(reply, seq + 2);
    appendExchange({ ...m, state: next, usage, turnCount: m.turnCount + 2 }, [candidate, interviewer], gaps);
    return getMockView(id);
  });
}

// -----------------------------------------------------------------------------
// End & grade
// -----------------------------------------------------------------------------

/**
 * Grade a mock, as NDJSON events. Validation happens BEFORE the first event so a
 * bad request is still an ordinary HTTP error (the route calls `prepareEnd`
 * first, then iterates `runEnd`).
 */
export function prepareEnd(id: string): MockRow {
  const m = getMock(id);
  if (!m) throw new MockError('No such mock.', 404);
  if (m.status === 'graded') throw new MockError('This mock is already graded.', 409);
  if (m.status === 'abandoned') throw new MockError('This mock was abandoned.', 409);
  if (busy.has(id)) throw new MockError('The interviewer is still answering your last message.', 429);
  if (m.state.candidateTurns === 0) {
    throw new MockError('Answer at least once before grading — there is nothing to grade yet.', 409);
  }
  return m;
}

/** POST /end's body: coding sends the editor as it is at End. */
export function parseEnd(body: unknown): { code?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.code !== 'string') return {};
  if (b.code.length > MOCK_MAX_CODE_CHARS) throw new MockError(`The editor is over ${MOCK_MAX_CODE_CHARS} characters.`, 400);
  return { code: b.code };
}

export async function* runEnd(m: MockRow, end: { code?: string } = {}): AsyncGenerator<MockEndEvent> {
  if (busy.has(m.id)) {
    yield { type: 'error', error: 'The interviewer is still answering your last message.' };
    return;
  }
  busy.add(m.id);
  try {
    updateMock({ ...m, status: 'grading' });
    yield { type: 'wrapup', status: 'grading', candidateTurns: m.state.candidateTurns };
    const turns = getTurns(m.id);
    const info = mockKindInfo(m.kind);
    const spec = mockKindSpec(m.kind);
    const prompt = m.promptId ? info.promptById(m.promptId) : null;
    // Coding: settle the hidden-test result (the last Submit, or the final code
    // run now). Stored at once, so a failed grade does not run it twice.
    if (spec.finalize) {
      const state = await spec.finalize(m.state, end, { runHidden });
      m = { ...m, state };
      updateMock({ ...m, status: 'grading' });
    }
    const graderContext = spec.graderContext?.(m.state) ?? null;
    let grade: MockGrade;
    let usage = m.usage;
    let gradeUsage = emptyUsage();
    try {
      const result = await gradeMock({
        kind: m.kind,
        level: m.level,
        promptTitle: prompt?.title ?? info.label,
        brief: m.prompt,
        transcript: renderTranscript(turns, m.kind),
        skipped: m.state.skipped,
        taught: m.state.taught,
        recordedGaps: getGaps(m.id).map((g) => ({ seq: g.seq, type: g.type, title: g.title, summary: g.summary })),
        ...(graderContext ? { graderContext } : {}),
      });
      grade = result.grade;
      for (const meta of result.metas) {
        usage = addUsage(usage, meta);
        gradeUsage = addUsage(gradeUsage, meta);
      }
    } catch (err) {
      console.error('[mock] grading failed:', err instanceof Error ? err.message : err);
      updateMock({ ...m, status: 'grade_failed' });
      const body = errorBody('mock-grade', err);
      yield { type: 'error', error: body.error, ...(body.detail ? { detail: body.detail } : {}) };
      return;
    }
    // Coding: the server-known test result onto the grade, and the one deliberate
    // grind side effect (a missed pattern → the review queue).
    if (spec.afterGrade) {
      const after = spec.afterGrade(m.state, grade, { enqueueReview: (pid) => enqueueReview(pid, 'failed') });
      grade = after.grade;
      m = { ...m, state: after.state };
    }
    putGrade(m.id, grade, gradeUsage);
    storeGradeGaps(m.id, grade);
    // Estimation/capacity gaps with a volume in them also become Envelope cards.
    envelopeCardsFromGaps(m.id, getGaps(m.id));
    const digest = `${grade.verdict} ${m.level}: ${grade.summary.slice(0, 280)}`;
    updateMock({ ...m, status: 'graded', usage, digest, endedAt: new Date().toISOString() });
    yield { type: 'grade', grade, usage };
  } finally {
    busy.delete(m.id);
  }
}

// -----------------------------------------------------------------------------
// Coding: a Submit inside the mock (routes/submit.ts, mode: 'mock')
// -----------------------------------------------------------------------------

/**
 * Check a mock-mode Submit before the sandbox runs: the mock exists, is an
 * active coding mock, and the problem is the mock's own.
 */
export function codingSubmitTarget(mockId: unknown, problemId: unknown): MockRow {
  const m = typeof mockId === 'string' ? getMock(mockId) : null;
  if (!m) throw new MockError('No such mock.', 404);
  if (!m.state.coding) throw new MockError('That mock has no editor.', 400);
  if (m.status !== 'active') throw new MockError(`This mock is ${m.status.replace('_', ' ')}.`, 409);
  if (problemId !== m.state.coding.problemId) throw new MockError('That is not this mock’s problem.', 400);
  return m;
}

/**
 * Record a mock Submit's hidden-test result on the mock — and NOTHING else: no
 * attempt row, no skill/SRS update, no review queue, no coaching. Re-read
 * right before the write (no await in between) so a turn stored meanwhile is
 * not overwritten.
 */
export function recordCodingSubmit(mockId: string, result: RunResult, code: string, now = new Date()): MockCodeResult {
  const r = toCodeResult(result, code, now);
  const m = getMock(mockId);
  if (!m?.state.coding) return r;
  const coding = { ...m.state.coding, submits: m.state.coding.submits + 1, lastSubmit: r };
  updateMock({ ...m, state: { ...m.state, coding } });
  return r;
}

export function abandonMock(id: string): MockView {
  const m = getMock(id);
  if (!m) throw new MockError('No such mock.', 404);
  if (busy.has(id)) throw new MockError('The interviewer is still answering your last message.', 429);
  if (m.status === 'graded') throw new MockError('A graded mock cannot be abandoned.', 409);
  updateMock({ ...m, status: 'abandoned', endedAt: new Date().toISOString() });
  return getMockView(id);
}

// -----------------------------------------------------------------------------
// Gaps the grader found, and the drill cards
// -----------------------------------------------------------------------------

/**
 * Store the grader's additional gaps as cards — minus any whose title the
 * turn-level capture already has (a re-grade after grade_failed must not
 * double them either). One transaction: all of a grade's gaps or none.
 */
export function storeGradeGaps(mockId: string, grade: MockGrade, now = new Date()): number {
  const seen = gapKeys(mockId);
  let added = 0;
  db.transaction(() => {
    for (const g of grade.gaps ?? []) {
      const key = gapKey(g.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      insertGap(
        mockId,
        { seq: g.turn, concept: g.concept, type: g.type, title: g.title, summary: g.title, answer: g.answer, source: 'grade' },
        now
      );
      added++;
    }
  })();
  return added;
}

/** GET /api/mock/cards — the due pile plus counts. A read; no model. */
export function gapCards(now = new Date()): GapCardsResponse {
  return { due: dueCards(now), ...cardCounts(now), aiReviews: aiReviewsEnabled() };
}

const cardChecksInFlight = new Set<number>();

/**
 * POST /api/mock/cards/:id/check — grade a typed / dictated answer against the
 * card back: one `small` call (llm.review.runCardCheck). Moves NOTHING: the
 * user confirms or overrides, and /grade applies it. An empty or "I don't
 * know" answer is `missed` with no call. Gated by the "AI reviews" toggle.
 */
export async function checkGapCard(id: number, body: unknown): Promise<GapCardCheck> {
  const raw = (body as Record<string, unknown> | null)?.answer;
  const answer = typeof raw === 'string' ? raw.slice(0, 6000) : '';
  const card = getCard(id);
  if (!card) throw new MockError('No such card.', 404);
  if (isNoAnswer(answer)) {
    return { grade: 'missed', why: 'No answer given — counted as missed.', missing: [], ai: false, costUsd: 0 };
  }
  if (!aiReviewsEnabled()) throw new MockError('AI reviews are off (Settings). Grade it yourself.', 409);
  if (cardChecksInFlight.has(id)) throw new MockError('That card is already being checked.', 429);
  cardChecksInFlight.add(id);
  try {
    const { result, meta } = await runCardCheck({
      question: card.title || `${card.concept}: ${card.summary}`,
      reference: card.answer,
      summary: card.summary,
      answer,
    });
    return { ...result, ai: true, costUsd: costOfMeta(meta) };
  } finally {
    cardChecksInFlight.delete(id);
  }
}

/**
 * POST /api/mock/cards/:id/grade — the candidate's own verdict on one card.
 * Self-graded by design: no model call, so drilling costs nothing.
 */
export function gradeGapCard(id: number, body: unknown, now = new Date()): GapCard {
  const grade = (body as Record<string, unknown> | null)?.grade;
  if (!isGapCardGrade(grade)) throw new MockError('grade must be got, shaky or missed.', 400);
  const card = getCard(id);
  if (!card) throw new MockError('No such card.', 404);
  if (card.retiredAt) throw new MockError('That card is already retired.', 409);
  // The double-grade guard: a second grade inside a few seconds is a double
  // tap (the client used to re-enable the buttons before the next card loaded).
  if (isDoubleGrade(card.lastReviewedAt, now)) throw new MockError('That card was just graded.', 409);
  const next = scheduleGapCard(card, grade, now);
  // Phase H2: with an interview loop ahead, no card is scheduled past its
  // final-review day (shared/loops.capDueAtIso).
  if (!next.retiredAt) next.dueAt = capDueAtIso(next.dueAt, now.getTime(), loopDeadlineMs(now.getTime()));
  logCardReview(id, grade, card.lastReviewedAt ?? card.createdAt, now);
  updateCardSchedule(id, next);
  return getCard(id)!;
}
