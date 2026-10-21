// What a mock interview costs, turn by turn. Run via bin/mock-dry-run.
//
//   bin/mock-dry-run --dry-run              # FREE: print the plan and the estimate
//   bin/mock-dry-run --kind behavioral --dry-run   # FREE: also reads the story bank (localhost) and
//                                                  # prints the interviewer context + the grader's bank block
//   bin/mock-dry-run --kind coding --dry-run       # FREE: a built-in sample problem (no database);
//                                                  # each turn carries the editor, as the app sends it
//   bin/mock-dry-run --live [--turns N]     # SPENDS: run a scripted mock for real
//   bin/mock-dry-run --live --grade         # ...and grade it (one more call)
//
// --dry-run builds the exact request the app would send on each turn of a
// scripted mock (the real system prompt, tool schema, frozen context and
// rendered control notes — the same functions the service calls), estimates the
// tokens in each part, and prices the conversation-cache plan: what each turn
// reads from cache, what it writes, and what it outputs. Nothing is sent and
// the database is never opened.
//
// --live sends the same script through the real seam, in memory — no mock row,
// no turns stored — and prints what the endpoint actually reported, including
// cache reads and writes, so the estimate can be replaced by a measurement.
// Bare, it prints this help and spends nothing.

import {
  applyReply,
  buildMessages,
  initialState,
  renderCandidateMessage,
  type StoredTurn,
} from '../src/server/services/mock.state.js';
import { sdPrompt } from '../src/shared/sd-prompts.js';
import { MODEL_PRICES, estimateMockCost, type MockState, type ModelPrice } from '../src/shared/mock.js';
import { MOCK_KINDS, isMockKind, type MockKind, type MockPrompt } from '../src/shared/mock-kinds.js';
import { mockKindSpec, type MockPrep } from '../src/server/services/mock-kinds/index.js';
import type { CallMeta } from '../src/server/services/llm.types.js';
import type { ProblemRecord } from '../src/shared/types.js';
import type { MockRunSummary } from '../src/shared/mock.js';

/** A scripted candidate turn: words, and (coding) the editor and the newest run. */
type ScriptTurn = string | { content: string; code?: string; lastRun?: MockRunSummary };
const turnOf = (t: ScriptTurn) => (typeof t === 'string' ? { content: t } : t);

// Coding: a built-in sample problem, so the dry run needs no database or bank.
const SAMPLE_PROBLEM: ProblemRecord = {
  id: 'dry-run-longest-substring',
  language: 'javascript',
  title: 'Longest Substring Without Repeating Characters',
  prompt: 'Given a string `s`, return the length of the longest substring of `s` that contains no repeated characters.',
  examples: [
    { input: 's = "abcabcbb"', output: '3', explanation: 'The answer is "abc".' },
    { input: 's = "bbbbb"', output: '1' },
  ],
  constraints: ['0 <= s.length <= 5 * 10^4', 's consists of English letters, digits, symbols and spaces.'],
  difficulty: 'medium',
  topic: 'sliding-window',
  pattern: 'sliding window',
  starterCode: 'function lengthOfLongestSubstring(s) {\n  \n}\n',
  functionName: 'lengthOfLongestSubstring',
  sampleTests: [],
  hiddenTests: Array.from({ length: 12 }, (_, i) => ({ name: `hidden ${i + 1}`, args: [], expected: 0 })),
  referenceSolution:
    'function lengthOfLongestSubstring(s) {\n  const last = new Map();\n  let best = 0;\n  let start = 0;\n  for (let i = 0; i < s.length; i++) {\n    const c = s[i];\n    if (last.has(c) && last.get(c) >= start) start = last.get(c) + 1;\n    last.set(c, i);\n    best = Math.max(best, i - start + 1);\n  }\n  return best;\n}',
  canonicalized: true,
  used: false,
  createdAt: '2026-10-21T00:00:00Z',
};

const CODE_BRUTE = `function lengthOfLongestSubstring(s) {
  let best = 0;
  for (let i = 0; i < s.length; i++) {
    const seen = new Set();
    for (let j = i; j < s.length; j++) {
      if (seen.has(s[j])) break;
      seen.add(s[j]);
      best = Math.max(best, j - i + 1);
    }
  }
  return best;
}
`;
const CODE_WINDOW = `function lengthOfLongestSubstring(s) {
  const seen = new Set();
  let best = 0;
  let left = 0;
  for (let right = 0; right < s.length; right++) {
    while (seen.has(s[right])) {
      seen.delete(s[left]);
      left++;
    }
    seen.add(s[right]);
    best = Math.max(best, right - left + 1);
  }
  return best;
}
`;
const CODE_WINDOW_BUG = CODE_WINDOW.replace('best = Math.max(best, right - left + 1);', 'best = Math.max(best, right - left);');

// A coding script: talking it through (often dictated, so long), then code, runs and a submit.
const CODING_SCRIPT: ScriptTurn[] = [
  { content: 'OK so let me restate it: given a string, find the length of the longest contiguous run with no repeated character. Quick questions — is the empty string possible, and should I treat upper and lower case as different characters? And it is a substring, so contiguous, not a subsequence, right?' },
  { content: 'Let me walk the first example: abcabcbb. Starting at a I get abc, then the next a repeats, so 3. Starting at b I get bca, also 3. The answer is 3. For bbbbb every window is just one b, so 1. Empty string gives 0.' },
  { content: 'Brute force: for every start index, extend until I hit a repeat, tracking a set. That is O(n squared) time worst case, O(min(n, alphabet)) space. Let me write that first so I have something correct.', code: CODE_BRUTE },
  { content: 'That runs. Now, I am recomputing the set from scratch for each start. If I keep a window with a left and right pointer, I can slide the left edge forward past the repeat instead of restarting — that is a sliding window, each character enters and leaves once, so O(n).', code: CODE_BRUTE, lastRun: { kind: 'run', verdict: 'accepted', passed: 3, total: 3 } },
  { content: 'Time is O(n) since left and right each move at most n times; space is O(k) for the set where k is the alphabet size. Writing it now.' },
  { content: 'Here is the window version. I grow right, and while the new character is already in the set I shrink from the left.', code: CODE_WINDOW_BUG },
  { content: 'Hmm, the run failed, expected 3 got 2 on the first sample. Let me trace: at abc the window is left 0 right 2, and I compute right minus left which is 2 — I forgot the plus one for an inclusive window.', code: CODE_WINDOW_BUG, lastRun: { kind: 'run', verdict: 'wrong_answer', passed: 1, total: 3, firstFailure: 'sample 1: expected 3, got 2' } },
  { content: 'Fixed the off-by-one. Running again, then submitting.', code: CODE_WINDOW },
  { content: 'All hidden tests pass. Edge cases I checked: empty string returns 0 because the loop never runs, and a string of one repeated character keeps shrinking the window to one.', code: CODE_WINDOW, lastRun: { kind: 'submit', verdict: 'accepted', passed: 12, total: 12 } },
  { content: 'If the string were a stream I could keep the same window — I only need the last-seen index per character, so a map of character to index, and I can report the best so far at any time. Memory is bounded by the alphabet, not the stream length.' },
  { content: 'If it were sharded across machines, a window can span a boundary, so each shard would also return its longest prefix and suffix runs and the coordinator stitches neighbours. That is a nice map-reduce shape.' },
];

/**
 * A crude token estimate: characters / 3.2. Claude Sonnet 5's tokenizer yields
 * roughly 30% more tokens than the older ~4 chars/token rule of thumb, so this
 * leans high. It is an ESTIMATE and is labelled as one everywhere it prints;
 * --live is the measurement.
 */
const tok = (s: string) => Math.ceil(s.length / 3.2);

const SCRIPT: string[] = [
  'Who buys tickets — members of the public on phones, or also box offices? I would assume both, with phones dominant.',
  'How many tickets go on sale at once for the biggest event, and how fast do they sell?',
  'How correct does it have to be? The central record is the ticket: it must never be sold twice, and a paid ticket must never be lost.',
  'The worst failure here is wrong — selling the same seat twice — so I will design for that first. I am willing to accept slow checkout during a rush to get it.',
  'Roughly: 50,000 buyers in a minute is ~850 writes a second at peak, tiny steady state. Storage is small; the spike is the problem.',
  'API: listEvents, holdSeats(eventId, seats, idempotencyKey), purchase(holdId, paymentToken, idempotencyKey), scan(ticketId).',
  'Data model: events, seats with a status and a hold expiry, orders, tickets. Seats partitioned by event.',
  'High level: a queue in front of holdSeats for hot events, a seat service owning the seat table, payments via a provider with webhooks.',
  'Deep dive on holds: a conditional update on the seat row — status available → held with an expiry — so two holds cannot both win.',
  'Wait, explain how idempotency keys work with the payment provider when the webhook arrives twice.',
  'Scanning offline: the door devices download a signed list of valid tickets before doors open and sync scans when back online.',
  'The trade-off here is availability against correctness at the door, and I would choose availability offline with a reconciliation pass, because a queue at the door is worse than a rare double scan.',
];

// A behavioral script: an intro, then answers and probe replies across the four questions.
const BEHAVIORAL_SCRIPT: string[] = [
  'I am a staff-level backend engineer. For the last several years I led the architecture of a multi-tenant SaaS rebuild of a single-tenant product, and before that I built most of its plugin system. I am looking for a Staff role on an AI or agent platform team, because that is where I have been spending my own time.',
  'Sure. At Sitehound each customer ran on its own environment with a licensed Oracle database, about three thousand dollars a month each. I was handed the job of building the replacement. Over three to four years, with five to ten engineers, I led the architecture of a multi-tenant product on PostgreSQL: a central node plus org nodes that share tenants and scale with traffic. Hosting and licensing went from about $3,000 a month per environment to about $300, and we serve 50+ tenants now, including legacy customers who moved over.',
  'My part was the architecture and the hard calls: schema-per-tenant over row-level tenancy, and the node model. I wrote the first version of the node service myself and reviewed every migration.',
  'Honestly I did not need much buy-in for the architecture since it was assigned to me, but the operations side surprised us — we underestimated the tooling and had to build a node-management UI.',
  'I would scope the operations tooling from day one as a product of its own.',
  'There was an engineer on the support side who needed to push back on a senior leader about a customer case. I coached her through building the case rather than doing it for her: what the leader cared about, what evidence to bring, how to frame the ask. She made the case herself and it landed.',
  'I asked her questions instead of handing her answers, and we rehearsed it twice.',
  'The result was that the decision changed and she became the person people went to for that kind of case.',
  'Our migrations used to get stuck during releases and nobody owned the fix. During one release I stepped in, unstuck the migration, then turned it into a process change so it could not recur.',
  'The change was a pre-flight check in the release pipeline; stuck migrations stopped after that.',
  'What would you say the team is most worried about over the next year?',
];

function args() {
  const a = process.argv.slice(2);
  const flag = (f: string) => a.includes(f);
  const n = a.indexOf('--turns');
  const k = a.indexOf('--kind');
  const kindRaw = k >= 0 ? a[k + 1] : 'system-design';
  if (!isMockKind(kindRaw)) {
    console.error(`--kind must be one of: ${MOCK_KINDS.join(', ')}`);
    process.exit(2);
  }
  const script: ScriptTurn[] = kindRaw === 'behavioral' ? BEHAVIORAL_SCRIPT : kindRaw === 'coding' ? CODING_SCRIPT : SCRIPT;
  return {
    kind: kindRaw as MockKind,
    script,
    dry: flag('--dry-run'),
    live: flag('--live'),
    grade: flag('--grade'),
    turns: n >= 0 ? Math.max(1, Math.min(script.length, parseInt(a[n + 1] ?? '', 10) || script.length)) : script.length,
    help: flag('--help') || flag('-h') || a.length === 0,
  };
}

function usage(): never {
  console.log(
    [
      'usage: bin/mock-dry-run [--kind system-design|behavioral|coding] --dry-run | --live [--turns N] [--grade]',
      '',
      '  --kind K    which mock kind (default system-design). behavioral reads the story bank',
      '              from resume-builder (localhost, free) and prints what the interviewer and',
      '              the grader each see. coding uses a built-in sample problem (no database) and',
      '              sends the editor with every turn, as the app does.',
      '  --dry-run   print the request plan and the cost estimate. Spends nothing.',
      `  --live      run a ${SCRIPT.length}-turn (behavioral: ${BEHAVIORAL_SCRIPT.length}) scripted mock against the configured workhorse.`,
      '              SPENDS REAL MONEY (about $0.10-0.30). Stores nothing.',
      '  --turns N   with --live: stop after N candidate turns',
      '  --grade     with --live: also grade the scripted mock (one more call, ~$0.10)',
    ].join('\n')
  );
  process.exit(0);
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** The prompt, prep and frozen context a kind's scripted mock runs on (behavioral reads the bank). */
async function setup(kind: MockKind): Promise<{ prompt: MockPrompt; prep?: MockPrep; context: string }> {
  const spec = mockKindSpec(kind);
  const prompt: MockPrompt = kind === 'system-design' ? sdPrompt('event-ticketing')! : spec.info.pickPrompt([]);
  const prep = spec.prepare
    ? await spec.prepare({
        level: 'staff', requested: undefined, history: [], recentQuestionIds: [],
        coding: { weakestTopic: () => 'sliding-window', fetchProblem: async () => SAMPLE_PROBLEM },
      })
    : undefined;
  return { prompt, prep, context: spec.buildContext(prompt, 'staff', prep) };
}

/** Mock state with a kind's frozen plan, as startMock builds it. */
function startState(now: Date, kind: MockKind, prep?: MockPrep): MockState {
  return { ...initialState(now, kind), ...(prep?.plan ? { plan: prep.plan } : {}), ...(prep ? { graderContext: prep.graderContext } : {}), ...(prep?.coding ? { coding: prep.coding } : {}) };
}

function excerpt(label: string, text: string, head: number, tail = 0): void {
  const lines = text.split('\n');
  console.log(`  --- ${label} (${lines.length} lines, ~${tok(text)} tokens) ---`);
  for (const l of lines.slice(0, head)) console.log(`  | ${l}`);
  if (lines.length > head + tail) console.log(`  | … ${lines.length - head - tail} more lines …`);
  if (tail) for (const l of lines.slice(Math.max(head, lines.length - tail))) console.log(`  | ${l}`);
  console.log('');
}

async function dryRun(price: ModelPrice, kind: MockKind, script: ScriptTurn[], turns: number): Promise<void> {
  const spec = mockKindSpec(kind);
  const { prep, context } = await setup(kind);
  const toolTokens = tok(JSON.stringify(spec.interviewerTool));
  const systemTokens = tok(spec.interviewerSystem);
  const contextTokens = tok(context);
  const prefix = toolTokens + systemTokens + contextTokens;
  // An interviewer reply's visible line, and the tool call around it.
  const REPLY_SAY = 'Good. And when two buyers hold the same seat in the same second, what happens to the loser?';
  const REPLY_OUT = 400;

  console.log(`codegrind :: mock-dry-run --kind ${kind} --dry-run   (nothing is sent; token counts are ESTIMATES, chars/3.2)\n`);
  if (prep?.coding) {
    console.log(`  problem              ${prep.coding.title} (${prep.coding.topic}, ${prep.coding.difficulty}, ${prep.coding.language}) — built-in sample`);
    console.log('');
    excerpt('interviewer context (the frozen first message — problem + reference, never-leak rule)', context, 14, 12);
    excerpt('grader block (grader only, after the rubric; the hidden-test result is added at End)', prep.graderContext, 6, 3);
  } else if (prep) {
    const bank = prep.plan?.storyBank;
    console.log(
      `  story bank           ${bank?.loaded ? `loaded: ${bank.stories} stories, ${bank.confirmed} confirmed` : `UNAVAILABLE (${bank?.error})`}`
    );
    if (bank?.openGaps.length) console.log(`  open bank gaps       ${bank.openGaps.join('; ')}`);
    for (const i of prep.plan?.items ?? []) {
      console.log(`  plan ${i.stage}              ${i.concept}  [${(prep.reasons[i.concept] ?? []).join('; ') || 'base weight'}]`);
    }
    console.log('');
    excerpt('interviewer context (the frozen first message — no stories)', context, 40);
    excerpt('grader story block (grader only, after the rubric)', prep.graderContext, 30, 16);
    const unconfirmedTagged = (prep.graderContext.match(/^OPEN QUESTIONS \(NOT facts/gm) ?? []).length;
    console.log(`  unconfirmed blocks tagged "OPEN QUESTIONS (NOT facts…)": ${unconfirmedTagged}`);
    console.log(`  interviewer context mentions a story id: ${/story-[a-z]/.test(context) ? 'YES — LEAK' : 'no'}\n`);
  }
  console.log(`  model priced as      claude-sonnet-5 (the workhorse default): $${price.input}/M in, $${price.output}/M out,`);
  console.log(`                       cache read $${price.cacheRead}/M, 1-hour cache write $${price.cacheWrite1h}/M`);
  console.log(`  cached prefix        tools ${toolTokens} + system ${systemTokens} + context ${contextTokens} = ~${prefix} tokens`);
  console.log(`                       (Sonnet 5's minimum cacheable prefix is 1,024 tokens — this clears it)`);
  console.log(`  cache plan           1-hour markers on the system block and on the LAST message of every request\n`);

  const first = spec.info.stages[0];
  let state = applyReply(startState(new Date(0), kind, prep), {
    stage: first, stagesCovered: [], mode: 'interview', teach: null, resumePoint: '', say: 'Opening.',
  }, false, false, kind);
  const opening =
    kind === 'behavioral'
      ? 'Thanks for making the time. To start, tell me a bit about yourself.'
      : kind === 'coding'
        ? 'Hi — the problem is beside your editor. Talk me through your understanding of it.'
        : 'Design a ticketing system for live events. Where would you like to start?';
  const stored: StoredTurn[] = [{ seq: 1, role: 'interviewer', rendered: opening }];
  let shown = 0;
  let prevPrefix = prefix;
  // Opening call: writes the whole prefix.
  let total = (prefix * price.cacheWrite1h + REPLY_OUT * price.output) / 1e6;
  console.log('  turn  read(cache)  write(cache)  out   cost      cumulative');
  console.log(`  open  ${String(0).padStart(11)}  ${String(prefix).padStart(12)}  ${String(REPLY_OUT).padStart(4)}  ${usd(total)}  ${usd(total)}`);

  for (let i = 0; i < turns; i++) {
    const { rendered, coding } = renderCandidateMessage({ ...turnOf(script[i]), action: 'answer' }, state, new Date((i + 1) * 3 * 60_000), kind);
    if (kind === 'coding' && shown < 2 && rendered.includes('[editor')) {
      shown++;
      excerpt(`candidate turn ${i + 1} as sent (rendered once, stored, replayed verbatim)`, rendered, 8, 6);
    }
    const msgs = buildMessages(context, stored, rendered);
    const allTokens = toolTokens + systemTokens + msgs.reduce((n, m) => n + tok(m.content), 0);
    const read = prevPrefix;
    const write = allTokens - prevPrefix;
    const cost = (read * price.cacheRead + write * price.cacheWrite1h + REPLY_OUT * price.output) / 1e6;
    total += cost;
    console.log(
      `  ${String(i + 1).padStart(4)}  ${String(read).padStart(11)}  ${String(write).padStart(12)}  ${String(REPLY_OUT).padStart(4)}  ${usd(cost)}  ${usd(total)}`
    );
    stored.push({ seq: stored.length + 1, role: 'candidate', rendered });
    stored.push({ seq: stored.length + 1, role: 'interviewer', rendered: REPLY_SAY });
    state = applyReply(state, { stage: state.stage, stagesCovered: [], mode: 'interview', teach: null, resumePoint: '', say: REPLY_SAY }, true, false, kind);
    if (coding && state.coding) state = { ...state, coding: { ...state.coding, ...coding } };
    // The breakpoint sat on this request's LAST message, so the next request
    // reads up to here and writes the reply plus its own new message.
    prevPrefix = allTokens;
  }

  const transcriptTokens = stored.reduce((n, t) => n + tok(t.rendered), 0);
  const graderExtra = spec.graderContext?.(state) ?? '';
  const gradeIn =
    tok(spec.gradeSystem) + tok(JSON.stringify(spec.gradeTool)) + tok(spec.rubric('staff')) + tok(graderExtra) + transcriptTokens;
  const GRADE_OUT = spec.info.cost.gradeOut;
  const gradeCost = (gradeIn * price.input + GRADE_OUT * price.output) / 1e6;
  total += gradeCost;
  console.log(`  grade ${String(gradeIn).padStart(11)} in    (uncached)  ${String(GRADE_OUT).padStart(4)}  ${usd(gradeCost)}  ${usd(total)}`);
  console.log(`\n  this ${turns}-turn script, graded:  ~${usd(total)}`);
  for (const n of [Math.round(spec.info.typicalTurns * 0.6), spec.info.typicalTurns, spec.info.turnCap]) {
    console.log(`  shape estimate, ${String(n).padStart(2)} turns:     ~${usd(estimateMockCost(n, price, kind).usd)}   (the start card's number)`);
  }
  console.log(`\n  Spent: $0. Replace the estimate with a measurement: bin/mock-dry-run --kind ${kind} --live --turns 4`);
}

async function live(kind: MockKind, script: ScriptTurn[], turns: number, grade: boolean): Promise<void> {
  // Only the live path opens the database (to read the stored routing and key).
  const { hydrateProviderConfig } = await import('../src/server/services/provider.service.js');
  const { hydrate, isConfigured } = await import('../src/server/services/apikey.service.js');
  const { describeRouting, needsAnthropicKey } = await import('../src/server/services/llm.client.js');
  const { interviewerTurn, gradeMock } = await import('../src/server/services/llm.mock.js');
  const { renderTranscript, kindForMode } = await import('../src/server/services/mock.state.js');
  const { addUsage } = await import('../src/server/services/mock.service.js');
  const { emptyUsage } = await import('../src/server/services/mock.store.js');
  hydrateProviderConfig();
  hydrate();
  if (needsAnthropicKey() && !isConfigured()) {
    console.error('No Anthropic API key is configured. Paste one into the setup screen first.');
    process.exit(1);
  }
  console.log(`codegrind :: mock-dry-run --live   (SPENDING)  ${describeRouting()}\n`);

  const spec = mockKindSpec(kind);
  const { prompt, prep, context } = await setup(kind);
  let state = startState(new Date(), kind, prep);
  const stored: StoredTurn[] = [];
  const transcript: (import('../src/shared/mock.js').MockTurn & { editor?: string })[] = [];
  let usage = emptyUsage();
  const line = (label: string, m: CallMeta) =>
    console.log(
      `  ${label.padEnd(5)} in ${String(m.usage.inputTokens).padStart(5)}  cacheRead ${String(m.usage.cachedInputTokens).padStart(6)}  cacheWrite ${String(m.usage.cacheWriteInputTokens ?? 0).padStart(6)}  out ${String(m.usage.outputTokens).padStart(5)}  ${m.latencyMs}ms  total ${usage.costUsd === null ? 'unpriced' : usd(usage.costUsd)}`
    );

  const open = await interviewerTurn(buildMessages(context, []), state.stage, kind);
  usage = addUsage(usage, open.meta);
  state = applyReply(state, open.reply, false, false, kind);
  stored.push({ seq: 1, role: 'interviewer', rendered: open.reply.say });
  transcript.push({ seq: 1, role: 'interviewer', kind: kindForMode(open.reply.mode), content: open.reply.say, stage: open.reply.stage, createdAt: '' });
  line('open', open.meta);

  for (let i = 0; i < turns; i++) {
    const turn = turnOf(script[i]);
    const { rendered, endNote, coding, editor } = renderCandidateMessage({ ...turn, action: 'answer' }, state, new Date(), kind);
    const r = await interviewerTurn(buildMessages(context, stored, rendered), state.stage, kind);
    usage = addUsage(usage, r.meta);
    transcript.push({ seq: stored.length + 1, role: 'candidate', kind: 'answer', content: turn.content, stage: state.stage, createdAt: '', ...(editor ? { editor } : {}) });
    stored.push({ seq: stored.length + 1, role: 'candidate', rendered });
    state = applyReply(state, r.reply, true, endNote, kind);
    if (coding && state.coding) state = { ...state, coding: { ...state.coding, ...coding } };
    transcript.push({ seq: stored.length + 1, role: 'interviewer', kind: kindForMode(r.reply.mode), content: r.reply.say, stage: r.reply.stage, createdAt: '', teach: r.reply.teach });
    stored.push({ seq: stored.length + 1, role: 'interviewer', rendered: r.reply.say });
    line(String(i + 1), r.meta);
    console.log(`        [${r.reply.mode}/${r.reply.stage}] ${r.reply.say.slice(0, 110).replace(/\n/g, ' ')}`);
  }

  if (grade) {
    const graderContext = spec.graderContext?.(state) ?? null;
    const g = await gradeMock({
      kind, level: 'staff', promptTitle: prompt.title, brief: prompt.brief,
      transcript: renderTranscript(transcript, kind), skipped: state.skipped, taught: state.taught,
      ...(graderContext ? { graderContext } : {}),
    });
    for (const m of g.metas) {
      usage = addUsage(usage, m);
      line('grade', m);
    }
    console.log(`        verdict ${g.grade.verdict}; drills: ${g.grade.drills.map((d) => d.concept).join(', ')}`);
  }
  console.log(`\n  measured: ${usage.calls} calls, ${usage.costUsd === null ? 'unpriced model' : usd(usage.costUsd)}`);
  if (stored.length > 2 && usage.cacheReadTokens === 0) {
    console.log('  WARNING: zero cache reads across turns — the conversation cache is not hitting.');
  }
}

const a = args();
if (a.help || (!a.dry && !a.live)) usage();
if (a.dry && a.live) {
  console.error('Pick one: --dry-run (free) or --live (spends).');
  process.exit(2);
}
if (a.dry) await dryRun(MODEL_PRICES['claude-sonnet-5'], a.kind, a.script, a.turns);
else await live(a.kind, a.script, a.turns, a.grade);
