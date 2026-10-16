// What a mock interview costs, turn by turn. Run via bin/mock-dry-run.
//
//   bin/mock-dry-run --dry-run              # FREE: print the plan and the estimate
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

import { INTERVIEWER_SYSTEM, INTERVIEWER_TOOL, GRADE_SYSTEM, EMIT_MOCK_GRADE_TOOL } from '../src/server/services/llm.mock.js';
import {
  applyReply,
  buildContext,
  buildMessages,
  initialState,
  renderCandidateMessage,
  type StoredTurn,
} from '../src/server/services/mock.state.js';
import { RUBRIC_TEXT } from '../src/server/services/sd-rubric.js';
import { sdPrompt } from '../src/shared/sd-prompts.js';
import { MODEL_PRICES, estimateMockCost, type ModelPrice } from '../src/shared/mock.js';
import type { CallMeta } from '../src/server/services/llm.types.js';

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

function args() {
  const a = process.argv.slice(2);
  const flag = (f: string) => a.includes(f);
  const n = a.indexOf('--turns');
  return {
    dry: flag('--dry-run'),
    live: flag('--live'),
    grade: flag('--grade'),
    turns: n >= 0 ? Math.max(1, Math.min(SCRIPT.length, parseInt(a[n + 1] ?? '', 10) || SCRIPT.length)) : SCRIPT.length,
    help: flag('--help') || flag('-h') || a.length === 0,
  };
}

function usage(): never {
  console.log(
    [
      'usage: bin/mock-dry-run --dry-run | --live [--turns N] [--grade]',
      '',
      '  --dry-run   print the request plan and the cost estimate. Spends nothing.',
      `  --live      run a ${SCRIPT.length}-turn scripted mock against the configured workhorse.`,
      '              SPENDS REAL MONEY (about $0.10-0.30). Stores nothing.',
      '  --turns N   with --live: stop after N candidate turns',
      '  --grade     with --live: also grade the scripted mock (one more call, ~$0.10)',
    ].join('\n')
  );
  process.exit(0);
}

const usd = (n: number) => `$${n.toFixed(4)}`;

function dryRun(price: ModelPrice, turns: number): void {
  const prompt = sdPrompt('event-ticketing')!;
  const context = buildContext(prompt, 'staff');
  const toolTokens = tok(JSON.stringify(INTERVIEWER_TOOL));
  const systemTokens = tok(INTERVIEWER_SYSTEM);
  const contextTokens = tok(context);
  const prefix = toolTokens + systemTokens + contextTokens;
  // An interviewer reply's visible line, and the tool call around it.
  const REPLY_SAY = 'Good. And when two buyers hold the same seat in the same second, what happens to the loser?';
  const REPLY_OUT = 400;

  console.log('codegrind :: mock-dry-run --dry-run   (nothing is sent; token counts are ESTIMATES, chars/3.2)\n');
  console.log(`  model priced as      claude-sonnet-5 (the workhorse default): $${price.input}/M in, $${price.output}/M out,`);
  console.log(`                       cache read $${price.cacheRead}/M, 1-hour cache write $${price.cacheWrite1h}/M`);
  console.log(`  cached prefix        tools ${toolTokens} + system ${systemTokens} + context ${contextTokens} = ~${prefix} tokens`);
  console.log(`                       (Sonnet 5's minimum cacheable prefix is 1,024 tokens — this clears it)`);
  console.log(`  cache plan           1-hour markers on the system block and on the LAST message of every request\n`);

  let state = applyReply(initialState(new Date(0)), {
    stage: 'requirements', stagesCovered: [], mode: 'interview', teach: null, resumePoint: '', say: 'Opening.',
  }, false, false);
  const stored: StoredTurn[] = [{ seq: 1, role: 'interviewer', rendered: 'Design a ticketing system for live events. Where would you like to start?' }];
  let prevPrefix = prefix;
  // Opening call: writes the whole prefix.
  let total = (prefix * price.cacheWrite1h + REPLY_OUT * price.output) / 1e6;
  console.log('  turn  read(cache)  write(cache)  out   cost      cumulative');
  console.log(`  open  ${String(0).padStart(11)}  ${String(prefix).padStart(12)}  ${String(REPLY_OUT).padStart(4)}  ${usd(total)}  ${usd(total)}`);

  for (let i = 0; i < turns; i++) {
    const { rendered } = renderCandidateMessage({ content: SCRIPT[i], action: 'answer' }, state, new Date((i + 1) * 3 * 60_000));
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
    state = applyReply(state, { stage: 'requirements', stagesCovered: [], mode: 'interview', teach: null, resumePoint: '', say: REPLY_SAY }, true, false);
    // The breakpoint sat on this request's LAST message, so the next request
    // reads up to here and writes the reply plus its own new message.
    prevPrefix = allTokens;
  }

  const transcriptTokens = stored.reduce((n, t) => n + tok(t.rendered), 0);
  const gradeIn = tok(GRADE_SYSTEM) + tok(JSON.stringify(EMIT_MOCK_GRADE_TOOL)) + tok(RUBRIC_TEXT.staff) + transcriptTokens;
  const GRADE_OUT = 8000;
  const gradeCost = (gradeIn * price.input + GRADE_OUT * price.output) / 1e6;
  total += gradeCost;
  console.log(`  grade ${String(gradeIn).padStart(11)} in    (uncached)  ${String(GRADE_OUT).padStart(4)}  ${usd(gradeCost)}  ${usd(total)}`);
  console.log(`\n  this ${turns}-turn script, graded:  ~${usd(total)}`);
  for (const n of [15, 25, 40]) {
    console.log(`  shape estimate, ${String(n).padStart(2)} turns:     ~${usd(estimateMockCost(n, price).usd)}   (the start card's number)`);
  }
  console.log('\n  Spent: $0. Replace the estimate with a measurement: bin/mock-dry-run --live --turns 4');
}

async function live(turns: number, grade: boolean): Promise<void> {
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

  const prompt = sdPrompt('event-ticketing')!;
  const context = buildContext(prompt, 'staff');
  let state = initialState(new Date());
  const stored: StoredTurn[] = [];
  const transcript: import('../src/shared/mock.js').MockTurn[] = [];
  let usage = emptyUsage();
  const line = (label: string, m: CallMeta) =>
    console.log(
      `  ${label.padEnd(5)} in ${String(m.usage.inputTokens).padStart(5)}  cacheRead ${String(m.usage.cachedInputTokens).padStart(6)}  cacheWrite ${String(m.usage.cacheWriteInputTokens ?? 0).padStart(6)}  out ${String(m.usage.outputTokens).padStart(5)}  ${m.latencyMs}ms  total ${usage.costUsd === null ? 'unpriced' : usd(usage.costUsd)}`
    );

  const open = await interviewerTurn(buildMessages(context, []), state.stage);
  usage = addUsage(usage, open.meta);
  state = applyReply(state, open.reply, false, false);
  stored.push({ seq: 1, role: 'interviewer', rendered: open.reply.say });
  transcript.push({ seq: 1, role: 'interviewer', kind: kindForMode(open.reply.mode), content: open.reply.say, stage: open.reply.stage, createdAt: '' });
  line('open', open.meta);

  for (let i = 0; i < turns; i++) {
    const { rendered, endNote } = renderCandidateMessage({ content: SCRIPT[i], action: 'answer' }, state, new Date());
    const r = await interviewerTurn(buildMessages(context, stored, rendered), state.stage);
    usage = addUsage(usage, r.meta);
    transcript.push({ seq: stored.length + 1, role: 'candidate', kind: 'answer', content: SCRIPT[i], stage: state.stage, createdAt: '' });
    stored.push({ seq: stored.length + 1, role: 'candidate', rendered });
    state = applyReply(state, r.reply, true, endNote);
    transcript.push({ seq: stored.length + 1, role: 'interviewer', kind: kindForMode(r.reply.mode), content: r.reply.say, stage: r.reply.stage, createdAt: '', teach: r.reply.teach });
    stored.push({ seq: stored.length + 1, role: 'interviewer', rendered: r.reply.say });
    line(String(i + 1), r.meta);
    console.log(`        [${r.reply.mode}/${r.reply.stage}] ${r.reply.say.slice(0, 110).replace(/\n/g, ' ')}`);
  }

  if (grade) {
    const g = await gradeMock({
      level: 'staff', promptTitle: prompt.title, brief: prompt.brief,
      transcript: renderTranscript(transcript), skipped: state.skipped, taught: state.taught,
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
if (a.dry) dryRun(MODEL_PRICES['claude-sonnet-5'], a.turns);
else await live(a.turns, a.grade);
