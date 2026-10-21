// =============================================================================
// behavioral-questions — the behavioral mock's vocabulary and question catalog
// =============================================================================
// Client-safe. The competencies are the behavioral kind's CONCEPTS (closed,
// like SD_CONCEPTS) and every id here is distinct from every system-design
// concept id, because a drill card carries a concept and no kind
// (anyConceptLabel looks the id up in every kind; a shared id would get the
// wrong label). mock-kinds.test.ts pins that disjointness.
//
// Questions are phrased the way a Staff loop asks them: scope beyond one team,
// influence rather than authority, decisions with consequences. Each is tagged
// with exactly one competency; the planner picks a competency first and a
// question within it second, so the catalog can grow unevenly without skewing
// which competencies get practised.

export const BQ_STAGES = ['intro', 'q1', 'q2', 'q3', 'q4', 'wrap'] as const;
export type BqStage = (typeof BQ_STAGES)[number];
/** The four question stages, in order. */
export const BQ_QUESTION_STAGES = ['q1', 'q2', 'q3', 'q4'] as const;

export const BQ_STAGE_META: Readonly<Record<BqStage, { label: string; goal: string }>> = {
  intro: {
    label: 'Intro',
    goal: 'Tell me about yourself: two minutes, present → past → why this role, ending on what you want next.',
  },
  q1: { label: 'Q1', goal: 'One story, told STAR with the result early, then two to four probes.' },
  q2: { label: 'Q2', goal: 'One story, told STAR with the result early, then two to four probes.' },
  q3: { label: 'Q3', goal: 'One story, told STAR with the result early, then two to four probes.' },
  q4: { label: 'Q4', goal: 'One story, told STAR with the result early, then two to four probes.' },
  wrap: { label: 'Wrap-up', goal: 'Your questions for the interviewer, and a clean close.' },
};

export const BQ_COMPETENCIES = [
  'ownership',
  'influence-without-authority',
  'conflict',
  'failure-learning',
  'ambiguity',
  'growing-others',
  'technical-strategy',
  'prioritization',
  'cross-team',
  'exec-communication',
  'delivery-under-pressure',
  'customer-impact',
] as const;
export type BqCompetency = (typeof BQ_COMPETENCIES)[number];

export function isBqCompetency(x: unknown): x is BqCompetency {
  return typeof x === 'string' && (BQ_COMPETENCIES as readonly string[]).includes(x);
}

const COMPETENCY_LABEL: Readonly<Record<BqCompetency, string>> = {
  ownership: 'Ownership',
  'influence-without-authority': 'Influence without authority',
  conflict: 'Conflict & disagreement',
  'failure-learning': 'Failure & learning',
  ambiguity: 'Ambiguity',
  'growing-others': 'Growing others',
  'technical-strategy': 'Technical strategy',
  prioritization: 'Prioritization & trade-offs',
  'cross-team': 'Cross-team work',
  'exec-communication': 'Communicating with executives',
  'delivery-under-pressure': 'Delivery under pressure',
  'customer-impact': 'Customer impact',
};

export function competencyLabel(c: string): string {
  return isBqCompetency(c) ? COMPETENCY_LABEL[c] : c.replace(/-/g, ' ');
}

export interface BqQuestion {
  id: string;
  competency: BqCompetency;
  text: string;
}

export const BQ_QUESTIONS: readonly BqQuestion[] = [
  // ownership
  { id: 'own-outside-scope', competency: 'ownership', text: 'Tell me about a time you took responsibility for a problem that was not yours to fix.' },
  { id: 'own-long-tail', competency: 'ownership', text: 'Describe something you owned end to end for more than a year. What did owning it actually mean day to day?' },
  { id: 'own-dropped-ball', competency: 'ownership', text: 'Tell me about a time something important was falling through the cracks between teams. What did you do?' },
  // influence without authority
  { id: 'iwa-no-mandate', competency: 'influence-without-authority', text: 'Tell me about a time you changed how other engineers or teams worked when you had no authority over them.' },
  { id: 'iwa-adopt', competency: 'influence-without-authority', text: 'Describe a technical direction you championed that other teams adopted. How did you get buy-in?' },
  { id: 'iwa-skeptic', competency: 'influence-without-authority', text: 'Tell me about convincing a skeptical senior engineer or manager to change their mind.' },
  { id: 'iwa-standard', competency: 'influence-without-authority', text: 'Describe a time you got a group to adopt a standard or practice they had resisted.' },
  // conflict
  { id: 'con-peer', competency: 'conflict', text: 'Tell me about a time you strongly disagreed with a peer on a technical decision. How was it resolved?' },
  { id: 'con-manager', competency: 'conflict', text: 'Describe a time you disagreed with your manager or a leader above you. What did you do?' },
  { id: 'con-commit', competency: 'conflict', text: 'Tell me about a time you disagreed with a decision, lost the argument, and had to commit to it anyway.' },
  { id: 'con-teams', competency: 'conflict', text: 'Describe a conflict between two teams that you helped resolve.' },
  // failure & learning
  { id: 'fail-wrong-call', competency: 'failure-learning', text: 'Tell me about a significant technical decision you made that turned out to be wrong.' },
  { id: 'fail-underestimate', competency: 'failure-learning', text: 'Describe a project where you badly underestimated something. What did you change afterwards?' },
  { id: 'fail-mistake', competency: 'failure-learning', text: 'Tell me about a mistake of yours that affected other people. How did you handle it?' },
  // ambiguity
  { id: 'amb-no-spec', competency: 'ambiguity', text: 'Tell me about a time you were handed a problem with no clear definition. How did you decide what to build?' },
  { id: 'amb-unknown-cause', competency: 'ambiguity', text: 'Describe a situation where the obvious explanations were ruled out and you had to find a way forward.' },
  { id: 'amb-shifting', competency: 'ambiguity', text: 'Tell me about a project where the goals kept shifting. How did you keep it moving?' },
  // growing others
  { id: 'grow-junior', competency: 'growing-others', text: 'Tell me about an engineer you helped grow. What did you do, and what changed for them?' },
  { id: 'grow-handoff', competency: 'growing-others', text: 'Describe a time you handed something you built over to someone else so they could own it.' },
  { id: 'grow-feedback', competency: 'growing-others', text: 'Tell me about giving difficult feedback to someone. How did they take it?' },
  // technical strategy
  { id: 'strat-multi-year', competency: 'technical-strategy', text: 'Tell me about a multi-year technical direction you set. How did you know it was the right one?' },
  { id: 'strat-build-buy', competency: 'technical-strategy', text: 'Describe a build-versus-buy or rewrite-versus-refactor decision you drove. What did you weigh?' },
  { id: 'strat-debt', competency: 'technical-strategy', text: 'Tell me about a time you made the case for paying down technical debt instead of shipping features.' },
  { id: 'strat-proud', competency: 'technical-strategy', text: 'What is the design you are proudest of, and what made it the right design for that organization?' },
  // prioritization
  { id: 'prio-say-no', competency: 'prioritization', text: 'Tell me about a time you said no, or not now, to something important. How did you decide?' },
  { id: 'prio-tradeoff', competency: 'prioritization', text: 'Describe a hard trade-off between speed and quality you had to make. What did you give up?' },
  { id: 'prio-too-much', competency: 'prioritization', text: 'Tell me about a time you had far more work than capacity. How did you choose what to cut?' },
  // cross-team
  { id: 'xteam-dependency', competency: 'cross-team', text: 'Tell me about a project that depended on another team that had different priorities.' },
  { id: 'xteam-boundary', competency: 'cross-team', text: 'Describe a change you led that crossed several team boundaries. How did you coordinate it?' },
  { id: 'xteam-platform', competency: 'cross-team', text: 'Tell me about building something that other teams had to adopt. How did you make it easy for them?' },
  // exec communication
  { id: 'exec-present', competency: 'exec-communication', text: 'Tell me about presenting a technical recommendation to executives. What did you leave out, and why?' },
  { id: 'exec-bad-news', competency: 'exec-communication', text: 'Describe a time you had to tell leadership something they did not want to hear.' },
  { id: 'exec-translate', competency: 'exec-communication', text: 'Tell me about explaining a technical risk to a non-technical decision maker so they could act on it.' },
  // delivery under pressure
  { id: 'press-incident', competency: 'delivery-under-pressure', text: 'Tell me about the worst production incident you led the response to.' },
  { id: 'press-deadline', competency: 'delivery-under-pressure', text: 'Describe a time you delivered against a deadline that looked impossible. What did you change to make it?' },
  { id: 'press-release', competency: 'delivery-under-pressure', text: 'Tell me about a release that went wrong. What did you do in the moment, and what did you change after?' },
  // customer impact
  { id: 'cust-escalation', competency: 'customer-impact', text: 'Tell me about a customer escalation you handled personally. What was the outcome for the customer?' },
  { id: 'cust-metric', competency: 'customer-impact', text: 'Describe work you did that measurably changed things for customers or the business. How do you know?' },
  { id: 'cust-advocate', competency: 'customer-impact', text: 'Tell me about a time you pushed back on a plan because of what it would do to users.' },
];

export function bqQuestion(id: string): BqQuestion | null {
  return BQ_QUESTIONS.find((q) => q.id === id) ?? null;
}

export function questionsFor(c: BqCompetency): BqQuestion[] {
  return BQ_QUESTIONS.filter((q) => q.competency === c);
}

/** One question for a competency, avoiding `recent` ids when there is another choice. */
export function pickQuestion(
  c: BqCompetency,
  recent: readonly string[] = [],
  rand: () => number = Math.random
): BqQuestion {
  const all = questionsFor(c);
  const fresh = all.filter((q) => !recent.includes(q.id));
  const pool = fresh.length ? fresh : all;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/** The behavioral "prompt": one loop. The plan (competencies, questions) is per mock. */
export const BQ_PROMPTS = [
  {
    id: 'staff-loop',
    title: 'Staff behavioral loop',
    brief:
      'Tell me about yourself, then four behavioral questions, each probed two to four levels deep, then your questions for me.',
    familiar: false,
  },
] as const;

/** Where to capture a missing story. No write-back: the candidate goes there. */
export const STORY_CAPTURE_URL = 'https://resume.cush.rocks';
