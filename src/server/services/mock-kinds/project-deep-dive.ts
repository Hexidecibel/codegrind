// =============================================================================
// mock-kinds/project-deep-dive — the Staff project deep-dive, as a spec (Phase H4)
// =============================================================================
// The candidate picks ONE project (a story-bank story, a master-resume line, or
// a typed one-liner). The interviewer drills about five levels into it:
// overview → architecture → alternatives → hardest problem → failure → numbers
// → alignment → retro.
//
// WHO SEES WHAT:
//   interviewer  the project's title and the one line a real interviewer would
//                have from the resume. Never the story bank: the candidate tells
//                the project; the interviewer asks.
//   grader       the transcript PLUS the story bank and the master resume as
//                they were at start (state.graderContext), to flag every claim
//                not in confirmed material — the same fidelity rule as the
//                behavioral grader.
//
// INTERVIEWER_SYSTEM is a constant (the cached prefix is shared across mocks).

import { MOCK_LEVEL_LABEL, type MockLevel } from '../../../shared/sd.js';
import { MOCK_KIND_INFO, type MockConcept, type MockPrompt } from '../../../shared/mock-kinds.js';
import { DD_STAGES, DD_TYPED_MAX, type DdProjectChoice, type DdProjectOption } from '../../../shared/deep-dive.js';
import type { MockGrade } from '../../../shared/mock.js';
import type { ToolSpec } from '../llm.types.js';
import {
  CANDIDATE_KNOWN_FACTS,
  fetchMasterResume,
  fetchStoryBank,
  renderResumeForGrader,
  renderStoryForGrader,
  type MasterResume,
  type ResumeResult,
  type StoryBank,
  type StoryBankResult,
} from '../story-bank.js';
import { CARD_FRONT_STYLE, coercers, gradeTool, interviewerTool } from './common.js';
import { MockPrepError, type MockKindSpec, type MockPrep, type MockPrepareArgs } from './types.js';

const INFO = MOCK_KIND_INFO['project-deep-dive'];

export const DEEP_DIVE_INTERVIEWER_SYSTEM = `You are a principal engineer running a live PROJECT DEEP-DIVE interview over chat for a Staff-level role. The candidate has picked one project they know well. Your job is to find out whether they really drove it and understand it to the bottom: you drill about five levels deep, always following the most interesting thread in what they just said. You are realistic, curious and skeptical, never hostile. Keep each message short — usually one to three sentences, ending with ONE question.

STAGES, in order: ${DD_STAGES.join(' → ')}.
- overview: "Walk me through it" — the problem, their role, the outcome, in about two minutes. At most one follow-up.
- architecture: why it is built the way it is. Make them name the components and the forces (load, cost, team, deadline) that shaped them. Ask "why" at least twice.
- alternatives: what else was on the table, and what they gave up by not choosing it. A design with no alternative considered is a red flag — probe it.
- hardest-problem: the hardest technical problem, drilled until the detail runs out: what made it hard, what they tried first, what failed, what worked, how they knew.
- failure: something that broke or went wrong (an incident, a wrong call, a slip). What did THEY do, what changed afterwards. Credit honesty, not heroics.
- numbers: scale, cost, latency, data size, team size, time. Ask for the number whenever a claim has none.
- alignment: how they got others — peers, other teams, leadership — to agree, adopt or fund it. Who disagreed, and how was it settled?
- retro: what they would do differently today, and why.
Move on when a stage is covered or time demands it; you may revisit. Report the stage your reply belongs to, and every stage adequately covered so far.

DRILLING: follow their last answer. When they say "we", ask what THEY did. When a claim is vague ("it scaled well"), ask for the number or the mechanism. When they name a decision, ask what it cost. Never accept a hypothetical ("I would…") as what happened — ask what actually happened.

MODES (pick one per reply):
- interview: the normal case — ask, drill, move on.
- nudge: they are stuck or wandering. Point the way with a question. Never supply facts about their project.
- offer_teach: they keep missing the same thing (no numbers, all "we", no alternatives). Say briefly what you noticed and OFFER a short tip; the app shows "Teach me" and "Keep going". Fill teach.concept.
- teach: break out of character and coach, when asked or on a [control: TEACH ME] line: what a Staff answer to THIS part of a deep-dive does, at most ~200 words, then "Back to the interview:" and the question that resumes. Fill teach.concept, teach.gapSummary and resumePoint. Never invent details of their project.
- wrap_up: only after a [control: END] line, or when every stage is covered. One or two sentences closing the interview. No new question.

NEVER INVENT. You know only what the candidate has said here and the one-line project description in the setup. Never state a fact about their project they did not say; never put numbers in their mouth.

LINES THE APP ADDS TO THE CANDIDATE'S MESSAGES — they come from the app, not the candidate; never quote them back:
- [server: …] facts: the clock, the turn count, the current stage, stages the server noticed were skipped, a time warning.
- [control: …] a button the candidate pressed (TEACH ME, I'M STUCK, MOVE ON, KEEP GOING) or END. Obey it. MOVE ON means go to the next stage.

ANSWER BEFORE YOU REDIRECT. When the candidate asks you something ("how deep do you want me to go on the database side?"), open by answering it in one sentence, then continue.

GAPS: list in gaps every piece of coaching YOU handed over in this reply (teach mode, or a tip inside a nudge). type skill for a delivery or reasoning move ("name the alternative you rejected and why", "lead with the number"); type fact only for a concrete fact they did not know. title: the drill-card front — a question an interviewer would ask about THIS project (${CARD_FRONT_STYLE}); answer: two to four sentences of the coaching. An empty list when you handed nothing over — drilling is not handing over.

OBSERVATIONS: on every reply, record what the candidate's LAST message showed about the closed list of concepts (depth, ownership, trade-offs, failure honesty, quantification, alignment, retrospection) — nailed, weak or missing. Zero is fine.

STYLE: plain language, no headings or bullets in interview mode. Do not praise every answer and do not summarise their answer back to them. Do not lead them toward an answer.

Return every reply by calling the interviewer_turn tool exactly once. The candidate sees only "say".`;

export const DEEP_DIVE_GRADE_SYSTEM = `You grade a completed PROJECT DEEP-DIVE mock interview at a stated level. You are the hiring-committee reviewer, not the interviewer: be specific, cite what the candidate said (by turn number), and be honest about the level.

You also have the candidate's STORY BANK and MASTER RESUME (after the rubric), frozen when the mock started. The interviewer never saw them. Use them to check fidelity, never to credit something the candidate did not say.

${CANDIDATE_KNOWN_FACTS}

Rules:
- stages: score each stage 1–4 against the rubric anchors; a stage never reached scores 0 with evidence "not reached". staffWouldAdd / principalWouldAdd: one concrete sentence the candidate could have said at that stage, not "more depth".
- dimensions: one entry per rubric dimension (the closed concept list), score 1–4 with one line of evidence citing turns. Score what the CANDIDATE raised: a point the interviewer raised first and the candidate merely agreed with earns nothing — say who raised it.
- fidelity: every concrete claim (a mechanism, a number, a design detail, a role, a result) checked against the bank and the resume:
  - unverified: the claim is NOT in the confirmed material (confirmed story fields or a resume line). Name it ("'sharded by tenant id' is not in the bank or resume — unverified"). Never credit it as evidence of depth or scope.
  - contradicted: the framing contradicts the material or the confirmed facts above (a new product told as a "migration", a team effort told as solo, a claim past a story's caveat, usage claimed for a product with no customers).
  - open-question: the candidate stated an answer to something the bank lists under OPEN QUESTIONS — say "the bank lists this as unconfirmed — confirm it", without calling it false.
  An empty list only when everything concrete they said was confirmed. With a typed project not in the bank or resume, list the main claims as unverified (nothing could be checked) — that is a note, not a penalty on depth.
- NEVER CREDIT UNVERIFIED CLAIMS when scoring ownership, quantification or depth. An impressive detail the material does not have earns nothing until confirmed.
- TAUGHT MATERIAL IS NOT EVIDENCE. Turns marked [TAUGHT: …] are coaching; list each taught concept in gapsTaught.
- I-vs-WE matters at Staff: a project where the candidate's own decisions are invisible is below level however big it was.
- HONESTY ABOUT FAILURE is a positive signal: a real failure owned with what changed beats a polished story with none.
- verdict: below / at / above the stated level overall.
- conceptObservations: the concepts the transcript gives evidence on, each nailed / weak / missing.
- drills: 3 to 6 short drills, most valuable first, each one concept — something they can rehearse in a few minutes ("Say the one alternative you rejected for the org-node design and what it would have cost"), plus why.
- gaps: AT MOST one per stage, only where the answer fell short, and not anything in RECORDED GAPS. title: the drill-card front — the question an interviewer would ask about this project (${CARD_FRONT_STYLE}); answer: what a strong answer covers, using ONLY confirmed material (never an open question, never an invented number — say "find the number" instead). turn: the interviewer turn that asked it.
- summary: three or four sentences — the overall picture, the skill gaps as practice areas, the fidelity problems as must-fix. Written as the verdict on a FINISHED interview, in the past tense.

Return the grade by calling emit_mock_grade exactly once.`;

const RUBRIC_TEXT: Readonly<Record<MockLevel, string>> = {
  senior: rubric('Senior', 'owned a significant component end to end, explains its design and failure modes concretely, with numbers'),
  staff: rubric(
    'Staff',
    'set the technical direction of a multi-person or multi-team project: explains why the architecture won against named alternatives, owns a real failure and what changed, quantifies scale and impact, and shows how others were brought along without relying on authority'
  ),
  principal: rubric(
    'Principal',
    'shaped a company-level technical direction: the trade-offs span years and teams, the alignment reached leadership, and the mechanism outlived their involvement'
  ),
};

function rubric(label: string, bar: string): string {
  return [
    `RUBRIC — project deep-dive, graded at ${label}.`,
    `The bar at this level: ${bar}.`,
    'Anchors for a stage:',
    '  1  no real answer: generic, hypothetical, or "the team did it".',
    '  2  a real answer that stayed shallow after drilling: no mechanism, no number, or no personal decision.',
    '  3  concrete and owned at the bar: the mechanism, the candidate\'s own decision, a number, answered when drilled.',
    '  4  as 3, volunteered before being drilled, with the trade-off and the cost named.',
    'Dimensions (score each 1–4):',
    '  dd-depth            how far down the detail goes before it runs out',
    '  dd-ownership        the candidate\'s own decisions are visible ("I decided…", not "we did")',
    '  dd-tradeoffs        alternatives named and rejected for stated reasons, with what was given up',
    '  dd-failure-honesty  a real failure owned, with what changed afterwards',
    '  dd-quantification   scale, cost, latency, people and time given as numbers',
    '  dd-alignment        how others were brought along, including disagreement',
    '  dd-retrospection    a specific, reasoned "what I would do differently"',
  ].join('\n');
}

// ===========================================================================
// The project
// ===========================================================================

export interface ResolvedProject {
  source: DdProjectChoice['source'];
  id: string | null;
  title: string;
  /** The one line the interviewer gets (what a real interviewer has from the resume). */
  line: string;
}

/** The start card's options: bank stories, then resume highlights and projects. Pure. */
export function projectOptions(bank: StoryBank | null, resume: MasterResume | null): DdProjectOption[] {
  const out: DdProjectOption[] = [];
  for (const s of bank?.stories ?? []) out.push({ source: 'story', id: s.id, title: s.title, where: s.employer ?? '' });
  for (const e of resume?.experience ?? []) {
    e.highlights.forEach((h, i) => out.push({ source: 'resume', id: `${e.id}#${i}`, title: h, where: e.company }));
  }
  for (const p of resume?.projects ?? []) {
    if (p.id === 'proj-more') continue; // "Other work" is a link, not a project
    out.push({ source: 'resume', id: p.id, title: `${p.name}: ${p.description}`, where: 'side project' });
  }
  return out;
}

/** The choice, validated and resolved against the material. Throws MockPrepError on a bad choice. */
export function resolveProject(choice: unknown, bank: StoryBank | null, resume: MasterResume | null): ResolvedProject {
  const c = (choice ?? {}) as Record<string, unknown>;
  if (c.source === 'typed') {
    const text = typeof c.text === 'string' ? c.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length < 8) throw new MockPrepError('Type a one-line description of the project (at least a few words).');
    const line = text.slice(0, DD_TYPED_MAX);
    return { source: 'typed', id: null, title: line.length > 80 ? `${line.slice(0, 77)}…` : line, line };
  }
  const id = typeof c.id === 'string' ? c.id : '';
  if (c.source === 'story') {
    if (!bank) throw new MockPrepError('The story bank is unavailable — pick a resume line or type the project.');
    const s = bank.stories.find((x) => x.id === id);
    if (!s) throw new MockPrepError('That story is not in the bank.');
    return { source: 'story', id: s.id, title: s.title, line: `${s.title}${s.employer ? ` (${s.employer})` : ''}` };
  }
  if (c.source === 'resume') {
    if (!resume) throw new MockPrepError('The master resume is unavailable — pick a story or type the project.');
    const opt = projectOptions(null, resume).find((o) => o.id === id);
    if (!opt) throw new MockPrepError('That resume line is not on the master resume.');
    const short = opt.title.length > 80 ? `${opt.title.slice(0, 77)}…` : opt.title;
    return { source: 'resume', id: opt.id, title: short, line: `${opt.title} (${opt.where})` };
  }
  throw new MockPrepError('Pick a project: a story, a resume line, or a typed one-liner.');
}

/** The frozen setup message. The project line only — never the bank. */
export function buildDeepDiveContext(level: MockLevel, project: Pick<ResolvedProject, 'source' | 'line'>): string {
  return [
    'MOCK SETUP',
    'Interview: project deep-dive',
    `Level the candidate is interviewing for: ${MOCK_LEVEL_LABEL[level]}`,
    `The project they chose: ${project.line}`,
    project.source === 'resume'
      ? '(This line is from their resume — you have read it, as a real interviewer would have.)'
      : '(This is all you know about it — they will tell you the rest.)',
    `Time budget: ${INFO.minutes} minutes, at most ${INFO.turnCap} candidate turns. Roughly 4-5 minutes per stage.`,
    '',
    'Begin: give your opening (mode interview, stage overview).',
  ].join('\n');
}

/** The grader's block: confirmed material, byte-stable for the same bank + resume. */
export function renderDeepDiveGraderContext(project: ResolvedProject, bank: StoryBankResult, resume: ResumeResult): string {
  return [
    `THE PROJECT: ${project.line} [source: ${project.source}${project.id ? `, id ${project.id}` : ''}]`,
    '',
    bank.ok
      ? [
          `STORY BANK (frozen at start — ${bank.bank.stories.length} stories). Material under CONFIRMED is what the candidate has said is true; OPEN QUESTIONS are not facts; caveats say how a story must be told.`,
          '',
          ...bank.bank.stories.map(renderStoryForGrader).flatMap((s) => [s, '']),
        ].join('\n')
      : `STORY BANK: UNAVAILABLE (${bank.error}).`,
    '',
    renderResumeForGrader(resume),
  ].join('\n');
}

async function prepareDeepDive(args: MockPrepareArgs): Promise<MockPrep> {
  const [bank, resume] = await Promise.all([fetchStoryBank(args.fetchImpl), fetchMasterResume(args.fetchImpl)]);
  const project = resolveProject(args.options, bank.ok ? bank.bank : null, resume.ok ? resume.resume : null);
  return {
    graderContext: renderDeepDiveGraderContext(project, bank, resume),
    reasons: {},
    brief: project.title,
    project: { source: project.source, id: project.id, title: project.title, line: project.line },
  };
}

// ===========================================================================
// The grade tool: the shared shape plus `dimensions` and `fidelity`
// ===========================================================================

export function deepDiveGradeTool(lean: boolean): ToolSpec {
  const base = gradeTool(INFO, lean);
  const schema = base.schema;
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    properties[k] = v;
    if (k === 'stages') {
      properties.dimensions = {
        type: 'array',
        description: 'One entry per rubric dimension.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            concept: { type: 'string', enum: [...INFO.concepts] },
            score: { type: 'integer', description: '1 to 4.' },
            note: { type: 'string', description: 'One line of evidence, with turn numbers.' },
          },
          required: ['concept', 'score', 'note'],
        },
      };
      properties.fidelity = {
        type: 'array',
        description: 'Claims checked against the bank and resume. Empty when everything concrete was confirmed.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim: { type: 'string' },
            status: { type: 'string', enum: ['unverified', 'contradicted', 'open-question'] },
            note: { type: 'string' },
          },
          required: ['claim', 'status', 'note'],
        },
      };
    }
  }
  const required = [...(schema.required ?? [])];
  required.splice(required.indexOf('stages') + 1, 0, 'dimensions', 'fidelity');
  return { ...base, schema: { ...schema, properties, required } };
}

const base = coercers(INFO);
const isConcept = (x: unknown): x is MockConcept => typeof x === 'string' && INFO.concepts.includes(x);
const FIDELITY = ['unverified', 'contradicted', 'open-question'] as const;

export function coerceDimensions(raw: unknown): NonNullable<MockGrade['dimensions']> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NonNullable<MockGrade['dimensions']> = [];
  for (const d of raw as Record<string, unknown>[]) {
    if (!d || !isConcept(d.concept) || seen.has(d.concept)) continue;
    seen.add(d.concept);
    const score = Number.isFinite(d.score as number) ? Math.max(1, Math.min(4, Math.round(d.score as number))) : 1;
    out.push({ concept: d.concept, score, note: typeof d.note === 'string' ? d.note.slice(0, 500) : '' });
  }
  // The rubric's order, whatever order they came in.
  return out.sort((a, b) => INFO.concepts.indexOf(a.concept) - INFO.concepts.indexOf(b.concept));
}

export function coerceFidelity(raw: unknown): NonNullable<MockGrade['fidelity']> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<MockGrade['fidelity']> = [];
  for (const f of raw as Record<string, unknown>[]) {
    const claim = typeof f?.claim === 'string' ? f.claim.trim().slice(0, 300) : '';
    if (!claim) continue;
    const status = (FIDELITY as readonly string[]).includes(f.status as string) ? (f.status as (typeof FIDELITY)[number]) : 'unverified';
    out.push({ claim, status, note: typeof f.note === 'string' ? f.note.slice(0, 500) : '' });
  }
  return out.slice(0, 12);
}

function coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade {
  return {
    ...base.coerceGrade(input, level, degraded),
    dimensions: coerceDimensions(input.dimensions),
    fidelity: coerceFidelity(input.fidelity),
  };
}

export const DEEP_DIVE_SPEC: MockKindSpec = {
  kind: 'project-deep-dive',
  info: INFO,
  interviewerSystem: DEEP_DIVE_INTERVIEWER_SYSTEM,
  interviewerTool: interviewerTool(INFO),
  prepare: prepareDeepDive,
  buildContext: (_prompt: MockPrompt, level, prep) =>
    buildDeepDiveContext(level, prep?.project ?? { source: 'typed', line: 'a project of their choice (ask them which)' }),
  nearlyOutNote: `[server: nearly out of time — skip to retro: ask what they would do differently, then close.]`,
  gradeSystem: DEEP_DIVE_GRADE_SYSTEM,
  gradeTool: deepDiveGradeTool(false),
  gradeToolLean: deepDiveGradeTool(true),
  rubric: (level) => RUBRIC_TEXT[level],
  graderContext: (state) => state.graderContext ?? null,
  coerceReply: base.coerceReply,
  coerceObservations: base.coerceObservations,
  coerceGrade,
};
