// =============================================================================
// sd — the system-design vocabulary, shared by the server and the client
// =============================================================================
// The mock interviewer, the grader, the stage chips on the Mock page and (from
// Phase 2) the knowledge state all speak in these words, so they are CLOSED
// lists declared once. A model that answers with a stage or a concept outside
// them is coerced, never stored verbatim — an open vocabulary would turn the
// Phase 2 "known / shaky / next" fold into a tally of near-duplicate strings.
//
// Deliberately NOT `TOPICS`. That is the 18-topic algorithm curriculum with a
// prerequisite graph and a tier ladder; system design has neither, and folding
// these into it would hand the scheduler topics it can never serve a problem for.

/**
 * The stages of a system-design interview, in the order an interviewer expects
 * them. The order is used: a jump forward past an uncovered stage is a SKIP, and
 * the server says so to both the interviewer and the grader (mock.state.ts).
 */
export const SD_STAGES = [
  'requirements',
  'capacity',
  'api',
  'data-model',
  'high-level',
  'deep-dive',
  'tradeoffs',
] as const;
export type SdStage = (typeof SD_STAGES)[number];

export const SD_STAGE_META: Readonly<Record<SdStage, { label: string; goal: string }>> = {
  requirements: {
    label: 'Requirements',
    goal: 'Who uses it and how, what it does, and which failure is worst — ranked, not listed.',
  },
  capacity: {
    label: 'Capacity',
    goal: 'How much: users, requests per second, data volume, growth — rough numbers that drive choices.',
  },
  api: {
    label: 'API',
    goal: 'The three or four main operations as calls, with the awkward parameters named.',
  },
  'data-model': {
    label: 'Data model',
    goal: 'The central record, its keys and access patterns, and where it lives.',
  },
  'high-level': {
    label: 'High-level design',
    goal: 'Boxes and arrows that serve the requirements, said out loud in one pass.',
  },
  'deep-dive': {
    label: 'Deep dive',
    goal: 'Two or three parts taken all the way down, including how they fail.',
  },
  tradeoffs: {
    label: 'Trade-offs',
    goal: 'What was chosen over what and why, what was deliberately not built, how it is operated.',
  },
};

export function isSdStage(x: unknown): x is SdStage {
  return typeof x === 'string' && (SD_STAGES as readonly string[]).includes(x);
}

/**
 * The concepts a mock can observe. ~30, closed, and named as the thing a
 * candidate either does or does not bring up — so an observation reads as
 * "nailed idempotency", "missing failure-ranking".
 */
export const SD_CONCEPTS = [
  'clarifying-questions',
  'users-and-access-patterns',
  'read-write-ratio',
  'scale-estimation',
  'freshness',
  'correctness-authority',
  'failure-ranking',
  'conflict-resolution',
  'availability',
  'consistency',
  'latency',
  'durability',
  'access-control',
  'existing-systems',
  'api-design',
  'idempotency',
  'pagination',
  'data-modeling',
  'partitioning-sharding',
  'replication',
  'caching-invalidation',
  'queues-events',
  'backpressure',
  'rate-limiting',
  'search-indexing',
  'multi-tenancy',
  'offline-sync',
  'hot-spots',
  'observability',
  'deploy-rollback',
  'migration-strategy',
  'cost',
] as const;
export type SdConcept = (typeof SD_CONCEPTS)[number];

export function isSdConcept(x: unknown): x is SdConcept {
  return typeof x === 'string' && (SD_CONCEPTS as readonly string[]).includes(x);
}

/** Human label for a concept id: `caching-invalidation` → `caching / invalidation`. */
export function conceptLabel(c: SdConcept): string {
  return CONCEPT_LABELS[c] ?? c.replace(/-/g, ' ');
}

const CONCEPT_LABELS: Partial<Record<SdConcept, string>> = {
  'users-and-access-patterns': 'users and access patterns',
  'read-write-ratio': 'read/write ratio',
  'correctness-authority': 'correctness / source of truth',
  'partitioning-sharding': 'partitioning / sharding',
  'caching-invalidation': 'caching / invalidation',
  'queues-events': 'queues and events',
  'deploy-rollback': 'deploy and rollback',
  'api-design': 'API design',
};

/**
 * The level a mock is graded against. Staff is the default because it is the
 * level the user is interviewing for; the others are there to answer "would
 * this have passed one level down / up".
 */
export const MOCK_LEVELS = ['senior', 'staff', 'principal'] as const;
export type MockLevel = (typeof MOCK_LEVELS)[number];
export const DEFAULT_MOCK_LEVEL: MockLevel = 'staff';

export const MOCK_LEVEL_LABEL: Readonly<Record<MockLevel, string>> = {
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
};

export function isMockLevel(x: unknown): x is MockLevel {
  return typeof x === 'string' && (MOCK_LEVELS as readonly string[]).includes(x);
}

/** What the interviewer is doing on a turn. Chosen by the model, coerced here. */
export const INTERVIEWER_MODES = ['interview', 'nudge', 'offer_teach', 'teach', 'wrap_up'] as const;
export type InterviewerMode = (typeof INTERVIEWER_MODES)[number];

/** One observation's verdict. `taught` is never emitted by the interviewer — Phase 2 writes it. */
export const CONCEPT_SIGNALS = ['nailed', 'weak', 'missing'] as const;
export type ConceptSignal = (typeof CONCEPT_SIGNALS)[number];
