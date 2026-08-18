// =============================================================================
// bank route + pace service — "what would happen if I asked for one right now?"
// =============================================================================
// The defect this exists to close: /manual defaulted to `two-pointer`/`easy` and
// auto-loaded on mount, while seeding only ever stocks `easy` x the four
// ROOT_TOPICS. That slot is empty BY CONSTRUCTION on a fresh install, so a
// brand-new user's first click paid a full cold generation. `suggested` must
// therefore point at a slot that can actually serve, and must keep doing so as
// the bank changes — which is why it is a query and not a second hardcoded topic.

import { describe as suite, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BankStatus, Difficulty, Topic } from '../../shared/types.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-bank-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { bankRoutes, pickSuggested } = await import('./bank.js');
const pace = await import('../services/pace.service.js');
const db = await import('../services/db.js');

const app = new Hono();
app.route('/api', bankRoutes);

let seq = 0;
function bank(
  topic: Topic,
  difficulty: Difficulty,
  opts: { used?: boolean; canonicalized?: boolean } = {},
): void {
  db.insertProblem({
    id: `p-${++seq}`,
    language: 'javascript',
    title: `T${seq}`,
    prompt: 'x',
    examples: [],
    constraints: [],
    difficulty,
    topic,
    pattern: 'p',
    starterCode: '',
    functionName: 'f',
    sampleTests: [],
    hiddenTests: [],
    referenceSolution: '',
    canonicalized: opts.canonicalized ?? true,
    used: opts.used ?? false,
    createdAt: new Date().toISOString(),
  });
}

async function status(): Promise<BankStatus> {
  const res = await app.request('/api/bank');
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  db.db.exec('DELETE FROM problems; DELETE FROM settings;');
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

suite('GET /api/bank', () => {
  it('suggests nothing when the bank is empty, rather than a slot that would generate', async () => {
    const s = await status();
    expect(s.servableTotal).toBe(0);
    expect(s.slots).toEqual([]);
    expect(s.suggested).toBeNull();
  });

  it('counts only what could actually be handed out', async () => {
    bank('arrays', 'easy');
    bank('arrays', 'easy', { used: true }); // already served
    bank('arrays', 'easy', { canonicalized: false }); // never verifiable
    const s = await status();
    expect(s.servableTotal).toBe(1);
    expect(s.slots).toEqual([{ topic: 'arrays', difficulty: 'easy', servable: 1 }]);
  });

  it('suggests a slot the bank can serve — never the old two-pointer default', async () => {
    // Exactly what `bin/seed-bank` leaves behind on a fresh install.
    for (const topic of ['arrays', 'hashing', 'math', 'bit-manipulation'] as Topic[]) {
      bank(topic, 'easy');
      bank(topic, 'easy');
    }
    const s = await status();
    expect(s.suggested).toEqual({ topic: 'arrays', difficulty: 'easy' });
    expect(s.slots.some((slot) => slot.topic === 'two-pointer')).toBe(false);
  });

  it('follows the bank rather than a hardcoded topic when arrays is exhausted', async () => {
    bank('hashing', 'easy');
    const s = await status();
    expect(s.suggested).toEqual({ topic: 'hashing', difficulty: 'easy' });
  });

  it('reports no pace at all before anything has been measured', async () => {
    const s = await status();
    expect(s.generationSeconds).toBeNull();
    expect(s.generationSource).toBeNull();
  });
});

suite('pickSuggested — the ordering, without a database', () => {
  const slot = (topic: Topic, difficulty: Difficulty, servable: number) => ({
    topic,
    difficulty,
    servable,
  });

  it('prefers the easiest difficulty over a deeper harder slot', () => {
    expect(
      pickSuggested([slot('graphs', 'hard', 9), slot('trees', 'easy', 1)]),
    ).toEqual({ topic: 'trees', difficulty: 'easy' });
  });

  it('prefers a curriculum root topic at the same difficulty', () => {
    expect(
      pickSuggested([slot('trees', 'easy', 5), slot('hashing', 'easy', 1)]),
    ).toEqual({ topic: 'hashing', difficulty: 'easy' });
  });

  it('prefers arrays among the roots — the same first step the study track takes', () => {
    expect(
      pickSuggested([slot('hashing', 'easy', 5), slot('arrays', 'easy', 1)]),
    ).toEqual({ topic: 'arrays', difficulty: 'easy' });
  });

  it('breaks a tie towards the deepest slot, so the second click is free too', () => {
    expect(
      pickSuggested([slot('hashing', 'easy', 1), slot('math', 'easy', 4)]),
    ).toEqual({ topic: 'math', difficulty: 'easy' });
  });

  it('ignores slots with nothing in them', () => {
    expect(pickSuggested([slot('arrays', 'easy', 0)])).toBeNull();
  });
});

suite('pace — measured or nothing, never a guess', () => {
  it('is null until something has been generated or probed', () => {
    expect(pace.readGenerationPace()).toBeNull();
  });

  it('falls back to the provider probe the setup wizard already ran', () => {
    pace.recordProbeEstimate(95);
    expect(pace.readGenerationPace()).toEqual({ seconds: 95, source: 'probe' });
  });

  it('prefers this install\'s own generations over the probe', () => {
    pace.recordProbeEstimate(95);
    pace.recordGeneration(20_000);
    expect(pace.readGenerationPace()).toEqual({ seconds: 20, source: 'measured' });
  });

  it('moves towards a new endpoint instead of averaging it away forever', () => {
    pace.recordGeneration(90_000); // the old local model
    for (let i = 0; i < 8; i++) pace.recordGeneration(20_000); // switched to Claude
    const read = pace.readGenerationPace();
    expect(read?.source).toBe('measured');
    expect(read!.seconds).toBeLessThan(25);
  });

  it('drops samples that are noise rather than pace', () => {
    pace.recordGeneration(50); // a cached/mocked call, not a real generation
    pace.recordGeneration(60 * 60_000); // a hung request someone eventually killed
    pace.recordGeneration(Number.NaN);
    expect(pace.readGenerationPace()).toBeNull();
  });

  it('surfaces through the route once it exists', async () => {
    pace.recordGeneration(30_000);
    const s = await status();
    expect(s.generationSeconds).toBe(30);
    expect(s.generationSource).toBe('measured');
  });
});
