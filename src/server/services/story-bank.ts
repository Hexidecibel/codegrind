// =============================================================================
// story-bank — the candidate's interview stories, read from resume-builder
// =============================================================================
// The behavioral mock's GRADER judges story choice and fidelity against the
// story bank the user keeps in resume-builder (same host, port 9410). This file
// fetches it, renders it for the grader, maps each story's free-text `fits[]`
// onto the mock's competencies with a keyword table (no model call), and plans
// which four competencies a mock asks about.
//
// WHO SEES THE STORIES: the grader only. The interviewer gets the plan (the
// competencies and questions) and nothing from the bank — a real interviewer
// has not read your stories.
//
// THE RULE, ported from resume-builder's renderStoryForPrompt
// (src/lib/interview.ts): a story's `unconfirmed[]` are OPEN QUESTIONS, never
// facts — rendered under their own heading that says so — and `caveats` say how
// a story must be told. Everything above the OPEN QUESTIONS line may be used;
// nothing below it may.
//
// READ ONLY. Nothing is ever written back to resume-builder; a competency with
// no good story is reported (MockGrade.storyGaps) with a link to its Capture tab.
//
// WHEN IT IS DOWN the mock still starts: the plan is made without the bank, and
// the grader is told the bank was unavailable (and the report says so).
//
// The base URL is a code default with an environment override
// (CODEGRIND_STORY_BANK_URL, set with `Environment=` in the unit — NOT .env,
// which cush-tools' inject truncates to the secrets manifest).

import {
  BQ_COMPETENCIES,
  BQ_QUESTION_STAGES,
  competencyLabel,
  pickQuestion,
  type BqCompetency,
} from '../../shared/behavioral-questions.js';
import type { MockPlan, StoryBankStatus } from '../../shared/mock.js';
import type { ConceptSignal } from '../../shared/sd.js';

export const DEFAULT_STORY_BANK_URL = 'http://127.0.0.1:9410';
const FETCH_TIMEOUT_MS = 2500;

export function storyBankUrl(): string {
  const base = (process.env.CODEGRIND_STORY_BANK_URL || DEFAULT_STORY_BANK_URL).replace(/\/+$/, '');
  return `${base}/api/data/read?file=stories.json`;
}

// -----------------------------------------------------------------------------
// Types — the subset of resume-builder's src/types/story.ts this app reads
// -----------------------------------------------------------------------------

export interface Story {
  id: string;
  title: string;
  employer?: string;
  status: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  complication?: string;
  example?: string;
  principle?: string;
  numbers: string[];
  caveats: string[];
  /** Open questions, NOT facts. */
  unconfirmed: string[];
  fits: string[];
  doesNotFit: string[];
}

export interface StoryGapEntry {
  type: string;
  status: string;
  note?: string;
  resolvedBy?: string;
}

export interface StoryBank {
  stories: Story[];
  gaps: StoryGapEntry[];
}

export type StoryBankResult = { ok: true; bank: StoryBank } | { ok: false; error: string };

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const strs = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [];

/** The parsed file, defensively: a story without an id is dropped, a missing list is empty. */
export function normalizeBank(raw: unknown): StoryBank {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(r.stories)) throw new Error('stories.json has no stories array');
  const stories: Story[] = [];
  for (const s of r.stories as Record<string, unknown>[]) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    stories.push({
      id: s.id,
      title: str(s.title) || s.id,
      ...(str(s.employer) ? { employer: str(s.employer) } : {}),
      status: str(s.status) || 'draft',
      situation: str(s.situation),
      task: str(s.task),
      action: str(s.action),
      result: str(s.result),
      ...(str(s.complication) ? { complication: str(s.complication) } : {}),
      ...(str(s.example) ? { example: str(s.example) } : {}),
      ...(str(s.principle) ? { principle: str(s.principle) } : {}),
      numbers: strs(s.numbers),
      caveats: strs(s.caveats),
      unconfirmed: strs(s.unconfirmed),
      fits: strs(s.fits),
      doesNotFit: strs(s.doesNotFit),
    });
  }
  const gaps: StoryGapEntry[] = [];
  for (const g of (Array.isArray(r.gaps) ? r.gaps : []) as Record<string, unknown>[]) {
    if (!g || !str(g.type)) continue;
    gaps.push({
      type: str(g.type),
      status: str(g.status) || 'open',
      ...(str(g.note) ? { note: str(g.note) } : {}),
      ...(str(g.resolvedBy) ? { resolvedBy: str(g.resolvedBy) } : {}),
    });
  }
  return { stories, gaps };
}

/** GET the bank. Never throws: a down or broken resume-builder is `{ok: false}`. */
export async function fetchStoryBank(fetchImpl: typeof fetch = fetch): Promise<StoryBankResult> {
  try {
    const res = await fetchImpl(storyBankUrl(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `resume-builder answered ${res.status}` };
    return { ok: true, bank: normalizeBank(await res.json()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `resume-builder unreachable (${msg.slice(0, 120)})` };
  }
}

// -----------------------------------------------------------------------------
// fits[] → competencies (a keyword table, no model)
// -----------------------------------------------------------------------------

/**
 * Matched against a lower-cased `fits` / `doesNotFit` / gap phrase. Word-boundary
 * regexes, not substrings ("present" must not match "represent"). The table is
 * tuned on the real bank's phrases; story-bank.test.ts pins the mapping.
 */
export const COMPETENCY_KEYWORDS: Readonly<Record<BqCompetency, readonly RegExp[]>> = {
  ownership: [/\bownership\b/, /\bowned?\b/, /outside your responsibility/, /\bstepp(ed|ing) in\b/, /\binitiative\b/, /\baccountab/, /\bdrove\b/],
  'influence-without-authority': [/\binfluenc/, /\bconvinc/, /\bpersua/, /\bbuy-?in\b/, /without authority/, /changing a long-standing practice/, /\badopted\b/, /\bearning trust\b/],
  conflict: [/\bdisagree/, /\bconflict/, /\bpush(ed|ing)? ?back\b/, /\bpushback\b/],
  'failure-learning': [/\bmistake/, /\bunderestimat/, /\bplan was wrong\b/, /\bfail(ed|ure)?\b/, /\bwent wrong\b/, /\blearn(ed|ing)?\b/, /\bclosest call\b/],
  ambiguity: [/\bambigu/, /\bunclear\b/, /\buncertain/, /\bhypothesis\b/, /\bundefined\b/, /\bobvious causes\b/],
  'growing-others': [/\bmentor/, /\bcoach/, /\bteach/, /\bdevelop engineers\b/, /\bjunior\b/, /\bgrow(ing|th)? (others|engineers|people)\b/],
  'technical-strategy': [/\barchitecture\b/, /\blong-horizon\b/, /\bstrateg/, /\bdesign you are proud\b/, /\btechnical (vision|direction)\b/, /configuration over customization/, /\btechnical challenge\b/],
  prioritization: [/\bpriorit/, /\btrade-?offs?\b/, /\bsaying no\b/, /\bscop(e|ing)\b/],
  'cross-team': [/\bacross team/, /\bcross-team\b/, /\bteam boundaries\b/, /\bother teams\b/, /\bothers adopted\b/],
  'exec-communication': [/\bexecutives?\b/, /\bboard\b/, /\bpresent(ing|ation)?\b/, /\bleadership\b/],
  'delivery-under-pressure': [/\bincident\b/, /\bunder pressure\b/, /\bdeadline/, /\brelease that went wrong\b/, /\bescalation\b/, /\bhardest bug\b/],
  'customer-impact': [/\bcustomers?\b/, /\busers?\b(?! records)/, /\bcost reduction\b/, /\bescalation\b/],
};

/** The competencies one free-text phrase names. */
export function competenciesFor(phrase: string): BqCompetency[] {
  const p = phrase.toLowerCase();
  return BQ_COMPETENCIES.filter((c) => COMPETENCY_KEYWORDS[c].some((re) => re.test(p)));
}

/** A story's competencies: what its fits[] name, minus anything its doesNotFit[] names. */
export function storyCompetencies(story: Pick<Story, 'fits' | 'doesNotFit'>): BqCompetency[] {
  const yes = new Set(story.fits.flatMap(competenciesFor));
  const no = new Set(story.doesNotFit.flatMap(competenciesFor));
  return BQ_COMPETENCIES.filter((c) => yes.has(c) && !no.has(c));
}

/** competency → ids of the stories that fit it (confirmed first). */
export function competencyCoverage(bank: StoryBank): Record<BqCompetency, string[]> {
  const out = Object.fromEntries(BQ_COMPETENCIES.map((c) => [c, [] as string[]])) as Record<BqCompetency, string[]>;
  const ordered = [...bank.stories].sort((a, b) => Number(b.status === 'confirmed') - Number(a.status === 'confirmed'));
  for (const s of ordered) for (const c of storyCompetencies(s)) out[c].push(s.id);
  return out;
}

export type GapWeight = 'open' | 'partial';

/** A gap is closed once resolved, or once its status says so. */
function gapState(g: StoryGapEntry): GapWeight | null {
  if (g.resolvedBy) return null;
  const s = g.status.toLowerCase();
  if (/\b(closed|resolved|covered|done)\b/.test(s) && !/\bpart/.test(s)) return null;
  return /\bpart/.test(s) ? 'partial' : 'open';
}

/** Story-bank gaps mapped onto competencies; open beats partial. */
export function gapCompetencies(bank: StoryBank): Map<BqCompetency, GapWeight> {
  const out = new Map<BqCompetency, GapWeight>();
  for (const g of bank.gaps) {
    const w = gapState(g);
    if (!w) continue;
    for (const c of competenciesFor(g.type)) if (out.get(c) !== 'open') out.set(c, w);
  }
  return out;
}

export function bankStatus(r: StoryBankResult): StoryBankStatus {
  if (!r.ok) return { loaded: false, stories: 0, confirmed: 0, openGaps: [], error: r.error };
  return {
    loaded: true,
    stories: r.bank.stories.length,
    confirmed: r.bank.stories.filter((s) => s.status === 'confirmed').length,
    openGaps: r.bank.gaps.filter((g) => gapState(g)).map((g) => `${g.type} (${g.status})`),
  };
}

// -----------------------------------------------------------------------------
// Rendering, for the grader only
// -----------------------------------------------------------------------------

function bulletBlock(label: string, items: string[]): string[] {
  return items.length > 0 ? [`${label}:`, ...items.map((i) => `  - ${i}`)] : [];
}

function fieldLine(label: string, value: string | undefined): string[] {
  return value && value.trim() ? [`${label}: ${value.trim()}`] : [];
}

/**
 * One story, with confirmed content and open questions under separate
 * headings — resume-builder's renderStoryForPrompt, plus the competencies this
 * app mapped it to. Everything above OPEN QUESTIONS may be used; nothing below.
 */
export function renderStoryForGrader(story: Story): string {
  const comps = storyCompetencies(story);
  const lines = [
    `<story id="${story.id}">`,
    `title: ${story.title}`,
    ...fieldLine('employer', story.employer),
    story.status === 'draft'
      ? 'DRAFT, CONFIRMED SO FAR (the only material you may treat as fact; the story is unfinished, so never fill in a missing part):'
      : 'CONFIRMED (the only material you may treat as fact):',
    ...fieldLine('situation', story.situation),
    ...fieldLine('task', story.task),
    ...fieldLine('action', story.action),
    ...fieldLine('result', story.result),
    ...fieldLine('complication', story.complication),
    ...fieldLine('example', story.example),
    ...fieldLine('principle', story.principle),
    ...bulletBlock('numbers', story.numbers),
    ...bulletBlock('how it must be told (caveats — telling it past these is overclaiming)', story.caveats),
    ...bulletBlock('fits questions about', story.fits),
    ...bulletBlock('does NOT fit questions about', story.doesNotFit),
    `competencies (keyword map): ${comps.length ? comps.join(', ') : 'none'}`,
  ];
  if (story.unconfirmed.length > 0) {
    lines.push(
      'OPEN QUESTIONS (NOT facts. Never state, assume or estimate an answer to these, and never put one in a drill card):',
      ...story.unconfirmed.map((u) => `  - ${u}`)
    );
  }
  lines.push('</story>');
  return lines.join('\n');
}

/**
 * The block appended to the grader's request (frozen into mocks.state at
 * start). Byte-stable for a given bank.
 */
export function renderGraderContext(r: StoryBankResult): string {
  if (!r.ok) {
    return [
      'STORY BANK: UNAVAILABLE',
      `The candidate's story bank (resume-builder) could not be read when this mock started: ${r.error}.`,
      'Judge story choice on the transcript alone. Leave storyId null on every question, do not report fidelity against a bank, and leave storyGaps empty — you cannot know which stories exist. Card backs use the beats the candidate actually told.',
    ].join('\n');
  }
  const { bank } = r;
  const cov = competencyCoverage(bank);
  const confirmed = bank.stories.filter((s) => s.status === 'confirmed').length;
  const gaps = bank.gaps.filter((g) => gapState(g));
  return [
    `STORY BANK (from resume-builder, frozen when this mock started — ${bank.stories.length} stories, ${confirmed} confirmed).`,
    'For judging story choice and fidelity ONLY. The interviewer never saw it. Rules:',
    '- Material under CONFIRMED is what the candidate has said is true. A number there that the answer left out is a fact gap.',
    '- OPEN QUESTIONS are not facts. If the candidate stated an answer to one, say so in fidelity ("stated X, which the bank lists as unconfirmed — confirm it") without calling it false. Never use one in a card back.',
    '- Caveats say how a story must be told. Telling it past a caveat (claiming you initiated what was assigned, a firmer number than the bank allows) is overclaiming — name it in fidelity.',
    '- A story told that is not in the bank is fine; storyId null, judge it on the transcript.',
    '',
    ...(bank.stories.length ? bank.stories.map(renderStoryForGrader).flatMap((s) => [s, '']) : ['(the story bank is empty)', '']),
    'STORY-BANK GAPS the candidate already knows about:',
    ...(gaps.length
      ? gaps.map((g) => `- ${g.type} [${g.status}]${g.note ? ` — ${g.note}` : ''}`)
      : ['- none']),
    '',
    'COVERAGE (keyword map from fits[], a hint not a judgement):',
    ...BQ_COMPETENCIES.map((c) => `- ${c}: ${cov[c].length ? cov[c].join(', ') : 'NO STORY'}`),
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Planning: which four competencies, which questions
// -----------------------------------------------------------------------------

export interface PlanInput {
  /** null when the bank did not load. */
  bank: StoryBank | null;
  /** Concept observations from recent behavioral grades, newest first. */
  history: readonly { concept: string; signal: ConceptSignal }[];
  /** Question ids asked in recent mocks, so a fresh one is preferred. */
  recentQuestionIds?: readonly string[];
  /** Concepts the start card previewed. Used when they are 4 distinct known competencies. */
  requested?: unknown;
  rand?: () => number;
}

export interface PlanResult {
  items: MockPlan['items'];
  /** Why each competency was weighted up. */
  reasons: Record<string, string[]>;
  weights: Record<BqCompetency, number>;
}

/** The competency the user named as the known weak spot: always weighted up, never weighted out. */
export const ALWAYS_ELIGIBLE: BqCompetency = 'influence-without-authority';

/**
 * Weights, from three sources (plan: open story-bank gaps, weak past grades,
 * influence without authority). Base 1; never below 0.25 so every competency
 * stays possible.
 */
export function competencyWeights(input: Pick<PlanInput, 'bank' | 'history'>): {
  weights: Record<BqCompetency, number>;
  reasons: Record<string, string[]>;
} {
  const weights = Object.fromEntries(BQ_COMPETENCIES.map((c) => [c, 1])) as Record<BqCompetency, number>;
  const reasons: Record<string, string[]> = {};
  const why = (c: BqCompetency, r: string) => (reasons[c] ??= []).push(r);

  if (input.bank) {
    for (const [c, w] of gapCompetencies(input.bank)) {
      weights[c] += w === 'open' ? 3 : 1.5;
      why(c, w === 'open' ? 'open story-bank gap' : 'story-bank gap, partly covered');
    }
    const cov = competencyCoverage(input.bank);
    const confirmedIds = new Set(input.bank.stories.filter((s) => s.status === 'confirmed').map((s) => s.id));
    for (const c of BQ_COMPETENCIES) {
      if (!cov[c].some((id) => confirmedIds.has(id)) && !reasons[c]?.length) {
        weights[c] += 1;
        why(c, 'no confirmed story maps to it');
      }
    }
  }

  const tally = new Map<string, number>();
  for (const o of input.history.slice(0, 60)) {
    const d = o.signal === 'missing' ? 1.5 : o.signal === 'weak' ? 1 : -0.5;
    tally.set(o.concept, (tally.get(o.concept) ?? 0) + d);
  }
  for (const c of BQ_COMPETENCIES) {
    const t = tally.get(c);
    if (t === undefined) continue;
    weights[c] += Math.max(-0.75, Math.min(3, t));
    if (t > 0) why(c, 'weak in past grades');
  }

  weights[ALWAYS_ELIGIBLE] += 2;
  why(ALWAYS_ELIGIBLE, 'your known weak spot');

  for (const c of BQ_COMPETENCIES) weights[c] = Math.max(0.25, weights[c]);
  return { weights, reasons };
}

/** Four distinct competencies, sampled by weight without replacement. */
export function pickCompetencies(
  weights: Record<BqCompetency, number>,
  n = BQ_QUESTION_STAGES.length,
  rand: () => number = Math.random
): BqCompetency[] {
  const pool = [...BQ_COMPETENCIES];
  const out: BqCompetency[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((s, c) => s + weights[c], 0);
    let r = rand() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= weights[pool[i]];
      if (r < 0) break;
    }
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

function requestedCompetencies(x: unknown): BqCompetency[] | null {
  const list = (x as { concepts?: unknown } | null | undefined)?.concepts;
  if (!Array.isArray(list) || list.length !== BQ_QUESTION_STAGES.length) return null;
  const known = list.filter((c): c is BqCompetency => (BQ_COMPETENCIES as readonly string[]).includes(c as string));
  return new Set(known).size === BQ_QUESTION_STAGES.length ? known : null;
}

/** The plan: the requested competencies when valid, else a weighted pick; one question each. */
export function planBehavioral(input: PlanInput): PlanResult {
  const rand = input.rand ?? Math.random;
  const { weights, reasons } = competencyWeights(input);
  const comps = requestedCompetencies(input.requested) ?? pickCompetencies(weights, BQ_QUESTION_STAGES.length, rand);
  const items = comps.map((c, i) => {
    const q = pickQuestion(c, input.recentQuestionIds ?? [], rand);
    return { stage: BQ_QUESTION_STAGES[i], concept: c, questionId: q.id, question: q.text };
  });
  return { items, reasons, weights };
}

/** A plan's competencies, one line each, for logs and the dry run. */
export function describePlan(items: MockPlan['items']): string {
  return items.map((i) => `${i.stage}: ${competencyLabel(i.concept)} — ${i.question}`).join('\n');
}
