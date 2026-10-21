// =============================================================================
// forge.service — the story forge (Phase H4)
// =============================================================================
//   options   competencies (open story-bank gaps first), candidates, stories   free
//   start     a session for a competency (+ an optional candidate / story to
//             deepen). The first question is written here, no model call     free
//   turn      one dictated answer → ONE workhorse call (pushback, the updated
//             STAR draft, the next question). At most FORGE_MAX_TURNS answers  ~$0.03
//   save      ONLY on an explicit click ({confirm: true}): back up the bank,
//             APPEND the draft to resume-builder's stories.json as status
//             'draft' (baseRev; a 409 refetches and re-appends), then mint a
//             "2-minute retell" drill card                                    free
//
// resume-builder is the owner of the story bank. This service never edits or
// removes an existing story, never writes without baseRev, and never writes
// on anything but the save click. The draft is the candidate's own words:
// llm.forge enforces that a number they never said cannot stay in it.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  BQ_COMPETENCIES,
  competencyLabel,
  type BqCompetency,
} from '../../shared/behavioral-questions.js';
import {
  FORGE_MAX_ANSWER_CHARS,
  FORGE_MAX_CALLS_PER_DAY,
  FORGE_MAX_TURNS,
  defaultRetellQuestion,
  draftSavable,
  forgeDay,
  isForgeCompetency,
  retellCard,
  type ForgeOptions,
  type ForgeSessionView,
  type ForgeTurn,
  type StoryDraft,
} from '../../shared/story-forge.js';
import { capDueAtIso } from '../../shared/loops.js';
import { costOf } from '../../shared/mock.js';
import { costOfMeta } from './ai-usage.service.js';
import { listLoops, loopDeadlineMs } from './db.js';
import { routingFor } from './llm.client.js';
import { runForgeTurn } from './llm.forge.js';
import { STORY_FORGE_ANCHOR, ensureStoryForgeAnchor, insertGap } from './mock.store.js';
import {
  CANDIDATE_KNOWN_FACTS,
  DEFAULT_STORY_BANK_URL,
  gapCompetencies,
  normalizeBank,
  renderStoryForGrader,
  type Story,
} from './story-bank.js';
import { dayStartMs, localDay, todayTz } from './today.compute.js';
import * as store from './forge.store.js';

export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429 | 502
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 4000;

function today(now: Date): string {
  return localDay(now.getTime(), todayTz());
}

// -----------------------------------------------------------------------------
// resume-builder I/O (seams for tests)
// -----------------------------------------------------------------------------

function rbBase(): string {
  return (process.env.CODEGRIND_STORY_BANK_URL || DEFAULT_STORY_BANK_URL).replace(/\/+$/, '');
}

/** resume-builder's install dir, for its own bin/backup. */
export function rbDir(): string {
  return process.env.CODEGRIND_RB_DIR || '/mnt/hexinas/apps/resume-builder';
}

export interface BackupResult {
  ok: boolean;
  note: string;
}

/**
 * resume-builder's own `bash bin/backup <label>` (copies stories.json and the
 * other small JSON files to backups/<stamp>-<label>/). Skipped — never fatal —
 * when the script is missing or fails: baseRev still protects the write.
 */
async function runRbBackup(label: string): Promise<BackupResult> {
  const dir = rbDir();
  const script = path.join(dir, 'bin', 'backup');
  if (!existsSync(script)) return { ok: false, note: `no ${script}; relying on baseRev` };
  return new Promise((resolve) => {
    // `bash <script>`: exec bits are unreliable on the pool (mergerfs/NTFS).
    execFile('bash', ['bin/backup', label], { cwd: dir, timeout: 20_000 }, (err, stdout) => {
      if (err) resolve({ ok: false, note: `bin/backup failed (${err.message.slice(0, 120)}); relying on baseRev` });
      else resolve({ ok: true, note: (stdout.match(/Backed up to (.+)/)?.[1] ?? 'backed up').trim() });
    });
  });
}

let deps: { fetchImpl: typeof fetch; backup: (label: string) => Promise<BackupResult> } = {
  fetchImpl: (...a) => fetch(...a),
  backup: runRbBackup,
};

/** Test seam: fake resume-builder and its backup script. */
export function setForgeDepsForTest(d: Partial<typeof deps>): void {
  deps = { ...deps, ...d };
}

/** The whole stories.json, untouched, with its revision. */
export async function readRawBank(): Promise<{ raw: Record<string, unknown>; rev: string }> {
  let res: Response;
  try {
    res = await deps.fetchImpl(`${rbBase()}/api/data/read?file=stories.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    throw new ForgeError(`resume-builder is unreachable (${err instanceof Error ? err.message.slice(0, 100) : err}).`, 502);
  }
  if (!res.ok) throw new ForgeError(`resume-builder answered ${res.status} reading the story bank.`, 502);
  const rev = res.headers.get('X-Data-Rev');
  if (!rev) throw new ForgeError('resume-builder sent no X-Data-Rev; refusing to write without a revision.', 502);
  const raw = (await res.json()) as Record<string, unknown>;
  if (!raw || !Array.isArray(raw.stories)) throw new ForgeError('stories.json has no stories array.', 502);
  return { raw, rev };
}

/** POST the whole file with baseRev. 409 = stale. */
async function writeRawBank(data: Record<string, unknown>, baseRev: string): Promise<'ok' | 'conflict'> {
  let res: Response;
  try {
    res = await deps.fetchImpl(`${rbBase()}/api/data/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'stories.json', data, baseRev }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ForgeError(`resume-builder is unreachable (${err instanceof Error ? err.message.slice(0, 100) : err}).`, 502);
  }
  if (res.status === 409) return 'conflict';
  if (!res.ok) throw new ForgeError(`resume-builder refused the write (${res.status}).`, 502);
  return 'ok';
}

// -----------------------------------------------------------------------------
// Pure: the story record and the append
// -----------------------------------------------------------------------------

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'story';
}

/** A story id not already in the bank: `story-<slug>`, then `-2`, `-3`… Pure. */
export function uniqueStoryId(title: string, existing: readonly string[]): string {
  const base = `story-${slug(title)}`;
  if (!existing.includes(base)) return base;
  for (let i = 2; ; i++) if (!existing.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** The draft in resume-builder's Story shape, ALWAYS status 'draft'. Pure. */
export function toBankStory(draft: StoryDraft, competency: BqCompetency, id: string, now: Date): Story & Record<string, unknown> {
  return {
    id,
    title: draft.title,
    status: 'draft',
    situation: draft.situation,
    task: draft.task,
    action: draft.action,
    result: draft.result,
    ...(draft.complication ? { complication: draft.complication } : {}),
    numbers: [...draft.numbers],
    caveats: [...draft.caveats],
    unconfirmed: [...draft.unconfirmed],
    fits: draft.fits.length ? [...draft.fits] : [competencyLabel(competency).toLowerCase()],
    doesNotFit: [],
    source: 'codegrind story forge (dictated; review before confirming)',
    createdAt: now.toISOString(),
  };
}

/**
 * APPEND ONLY: a new object whose `stories` is the old list plus one, every
 * other key (and every existing story) passed through by reference. Throws if
 * the id is taken — an existing story is never replaced. Pure.
 */
export function appendStory(raw: Record<string, unknown>, story: { id: string }): Record<string, unknown> {
  const stories = raw.stories;
  if (!Array.isArray(stories)) throw new ForgeError('stories.json has no stories array.', 502);
  if (stories.some((s) => (s as { id?: unknown })?.id === story.id)) {
    throw new ForgeError(`A story with id ${story.id} already exists; refusing to overwrite it.`, 409);
  }
  return { ...raw, stories: [...stories, story] };
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------

function toView(r: store.ForgeRow): ForgeSessionView {
  return {
    id: r.id,
    day: r.day,
    seed: { competency: r.seed.competency, candidate: r.seed.candidate },
    status: r.status,
    turns: r.turns,
    covered: r.covered,
    draft: r.draft,
    answers: r.turns.filter((t) => t.role === 'you').length,
    maxTurns: FORGE_MAX_TURNS,
    savedStoryId: r.savedStoryId,
    cardId: r.cardId,
    costUsd: r.costUsd,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A typical turn (~3k in incl. the growing transcript, ~1.8k out incl. thinking) on the workhorse. */
export function forgeTurnEstimateUsd(): number | null {
  try {
    return costOf(routingFor('workhorse').model, { inputTokens: 3000, outputTokens: 1800, cacheReadTokens: 0, cacheWriteTokens: 0 });
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The bank's open gaps, cached for Today (which is synchronous)
// -----------------------------------------------------------------------------
let gapCache: { openGaps: number; at: number } | null = null;
let gapRefreshing = false;
const GAP_CACHE_MS = 30 * 60 * 1000;

function noteGaps(raw: Record<string, unknown>, now: number): void {
  try {
    gapCache = { openGaps: gapCompetencies(normalizeBank(raw)).size, at: now };
  } catch {
    /* a broken bank leaves the cache as it was */
  }
}

/** Open gaps as last read; null when never read. Kicks a background refresh when stale. Never throws. */
export function cachedOpenGaps(now = Date.now()): number | null {
  // Never from a test run: the suite must not reach a real resume-builder.
  if ((!gapCache || now - gapCache.at > GAP_CACHE_MS) && !gapRefreshing && !process.env.VITEST) {
    gapRefreshing = true;
    readRawBank()
      .then(({ raw }) => noteGaps(raw, Date.now()))
      .catch(() => {})
      .finally(() => {
        gapRefreshing = false;
      });
  }
  return gapCache?.openGaps ?? null;
}

/** For tests. */
export function resetForgeForTest(openGaps: number | null = null): void {
  gapCache = openGaps === null ? null : { openGaps, at: Date.now() + 365 * DAY_MS };
  inFlight.clear();
}

// -----------------------------------------------------------------------------
// Options and start
// -----------------------------------------------------------------------------

/** GET /api/forge/options. Free; a down resume-builder still lets a forge start. */
export async function forgeOptions(now = new Date()): Promise<ForgeOptions> {
  let raw: Record<string, unknown> | null = null;
  let error: string | undefined;
  try {
    raw = (await readRawBank()).raw;
    noteGaps(raw, now.getTime());
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const bank = raw ? normalizeBank(raw) : null;
  const gaps = bank ? gapCompetencies(bank) : new Map();
  const competencies = BQ_COMPETENCIES.map((c) => ({ id: c, label: competencyLabel(c), gap: (gaps.get(c) ?? null) as 'open' | 'partial' | null }));
  // Open gaps first, then partial, then the rest — the user's known weak spot leads its group.
  const rank = (g: 'open' | 'partial' | null) => (g === 'open' ? 0 : g === 'partial' ? 1 : 2);
  competencies.sort((a, b) => rank(a.gap) - rank(b.gap) || Number(b.id === 'influence-without-authority') - Number(a.id === 'influence-without-authority'));
  const candidates = (Array.isArray(raw?.candidates) ? (raw!.candidates as Record<string, unknown>[]) : [])
    .filter((c) => c && typeof c.title === 'string')
    .map((c) => ({
      title: c.title as string,
      note: typeof c.note === 'string' ? c.note : '',
      fits: Array.isArray(c.fits) ? (c.fits as unknown[]).filter((f): f is string => typeof f === 'string') : [],
    }));
  return {
    competencies,
    candidates,
    stories: (bank?.stories ?? []).map((s) => ({ id: s.id, title: s.title, status: s.status })),
    defaultCompetency: competencies.find((c) => c.gap === 'open')?.id ?? 'influence-without-authority',
    bank: raw ? { loaded: true } : { loaded: false, error },
    recent: store.recentSessions(6).map(toView),
    estimateUsd: forgeTurnEstimateUsd(),
  };
}

function confirmedText(s: Story): string {
  return [s.situation, s.task, s.action, s.result, s.complication ?? '', ...s.numbers].filter(Boolean).join('\n');
}

/** The opening question: written here, no model call. Pure. */
export function openingQuestion(competency: BqCompetency, candidate: { kind: string; title: string } | null): string {
  const q = defaultRetellQuestion(competency);
  if (candidate?.kind === 'story') {
    return `Let's deepen "${candidate.title}" for ${competencyLabel(competency).toLowerCase()} — the question it should answer: "${q}" Start with the situation in your own words: where were you, what was going on, and why did it matter?`;
  }
  if (candidate) {
    return `Let's capture "${candidate.title}" as a story for ${competencyLabel(competency).toLowerCase()}. Start with the situation in your own words: where were you, what was going on, and why did it matter?`;
  }
  return `The question this story answers: "${q}" Think of one specific time. Start with the situation: where were you, what was going on, and why did it matter? Two or three sentences.`;
}

/** POST /api/forge/start {competency, candidate?: {kind: 'candidate'|'story', ref}}. Free. */
export async function startForge(body: unknown, now = new Date()): Promise<ForgeSessionView> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isForgeCompetency(b.competency)) throw new ForgeError('Pick a competency.', 400);
  const competency = b.competency;
  const c = (b.candidate ?? null) as Record<string, unknown> | null;
  let seed: store.StoredSeed = { competency, candidate: null, text: '', confirmed: '' };
  if (c && (c.kind === 'candidate' || c.kind === 'story') && typeof c.ref === 'string' && c.ref) {
    const { raw } = await readRawBank();
    if (c.kind === 'story') {
      const s = normalizeBank(raw).stories.find((x) => x.id === c.ref);
      if (!s) throw new ForgeError('That story is not in the bank.', 400);
      seed = { competency, candidate: { kind: 'story', ref: s.id, title: s.title }, text: renderStoryForGrader(s), confirmed: confirmedText(s) };
    } else {
      const cand = (Array.isArray(raw.candidates) ? (raw.candidates as Record<string, unknown>[]) : []).find((x) => x?.title === c.ref);
      if (!cand) throw new ForgeError('That candidate is not in the bank.', 400);
      // A candidate's note is a lead, not a confirmed story: all of it is an open question.
      const note = typeof cand.note === 'string' ? cand.note : '';
      seed = {
        competency,
        candidate: { kind: 'candidate', ref: c.ref, title: c.ref },
        text: [
          `<candidate title="${c.ref}">`,
          `source: ${typeof cand.source === 'string' ? cand.source : 'unknown'}`,
          'OPEN QUESTIONS (NOT facts — a note written before the candidate told this story; confirm each detail with them before using it):',
          note ? `  - ${note}` : '  - (no note)',
          '</candidate>',
        ].join('\n'),
        confirmed: '',
      };
    }
  }
  const row: store.ForgeRow = {
    id: nanoid(),
    day: today(now),
    seed,
    status: 'active',
    turns: [{ role: 'coach', content: openingQuestion(competency, seed.candidate), beat: 'situation', createdAt: now.toISOString() }],
    covered: [],
    draft: null,
    savedStoryId: null,
    cardId: null,
    costUsd: 0,
    calls: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  store.insertSession(row);
  return toView(row);
}

export function getForge(id: string): ForgeSessionView {
  const r = store.getSession(id);
  if (!r) throw new ForgeError('No such forge session.', 404);
  return toView(r);
}

// -----------------------------------------------------------------------------
// A turn
// -----------------------------------------------------------------------------
const inFlight = new Set<string>();

/** POST /api/forge/:id/turn {answer, expectedAnswers}. ONE workhorse call. */
export async function forgeTurn(id: string, body: unknown, now = new Date()): Promise<ForgeSessionView> {
  const b = (body ?? {}) as Record<string, unknown>;
  const answer = typeof b.answer === 'string' ? b.answer.trim() : '';
  if (!answer) throw new ForgeError('Say something first.', 400);
  if (answer.length > FORGE_MAX_ANSWER_CHARS) throw new ForgeError(`That answer is over ${FORGE_MAX_ANSWER_CHARS} characters — split it up.`, 400);
  const row = store.getSession(id);
  if (!row) throw new ForgeError('No such forge session.', 404);
  if (row.status === 'saved' || row.status === 'abandoned') throw new ForgeError('That session is closed.', 409);
  const answers = row.turns.filter((t) => t.role === 'you').length;
  if (Number.isInteger(b.expectedAnswers) && b.expectedAnswers !== answers) throw new ForgeError('The session moved on — reload it.', 409);
  if (answers >= FORGE_MAX_TURNS) throw new ForgeError(`That is ${FORGE_MAX_TURNS} answers — save the draft or start over.`, 409);
  if (inFlight.has(id)) throw new ForgeError('The coach is already answering.', 429);
  const day = today(now);
  if (store.callsOfDay(day) >= FORGE_MAX_CALLS_PER_DAY) throw new ForgeError('That is enough forging for today — come back tomorrow.', 429);

  const mine: ForgeTurn = { role: 'you', content: answer, createdAt: now.toISOString() };
  const turns = [...row.turns, mine];
  inFlight.add(id);
  try {
    const { result, meta } = await runForgeTurn({
      competency: row.seed.competency,
      seed: row.seed.text,
      seedConfirmed: row.seed.confirmed,
      knownFacts: CANDIDATE_KNOWN_FACTS,
      turns,
      answers: answers + 1,
      maxTurns: FORGE_MAX_TURNS,
    });
    if (!result.say) throw new Error('the coach came back with nothing to say');
    const spent = answers + 1 >= FORGE_MAX_TURNS;
    const next: store.ForgeRow = {
      ...row,
      turns: [
        ...turns,
        { role: 'coach', content: result.say, beat: result.nextBeat, pushback: result.pushback, createdAt: new Date(now.getTime() + 1).toISOString() },
      ],
      covered: result.covered,
      draft: result.draft,
      status: result.done || spent ? 'drafted' : 'active',
      costUsd: row.costUsd + (costOfMeta(meta) ?? 0),
      calls: row.calls + 1,
      updatedAt: now.toISOString(),
    };
    store.updateSession(next);
    return toView(next);
  } finally {
    inFlight.delete(id);
  }
}

export function abandonForge(id: string, now = new Date()): ForgeSessionView {
  const row = store.getSession(id);
  if (!row) throw new ForgeError('No such forge session.', 404);
  if (row.status === 'saved') throw new ForgeError('That draft is already in the story bank.', 409);
  const next = { ...row, status: 'abandoned' as const, updatedAt: now.toISOString() };
  store.updateSession(next);
  return toView(next);
}

// -----------------------------------------------------------------------------
// Save: explicit click only, append-only, baseRev, then the retell card
// -----------------------------------------------------------------------------
const saving = new Set<string>();
const MAX_CONFLICT_RETRIES = 2;

/** POST /api/forge/:id/save {confirm: true}. */
export async function saveForge(id: string, body: unknown, now = new Date()): Promise<ForgeSessionView & { backup: BackupResult }> {
  if ((body as Record<string, unknown> | null)?.confirm !== true) {
    throw new ForgeError('Saving to the story bank needs an explicit click (confirm: true).', 400);
  }
  const row = store.getSession(id);
  if (!row) throw new ForgeError('No such forge session.', 404);
  if (row.status === 'saved' || row.savedStoryId) throw new ForgeError('That draft is already in the story bank.', 409);
  if (row.status === 'abandoned') throw new ForgeError('That session was abandoned.', 409);
  if (!draftSavable(row.draft)) throw new ForgeError('The draft needs a title, situation, action and result first.', 409);
  if (saving.has(id)) throw new ForgeError('Already saving.', 429);
  saving.add(id);
  try {
    const backup = await deps.backup('codegrind-forge');
    let storyId = '';
    for (let attempt = 0; ; attempt++) {
      // Read fresh every attempt: a 409 means someone wrote in between, and the
      // append goes onto THEIR version — nothing of theirs is overwritten.
      const { raw, rev } = await readRawBank();
      const ids = (raw.stories as { id?: unknown }[]).map((s) => String(s?.id ?? ''));
      storyId = uniqueStoryId(row.draft!.title, ids);
      const next = appendStory(raw, toBankStory(row.draft!, row.seed.competency, storyId, now));
      const r = await writeRawBank(next, rev);
      if (r === 'ok') {
        noteGaps(next, now.getTime());
        break;
      }
      if (attempt >= MAX_CONFLICT_RETRIES) throw new ForgeError('The story bank kept changing under the save (409). Try again.', 409);
    }
    const cardId = mintRetellCard(row.draft!, row.seed.competency, now);
    const saved: store.ForgeRow = { ...row, status: 'saved', savedStoryId: storyId, cardId, updatedAt: now.toISOString() };
    store.updateSession(saved);
    return { ...toView(saved), backup };
  } finally {
    saving.delete(id);
  }
}

/**
 * The "2-minute retell" card: front "Tell me about a time you…", back the three
 * beats + the number. Due TOMORROW (you just wrote it), capped by a loop's
 * final-review day. Never throws: a failed mint never undoes the save.
 */
function mintRetellCard(draft: StoryDraft, competency: BqCompetency, now: Date): number | null {
  try {
    ensureStoryForgeAnchor();
    const card = retellCard(draft, competency);
    const due = capDueAtIso(new Date(now.getTime() + DAY_MS).toISOString(), now.getTime(), loopDeadlineMs(now.getTime()));
    return insertGap(
      STORY_FORGE_ANCHOR,
      { seq: null, concept: competency, type: 'skill', title: card.title, summary: card.summary, answer: card.answer, source: 'retell' },
      now,
      due
    );
  } catch (err) {
    console.error('[forge] retell card mint failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// What Today, the step review and the debrief read
// -----------------------------------------------------------------------------

/** Today's forge work: sessions that produced a draft. Never throws. */
export function todayForge(now = new Date()): { doneToday: number; last: { title: string; status: string } | null } {
  try {
    const done = store.sessionsOfDay(today(now)).filter((s) => s.draft && s.status !== 'abandoned');
    const last = done[done.length - 1];
    return { doneToday: done.length, last: last ? { title: last.draft!.title || 'untitled story', status: last.status } : null };
  } catch {
    return { doneToday: 0, last: null };
  }
}

/** Days to the nearest loop with a behavioral or deep-dive round, or null. Never throws. */
export function behavioralLoopDays(now = new Date()): number | null {
  try {
    const d = today(now);
    const days = listLoops()
      .filter((l) => l.date >= d && l.rounds.some((r) => r === 'behavioral' || r === 'project-deep-dive'))
      .map((l) => Math.round((dayStartMs(l.date, todayTz()) - dayStartMs(d, todayTz())) / DAY_MS));
    return days.length ? Math.min(...days) : null;
  } catch {
    return null;
  }
}

/** Is today's concept step a story-forge session? Never throws. */
export function isForgeDayNow(repDoneToday: boolean, now = new Date()): boolean {
  try {
    return forgeDay({
      date: today(now),
      openGaps: cachedOpenGaps(now.getTime()),
      behavioralLoopDays: behavioralLoopDays(now),
      repDoneToday,
      forgeDoneToday: todayForge(now).doneToday > 0,
    });
  } catch {
    return false;
  }
}

/** One line per forge session today, for the step review and the debrief. Never throws. */
export function forgeDigest(now = new Date()): string[] {
  try {
    return store
      .sessionsOfDay(today(now))
      .filter((s) => s.draft)
      .map((s) => {
        const pb = s.turns.flatMap((t) => t.pushback ?? []).map((p) => p.kind);
        return (
          `Story forge "${s.draft!.title}" (${competencyLabel(s.seed.competency)}): ${s.status}, ${s.covered.length}/6 beats` +
          (pb.length ? `; pushback: ${[...new Set(pb)].join(', ')}` : '') +
          (s.draft!.unconfirmed.length ? `; ${s.draft!.unconfirmed.length} detail(s) still unconfirmed` : '')
        );
      });
  } catch {
    return [];
  }
}
