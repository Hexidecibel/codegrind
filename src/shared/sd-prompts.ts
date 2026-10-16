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
];

const BY_ID = new Map(SD_PROMPTS.map((p) => [p.id, p]));

export function sdPrompt(id: string): SdPrompt | null {
  return BY_ID.get(id) ?? null;
}

/**
 * Which prompt to run when the candidate did not choose.
 *
 * The first mock ever is a familiar one — see the header. After that, anything
 * not used in the last few mocks, familiar or not, chosen by `rand` (injected so
 * the choice is testable).
 */
export function pickPrompt(recentIds: readonly string[], rand: () => number = Math.random): SdPrompt {
  const pool =
    recentIds.length === 0
      ? SD_PROMPTS.filter((p) => p.familiar)
      : SD_PROMPTS.filter((p) => !recentIds.slice(0, 5).includes(p.id));
  const from = pool.length ? pool : SD_PROMPTS;
  return from[Math.floor(rand() * from.length) % from.length];
}
