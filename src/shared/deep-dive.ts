// =============================================================================
// deep-dive — the project deep-dive interview's client-safe vocabulary (Phase H4)
// =============================================================================
// A Staff "tell me about a project you're proud of" round: the interviewer takes
// ONE project the candidate chose and drills about five levels into it — why
// this architecture, what else was on the table, the hardest technical problem,
// the failure and what changed, the numbers, how others were brought along, and
// what they would do differently.
//
// Concept ids carry a `dd-` prefix so they can never collide with another
// kind's (drill cards carry a concept, not a kind — mock-kinds.test pins it).

export const DD_STAGES = [
  'overview',
  'architecture',
  'alternatives',
  'hardest-problem',
  'failure',
  'numbers',
  'alignment',
  'retro',
] as const;
export type DdStage = (typeof DD_STAGES)[number];

export const DD_STAGE_META: Readonly<Record<DdStage, { label: string; goal: string }>> = {
  overview: { label: 'Overview', goal: 'The project in two minutes: the problem, your role, the outcome — result first.' },
  architecture: { label: 'Architecture', goal: 'Why it is built the way it is: the main components and the forces that shaped them.' },
  alternatives: { label: 'Alternatives', goal: 'What else was on the table, and what you traded away by not choosing it.' },
  'hardest-problem': { label: 'Hardest problem', goal: 'The hardest technical problem, in depth: what made it hard, what you tried, what worked.' },
  failure: { label: 'Failure', goal: 'Something that broke or went wrong, what you did, and what changed afterwards.' },
  numbers: { label: 'Numbers', goal: 'Scale, cost, latency, people, time: the figures that make the story real.' },
  alignment: { label: 'Alignment', goal: 'How you got others — peers, other teams, leadership — to agree or adopt it.' },
  retro: { label: 'Retro', goal: 'What you would do differently today, and why.' },
};

export const DD_CONCEPTS = [
  'dd-depth',
  'dd-ownership',
  'dd-tradeoffs',
  'dd-failure-honesty',
  'dd-quantification',
  'dd-alignment',
  'dd-retrospection',
] as const;
export type DdConcept = (typeof DD_CONCEPTS)[number];

const DD_CONCEPT_LABEL: Readonly<Record<DdConcept, string>> = {
  'dd-depth': 'Technical depth',
  'dd-ownership': 'Ownership (I vs we)',
  'dd-tradeoffs': 'Trade-off reasoning',
  'dd-failure-honesty': 'Honesty about failure',
  'dd-quantification': 'Quantification',
  'dd-alignment': 'Getting others aligned',
  'dd-retrospection': 'Retrospection',
};

export function ddConceptLabel(c: string): string {
  return (DD_CONCEPTS as readonly string[]).includes(c) ? DD_CONCEPT_LABEL[c as DdConcept] : c.replace(/-/g, ' ');
}

/** One catalog entry: the project itself is chosen at start (MockStartRequest.project). */
export const DD_PROMPTS = [
  {
    id: 'project',
    title: 'Project deep-dive',
    brief: 'Pick one project you know deeply. I will drill about five levels into it: architecture, alternatives, the hardest problem, a failure, the numbers, alignment, and what you would change.',
    familiar: true,
  },
] as const;

/** Where a deep-dive project comes from. */
export const DD_PROJECT_SOURCES = ['story', 'resume', 'typed'] as const;
export type DdProjectSource = (typeof DD_PROJECT_SOURCES)[number];

/** GET /api/mock/projects — what the start card offers. */
export interface DdProjectOption {
  source: Exclude<DdProjectSource, 'typed'>;
  /** story: the story id; resume: `<experience id>#<highlight index>`. */
  id: string;
  title: string;
  /** Employer / company, when known. */
  where: string;
}

export interface DdProjectsResponse {
  options: DdProjectOption[];
  /** Why a source is missing (resume-builder down). */
  errors: string[];
}

/** The start request's choice. `typed`: a one-liner the candidate wrote. */
export interface DdProjectChoice {
  source: DdProjectSource;
  id?: string;
  text?: string;
}

/** Longest typed one-liner accepted. */
export const DD_TYPED_MAX = 300;
