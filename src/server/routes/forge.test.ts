// =============================================================================
// routes/forge — the story forge over HTTP, against a real (temporary) database
// =============================================================================
// The coach call is faked; resume-builder is an in-memory fake with revisions
// (X-Data-Rev, baseRev, 409) and a fake backup script. Pinned: start is free,
// a turn is one call, the cap; SAVE is explicit-only, backs up first, appends
// as status 'draft' with baseRev, refetches on a 409 and appends onto the NEW
// version, never touches an existing story, never saves twice; the retell
// card; and the Today alternation.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ runForgeTurn: vi.fn() }));
vi.mock('../services/llm.forge.js', async (orig) => ({
  ...(await orig<typeof import('../services/llm.forge.js')>()),
  runForgeTurn: fake.runForgeTurn,
}));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-forge-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) throw new Error('refusing to run outside tmpdir');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { forgeRoutes } = await import('./forge.js');
const { todayRoutes } = await import('./today.js');
const { db, setSetting } = await import('../services/db.js');
const svc = await import('../services/forge.service.js');
const { listMocks, STORY_FORGE_ANCHOR } = await import('../services/mock.store.js');
const { withRetellLength } = await import('../services/mock.service.js');
const { deriveSteps } = await import('../services/today.compute.js');

const app = new Hono();
app.route('/api', forgeRoutes);
app.route('/api', todayRoutes);

// 2026-10-22 local (LA) is a forge day with open gaps (day % 3 === 0); the 21st is not.
const NOW = new Date('2026-10-22T20:00:00.000Z');
const META = { servedModel: 'claude-sonnet-5', usage: { inputTokens: 3000, outputTokens: 1500, cachedInputTokens: 0 } };

const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// --- the fake resume-builder ---------------------------------------------------
const EXISTING = {
  id: 'story-existing', title: 'Existing', status: 'confirmed', situation: 'S', task: 'T', action: 'A', result: 'R',
  numbers: ['n'], caveats: ['c'], unconfirmed: ['u'], fits: ['architecture'], doesNotFit: [], hook: 'keep me',
};
let file: Record<string, unknown>;
const rev = () => createHash('sha256').update(JSON.stringify(file, null, 2)).digest('hex').slice(0, 32);
let writes: { baseRev: unknown; data: Record<string, unknown> }[] = [];
let conflictsToServe = 0;
let backups: string[] = [];

function freshFile() {
  file = {
    version: 1,
    updatedAt: '2026-10-14',
    stories: [structuredClone(EXISTING)],
    candidates: [{ title: 'SOW negotiation', source: 'SOW history', fits: ['negotiation'], note: 'Eight versions; maps deferred.' }],
    gaps: [
      { type: 'disagreement or conflict', status: 'open' },
      { type: 'convincing others / persuasion', status: 'partly covered' },
    ],
    factSheet: { note: 'hand-written, pass through' },
  };
}

const rbFetch = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.includes('/api/data/read')) {
    return new Response(JSON.stringify(file), { status: 200, headers: { 'X-Data-Rev': rev() } });
  }
  if (url.includes('/api/data/write')) {
    const body = JSON.parse(String(init?.body));
    writes.push({ baseRev: body.baseRev, data: body.data });
    if (conflictsToServe > 0) {
      conflictsToServe--;
      // Someone else saved in between: the file moved on.
      (file.stories as unknown[]).push({ ...EXISTING, id: 'story-someone-else', title: 'Theirs' });
      return new Response(JSON.stringify({ error: 'conflict', rev: rev() }), { status: 409 });
    }
    if (body.baseRev !== rev()) return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
    file = body.data;
    return new Response(JSON.stringify({ ok: true, rev: rev() }), { status: 200 });
  }
  return new Response('nope', { status: 404 });
});

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.runForgeTurn.mockReset();
  rbFetch.mockClear();
  freshFile();
  writes = [];
  backups = [];
  conflictsToServe = 0;
  svc.setForgeDepsForTest({
    fetchImpl: rbFetch as unknown as typeof fetch,
    backup: async (label: string) => {
      backups.push(label);
      return { ok: true, note: `backups/x-${label}` };
    },
  });
  svc.resetForgeForTest(2);
  for (const t of ['story_forge_sessions', 'daily_sessions', 'mock_gaps', 'mocks', 'interview_loops', 'concept_reps']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setSetting('ai.reviews', false);
  setSetting('envelope.daily', 0);
});

const DRAFT = {
  title: 'One test runner for four platforms',
  question: 'Tell me about a time you got people to adopt a change you could not mandate.',
  situation: 'Local and CI test runs disagreed on four platforms.',
  task: 'A four-week contract to fix flaky CI.',
  action: 'I made repo-owned scripts the single entry point and rewired Jenkins to call them.',
  result: 'Local and CI ran the same commands on all four platforms.',
  complication: 'The iOS lead pushed back.',
  beats: ['Same commands locally and in CI.', 'Four-week contract.', 'Scripts first, then Jenkins.'],
  numbers: ['four platforms'],
  caveats: ['Contract work, not an employee.'],
  unconfirmed: ['How many flaky runs before?'],
  fits: ['influence without authority'],
};
const turnResult = (over: Record<string, unknown> = {}) => ({
  result: { covered: ['situation'], nextBeat: 'role', pushback: [{ kind: 'i-vs-we', note: 'Whose call?' }], draft: DRAFT, done: false, say: 'Whose call was it?', moved: [], ...over },
  meta: META,
});

async function startAndAnswer(n = 1) {
  const s = await (await post('/api/forge/start', { competency: 'influence-without-authority' })).json();
  for (let i = 0; i < n; i++) {
    fake.runForgeTurn.mockResolvedValueOnce(turnResult());
    const r = await post(`/api/forge/${s.id}/turn`, { answer: `answer ${i} — we had four platforms`, expectedAnswers: i });
    expect(r.status).toBe(200);
  }
  return s.id as string;
}

describe('options and start', () => {
  it('lists competencies with open gaps first, candidates and stories — free', async () => {
    const o = await (await app.request('/api/forge/options')).json();
    expect(o.bank.loaded).toBe(true);
    expect(o.competencies[0]).toMatchObject({ id: 'conflict', gap: 'open' });
    expect(o.defaultCompetency).toBe('conflict');
    expect(o.competencies.find((c: { id: string }) => c.id === 'influence-without-authority').gap).toBe('partial');
    expect(o.candidates[0].title).toBe('SOW negotiation');
    expect(o.stories).toEqual([{ id: 'story-existing', title: 'Existing', status: 'confirmed' }]);
    expect(fake.runForgeTurn).not.toHaveBeenCalled();
  });

  it('starts with a static first question (no call); a candidate seed is rendered entirely as open questions', async () => {
    const s = await (await post('/api/forge/start', { competency: 'conflict', candidate: { kind: 'candidate', ref: 'SOW negotiation' } })).json();
    expect(s.status).toBe('active');
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({ role: 'coach', beat: 'situation' });
    expect(s.turns[0].content).toMatch(/Let's capture "SOW negotiation"/);
    expect(fake.runForgeTurn).not.toHaveBeenCalled();
    fake.runForgeTurn.mockResolvedValueOnce(turnResult());
    await post(`/api/forge/${s.id}/turn`, { answer: 'the client red-lined it eight times' });
    const input = fake.runForgeTurn.mock.calls[0][0];
    expect(input.seed).toMatch(/OPEN QUESTIONS \(NOT facts/);
    expect(input.seed).toContain('Eight versions; maps deferred.');
    expect(input.seedConfirmed).toBe('');
    expect(input.knownFacts).toMatch(/NEVER-?|NO live customers/);
    expect(await (await post('/api/forge/start', { competency: 'nope' })).status).toBe(400);
  });
});

describe('a turn', () => {
  it('is one call; stores both turns, the draft, the cost; a failed call stores nothing', async () => {
    const id = await startAndAnswer(1);
    const v = await (await app.request(`/api/forge/${id}`)).json();
    expect(v.turns.map((t: { role: string }) => t.role)).toEqual(['coach', 'you', 'coach']);
    expect(v.turns[2].pushback).toEqual([{ kind: 'i-vs-we', note: 'Whose call?' }]);
    expect(v.draft.title).toBe(DRAFT.title);
    expect(v.costUsd).toBeGreaterThan(0);
    fake.runForgeTurn.mockRejectedValueOnce(new Error('model down'));
    expect((await post(`/api/forge/${id}/turn`, { answer: 'more' })).status).toBe(502);
    expect((await (await app.request(`/api/forge/${id}`)).json()).turns).toHaveLength(3);
    expect((await post(`/api/forge/${id}/turn`, { answer: 'x', expectedAnswers: 0 })).status).toBe(409);
  });

  it('caps a session at 12 answers and then it is a draft', async () => {
    const id = await startAndAnswer(12);
    const v = await (await app.request(`/api/forge/${id}`)).json();
    expect(v.status).toBe('drafted');
    expect((await post(`/api/forge/${id}/turn`, { answer: 'one more' })).status).toBe(409);
    expect(fake.runForgeTurn).toHaveBeenCalledTimes(12);
  });
});

describe('save to the story bank', () => {
  it('needs an explicit click: no confirm → 400 and NOTHING is read, backed up or written', async () => {
    const id = await startAndAnswer(1);
    rbFetch.mockClear();
    expect((await post(`/api/forge/${id}/save`, {})).status).toBe(400);
    expect((await post(`/api/forge/${id}/save`, { confirm: 'yes' })).status).toBe(400);
    expect(rbFetch).not.toHaveBeenCalled();
    expect(backups).toEqual([]);
    expect(writes).toEqual([]);
    // Turns never write either.
    expect(fake.runForgeTurn).toHaveBeenCalledTimes(1);
  });

  it('backs up, appends ONE status:draft story with baseRev, leaves everything else untouched, mints the retell card', async () => {
    const id = await startAndAnswer(2);
    const before = structuredClone(file);
    const baseRev = rev();
    const res = await post(`/api/forge/${id}/save`, { confirm: true });
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(backups).toEqual(['codegrind-forge']);
    expect(writes).toHaveLength(1);
    expect(writes[0].baseRev).toBe(baseRev);
    const stories = file.stories as Record<string, unknown>[];
    expect(stories).toHaveLength(2);
    expect(stories[0]).toEqual(EXISTING);
    expect(stories[1]).toMatchObject({ id: 'story-one-test-runner-for-four-platforms', status: 'draft', title: DRAFT.title, unconfirmed: DRAFT.unconfirmed, doesNotFit: [] });
    for (const k of ['version', 'updatedAt', 'candidates', 'gaps', 'factSheet']) expect(file[k]).toEqual(before[k]);
    expect(v.status).toBe('saved');
    expect(v.savedStoryId).toBe('story-one-test-runner-for-four-platforms');

    const card = db.prepare(`SELECT * FROM mock_gaps WHERE id = ?`).get(v.cardId) as Record<string, string>;
    expect(card.mockId).toBe(STORY_FORGE_ANCHOR);
    expect(card.source).toBe('retell');
    expect(card.concept).toBe('influence-without-authority');
    expect(card.title).toBe(`2-minute retell: ${DRAFT.question}`);
    expect(card.answer).toMatch(/1\) Same commands.*2\) Four-week.*3\) Scripts first.*The number: four platforms\./);
    expect(card.dueAt).toBe('2026-10-23T20:00:00.000Z');
    expect(listMocks().map((m) => m.id)).not.toContain(STORY_FORGE_ANCHOR);

    // Never twice.
    expect((await post(`/api/forge/${id}/save`, { confirm: true })).status).toBe(409);
    expect(writes).toHaveLength(1);
  });

  it('a 409 refetches and appends onto the NEW version — the other writer\'s story survives', async () => {
    const id = await startAndAnswer(1);
    conflictsToServe = 1;
    const res = await post(`/api/forge/${id}/save`, { confirm: true });
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(2);
    expect(writes[1].baseRev).not.toBe(writes[0].baseRev);
    expect((file.stories as { id: string }[]).map((s) => s.id)).toEqual(['story-existing', 'story-someone-else', 'story-one-test-runner-for-four-platforms']);
  });

  it('gives up after repeated 409s without writing anything', async () => {
    const id = await startAndAnswer(1);
    conflictsToServe = 99;
    expect((await post(`/api/forge/${id}/save`, { confirm: true })).status).toBe(409);
    expect((await (await app.request(`/api/forge/${id}`)).json()).status).toBe('active');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mock_gaps`).get()).toEqual({ n: 0 });
  });

  it('never overwrites: a taken id gets a suffix; appendStory refuses an existing id outright', () => {
    expect(svc.uniqueStoryId('Existing', ['story-existing'])).toBe('story-existing-2');
    expect(() => svc.appendStory({ stories: [EXISTING] }, { id: 'story-existing' })).toThrow(/refusing to overwrite/);
    const raw = { stories: [EXISTING], other: { x: 1 } };
    const next = svc.appendStory(raw, { id: 'new' });
    expect(next.other).toBe(raw.other);
    expect((next.stories as unknown[])[0]).toBe(EXISTING);
    expect(raw.stories).toHaveLength(1);
  });

  it('a save without a revision header is refused (never a blind write)', async () => {
    const id = await startAndAnswer(1);
    svc.setForgeDepsForTest({ fetchImpl: (async () => new Response(JSON.stringify(file), { status: 200 })) as unknown as typeof fetch });
    expect((await post(`/api/forge/${id}/save`, { confirm: true })).status).toBe(502);
    expect(writes).toEqual([]);
  });
});

describe('retell card grading', () => {
  it('adds the length check: out of band, a got becomes shaky', () => {
    const base = { grade: 'got' as const, why: 'ok', missing: [], ai: true, costUsd: 0.001 };
    expect(withRetellLength(base, 'word '.repeat(300))).toMatchObject({ grade: 'got', length: { verdict: 'ok', words: 300 } });
    const short = withRetellLength(base, 'word '.repeat(60));
    expect(short.grade).toBe('shaky');
    expect(short.length?.verdict).toBe('short');
    expect(short.missing).toContain('length: too short for two minutes');
    expect(withRetellLength({ ...base, grade: 'missed' }, 'word '.repeat(900)).grade).toBe('missed');
  });
});

describe('Today: the concept step alternates with the story forge', () => {
  const stepOf = async () => {
    const t = await (await app.request('/api/today')).json();
    return t.steps.find((s: { id: string }) => s.id === 'concept');
  };

  it('a forge day: "Story forge" linking /stories; done once a draft exists today', async () => {
    let s = await stepOf();
    expect(s.label).toBe('Story forge');
    expect(s.href).toBe('/stories?from=today&step=concept');
    expect(s.status).toBe('current');
    await startAndAnswer(1);
    s = await stepOf();
    expect(s.status).toBe('done');
    expect(s.result).toBe(`Drafted · ${DRAFT.title}`);
  });

  it('not a forge day: the concept rep as before', async () => {
    vi.setSystemTime(new Date('2026-10-21T20:00:00.000Z'));
    const s = await stepOf();
    expect(s.label).toBe('Concept rep');
    expect(s.href).toBe('/concept?from=today&step=concept');
  });

  it('a behavioral loop within 7 days makes every other day a forge day; no gaps and no loop → never', async () => {
    svc.resetForgeForTest(0);
    vi.setSystemTime(new Date('2026-10-22T20:00:00.000Z'));
    expect((await stepOf()).label).toBe('Concept rep');
    db.prepare(
      `INSERT INTO interview_loops (id, company, date, rounds, postingId, postingTitle, createdAt, updatedAt) VALUES ('l1', 'Acme', '2026-10-27', '["behavioral"]', NULL, NULL, '2026-10-01', '2026-10-01')`
    ).run();
    expect(svc.behavioralLoopDays(new Date('2026-10-22T20:00:00.000Z'))).toBe(5);
    expect((await stepOf()).label).toBe('Story forge');
  });

  it('deriveSteps: a 30-min day turns the forge off; a skip skips it', () => {
    const base = {
      dayStart: '2026-10-22T07:00:00.000Z', attempts: [], mocks: [], cardsDue: 0, reviewsDue: 0, cardsReviewedToday: 0,
      skips: [] as never[], endedEarly: false, mockKind: 'system-design' as const, mockKindLabel: 'System design', hasDebrief: false, debriefVerdict: null,
      forge: { day: true, doneToday: 0, last: null },
    };
    expect(deriveSteps({ ...base, quick: true }).steps.find((s) => s.id === 'concept')).toMatchObject({ status: 'skipped', label: 'Story forge' });
    expect(deriveSteps({ ...base, skips: ['concept'] as never[] }).steps.find((s) => s.id === 'concept')!.status).toBe('skipped');
  });
});
