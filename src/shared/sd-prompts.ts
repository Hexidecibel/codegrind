// =============================================================================
// sd-prompts — the static system-design prompt bank
// =============================================================================
// Seeded from the user's own drill list (resume-builder `stories.json` →
// factSheet.systemDesignCard.drillPrompts, read 2026-10-15) and COPIED here, not
// fetched: Phase 1 has no runtime dependency on resume-builder. Phase 3 adds
// posting-themed prompts generated per job posting; these stay as the base bank.
//
// `familiar` marks a system the candidate has actually built. Those are the
// warm-up prompts: the card's last session ended frustrated, and its own note
// for the next one is "start with something he can already do". A first mock
// with no prompt chosen is therefore always a familiar one (pickPrompt).
//
// `twists` are what an interviewer reaches for once the happy path is drawn —
// the abnormal flow the card says to practise asking about.

export interface SdPrompt {
  id: string;
  title: string;
  /** What the interviewer says to open. Deliberately under-specified, as in a real loop. */
  brief: string;
  familiar: boolean;
  twists: readonly string[];
  /**
   * An AI/LLM system (Phase H3): the user targets Staff roles at AI- and
   * agent-focused companies, where the system-design round is often one of
   * these. Mock picking mixes them in, and favours them when an upcoming loop
   * is marked AI-focused (pickPrompt).
   */
  ai?: boolean;
}

export const SD_PROMPTS: readonly SdPrompt[] = [
  {
    id: 'event-ticketing',
    title: 'A ticketing system for events',
    brief:
      'Design a ticketing system for live events: organisers put events on sale, buyers purchase tickets, and staff scan tickets at the door.',
    familiar: true,
    twists: [
      'A popular event goes on sale and 50,000 people hit buy in the same minute.',
      'The venue has no connectivity at the door — scanning must work offline.',
      'A payment succeeds but the confirmation never reaches the buyer.',
    ],
  },
  {
    id: 'telecom-inventory',
    title: 'An inventory system for telecom warehouses',
    brief:
      'Design an inventory system for a company that stores telecom equipment across many warehouses and field sites.',
    familiar: true,
    twists: [
      'Technicians record usage from sites with poor connectivity.',
      'Two warehouses both claim the last unit of a part.',
      'A customer organisation wants its data fully separated from everyone else’s.',
    ],
  },
  {
    id: 'wedding-jukebox',
    title: 'The wedding jukebox',
    brief:
      'Design a jukebox for a wedding: guests request songs from their phones, and one playlist plays through the venue speakers.',
    familiar: true,
    twists: [
      'Two hundred guests request at once after the first dance.',
      'The DJ needs to veto a song before it plays.',
      'The venue wifi drops for ten minutes.',
    ],
  },
  {
    id: 'hiker-photos',
    title: 'A photo-sharing app for hikers',
    brief:
      'Design a photo-sharing app for hikers: people upload photos from trails, tagged with location, and browse what others have seen nearby.',
    familiar: true,
    twists: [
      'Uploads start on a mountain with one bar of signal.',
      'A trail goes viral and its photos are requested a thousand times a second.',
      'Location data on a photo reveals where someone lives.',
    ],
  },
  {
    id: 'parking-city',
    title: 'A parking app for a city',
    brief: 'Design a parking app for a city: drivers find and pay for parking, and the city enforces it.',
    familiar: false,
    twists: [
      'An enforcement officer and a driver disagree about whether a session was paid.',
      'Prices change by time of day and by event.',
    ],
  },
  {
    id: 'library-lending',
    title: 'A library’s book lending system',
    brief: 'Design the lending system for a library network: members borrow, reserve and return books across branches.',
    familiar: false,
    twists: [
      'Two members reserve the last copy at the same moment.',
      'A branch’s system is offline for a day and keeps lending.',
    ],
  },
  {
    id: 'url-shortener',
    title: 'A URL shortener',
    brief: 'Design a URL shortener.',
    familiar: false,
    twists: [
      'One link is posted during a sporting final and gets most of the traffic.',
      'Links must be revocable within a minute for abuse.',
    ],
  },
  {
    id: 'notification-service',
    title: 'A notification service for a large company',
    brief:
      'Design a notification service that every team in a large company uses to send email, SMS and push notifications to customers.',
    familiar: false,
    twists: [
      'One team sends ten million messages by mistake.',
      'The SMS vendor is down for an hour.',
      'A customer must never get the same notification twice.',
    ],
  },
  {
    id: 'test-results',
    title: 'A system that collects test results from many machines',
    brief:
      'Design a system that collects test results from thousands of test machines and lets engineers look at them.',
    familiar: false,
    twists: [
      'Raw results are large; most people only need summaries.',
      'A machine’s clock is wrong.',
    ],
  },
  {
    id: 'document-approval',
    title: 'A document approval workflow for engineers',
    brief:
      'Design a document approval workflow: engineers submit documents, reviewers approve or reject them, and approved versions are released.',
    familiar: false,
    twists: [
      'A reviewer approves version 3 while the author uploads version 4.',
      'An auditor asks who approved what, two years later.',
    ],
  },
  {
    id: 'engineering-data-access',
    title: 'Unified access to engineering data',
    brief:
      'Design a layer that gives engineers unified access to parts, test results, requirements and work-order data that today live in separate systems.',
    familiar: false,
    twists: [
      'Two source systems disagree about a part’s current revision.',
      'Some users may only see data for programmes they are cleared for.',
      'One source system can only be queried in a nightly batch.',
    ],
  },
  // ---------------------------------------------------------------------------
  // AI / LLM systems (Phase H3). Briefs stay under-specified on purpose; the
  // twists are the failure an AI-company interviewer reaches for: quality you
  // cannot unit-test, cost per request, a latency budget, untrusted text that
  // reaches the model, and a provider that is down or rate-limited.
  // ---------------------------------------------------------------------------
  {
    id: 'rag-company-docs',
    title: 'Question answering over a company’s internal docs (RAG)',
    brief:
      'Design an assistant that answers employees’ questions using the company’s internal documents — wikis, design docs, tickets and chat — with citations.',
    familiar: false,
    ai: true,
    twists: [
      'A user asks about a document they are not allowed to see.',
      'Answers cite a policy page that was replaced last month.',
      'Leadership asks how you know answers got better after you changed the chunking.',
    ],
  },
  {
    id: 'agent-with-tools-evals',
    title: 'A support agent that takes actions with tools, and its eval harness',
    brief:
      'Design an AI agent that resolves customer-support tickets by calling internal tools — look up orders, issue refunds, update addresses — plus the harness you would use to know it works.',
    familiar: false,
    ai: true,
    twists: [
      'The agent loops, calling the same tool twenty times on one ticket.',
      'A refund tool call times out — did the refund happen?',
      'A prompt change fixes one class of tickets and silently breaks another.',
    ],
  },
  {
    id: 'llm-gateway',
    title: 'An LLM gateway for every team in a company',
    brief:
      'Design an internal gateway that every team uses to call large language models from several vendors: one API, rate limits, fallbacks, and cost tracking per team.',
    familiar: false,
    ai: true,
    twists: [
      'The primary vendor starts returning 429s at peak and one team’s batch job is the cause.',
      'Finance wants a hard monthly budget per team, enforced, not just reported.',
      'A streaming response is half-delivered when the upstream fails.',
    ],
  },
  {
    id: 'inference-serving',
    title: 'Serving an open-weights model with batching and a KV cache',
    brief:
      'Design the serving layer for a 70B-parameter open-weights chat model on your own GPUs: many concurrent users, streaming tokens.',
    familiar: false,
    ai: true,
    twists: [
      'A few users send 100k-token prompts and everyone else’s time to first token triples.',
      'GPU memory runs out mid-generation as conversations get longer.',
      'Traffic doubles every evening and GPUs take ten minutes to come up.',
    ],
  },
  {
    id: 'llm-eval-pipeline',
    title: 'An offline and online evaluation pipeline for an LLM product',
    brief:
      'Design the evaluation system for an LLM-powered product: offline evals before a prompt or model change ships, and online measurement once it is live.',
    familiar: false,
    ai: true,
    twists: [
      'The LLM judge and human raters disagree on a third of examples.',
      'The eval set leaked into a fine-tuning dataset.',
      'Offline scores went up but users’ thumbs-up rate went down.',
    ],
  },
  {
    id: 'llm-guardrails',
    title: 'Guardrails and prompt-injection defence for an assistant with tools',
    brief:
      'Design the safety layer for an assistant that reads users’ email and web pages and can send messages on their behalf.',
    familiar: false,
    ai: true,
    twists: [
      'A web page contains hidden text telling the assistant to forward the inbox to an outside address.',
      'The guardrail model adds 800 ms to every response.',
      'A customer reports a false positive that blocks legitimate medical questions.',
    ],
  },
  {
    id: 'embedding-search-at-scale',
    title: 'A semantic search and embedding pipeline at scale',
    brief:
      'Design semantic search over a billion product listings that change all day: embed them, index them, and serve queries in under 100 ms.',
    familiar: false,
    ai: true,
    twists: [
      'You need to switch to a new embedding model without downtime.',
      'Exact keyword matches (part numbers) rank below vaguely similar items.',
      'A seller updates a listing and it is not searchable for an hour.',
    ],
  },
  {
    id: 'multi-tenant-adapters',
    title: 'Multi-tenant fine-tuned adapter serving',
    brief:
      'Design a platform where thousands of business customers each fine-tune their own LoRA adapter on a shared base model and call it through one API.',
    familiar: false,
    ai: true,
    twists: [
      'Most adapters are called once a day; a few get thousands of requests a second.',
      'A customer’s training data must never influence another customer’s outputs.',
      'A new base-model version ships — what happens to ten thousand adapters?',
    ],
  },
  {
    id: 'llm-observability',
    title: 'An observability platform for LLM applications',
    brief:
      'Design an observability platform for teams running LLM applications: traces of every call and tool step, cost and latency, and a way to find bad answers.',
    familiar: false,
    ai: true,
    twists: [
      'Prompts and outputs contain customer PII.',
      'One agent run produces 400 spans and a 2 MB trace.',
      'A team asks “which of yesterday’s answers were wrong?” across a million calls.',
    ],
  },
];

const BY_ID = new Map(SD_PROMPTS.map((p) => [p.id, p]));

export function sdPrompt(id: string): SdPrompt | null {
  return BY_ID.get(id) ?? null;
}

/** Options for pickPrompt (Phase H3). */
export interface PickPromptOptions {
  /**
   * The AI prompts are UNLOCKED for the random pick: enough AI concepts are
   * known (shared/concepts.AI_UNLOCK_KNOWN). Until then they are only run when
   * the candidate picks one by hand — material is learned before it is tested.
   */
  aiUnlocked?: boolean;
  /** An upcoming interview loop is at an AI-focused company: favour the AI prompts (once unlocked). */
  aiFocus?: boolean;
}

/** An AI prompt is mixed in when none of the last this-many mocks was one. */
export const AI_MIX_RECENT = 2;

/**
 * Which prompt to run when the candidate did not choose.
 *
 * The first mock ever is a familiar one — see the header. After that, anything
 * not used in the last few mocks, chosen by `rand` (injected so the choice is
 * testable). Phase H3 AI prompts:
 *   - locked (not enough AI concepts known): never picked here.
 *   - unlocked: an AI prompt whenever aiFocus is set, or when none of the last
 *     AI_MIX_RECENT mocks was one; otherwise the whole fresh pool.
 */
export function pickPrompt(
  recentIds: readonly string[],
  rand: () => number = Math.random,
  opts: PickPromptOptions = {}
): SdPrompt {
  const at = (xs: readonly SdPrompt[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  const eligible = SD_PROMPTS.filter((p) => !p.ai || opts.aiUnlocked);
  if (recentIds.length === 0) {
    return at(eligible.filter((p) => (opts.aiFocus && opts.aiUnlocked ? p.ai : p.familiar)));
  }
  const recent = recentIds.slice(0, 5);
  const fresh = eligible.filter((p) => !recent.includes(p.id));
  const from = fresh.length ? fresh : eligible;
  const freshAi = from.filter((p) => p.ai);
  const recentAi = recentIds.slice(0, AI_MIX_RECENT).some((id) => BY_ID.get(id)?.ai);
  if (freshAi.length && (opts.aiFocus || !recentAi)) return at(freshAi);
  return at(from);
}

/** The AI/LLM prompts (Phase H3). */
export const AI_SD_PROMPTS: readonly SdPrompt[] = SD_PROMPTS.filter((p) => p.ai);
