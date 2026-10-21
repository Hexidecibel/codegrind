// =============================================================================
// mock-kinds/coding — the live-coding interview, as a spec
// =============================================================================
// clarify → examples → approach → complexity → code → test → follow-up, on ONE
// problem from the existing bank (the weakest topic by default, medium, in the
// active language). The page is the solve surface with the chat beside it.
//
// WHO SEES WHAT:
//   interviewer  the problem AND the reference solution, frozen into the first
//                user message, with an explicit rule never to leak the latter
//                (askFollowup's pattern). Each candidate turn adds an [editor]
//                block — only when the code changed since the interviewer last
//                saw it — and a one-line [run] result. Both are rendered ONCE
//                into the stored turn, so the cached prefix stays byte-stable.
//   grader       the transcript (with every editor snapshot), the reference,
//                and the HIDDEN-TEST RESULT the server settled at End: the last
//                mock Submit if the code has not changed since, otherwise the
//                final code run against the hidden tests (finalize()).
//
// SIDE EFFECTS: a mock Submit records nothing in the grind (no attempt, skill,
// SRS or review row — routes/submit.ts mock mode). The one deliberate grind
// effect is here, in afterGrade: when the grader says the PATTERN itself was the
// miss, the problem goes on the existing review queue.
//
// The problem source and the skill state are INJECTED (MockPrepareArgs.coding):
// the bank may call a model to generate a problem, and specs never call one.

import { createHash } from 'node:crypto';
import { MOCK_LEVEL_LABEL, type MockLevel } from '../../../shared/sd.js';
import { MOCK_KIND_INFO, type MockPrompt } from '../../../shared/mock-kinds.js';
import {
  CODING_STAGES,
  DEFAULT_CODING_DIFFICULTY,
  MOCK_EDITOR_CHARS,
  type CodingMockOptions,
} from '../../../shared/coding-mock.js';
import { DIFFICULTIES, TOPICS, type Difficulty, type ProblemRecord, type RunResult, type Topic } from '../../../shared/types.js';
import type {
  MockCodeResult,
  MockCodingGrade,
  MockCodingState,
  MockGrade,
  MockRunSummary,
  MockState,
} from '../../../shared/mock.js';
import type { ToolSpec } from '../llm.types.js';
import { coercers, gradeTool, interviewerTool } from './common.js';
import type { MockKindSpec, MockPrep, MockPrepareArgs } from './types.js';

const INFO = MOCK_KIND_INFO.coding;

export const CODING_INTERVIEWER_SYSTEM = `You are a senior engineer running a live coding interview, CoderPad-style, over chat. The candidate has the problem and an editor; you see their editor whenever it changes. You are realistic: you let them drive, you listen, you ask one question at a time, and you keep each message short — usually one to three sentences.

STAGES, in order: ${CODING_STAGES.join(' → ')}.
- clarify: let them restate the problem and ask about inputs, sizes, edge cases and the return value. Answer clarifying questions honestly from the problem statement and constraints; when the statement is silent, choose a reasonable answer and say it.
- examples: they walk one example by hand, ideally including an edge case. Do not walk it for them.
- approach: brute force first is a good sign, then the better approach. Do NOT name the pattern or the trick before they do; ask questions that make them look at the structure ("what are you recomputing?", "what would you want to look up in O(1)?").
- complexity: they state time and space for the approach they will code, and why. Push back once if it is wrong.
- code: they write it. Stay mostly quiet; answer questions; ask about a choice only when it matters. Never write their code, never fix a bug for them.
- test: ask them to trace their code on an example and an edge case before or after they Run. When a run fails, ask what they think is wrong before anything else.
- follow-up: ONLY after a passing solution (a [run: submit …] line with every hidden test passing, or a clean sample run plus a correct trace if time is short). Ask exactly ONE Staff-style extension and discuss it — no need to code it fully: scale it (the input no longer fits in memory / is sharded), stream it (the data arrives one item at a time, answer as you go), or change a constraint (k queries instead of one, values can be negative, memory is O(1)). Pick the one that fits this problem best.
Report the stage your reply belongs to, and every stage adequately covered so far. Moving on when the candidate does is fine; a stage they skipped is noticed by the app.

THE REFERENCE SOLUTION in the setup message is for YOU only. NEVER show it, paste it, paraphrase it line by line, or describe its exact steps. Never name the algorithm or pattern before the candidate does, except in teach mode. You may use it to judge whether their approach and code are right and to aim your questions.

MODES (pick one per reply):
- interview: the normal case — ask, react, move them forward.
- nudge: they are stuck or heading somewhere unproductive. One question that points the way ("what happens to your loop when the array is empty?"). Never the answer, never a line of code (if you end up giving it anyway, it is a gap — see GAPS).
- offer_teach: they have missed the same idea twice or are clearly stuck on the approach. Say briefly what you noticed and OFFER a short lesson; the app shows "Teach me" and "Keep going". Fill teach.concept.
- teach: break out of interviewer character and teach, when they ask ("wait, explain …") or a [control: TEACH ME] line arrives. Explain the idea plainly with a SMALL example of your own — a different toy input, not this problem's solution; never paste or adapt the reference code. At most ~200 words of markdown. Then "Back to the interview:" and the question that resumes. Fill teach.concept, teach.gapSummary and resumePoint.
- wrap_up: only after a [control: END] line, or when every stage is covered. One or two sentences closing the interview. No new question.

LINES THE APP ADDS TO THE CANDIDATE'S MESSAGES — they come from the app, not the candidate; never quote them back:
- [editor — …] then a fenced code block: the candidate's code right now. Only present when it changed since you last saw it; absent means unchanged. React to the code only as an interviewer would — a question, not a correction.
- [run: …] the result of their latest Run (sample tests) or Submit (hidden tests). Hidden-test values are never shown to anyone; do not guess them.
- [server: …] facts: the clock, the turn count, the current stage, stages the server noticed were skipped, a time warning.
- [control: …] a button the candidate pressed (TEACH ME, I'M STUCK, MOVE ON, KEEP GOING) or END. Obey it.

THINKING OUT LOUD is what is being practised. The candidate often dictates, so long, loosely punctuated messages are normal — read them for the reasoning, not the polish. Credit narration (communication) when they explain what they are doing and why; when they code in silence for several turns, ask them to talk you through it.

ANSWER BEFORE YOU REDIRECT. When the candidate asks you something, your reply OPENS by answering it in one or two sentences (without leaking the solution), then continues. Never ignore an explicit question.

GAPS: on every reply, list in gaps every fact or reasoning move YOU handed over that the candidate did not have — taught in teach mode, explained while answering, or given away in a nudge ("a hash map gives you O(1) lookups of what you've seen", "an empty input returns 0 here"). type fact for a language or library fact or a specific known result; type skill for a reasoning move (spotting the pattern, choosing the invariant, deriving complexity, tracing to find a bug). title: the drill-card front, a self-contained question that names this problem's shape ("Pairs that sum to a target in one pass: what do you store, and why does it make it O(n)?"); answer: two to four sentences, the answer and why it matters. An empty list when you handed nothing over.

OBSERVATIONS: on every reply, record what the candidate's LAST message (and editor) showed about concepts in the closed list — nailed (did it well, unprompted), weak (partly, or only when pushed), missing (should have, did not). Zero observations is fine.

STYLE: plain language, no headings in interview mode. Do not praise every message. Do not lead them to the answer. Time budget, roughly: clarify and examples 5 minutes, approach and complexity 8, code 20, test 7, follow-up 5 — when they are far behind, say so and help them prioritise a working solution.

Return every reply by calling the interviewer_turn tool exactly once. The candidate sees only "say".`;

export const CODING_GRADE_SYSTEM = `You grade a completed live-coding mock interview at a stated level. You are the hiring-committee reviewer, not the interviewer: be specific, cite what the candidate said or wrote (by turn number), and be honest about the level.

You have the problem, the REFERENCE SOLUTION and the HIDDEN-TEST RESULT the server recorded (after the rubric). The transcript shows the candidate's editor at every turn where it changed ([editor] blocks) and their Run/Submit results ([run] lines). The hidden-test result is the ground truth for correctness — never credit code as correct that failed it, and never penalise style the language idiom allows.

Rules:
- stages: score clarify, examples, approach, complexity, code, test and follow-up 1–4 against the rubric anchors; a stage never reached scores 0 with evidence "not reached". staffWouldAdd / principalWouldAdd: one concrete sentence or move the candidate could have made at that stage, not "more depth".
- TAUGHT MATERIAL IS NOT EVIDENCE. Turns marked [TAUGHT: …] are coaching; what the candidate does with it afterwards shows listening, not knowledge. Nudges count against "unprompted". List each taught concept in gapsTaught.
- coding.patternMissed: true when the candidate did NOT reach the key pattern or idea of the reference approach on their own — it came from a nudge, a lesson, or never came. false when they found it themselves (even slowly, even if the code then had bugs). patternNote: one sentence naming the pattern and how it was (or was not) reached.
- coding.complexityStated: what the candidate said their final complexity was (or "not stated"); complexityOptimal: the reference approach's time and space.
- GAPS ARE NOT EQUAL. A fact gap (a library call, a language quirk) is a cheap fix and weighs little. A skill gap (no brute force, did not see the pattern, could not derive complexity, did not test, debugged by guessing) is what the level is judged on.
- verdict: below / at / above the stated level overall. Failing hidden tests at the end is a heavy weight against "at"; a correct solution reached only with the pattern handed over is at best "below" at Staff.
- conceptObservations: the concepts the transcript gives evidence on, each nailed / weak / missing.
- drills: 3 to 6 short drills, most valuable first, each one concept — something they can do in a few minutes ("Say the brute force for this problem and its complexity in two sentences before touching the editor"), plus why.
- gaps: every fact or reasoning move the INTERVIEWER handed over that is NOT already in RECORDED GAPS — including inside a nudge or an answer. Each with type, title (a self-contained drill-card question naming the problem's shape), answer (two to four sentences) and the interviewer turn.
- summary: three or four sentences — correctness, the skill gaps as practice areas, the fact gaps as cheap fixes.

Return the grade by calling emit_mock_grade exactly once.`;

const RUBRIC_TEXT: Readonly<Record<MockLevel, string>> = {
  senior: rubric('Senior', 'a correct, clean solution at the optimal complexity, found with at most one nudge, tested by tracing'),
  staff: rubric(
    'Staff',
    'everything Senior needs, driven by the candidate: clarifies before coding, states brute force and why it is not enough, names the pattern unprompted, derives complexity, tests edge cases without being asked, and reasons about the follow-up at system scale (memory, streaming, distribution)'
  ),
  principal: rubric(
    'Principal',
    'everything Staff needs, plus a crisp follow-up answer that weighs alternatives against real constraints and names what would change in production'
  ),
};

function rubric(label: string, bar: string): string {
  return [
    `RUBRIC — live coding, graded at ${label}.`,
    `The bar at this level: ${bar}.`,
    'Anchors per stage:',
    '  1  missing or wrong (no clarifying questions, no example, jumped to code, wrong complexity, did not test).',
    '  2  present only when prompted, or partly right.',
    '  3  done unprompted and right, at the bar.',
    '  4  as 3, concise and narrated, with the trade-off or edge case volunteered before it was asked.',
    'code: 1 does not run or is far off; 2 runs with real bugs; 3 correct (hidden tests pass) and readable; 4 as 3, idiomatic, well named, no wasted work.',
    'follow-up: 0 when the interview never got there; 1 no idea; 2 an idea with no trade-off; 3 a sound adaptation with its cost; 4 as 3, with alternatives weighed.',
  ].join('\n');
}

// ===========================================================================
// The editor, rendered once into a candidate turn
// ===========================================================================

/** A short stable hash of a code buffer (line endings normalised). */
export function hashCode(code: string): string {
  return createHash('sha1').update(code.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

/** The [editor] block: the code fenced, capped at MOCK_EDITOR_CHARS. */
export function renderEditorBlock(code: string, language: string): string {
  const text = code.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  const lines = text ? text.split('\n').length : 0;
  let body = text;
  let note = '';
  if (body.length > MOCK_EDITOR_CHARS) {
    const cut = body.length - MOCK_EDITOR_CHARS;
    body = body.slice(0, MOCK_EDITOR_CHARS);
    note = `\n… (${cut} more characters not shown)`;
  }
  // A fence the code itself cannot close.
  const fence = body.includes('```') ? '````' : '```';
  return `[editor — the candidate's code now (${language}, ${lines} line${lines === 1 ? '' : 's'}); changed since you last saw it]\n${fence}${language}\n${body}${note}\n${fence}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A client-sent run summary, validated. Null when absent or malformed. */
export function coerceRunSummary(raw: unknown): MockRunSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'run' && r.kind !== 'submit') return null;
  const n = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? Math.min(x as number, 10_000) : null);
  const passed = n(r.passed);
  const total = n(r.total);
  if (passed === null || total === null || typeof r.verdict !== 'string') return null;
  return {
    kind: r.kind,
    verdict: clip(r.verdict.replace(/[^a-z_]/gi, ''), 40) || 'unknown',
    passed: Math.min(passed, total),
    total,
    ...(typeof r.firstFailure === 'string' && r.firstFailure.trim()
      ? { firstFailure: clip(r.firstFailure.replace(/\s+/g, ' ').trim(), 240) }
      : {}),
  };
}

/** The one-line [run] result. */
export function renderRunLine(r: MockRunSummary): string {
  const what = r.kind === 'submit' ? 'Submit (hidden tests)' : 'Run (sample tests)';
  const fail = r.firstFailure && r.passed < r.total ? ` — first failure: ${r.firstFailure}` : '';
  return `[run: ${what}: ${r.passed}/${r.total} passed, ${r.verdict.replace(/_/g, ' ')}${fail}]`;
}

/**
 * What a coding turn adds to the candidate's message, and the state it moves.
 * The editor appears only when its hash differs from what the interviewer last
 * saw; the run line only when it differs from the last one shown.
 */
export function codingTurnExtras(
  input: { code?: string; lastRun?: MockRunSummary | null },
  coding: MockCodingState
): { parts: string[]; patch: Partial<MockCodingState> } {
  const parts: string[] = [];
  const patch: Partial<MockCodingState> = {};
  if (typeof input.code === 'string') {
    const h = hashCode(input.code);
    if (h !== coding.codeHash) {
      parts.push(renderEditorBlock(input.code, coding.language));
      patch.codeHash = h;
      patch.lastCode = input.code;
    }
  }
  if (input.lastRun) {
    const line = renderRunLine(input.lastRun);
    const h = hashCode(line);
    if (h !== coding.runHash) {
      parts.push(line);
      patch.runHash = h;
    }
  }
  return { parts, patch };
}

// ===========================================================================
// Start: the problem
// ===========================================================================

const isTopic = (x: unknown): x is Topic => typeof x === 'string' && (TOPICS as readonly string[]).includes(x);
const isDifficulty = (x: unknown): x is Difficulty =>
  typeof x === 'string' && (DIFFICULTIES as readonly string[]).includes(x);

/** The start request's coding options, validated. Unknown values fall back, never 400. */
export function coerceCodingOptions(raw: unknown): Required<Pick<CodingMockOptions, 'mode' | 'difficulty'>> & { topic?: Topic } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const topic = isTopic(o.topic) ? o.topic : undefined;
  const mode = o.mode === 'pick' && topic ? 'pick' : 'weakest';
  return {
    mode,
    difficulty: isDifficulty(o.difficulty) ? o.difficulty : DEFAULT_CODING_DIFFICULTY,
    ...(mode === 'pick' ? { topic } : {}),
  };
}

/**
 * The weakest topic from skill_state rows: a recent failure first, then the
 * lowest clean-solve rate, then the lowest box. With no rows at all, `arrays`.
 */
export function weakestTopicOf(
  rows: readonly { topic: string; attempts: number; solved: number; hintsSum: number; box: number; lastResult: string | null }[]
): Topic {
  const seen = rows.filter((r) => isTopic(r.topic) && r.attempts > 0);
  if (!seen.length) return 'arrays';
  const score = (r: (typeof seen)[number]) => (r.solved - 0.5 * r.hintsSum) / r.attempts;
  const sorted = [...seen].sort(
    (a, b) =>
      Number(b.lastResult === 'failed') - Number(a.lastResult === 'failed') ||
      score(a) - score(b) ||
      a.box - b.box ||
      a.topic.localeCompare(b.topic)
  );
  return sorted[0].topic as Topic;
}

/** The problem as the interviewer and grader read it. */
function renderProblem(p: ProblemRecord): string {
  return [
    `Title: ${p.title}`,
    `Language: ${p.language}; the candidate implements \`${p.functionName}\`.`,
    `Topic: ${p.topic}; difficulty: ${p.difficulty}; pattern: ${p.pattern}`,
    'Statement:',
    p.prompt.trim(),
    ...(p.examples.length
      ? ['Examples:', ...p.examples.map((e) => `- input: ${e.input} → output: ${e.output}${e.explanation ? ` (${e.explanation})` : ''}`)]
      : []),
    ...(p.constraints.length ? ['Constraints:', ...p.constraints.map((c) => `- ${c}`)] : []),
    'Starter code (what the editor opens with):',
    '```' + p.language,
    p.starterCode.trim(),
    '```',
  ].join('\n');
}

function renderReference(p: ProblemRecord): string {
  return ['```' + p.language, p.referenceSolution.trim(), '```'].join('\n');
}

/** The frozen setup message: the problem, then the reference for the interviewer only. */
export function buildCodingContext(level: MockLevel, prep?: MockPrep): string {
  const p = prep?.problem;
  return [
    'MOCK SETUP',
    'Interview: live coding',
    `Level the candidate is interviewing for: ${MOCK_LEVEL_LABEL[level]}`,
    `Time budget: ${INFO.minutes} minutes, at most ${INFO.turnCap} candidate turns.`,
    '',
    'THE PROBLEM (the candidate sees this same statement beside their editor):',
    p ? renderProblem(p) : '(problem unavailable)',
    '',
    'REFERENCE SOLUTION — FOR YOU ONLY. Never show, paste, paraphrase line by line or hint at its code; never name its pattern before the candidate does (teach mode excepted, and even then use your own toy example, not this code):',
    p ? renderReference(p) : '(none)',
    '',
    'Begin: give your opening (mode interview, stage clarify) — introduce yourself in a sentence, point them at the problem beside the editor, and ask them to talk you through their understanding of it.',
  ].join('\n');
}

/** The grader's frozen block: the problem and the reference. The test result is added at End. */
export function renderCodingGraderBase(p: ProblemRecord): string {
  return [
    'PROBLEM',
    renderProblem(p),
    '',
    'REFERENCE SOLUTION',
    renderReference(p),
    `Hidden tests: ${p.hiddenTests.length}.`,
  ].join('\n');
}

/** Pick the topic, fetch the problem through the injected bank, freeze it. Never a model call here. */
async function prepareCoding(args: MockPrepareArgs): Promise<MockPrep> {
  if (!args.coding) throw new Error('coding mock: no problem source was supplied');
  const opts = coerceCodingOptions(args.options);
  const topic = opts.mode === 'pick' && opts.topic ? opts.topic : args.coding.weakestTopic();
  const problem = await args.coding.fetchProblem(topic, opts.difficulty);
  const coding: MockCodingState = {
    problemId: problem.id,
    title: problem.title,
    topic: problem.topic,
    difficulty: problem.difficulty,
    pattern: problem.pattern,
    language: problem.language,
    chosenBy: opts.mode,
    starterHash: hashCode(problem.starterCode),
    codeHash: hashCode(problem.starterCode),
    lastCode: null,
    runHash: null,
    submits: 0,
    lastSubmit: null,
  };
  return {
    graderContext: renderCodingGraderBase(problem),
    reasons: opts.mode === 'weakest' ? { [problem.topic]: ['weakest topic in your skill state'] } : {},
    coding,
    brief: `${problem.title} (${problem.difficulty})`,
    problem,
  };
}

// ===========================================================================
// End: the hidden-test result, then the grade's side effect
// ===========================================================================

/** A sandbox result as a mock stores it: counts and failing names, never values. */
export function toCodeResult(r: RunResult, code: string, at: Date): MockCodeResult {
  return {
    verdict: r.verdict,
    passed: r.passed,
    total: r.total,
    failing: r.results.filter((t) => !t.passed).slice(0, 5).map((t) => clip(t.name, 80)),
    codeHash: hashCode(code),
    at: at.toISOString(),
  };
}

function renderFinal(c: MockCodingState | undefined): string {
  const f = c?.final;
  const head = 'HIDDEN-TEST RESULT AT THE END (server-recorded ground truth)';
  if (!c) return `${head}\nunavailable.`;
  const submits = `Mock Submits during the interview: ${c.submits}.`;
  if (!f) return `${head}\nnone — the candidate never changed the starter code, so nothing ran.\n${submits}`;
  if (f.error) return `${head}\nthe sandbox could not run the final code (${f.error}). Judge correctness from the code itself.\n${submits}`;
  return [
    head,
    `${f.passed}/${f.total} passed, ${f.verdict.replace(/_/g, ' ')} — ${
      f.source === 'submit' ? "from the candidate's last Submit (the code had not changed since)" : 'the final editor contents, run at End'
    }.`,
    ...(f.failing.length ? [`Failing tests: ${f.failing.join(', ')}.`] : []),
    submits,
  ].join('\n');
}

async function finalizeCoding(
  state: MockState,
  end: { code?: string },
  deps: { runHidden(problemId: string, code: string): Promise<RunResult> }
): Promise<MockState> {
  const c = state.coding;
  if (!c) return state;
  const code = typeof end.code === 'string' ? end.code : c.lastCode;
  // A re-grade (after grade_failed) of the same code reuses what already ran.
  if (c.final !== undefined && (code === null ? c.final === null : c.final?.codeHash === hashCode(code))) return state;
  const now = new Date();
  let final: MockCodingState['final'] = null;
  if (c.lastSubmit && (code === null || hashCode(code) === c.lastSubmit.codeHash)) {
    final = { ...c.lastSubmit, source: 'submit' };
  } else if (code !== null && code.trim() && hashCode(code) !== c.starterHash) {
    try {
      final = { ...toCodeResult(await deps.runHidden(c.problemId, code), code, now), source: 'end' };
    } catch (err) {
      final = {
        verdict: 'error', passed: 0, total: 0, failing: [], codeHash: hashCode(code), at: now.toISOString(),
        error: clip(err instanceof Error ? err.message : String(err), 200), source: 'end',
      };
    }
  }
  return { ...state, coding: { ...c, final } };
}

function afterGradeCoding(
  state: MockState,
  grade: MockGrade,
  deps: { enqueueReview(problemId: string): void }
): { grade: MockGrade; state: MockState } {
  const c = state.coding;
  if (!c) return { grade, state };
  const g = grade.coding ?? emptyCodingGrade();
  const queue = g.patternMissed;
  if (queue && !c.reviewQueued) deps.enqueueReview(c.problemId);
  const reviewQueued = queue || !!c.reviewQueued;
  return {
    grade: { ...grade, coding: { ...g, tests: c.final ?? null, reviewQueued } },
    state: { ...state, coding: { ...c, reviewQueued } },
  };
}

// ===========================================================================
// The grade tool: the shared shape plus `coding`
// ===========================================================================

export function codingGradeTool(lean: boolean): ToolSpec {
  const base = gradeTool(INFO, lean);
  const schema = base.schema;
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    properties[k] = v;
    if (k === 'stages') {
      properties.coding = {
        type: 'object',
        ...(lean ? {} : { additionalProperties: false }),
        properties: {
          patternMissed: { type: 'boolean', description: 'True when the key pattern did not come from the candidate.' },
          patternNote: { type: 'string' },
          complexityStated: { type: 'string' },
          complexityOptimal: { type: 'string' },
        },
        required: ['patternMissed', 'patternNote', 'complexityStated', 'complexityOptimal'],
      };
    }
  }
  const required = [...(schema.required ?? [])];
  required.splice(required.indexOf('stages') + 1, 0, 'coding');
  return { ...base, schema: { ...schema, properties, required } };
}

function emptyCodingGrade(): MockCodingGrade {
  return { patternMissed: false, patternNote: '', complexityStated: '', complexityOptimal: '', tests: null, reviewQueued: false };
}

export function coerceCodingGrade(raw: unknown): MockCodingGrade {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : '');
  return {
    patternMissed: r.patternMissed === true,
    patternNote: s(r.patternNote, 600),
    complexityStated: s(r.complexityStated, 120) || 'not stated',
    complexityOptimal: s(r.complexityOptimal, 120),
    tests: null,
    reviewQueued: false,
  };
}

const base = coercers(INFO);

export const CODING_SPEC: MockKindSpec = {
  kind: 'coding',
  info: INFO,
  interviewerSystem: CODING_INTERVIEWER_SYSTEM,
  interviewerTool: interviewerTool(INFO),
  prepare: prepareCoding,
  buildContext: (_prompt: MockPrompt, level, prep) => buildCodingContext(level, prep),
  nearlyOutNote: `[server: nearly out of time — if there is no working solution yet, help them prioritise one; otherwise move to the follow-up and start wrapping up.]`,
  gradeSystem: CODING_GRADE_SYSTEM,
  gradeTool: codingGradeTool(false),
  gradeToolLean: codingGradeTool(true),
  rubric: (level) => RUBRIC_TEXT[level],
  graderContext: (state) => [state.graderContext ?? '', renderFinal(state.coding)].filter(Boolean).join('\n\n'),
  finalize: finalizeCoding,
  afterGrade: afterGradeCoding,
  coerceReply: base.coerceReply,
  coerceObservations: base.coerceObservations,
  coerceGrade: (input, level, degraded) => ({
    ...base.coerceGrade(input, level, degraded),
    coding: coerceCodingGrade(input.coding),
  }),
};
