// =============================================================================
// db.corpus.test — the shared corpus, its language overlay, and the two globals
// =============================================================================
// Phase 4's whole bet is that a lesson is written ONCE and only its snippet
// forks. Two things have to be true for that to hold, and neither is visible on
// a machine that has only ever run JavaScript:
//
//   1. A translated snippet is served in place of the stored one, and a MISSING
//      translation falls back to the stored one rather than to an error or an
//      empty code block. The fallback is what makes a half-translated topic
//      merely half-translated.
//   2. The two metrics the plan pulls back OUT of the language partition —
//      `lessonsRead` and `streak` — really are global.
//
// Like db.language.test.ts this imports the real db.ts after pointing DATA_DIR
// at a throwaway directory, because the thing under test is the SHIPPING query.
// An in-memory re-implementation of the overlay would only prove a copy agrees
// with itself.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Lesson, Primer, ProblemRecord, Topic, Difficulty } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-corpus-test-'));

// Belt and braces: a bug here would write to the user's real practice history.
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const db = await import('./db.js');
const { CORPUS_LANGUAGE } = await import('./llm.language.js');
// Pure, no DB — but imported here beside the others so the file has one import
// style rather than two.
const { buildActivity, computeDayStreak, ACTIVITY_DAYS } = await import('./reflect.compute.js');

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
const JS_SNIPPET = 'for (let i = 0; i < n; i++) {\n  total += nums[i];\n}';
const PY_SNIPPET = 'for i in range(n):\n    total += nums[i]';
const JS_TEMPLATE = 'let left = 0, right = n - 1;\nwhile (left < right) {\n  // shrink\n}';
const PY_TEMPLATE = 'left, right = 0, n - 1\nwhile left < right:\n    # shrink';

function lesson(over: Partial<Lesson> & { id: string }): Lesson {
  return {
    topic: 'arrays' as Topic,
    kind: 'concept',
    seq: 1,
    title: `Lesson ${over.id}`,
    body: 'Prose with no fence in it, which is the property the whole plan rides on.',
    takeaway: 'Remember the thing.',
    ...over,
  };
}

function primer(over: Partial<Primer> & { pattern: string }): Primer {
  return {
    recognitionCues: ['sorted input'],
    template: JS_TEMPLATE,
    pitfalls: ['off by one'],
    example: { title: 'Two Sum II', insight: 'converge from both ends' },
    ...over,
  };
}

function problem(id: string, language: Language): ProblemRecord {
  return {
    id,
    language,
    title: `Problem ${id}`,
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
    canonicalized: true,
    used: false,
    createdAt: '2026-08-13T00:00:00.000Z',
  };
}

let attemptSeq = 0;
function attempt(over: { problemId: string; language: Language; createdAt: string }): void {
  attemptSeq += 1;
  db.insertAttempt({
    id: `attempt-${attemptSeq}`,
    problemId: over.problemId,
    language: over.language,
    pattern: 'arrays',
    difficulty: 'easy',
    solved: true,
    hintsUsed: 0,
    testsPassed: 5,
    testsTotal: 5,
    code: 'const x = 1;',
    createdAt: over.createdAt,
    prediction: null,
    mistakeTags: null,
  });
}

function reset(): void {
  db.db.exec(`
    DELETE FROM attempts;
    DELETE FROM problems;
    DELETE FROM lessons;
    DELETE FROM lesson_reads;
    DELETE FROM pattern_primers;
    DELETE FROM code_translations;
    DELETE FROM settings;
  `);
}

beforeEach(reset);

// =============================================================================
describe('the code_translations overlay', () => {
  it('serves the translated snippet when one exists', () => {
    db.insertLesson(lesson({ id: 'arrays:1', code: JS_SNIPPET }));
    db.putCodeTranslations('python', [
      { sourceId: db.lessonSourceId('arrays:1'), code: PY_SNIPPET },
    ]);

    expect(db.getLesson('python', 'arrays:1')?.code).toBe(PY_SNIPPET);
  });

  it('falls back to the stored snippet when the translation is missing', () => {
    // THE load-bearing behaviour. warmAhead fills translations lazily, so at any
    // moment most of the corpus has none — and "no translation yet" has to read
    // as a JavaScript snippet, never as an error and never as an empty block.
    db.insertLesson(lesson({ id: 'arrays:2', code: JS_SNIPPET }));

    const served = db.getLesson('python', 'arrays:2');
    expect(served?.code).toBe(JS_SNIPPET);
    expect(served?.body).toContain('no fence');
  });

  it('does not invent a snippet for a lesson that never had one', () => {
    // 2 of the 114 stored lessons have no `code` field at all. An overlay that
    // helpfully filled one in would put code under prose that never refers to it.
    db.insertLesson(lesson({ id: 'arrays:3' }));
    db.putCodeTranslations('python', [
      { sourceId: db.lessonSourceId('arrays:3'), code: PY_SNIPPET },
    ]);

    expect(db.getLesson('python', 'arrays:3')?.code).toBeUndefined();
  });

  it('leaves the corpus language reading exactly the stored bytes', () => {
    // The regression argument for the whole phase: JavaScript must serve what it
    // served before the overlay existed. A row filed under the corpus language
    // is never consulted, so it cannot drift away from the row it was copied
    // from during the Phase 1 backfill.
    db.insertLesson(lesson({ id: 'arrays:4', code: JS_SNIPPET }));
    db.putCodeTranslations(CORPUS_LANGUAGE, [
      { sourceId: db.lessonSourceId('arrays:4'), code: 'IMPOSTOR' },
    ]);

    expect(db.getLesson(CORPUS_LANGUAGE, 'arrays:4')?.code).toBe(JS_SNIPPET);
  });

  it('keeps every language`s snippet separate', () => {
    db.insertLesson(lesson({ id: 'arrays:5', code: JS_SNIPPET }));
    db.putCodeTranslations('python', [
      { sourceId: db.lessonSourceId('arrays:5'), code: PY_SNIPPET },
    ]);

    expect(db.getLesson('python', 'arrays:5')?.code).toBe(PY_SNIPPET);
    // Java has never been translated: it falls back, it does not read Python's.
    expect(db.getLesson('java', 'arrays:5')?.code).toBe(JS_SNIPPET);
  });

  it('overlays a primer template the same way, fallback included', () => {
    db.insertPrimer(primer({ pattern: 'two-pointer' }));

    expect(db.getPrimer('python', 'two-pointer')?.template).toBe(JS_TEMPLATE);

    db.putCodeTranslations('python', [
      { sourceId: db.primerSourceId('two-pointer'), code: PY_TEMPLATE },
    ]);

    expect(db.getPrimer('python', 'two-pointer')?.template).toBe(PY_TEMPLATE);
    // Everything else on the card is shared prose and must not have moved.
    expect(db.getPrimer('python', 'two-pointer')?.recognitionCues).toEqual(['sorted input']);
    expect(db.getPrimer(CORPUS_LANGUAGE, 'two-pointer')?.template).toBe(JS_TEMPLATE);
  });

  it('overwrites rather than duplicating when a topic is re-translated', () => {
    db.insertLesson(lesson({ id: 'arrays:6', code: JS_SNIPPET }));
    const sourceId = db.lessonSourceId('arrays:6');

    db.putCodeTranslations('python', [{ sourceId, code: 'first' }]);
    db.putCodeTranslations('python', [{ sourceId, code: 'second' }]);

    expect(db.getLesson('python', 'arrays:6')?.code).toBe('second');
    expect(
      (db.db.prepare(`SELECT COUNT(*) AS n FROM code_translations`).get() as { n: number }).n
    ).toBe(1);
  });

  it('refuses to store an empty translation', () => {
    // An empty string would out-rank the fallback and render a blank <pre>,
    // which is strictly worse than the JavaScript snippet it replaced.
    db.insertLesson(lesson({ id: 'arrays:7', code: JS_SNIPPET }));
    const written = db.putCodeTranslations('python', [
      { sourceId: db.lessonSourceId('arrays:7'), code: '   ' },
    ]);

    expect(written).toBe(0);
    expect(db.getLesson('python', 'arrays:7')?.code).toBe(JS_SNIPPET);
  });
});

// =============================================================================
describe('getCorpusSnippets — the input side of a translation batch', () => {
  it('returns the primer skeleton first, then the topic`s lesson snippets', () => {
    db.insertPrimer(primer({ pattern: 'arrays' }));
    db.insertLesson(lesson({ id: 'arrays:1', seq: 1, code: JS_SNIPPET }));
    db.insertLesson(lesson({ id: 'arrays:2', seq: 2, code: 'const b = 2;' }));

    expect(db.getCorpusSnippets('arrays')).toEqual([
      { sourceId: 'primer:arrays', code: JS_TEMPLATE },
      { sourceId: 'lesson:arrays:1', code: JS_SNIPPET },
      { sourceId: 'lesson:arrays:2', code: 'const b = 2;' },
    ]);
  });

  it('skips lessons with no snippet, so the batch has nothing empty in it', () => {
    db.insertLesson(lesson({ id: 'arrays:1', seq: 1, code: JS_SNIPPET }));
    db.insertLesson(lesson({ id: 'arrays:2', seq: 2 }));

    expect(db.getCorpusSnippets('arrays').map((s) => s.sourceId)).toEqual(['lesson:arrays:1']);
  });

  it('reads the STORED bytes, never the overlay', () => {
    // Feeding an overlaid snippet back into a translation would translate
    // Python from Python. This is the guard against that.
    db.insertLesson(lesson({ id: 'arrays:1', code: JS_SNIPPET }));
    db.putCodeTranslations('python', [
      { sourceId: db.lessonSourceId('arrays:1'), code: PY_SNIPPET },
    ]);

    expect(db.getCorpusSnippets('arrays')[0].code).toBe(JS_SNIPPET);
  });

  it('is empty for a topic nothing has been written for yet', () => {
    expect(db.getCorpusSnippets('graphs')).toEqual([]);
  });
});

// =============================================================================
describe('the two metrics that stay GLOBAL', () => {
  it('counts a streak across languages, not once per language', () => {
    // The plan's example, exactly: Python yesterday and JavaScript today is a
    // 2-day streak. Per-language it reads as two 1-day streaks, which punishes
    // the one behaviour this whole phase exists to allow.
    db.insertProblem(problem('py-1', 'python'));
    db.insertProblem(problem('js-1', 'javascript'));

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    attempt({ problemId: 'py-1', language: 'python', createdAt: yesterday.toISOString() });
    attempt({ problemId: 'js-1', language: 'javascript', createdAt: today.toISOString() });

    const global = buildActivity(db.getGlobalDailyActivity(ACTIVITY_DAYS), ACTIVITY_DAYS);
    expect(computeDayStreak(global)).toBe(2);

    // And the per-language series each see only their own day — which is
    // precisely why the streak may not be derived from the one on screen.
    const js = buildActivity(db.getDailyActivity('javascript', ACTIVITY_DAYS), ACTIVITY_DAYS);
    const py = buildActivity(db.getDailyActivity('python', ACTIVITY_DAYS), ACTIVITY_DAYS);
    expect(computeDayStreak(js)).toBe(1);
    expect(computeDayStreak(py)).toBe(1);
  });

  it('sums a day`s attempts across languages', () => {
    db.insertProblem(problem('py-1', 'python'));
    db.insertProblem(problem('js-1', 'javascript'));
    const today = new Date().toISOString();
    attempt({ problemId: 'py-1', language: 'python', createdAt: today });
    attempt({ problemId: 'js-1', language: 'javascript', createdAt: today });

    const rows = db.getGlobalDailyActivity(84);
    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].solved).toBe(2);
  });

  it('counts lessons read globally, because the corpus is shared', () => {
    // A lesson you read is read. Re-reading the same prose in a second language
    // is not the gap, so the read receipt survives the switch — which is also
    // what kept all 19 live receipts valid through Phase 1.
    db.insertLesson(lesson({ id: 'arrays:1', topic: 'arrays' as Topic }));
    db.insertLesson(lesson({ id: 'hashing:1', topic: 'hashing' as Topic }));
    db.markLessonRead('arrays:1');
    db.markLessonRead('hashing:1');

    const counts = db.getLessonReadCounts();
    expect(counts.get('arrays' as Topic)).toBe(1);
    expect(counts.get('hashing' as Topic)).toBe(1);

    // The active language is the one input that could have scoped this. It does
    // not, in either direction.
    db.setActiveLanguage('python');
    expect([...db.getLessonReadCounts().values()].reduce((a, b) => a + b, 0)).toBe(2);
    db.setActiveLanguage('javascript');
    expect([...db.getLessonReadCounts().values()].reduce((a, b) => a + b, 0)).toBe(2);
  });
});
