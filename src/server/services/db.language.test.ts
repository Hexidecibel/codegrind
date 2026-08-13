// =============================================================================
// db.language.test — the required-parameter rule, proven against real SQL
// =============================================================================
// Every OTHER suite in this repo refuses to import db.ts, and for a good reason:
// it opens SQLite at module scope, so importing it touches the live database.
// This suite imports it anyway — after pointing DATA_DIR at a throwaway
// directory, which is the one input that decides which file gets opened.
//
// That indirection is what makes the test worth having. The alternative (build
// an in-memory database and re-run the accessors' SQL by hand) proves only that
// a copy of a query agrees with itself, and the thing under test here is
// precisely whether the SHIPPING query carries its language filter. A partition
// bug is invisible on a machine that only ever had JavaScript rows, so it has to
// be caught by a test that owns rows in two languages at once.
//
// The seam is `process.env.DATA_DIR`, read at db.ts module scope, so the
// assignment below must happen before the dynamic import — hence top-level
// await rather than a static import.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProblemRecord, Topic, Difficulty } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-db-test-'));

// Belt and braces: a bug here would write to the user's real practice history.
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const db = await import('./db.js');

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
function problem(over: Partial<ProblemRecord> & { id: string; language: Language }): ProblemRecord {
  return {
    title: `Problem ${over.id}`,
    prompt: 'do the thing',
    examples: [],
    constraints: [],
    difficulty: 'easy' as Difficulty,
    topic: 'arrays' as Topic,
    pattern: 'arrays',
    starterCode: 'function f() {}',
    functionName: 'f',
    sampleTests: [{ name: 's', args: [1], expected: 1 }],
    hiddenTests: [{ name: 'h', args: [2], expected: 2 }],
    referenceSolution: 'function f(x) { return x; }',
    used: false,
    createdAt: '2026-08-13T00:00:00.000Z',
    ...over,
  };
}

let attemptSeq = 0;
function attempt(over: {
  problemId: string;
  language: Language;
  solved?: boolean;
  hintsUsed?: number;
  pattern?: string;
  difficulty?: Difficulty;
  mistakeTags?: string[] | null;
  createdAt?: string;
}): void {
  attemptSeq += 1;
  db.insertAttempt({
    id: `attempt-${attemptSeq}`,
    problemId: over.problemId,
    language: over.language,
    pattern: over.pattern ?? 'arrays',
    difficulty: over.difficulty ?? 'easy',
    solved: over.solved ?? true,
    hintsUsed: over.hintsUsed ?? 0,
    testsPassed: 5,
    testsTotal: 5,
    code: 'const x = 1;',
    createdAt: over.createdAt ?? new Date().toISOString(),
    prediction: null,
    mistakeTags: over.mistakeTags ?? null,
  });
}

/** Wipe every table this suite writes to, so each test starts from nothing. */
function reset(): void {
  db.db.exec(`
    DELETE FROM attempts;
    DELETE FROM problems;
    DELETE FROM skill_state;
    DELETE FROM review_queue;
    DELETE FROM sessions;
    DELETE FROM settings;
  `);
}

beforeEach(reset);

// =============================================================================
describe('the bank partitions by language', () => {
  it('never serves one language a problem stored for another', () => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript', title: 'JS Two Sum' }));
    db.insertProblem(problem({ id: 'py-1', language: 'python', title: 'PY Two Sum' }));

    expect(db.findUnusedProblem('javascript', 'arrays', 'easy')?.id).toBe('js-1');
    expect(db.findUnusedProblem('python', 'arrays', 'easy')?.id).toBe('py-1');
    // The point of the whole phase, from both directions:
    expect(db.findUnusedProblem('java', 'arrays', 'easy')).toBeNull();
  });

  it('reads a problem`s own language back off the record', () => {
    db.insertProblem(problem({ id: 'py-1', language: 'python' }));
    // getProblem takes no language — the id carries it. This is what lets
    // /api/run and /api/submit stay language-free.
    expect(db.getProblem('py-1')?.language).toBe('python');
  });

  it('scopes titles, digests and variation seeds', () => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript', title: 'JS Two Sum' }));
    db.insertProblem(problem({ id: 'py-1', language: 'python', title: 'PY Two Sum' }));
    attempt({ problemId: 'py-1', language: 'python' });

    expect(db.getBankTitles('javascript', 'arrays')).toEqual(['JS Two Sum']);
    expect(db.getBankTitles('python', 'arrays')).toEqual(['PY Two Sum']);

    expect(db.getRecentProblemDigests('javascript', 'arrays').map((d) => d.title)).toEqual([
      'JS Two Sum',
    ]);

    // A Python solve must not become the seed for a JavaScript variation.
    expect(db.getRecentSolvedProblem('python', 'arrays')?.id).toBe('py-1');
    expect(db.getRecentSolvedProblem('javascript', 'arrays')).toBeNull();
  });

  it('counts the bank per language', () => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript' }));
    db.insertProblem(problem({ id: 'js-2', language: 'javascript' }));
    db.insertProblem(problem({ id: 'py-1', language: 'python' }));

    expect(db.bankSize('javascript')).toBe(2);
    expect(db.bankSize('python')).toBe(1);
    expect(db.bankSize('java')).toBe(0);
  });
});

// =============================================================================
describe('attempt-derived reads partition by language', () => {
  beforeEach(() => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript', title: 'JS One' }));
    db.insertProblem(problem({ id: 'py-1', language: 'python', title: 'PY One' }));
    attempt({ problemId: 'js-1', language: 'javascript', mistakeTags: ['off-by-one'] });
    attempt({
      problemId: 'py-1',
      language: 'python',
      hintsUsed: 2,
      solved: false,
      mistakeTags: ['indentation'],
    });
  });

  it('history shows only this language`s attempts', () => {
    expect(db.getHistory('javascript').map((a) => a.problemId)).toEqual(['js-1']);
    expect(db.getHistory('python').map((a) => a.problemId)).toEqual(['py-1']);
  });

  it('tier credit does not leak across languages', () => {
    const js = db.getCleanSolvesByTopic('javascript');
    const py = db.getCleanSolvesByTopic('python');
    expect(js.get('arrays')?.easy).toBe(1);
    // Solved with hints and failed — no credit, and certainly not JS credit.
    expect(py.get('arrays')?.easy ?? 0).toBe(0);
    expect(db.getCleanSolvesForTopic('javascript', 'arrays').easy).toBe(1);
    expect(db.getCleanSolvesForTopic('python', 'arrays').easy).toBe(0);
    expect(db.getCleanSolvesForTopic('java', 'arrays').easy).toBe(0);
  });

  it('the tiles are per language', () => {
    expect(db.getSolvedProblemCount('javascript')).toBe(1);
    expect(db.getSolvedProblemCount('python')).toBe(0);
    expect(db.getHintFreeRate('javascript')).toBe(1);
    expect(db.getHintFreeRate('python')).toBe(0);
    // No attempts at all must be 0, not NaN.
    expect(db.getHintFreeRate('java')).toBe(0);
  });

  it('pattern progress, trend, activity and mistake tallies are per language', () => {
    expect(db.getProgress('javascript').map((p) => p.attempted)).toEqual([1]);
    expect(db.getProgress('java')).toEqual([]);

    expect(db.getAttemptsByProblem('javascript').map((s) => s.problemId)).toEqual(['js-1']);
    expect(db.getAttemptsByProblem('python').map((s) => s.problemId)).toEqual(['py-1']);

    expect(db.getDailyActivity('javascript').reduce((n, d) => n + d.attempts, 0)).toBe(1);
    expect(db.getDailyActivity('java').length).toBe(0);

    expect(db.getTaggedAttempts('javascript').flatMap((t) => t.mistakeTags)).toEqual([
      'off-by-one',
    ]);
    expect(db.getTaggedAttempts('python').flatMap((t) => t.mistakeTags)).toEqual(['indentation']);

    expect(db.getMistakeContexts('javascript').map((m) => m.tag)).toEqual(['off-by-one']);
    expect(db.getMistakeContexts('python').map((m) => m.tag)).toEqual(['indentation']);

    // The Python attempt was hinted + failed, so it is walkthrough material —
    // for Python, and for nothing else.
    expect(db.getWalkthroughCandidates('python').map((w) => w.problemId)).toEqual(['py-1']);
    expect(db.getWalkthroughCandidates('javascript')).toEqual([]);
  });
});

// =============================================================================
describe('skill_state forks on (topic, language)', () => {
  it('keeps two independent ladders for the same topic', () => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript' }));
    attempt({ problemId: 'js-1', language: 'javascript' });

    db.updateSkillOnAttempt('javascript', 'arrays', true, 0);

    expect(db.getSkillForTopic('javascript', 'arrays')?.streak).toBe(1);
    expect(db.getSkillForTopic('python', 'arrays')).toBeNull();
    expect(db.getSkillState('javascript').map((s) => s.topic)).toEqual(['arrays']);
    // A cold ladder is an ABSENT row, which is what the scheduler's cold-start
    // path keys on — not a row full of zeros.
    expect(db.getSkillState('python')).toEqual([]);

    db.updateSkillOnAttempt('python', 'arrays', false, 0);

    expect(db.getSkillForTopic('python', 'arrays')?.lastResult).toBe('failed');
    // The JavaScript ladder must be exactly where it was.
    expect(db.getSkillForTopic('javascript', 'arrays')?.lastResult).toBe('solved');
    expect(db.getSkillForTopic('javascript', 'arrays')?.streak).toBe(1);
  });

  it('reports the language on the row it read', () => {
    db.updateSkillOnAttempt('python', 'trees', true, 0);
    expect(db.getSkillState('python')[0].language).toBe('python');
  });
});

// =============================================================================
describe('the review queue serves within one language', () => {
  it('never surfaces another language`s due item', () => {
    db.insertProblem(problem({ id: 'js-1', language: 'javascript' }));
    db.insertProblem(problem({ id: 'py-1', language: 'python' }));
    db.enqueueReview('js-1', 'failed');
    db.enqueueReview('py-1', 'hinted');

    expect(db.getDueReview('javascript')?.problemId).toBe('js-1');
    expect(db.getDueReview('python')?.problemId).toBe('py-1');
    expect(db.getDueReview('java')).toBeNull();

    expect(db.getReviewDueCount('javascript')).toBe(1);
    expect(db.getReviewDueCount('java')).toBe(0);

    // Clearing is keyed on problemId alone and stays that way.
    db.clearReview('js-1');
    expect(db.getDueReview('javascript')).toBeNull();
    expect(db.getDueReview('python')?.problemId).toBe('py-1');
  });
});

// =============================================================================
describe('sessions remember the language they started in', () => {
  it('stores it and reads it back off the row', () => {
    db.createSession('python', 'sess-1', { theme: 't', coachIntro: '', focus: [] });
    const row = db.getSession('sess-1');
    expect(row?.language).toBe('python');
  });
});

// =============================================================================
describe('the settings store', () => {
  it('falls back to the default language when the row is absent', () => {
    expect(db.getSetting(db.ACTIVE_LANGUAGE_KEY)).toBeNull();
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('round-trips the active language', () => {
    db.setActiveLanguage('python');
    expect(db.getActiveLanguage()).toBe('python');
    db.setActiveLanguage('java');
    expect(db.getActiveLanguage()).toBe('java');
    db.setActiveLanguage('javascript');
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('falls back rather than throwing on a value this build does not know', () => {
    // What a downgrade looks like: a row written by a build that supported a
    // language this one does not.
    db.setSetting(db.ACTIVE_LANGUAGE_KEY, 'kotlin');
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('treats an unparseable row as unset', () => {
    db.db
      .prepare(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, ?)`)
      .run('language', 'not json', new Date().toISOString());
    expect(db.getSetting('language')).toBeNull();
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('stores arbitrary JSON values, which is what the provider wizard needs', () => {
    // No migration, no new column: the wizard's provider/model/apiKeyRef are
    // rows in exactly this shape.
    db.setSetting('provider', { name: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(db.getSetting<{ name: string; model: string }>('provider')).toEqual({
      name: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(db.getSetting('nothing-was-ever-written-here')).toBeNull();
  });
});
