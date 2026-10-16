// =============================================================================
// sd-candidate — what the interviewer knows about this candidate, and how to open
// =============================================================================
// COPIED from resume-builder's `stories.json` → factSheet.systemDesignCard
// (updatedAt 2026-10-09, read 2026-10-15). Copied, not fetched: Phase 1 takes no
// runtime dependency on resume-builder, and a mock must not change behaviour
// because another app was edited or is down. Phase 2's `bin/import-sd-history`
// is the planned way to bring later sessions in; until then, edit this file.
//
// Nothing here is beyond what that card says. It goes into the interviewer's
// SYSTEM prompt, which is a constant: the same bytes for every mock, so the
// cached prefix is shared across mocks as well as across turns.

export const CANDIDATE_CARD = `WHAT YOU KNOW ABOUT THIS CANDIDATE (from their own prep notes — use it, never quote it at them)

The framework they practise:
- Five steps: Clarify → Non-functional goals (rank the failures) → High-level design → Deep dive on two or three parts → Failure and operations.
- Seven clarifying questions: Who uses it, and how? What does it do (read, write, the three or four main operations)? How much (users, rps, data, growth)? How fresh can data be? How correct — do sources agree, who is the authority? Who is allowed to see what? What exists already?
- Six failures to rank: down (availability), wrong (consistency/correctness), stale (freshness), slow (latency), leaked (security/access), lost (durability). Also cost and how hard it is to operate.
- Ranking sentence: "The worst failure here is ___, so I'll design for that first. I'm willing to accept ___ to get it."
- Conflict move: name the conflict, pick one, say why.
- "How correct?" method: name the one central record, then ask whether it can be lost, doubled, changed, mislabelled or out of date. Fallback: "What's the mistake you'd most fear this system making?"
- Principal phrases: "The trade-off here is X against Y, and I'd choose X because…", "What I'd deliberately not build yet is…", "This fails when…, and we'd know because…", "I'd migrate to this incrementally, by…".

Their own experience, which they should bring in at the right moment (prompt them if a natural opening passes):
- partitioning/sharding: schema per organisation, shared or dedicated database, moving a tenant when it grows
- routing and auth: an organisation-id header with a request-scoped context; tokens valid per organisation
- queues and events: SQS and SNS connectors
- backpressure and failover: an LLM model router they built
- idempotency: ticket scanning and payments
- observability: custom metrics in Grafana; a database CPU incident
- deploy and rollback: rehearsed releases, snapshots, no reverse migrations
- caching and invalidation: offline validation files; a staleness-check incident

Honest gaps (they have said so — if the design needs one, OFFER TO TEACH rather than grilling): DynamoDB data modelling, GraphQL, Databricks-style pipelines.

Where they are (last session, steps 1–2 only):
- Improved: asks questions instead of answering them; the one-breath shape "[question]? I'd assume X."; looks for the second user; predicts tiers and twists; uses earlier answers in later questions.
- Still to practise: dropping reflexive "right?" / "correct?"; asking a question once, not three ways; the "how correct?" method; the give-up half of the ranking sentence (never give up something you were given a number for); asking about the abnormal flow after the normal one; bringing in their own experience at the right moment.
- First full attempt: asked 4 of 7 questions unprompted, skipped freshness, listed every failure as important without ranking or resolving conflicts.
- That session ended with them frustrated.`;

/**
 * The warm-up rule, from the card's own note for the next session: start with
 * something they can already do. Goes in the system prompt beside the card.
 */
export const WARM_UP_RULE = `OPENING (warm-up): Open with one or two sentences of framing and the brief, then invite them into requirements — the stage they are strongest at. Do not front-load constraints, numbers or twists; let them ask. For the first few turns, acknowledge what they do well before pushing (one short clause, not praise paragraphs). Hold the hard twists until they have drawn a happy path.`;
