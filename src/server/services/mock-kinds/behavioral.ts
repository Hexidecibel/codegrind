// =============================================================================
// mock-kinds/behavioral — the Staff behavioral interview, as a spec
// =============================================================================
// Intro ("tell me about yourself") → four questions, each probed two to four
// levels deep → wrap. The four competencies are planned at start
// (story-bank.planBehavioral) and frozen into the first user message.
//
// WHO SEES WHAT:
//   interviewer  the plan only — competencies and questions. Never the story
//                bank: a real interviewer has not read your stories, and one
//                that had would lead you to them.
//   grader       the plan's transcript PLUS the story bank as it was at start
//                (state.graderContext, appended by llm.gradeMock after the
//                rubric) — to judge story choice, missing numbers and
//                overclaiming against caveats.
//
// INTERVIEWER_SYSTEM is a constant, like system design's: everything per-mock
// is in the context message, so the cached prefix is shared across mocks.
//
// The grade adds two things to the shared emit_mock_grade shape: `questions`
// (per question: STAR, scope, I-vs-we, numbers, length, story fit, fidelity)
// and `storyGaps` (competencies with no good story → resume-builder's Capture).

import { MOCK_LEVEL_LABEL, type MockLevel } from '../../../shared/sd.js';
import { MOCK_KIND_INFO, type MockConcept, type MockPrompt } from '../../../shared/mock-kinds.js';
import {
  BQ_QUESTION_STAGES,
  BQ_STAGES,
  competencyLabel,
} from '../../../shared/behavioral-questions.js';
import type { MockGrade, MockQuestionGrade } from '../../../shared/mock.js';
import type { ToolSpec } from '../llm.types.js';
import { bankStatus, fetchStoryBank, planBehavioral, renderGraderContext } from '../story-bank.js';
import { CARD_FRONT_STYLE, coercers, gradeTool, interviewerTool } from './common.js';
import type { MockKindSpec, MockPrep, MockPrepareArgs } from './types.js';

const INFO = MOCK_KIND_INFO.behavioral;

export const BEHAVIORAL_INTERVIEWER_SYSTEM = `You are a senior engineering leader running a live behavioral interview over chat for a Staff-level role. You are realistic: warm but probing. You ask one question at a time, listen, and dig. You have NOT seen the candidate's résumé stories — everything you know about their work comes from what they tell you here. Keep each message short — usually one to three sentences, ending with one question.

STAGES, in order: ${BQ_STAGES.join(' → ')}.
- intro: open with "tell me about yourself" (in your own words). At most one follow-up, then move to q1.
- q1..q4: the MOCK SETUP message gives one competency and one question per stage. Ask that question (you may rephrase it to sound natural; keep its competency). After the candidate's story, PROBE two to four levels deep before moving on. Good probes, pick what the answer is missing:
  - "What did YOU specifically do?" — when they say "we" and their own part is unclear.
  - "How did you get buy-in?" / "Who disagreed, and how did you bring them along?" — for anything that needed other people.
  - "What was the measurable result?" — when there is no number or no outcome.
  - "What would you do differently?" / "What did you learn?" — once the story is told.
  - "Why was that the right call at the time — what did you trade away?" — for decisions.
  - "How big was this — how many teams, people, users, dollars?" — when scope is unclear.
  Move to the next stage after two to four probes, or sooner if the answer is complete and time is short.
- wrap: ask whether they have questions for you; answer one briefly and honestly as an interviewer would, then close.
Report the stage your reply belongs to, and every stage adequately covered so far. A question stage is covered once its story was told and probed.

MODES (pick one per reply):
- interview: the normal case — ask, probe, move on.
- nudge: they are stuck finding a story, or rambling without one. Point the way with a question ("think of a time a decision of yours was challenged by someone senior — anything come to mind?"). Never supply a story.
- offer_teach: they keep missing the same thing (no result, all "we", no structure). Say briefly what you noticed and OFFER a short tip; the app shows "Teach me" and "Keep going". Fill teach.concept with the competency of the current question.
- teach: break out of interviewer character and coach. Use this when the candidate asks ("how should I structure this?", "what are you looking for?") or a [control: TEACH ME] line arrives. Short markdown: what a Staff answer to THIS question does (lead with the result in one sentence, then situation and task in two, most of the time on what YOU did and how you brought people along, close with the number and what you would change), at most ~200 words. Then "Back to the interview:" and the question that resumes. Fill teach.concept, teach.gapSummary and resumePoint. Never invent a story for them.
- wrap_up: only after a [control: END] line, or when every stage is covered. One or two sentences closing the interview. No new question.

LINES THE APP ADDS TO THE CANDIDATE'S MESSAGES — they come from the app, not the candidate; never quote them back:
- [server: …] facts: the clock, the turn count, the current stage, stages the server noticed were skipped, a time warning.
- [control: …] a button the candidate pressed (TEACH ME, I'M STUCK, MOVE ON, KEEP GOING) or END. Obey it. MOVE ON means go to the next question stage.

ANSWER BEFORE YOU REDIRECT. When the candidate asks you something ("do you want the technical detail or the people side?", "is it OK if this was at a smaller company?"), your reply OPENS by answering it in one sentence, then continues. Never ignore an explicit question.

GAPS: list in gaps every piece of coaching YOU handed over in this reply (teach mode, or a tip inside a nudge): type skill for a delivery move ("lead with the result", "say I, not we", "close with the number"); type fact only for a concrete fact about how interviews work that they did not know. title: the drill-card front — the interview question it applies to, worded as the interviewer would ask it (${CARD_FRONT_STYLE}); answer: two to four sentences of the coaching. An empty list when you handed nothing over — probing is not handing over.

OBSERVATIONS: on every reply, record what the candidate's LAST message showed about the competencies in the closed list — nailed (clear, owned, quantified, at Staff scope), weak (partly, vague, or only when probed), missing (the question called for it and it was not there). Usually the current question's competency; another only when the answer clearly showed it. Zero observations is fine.

STYLE: plain language, no headings or bullets in interview mode. Do not praise every answer and do not summarise their story back to them. Do not accept a hypothetical ("I would…") as a story — ask for a real time. Do not lead them toward an answer.

Return every reply by calling the interviewer_turn tool exactly once. The candidate sees only "say".`;

export const BEHAVIORAL_GRADE_SYSTEM = `You grade a completed behavioral mock interview at a stated level. You are the hiring-committee reviewer, not the interviewer: be specific, cite what the candidate said (by turn number), and be honest about the level.

You also have the candidate's STORY BANK (after the rubric) — the stories they have prepared, with confirmed facts, numbers, caveats and open questions. The interviewer never saw it. Use it to judge story choice and fidelity, never to credit something the candidate did not say.

Rules:
- stages: score intro, q1..q4 and wrap 1–4 against the rubric anchors; a stage never reached scores 0 with evidence "not reached". A question stage's score covers the first answer AND the probes. staffWouldAdd / principalWouldAdd: one concrete sentence the candidate could have said at that stage, not "more depth".
- questions: one entry per question stage the interview reached (q1..q4), in order:
  - question: as the interviewer asked it; concept: its competency.
  - storyId: the bank story the answer told, or null (a story not in the bank, no story, or the bank was unavailable). storyFit: how well that story fits the competency — strong / ok / weak / none. If a better-fitting bank story existed, say which in fix.
  - star: whether the answer (before probing) gave a situation, the task, the candidate's own actions, and a result.
  - scope: 1–4, the scope and impact of the story against the level's bar (Staff: beyond one team, a lasting change, a decision with consequences).
  - ownership: "i" when the candidate's own actions are clear, "we" when they hid behind the team, "mixed".
  - quantified: whether the result had a number (time, money, people, users, incidents, percent).
  - words: the word count of the candidate's FIRST answer to the question, from the (N words) marks in the transcript. length: short under ~180 words, ok ~180–400, long over ~400 (aim: about two minutes spoken, 250–350 words).
  - fidelity: against the bank — numbers the bank has that the answer left out, claims past a caveat (overclaiming), answers to an OPEN QUESTION stated as fact. Empty string when clean or when there is no bank story.
  - fix: the single change that would most improve this answer, as a sentence they could say ("Open with: 'We cut hosting cost about 90%, and here is how I got there.'").
- TAUGHT MATERIAL IS NOT EVIDENCE. Turns marked [TAUGHT: …] are coaching; an answer improved right after it shows listening, not skill. List each taught competency in gapsTaught.
- I-vs-WE matters at Staff. A story where the candidate's own decisions and influence are invisible is below level however big the project was.
- GAPS ARE NOT EQUAL. A fact gap (a number from the bank left out) is a cheap fix and weighs little. A skill gap (no result, no ownership, no buy-in story, rambling) is what the level is judged on.
- verdict: below / at / above the stated level overall.
- conceptObservations: the competencies the transcript gives evidence on, each nailed / weak / missing.
- drills: 3 to 6 short drills, most valuable first, each one competency — a prompt they can rehearse in a few minutes ("Tell the saas-rebuild story in 90 seconds, leading with the cost number"), plus why.
- gaps: AT MOST ONE per question stage (the drill card for that question), and only when the answer fell short. type: skill or fact, whichever was the bigger miss. title: the question exactly as asked (the card front). answer: "Best story: <story id> (<title>)." then three beats — "1) … 2) … 3) …" — the result-first outline of how to tell it, using ONLY confirmed bank material (never an open question), then one line naming the fix. With no fitting bank story, write "Best story: none in the bank yet" and three beats of what such a story needs. turn: the interviewer turn that asked it. Do not repeat anything in RECORDED GAPS.
- storyGaps: competencies the interview asked about (or the bank's coverage shows) where the candidate has NO good story — the bank has none that fits, or the one they told fits weakly. One short note each saying what kind of story to capture. Empty when the bank was unavailable.
- summary: three or four sentences — the overall picture, the skill gaps as practice areas, the fact gaps as cheap fixes.

Return the grade by calling emit_mock_grade exactly once.`;

const RUBRIC_TEXT: Readonly<Record<MockLevel, string>> = {
  senior: rubric('Senior', 'a story owned within one team, with clear personal actions and a concrete result'),
  staff: rubric(
    'Staff',
    'a story whose scope crosses teams or lasts years: the candidate set direction or changed how others worked without relying on authority, made a decision with real trade-offs, and can name the measurable result and what they would change'
  ),
  principal: rubric(
    'Principal',
    'a story that changed an organization or a company-level outcome: direction set across many teams, executives persuaded, a lasting mechanism left behind'
  ),
};

function rubric(label: string, bar: string): string {
  return [
    `RUBRIC — behavioral, graded at ${label}.`,
    `The bar for a question stage at this level: ${bar}.`,
    'Anchors for a question stage (q1..q4):',
    '  1  no real story (hypothetical, generic, or not about the competency), or no result.',
    '  2  a real story, but the candidate\'s own role or the result stayed vague even after probing; scope below the bar.',
    '  3  a clear STAR story at the bar: own actions explicit, result stated (ideally with a number), probes answered concretely.',
    '  4  as 3, told result-first in about two minutes, with the trade-off and the lesson volunteered before being probed.',
    'intro: 1 a career recital; 2 chronological but long; 3 present → past → why this role in about two minutes; 4 as 3, with one memorable proof point and a clear "what I want next".',
    'wrap: 1 no questions; 2 generic questions; 3 questions that show they thought about the role; 4 as 3, tied to something said in the interview.',
  ].join('\n');
}

/** The frozen setup message. The plan only — never the story bank. */
export function buildBehavioralContext(level: MockLevel, prep?: MockPrep): string {
  const items = prep?.plan?.items ?? [];
  return [
    'MOCK SETUP',
    'Interview: behavioral',
    `Level the candidate is interviewing for: ${MOCK_LEVEL_LABEL[level]}`,
    `Time budget: ${INFO.minutes} minutes, at most ${INFO.turnCap} candidate turns. Roughly: intro 4 minutes, each question 7 minutes, wrap 3.`,
    'Plan:',
    '- intro: "Tell me about yourself."',
    ...items.map((i) => `- ${i.stage}: competency ${i.concept} (${competencyLabel(i.concept)}). Ask: "${i.question}"`),
    '- wrap: their questions for you, then close.',
    '',
    'Begin: give your opening (mode interview, stage intro).',
  ].join('\n');
}

/** Read the bank, plan the four questions, render the grader's block. Never a model call. */
async function prepareBehavioral(args: MockPrepareArgs): Promise<MockPrep> {
  const bank = await fetchStoryBank(args.fetchImpl);
  const plan = planBehavioral({
    bank: bank.ok ? bank.bank : null,
    history: args.history,
    recentQuestionIds: args.recentQuestionIds,
    requested: args.requested,
    rand: args.rand,
  });
  return {
    plan: { items: plan.items, storyBank: bankStatus(bank) },
    graderContext: renderGraderContext(bank),
    reasons: plan.reasons,
  };
}

// ===========================================================================
// The grade tool: the shared shape plus `questions` and `storyGaps`
// ===========================================================================

function questionItem(lean: boolean) {
  const closed = lean ? {} : { additionalProperties: false };
  return {
    type: 'object',
    ...closed,
    properties: {
      stage: { type: 'string', enum: [...BQ_QUESTION_STAGES] },
      concept: { type: 'string', enum: [...INFO.concepts] },
      question: { type: 'string' },
      storyId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      storyFit: { type: 'string', enum: ['strong', 'ok', 'weak', 'none'] },
      star: {
        type: 'object',
        ...closed,
        properties: {
          situation: { type: 'boolean' },
          task: { type: 'boolean' },
          action: { type: 'boolean' },
          result: { type: 'boolean' },
        },
        required: ['situation', 'task', 'action', 'result'],
      },
      scope: { type: 'integer', description: '1 to 4 against the level bar.' },
      ownership: { type: 'string', enum: ['i', 'we', 'mixed'] },
      quantified: { type: 'boolean' },
      words: { type: 'integer', description: 'Word count of the first answer, from the transcript marks.' },
      length: { type: 'string', enum: ['short', 'ok', 'long'] },
      fidelity: { type: 'string', description: 'Against the bank; empty when clean.' },
      fix: { type: 'string' },
    },
    required: [
      'stage', 'concept', 'question', 'storyId', 'storyFit', 'star', 'scope',
      'ownership', 'quantified', 'words', 'length', 'fidelity', 'fix',
    ],
  };
}

export function behavioralGradeTool(lean: boolean): ToolSpec {
  const base = gradeTool(INFO, lean);
  const schema = base.schema;
  // questions and storyGaps go right after stages: the per-question analysis is
  // written before the drills and the cards that are built from it.
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    properties[k] = v;
    if (k === 'stages') {
      properties.questions = {
        type: 'array',
        description: 'One entry per question stage reached, in order.',
        items: questionItem(lean),
      };
      properties.storyGaps = {
        type: 'array',
        description: 'Competencies with no good story in the bank. Empty when the bank was unavailable.',
        items: {
          type: 'object',
          ...(lean ? {} : { additionalProperties: false }),
          properties: {
            concept: { type: 'string', enum: [...INFO.concepts] },
            note: { type: 'string' },
          },
          required: ['concept', 'note'],
        },
      };
    }
  }
  const required = [...(schema.required ?? [])];
  required.splice(required.indexOf('stages') + 1, 0, 'questions', 'storyGaps');
  return { ...base, schema: { ...schema, properties, required } };
}

// ===========================================================================
// Coercion
// ===========================================================================

const base = coercers(INFO);
const isConcept = (x: unknown): x is MockConcept => typeof x === 'string' && INFO.concepts.includes(x);
const pick = <T extends string>(x: unknown, allowed: readonly T[], dflt: T): T =>
  (allowed as readonly string[]).includes(x as string) ? (x as T) : dflt;
const int = (x: unknown, lo: number, hi: number, dflt: number) =>
  Number.isFinite(x as number) ? Math.max(lo, Math.min(hi, Math.round(x as number))) : dflt;

export function coerceQuestions(raw: unknown): MockQuestionGrade[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MockQuestionGrade[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    if (!q || !(BQ_QUESTION_STAGES as readonly string[]).includes(q.stage as string) || seen.has(q.stage as string)) continue;
    if (!isConcept(q.concept)) continue;
    seen.add(q.stage as string);
    const star = (q.star ?? {}) as Record<string, unknown>;
    const storyId = typeof q.storyId === 'string' && q.storyId.trim() ? q.storyId.trim().slice(0, 80) : null;
    out.push({
      stage: q.stage as string,
      concept: q.concept,
      question: typeof q.question === 'string' ? q.question.slice(0, 400) : '',
      storyId,
      storyFit: pick(q.storyFit, ['strong', 'ok', 'weak', 'none'] as const, storyId ? 'ok' : 'none'),
      star: {
        situation: star.situation === true,
        task: star.task === true,
        action: star.action === true,
        result: star.result === true,
      },
      scope: int(q.scope, 1, 4, 1),
      ownership: pick(q.ownership, ['i', 'we', 'mixed'] as const, 'mixed'),
      quantified: q.quantified === true,
      words: int(q.words, 0, 5000, 0),
      length: pick(q.length, ['short', 'ok', 'long'] as const, 'ok'),
      fidelity: typeof q.fidelity === 'string' ? q.fidelity.slice(0, 800) : '',
      fix: typeof q.fix === 'string' ? q.fix.slice(0, 600) : '',
    });
  }
  return out.sort((a, b) => a.stage.localeCompare(b.stage));
}

export function coerceStoryGaps(raw: unknown): { concept: MockConcept; note: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { concept: MockConcept; note: string }[] = [];
  for (const g of raw as Record<string, unknown>[]) {
    if (!g || !isConcept(g.concept) || seen.has(g.concept)) continue;
    seen.add(g.concept);
    out.push({ concept: g.concept, note: typeof g.note === 'string' ? g.note.slice(0, 400) : '' });
  }
  return out;
}

function coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade {
  return {
    ...base.coerceGrade(input, level, degraded),
    questions: coerceQuestions(input.questions),
    storyGaps: coerceStoryGaps(input.storyGaps),
  };
}

export const BEHAVIORAL_SPEC: MockKindSpec = {
  kind: 'behavioral',
  info: INFO,
  interviewerSystem: BEHAVIORAL_INTERVIEWER_SYSTEM,
  interviewerTool: interviewerTool(INFO),
  prepare: prepareBehavioral,
  buildContext: (_prompt: MockPrompt, level, prep) => buildBehavioralContext(level, prep),
  nearlyOutNote: `[server: nearly out of time — finish the current question's probes, skip any question not started, and go to wrap.]`,
  gradeSystem: BEHAVIORAL_GRADE_SYSTEM,
  gradeTool: behavioralGradeTool(false),
  gradeToolLean: behavioralGradeTool(true),
  rubric: (level) => RUBRIC_TEXT[level],
  graderContext: (state) => state.graderContext ?? null,
  coerceReply: base.coerceReply,
  coerceObservations: base.coerceObservations,
  coerceGrade,
};
