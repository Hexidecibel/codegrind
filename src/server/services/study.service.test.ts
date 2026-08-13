import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Lesson, Primer, Topic, TrackOutlineItem } from '../../shared/types.js';
import type { StudySlot } from './study.order.js';

// -----------------------------------------------------------------------------
// The two boundaries this module owns are SQLite and the Anthropic API. Both are
// replaced wholesale: db.ts opens the live database at module scope (and binds a
// native ABI), and llm.service.ts would spend real money. Everything else in the
// dependency graph — study.order, curriculum — is pure and runs for real.
// -----------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const store = {
    lessons: new Map<string, Lesson>(),
    primers: new Map<string, Primer>(),
    outlines: new Map<string, TrackOutlineItem[]>(),
    problems: new Map<string, { id: string; title: string; prompt: string }>(),
    reads: [] as Array<{ lessonId: string; readAt: string; fuzzy: boolean }>,
    skills: [] as Array<{ topic: string; attempts: number }>,
    mistakes: [] as Array<{ tag: string; count: number; topic: string }>,
    walkthroughs: [] as Array<{ problemId: string; title: string; topic: string }>,
    /** topic -> the corpus snippets it owns, in the language the corpus is written in. */
    snippets: new Map<string, Array<{ sourceId: string; code: string }>>(),
    /** language -> sourceId -> translated code. */
    translations: new Map<string, Map<string, string>>(),
  };

  const db = {
    // getLesson/getPrimer/getLessonsByTopic take a LEADING language now: the
    // corpus row is shared and only its `code` snippet forks, so the language
    // selects an overlay rather than a partition. These fakes ignore it — this
    // suite is about ordering and dedupe, and db.translations.test.ts owns the
    // overlay against real SQL — but they take it so the shape matches.
    getLesson: vi.fn((_language: string, id: string) => store.lessons.get(id) ?? null),
    insertLesson: vi.fn((l: Lesson) => {
      store.lessons.set(l.id, l);
    }),
    getPrimer: vi.fn((_language: string, pattern: string) => store.primers.get(pattern) ?? null),
    insertPrimer: vi.fn((p: Primer) => {
      store.primers.set(p.pattern, p);
    }),
    getPrimerPatterns: vi.fn(() => [...store.primers.keys()]),
    getTrackOutline: vi.fn((topic: string) => store.outlines.get(topic) ?? null),
    insertTrackOutline: vi.fn((topic: string, outline: TrackOutlineItem[]) => {
      store.outlines.set(topic, outline);
    }),
    getAllTrackOutlines: vi.fn(() => new Map(store.outlines)),
    getCachedLessonMeta: vi.fn(() =>
      [...store.lessons.values()].map((l) => ({
        id: l.id,
        topic: l.topic,
        kind: l.kind,
        seq: l.seq,
        title: l.title,
      }))
    ),
    getLessonReads: vi.fn(() => store.reads),
    // The language-partitioned accessors take a REQUIRED leading `language`.
    // The fakes accept and ignore it — this suite is about ordering, not
    // partitioning (db.language.test.ts covers that against real SQL) — but
    // they take it so the mocked shape matches the real signature.
    getSkillState: vi.fn((_language: string) => store.skills),
    getCleanSolvesByTopic: vi.fn((_language: string) => new Map()),
    getMistakeContexts: vi.fn((_language: string) => store.mistakes),
    getWalkthroughCandidates: vi.fn((_language: string) => store.walkthroughs),
    getProblem: vi.fn((id: string) => store.problems.get(id) ?? null),
    getCorpusSnippets: vi.fn((topic: string) => store.snippets.get(topic) ?? []),
    getTranslatedSourceIds: vi.fn((language: string) => new Set(store.translations.get(language)?.keys() ?? [])),
    putCodeTranslations: vi.fn((language: string, rows: Array<{ sourceId: string; code: string }>) => {
      let target = store.translations.get(language);
      if (!target) {
        target = new Map<string, string>();
        store.translations.set(language, target);
      }
      for (const row of rows) target.set(row.sourceId, row.code);
      return rows.length;
    }),
  };

  const llm = {
    generatePrimer: vi.fn(),
    generateTrackOutline: vi.fn(),
    generateLessonBody: vi.fn(),
    generateMistakeLesson: vi.fn(),
    generateWalkthroughLesson: vi.fn(),
    translateSnippets: vi.fn(),
  };

  return { store, db, llm };
});

vi.mock('./db.js', () => mocks.db);
vi.mock('./llm.service.js', () => mocks.llm);

const { store, db, llm } = mocks;

type StudyService = typeof import('./study.service.js');

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const COOLDOWN_MS = 5 * 60 * 1000;

const PRIMER: Primer = {
  pattern: 'arrays',
  recognitionCues: ['contiguous window'],
  template: 'function f(a) {}',
  pitfalls: ['off by one'],
  example: { title: 'Two Sum', insight: 'Index as you go.' },
};

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id,
    topic: 'arrays',
    kind: 'concept',
    seq: 0,
    title: id,
    body: 'body',
    takeaway: 'takeaway',
    ...over,
  };
}

function trackSlot(topic: Topic, seq: number, over: Partial<StudySlot> = {}): StudySlot {
  return {
    id: `${topic}:${seq}`,
    topic,
    kind: 'concept',
    seq,
    title: `${topic} ${seq}`,
    cached: false,
    source: 'track',
    ...over,
  };
}

function mistakeSlot(tag: string, n: number, over: Partial<StudySlot> = {}): StudySlot {
  return {
    id: `mistake:${tag}:${n}`,
    topic: 'arrays',
    kind: 'mistake',
    seq: 1000 + n,
    title: `Your recurring miss: ${tag}`,
    cached: false,
    source: 'mistake',
    tag,
    ...over,
  };
}

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the fire-and-forget work settle before asserting on its effects. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let svc: StudyService;

beforeEach(async () => {
  store.lessons.clear();
  store.primers.clear();
  store.outlines.clear();
  store.problems.clear();
  store.reads.length = 0;
  store.skills.length = 0;
  store.mistakes.length = 0;
  store.walkthroughs.length = 0;
  store.snippets.clear();
  store.translations.clear();

  vi.clearAllMocks();
  llm.generatePrimer.mockImplementation(async (topic: string) => ({ ...PRIMER, pattern: topic }));
  llm.generateTrackOutline.mockImplementation(async () => []);
  llm.generateLessonBody.mockImplementation(async () => lesson('generated'));
  llm.generateMistakeLesson.mockImplementation(async () => lesson('generated', { kind: 'mistake' }));
  llm.generateWalkthroughLesson.mockImplementation(async () =>
    lesson('generated', { kind: 'walkthrough' })
  );
  // Default: echo every snippet back with a marker, so a test can tell a
  // translated snippet from the stored one without asserting on model prose.
  llm.translateSnippets.mockImplementation(
    async (snippets: Array<{ id: string; code: string }>, _from: string, to: string) =>
      new Map(snippets.map((s) => [s.id, `${to}:${s.code}`]))
  );

  // Only Date is faked: the cooldown reads Date.now(), while promises and the
  // flush helper must keep running for real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  // The in-flight / failure maps are module-level, so every test gets a fresh
  // copy of the module rather than leaking a warm slot into the next test.
  vi.resetModules();
  svc = await import('./study.service.js');

  // Silence the deliberate failure paths; `once()` logs every caught error.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
describe('materializeDerivedLessons — seq 0 backfilled free from a cached primer', () => {
  it('writes the seq-0 lesson for a primed topic without touching the API', async () => {
    store.primers.set('arrays', PRIMER);

    const state = svc.buildStudyState('javascript');

    expect(db.insertLesson).toHaveBeenCalledTimes(1);
    expect(state.cached.map((m) => m.id)).toContain('arrays:0');
    expect(store.lessons.get('arrays:0')?.body).toContain('recognition card');
    expect(llm.generatePrimer).not.toHaveBeenCalled();
  });

  it('is idempotent — a second build re-derives nothing', async () => {
    store.primers.set('arrays', PRIMER);

    svc.buildStudyState('javascript');
    svc.buildStudyState('javascript');

    expect(db.insertLesson).toHaveBeenCalledTimes(1);
  });

  it('never overwrites a lesson row that already exists', async () => {
    store.primers.set('arrays', PRIMER);
    store.lessons.set('arrays:0', lesson('arrays:0', { body: 'HAND WRITTEN' }));

    svc.buildStudyState('javascript');

    expect(db.insertLesson).not.toHaveBeenCalled();
    expect(store.lessons.get('arrays:0')?.body).toBe('HAND WRITTEN');
  });

  it('ignores primer rows whose pattern is not a real topic', async () => {
    store.primers.set('vibes-based-search', { ...PRIMER, pattern: 'vibes-based-search' });

    const state = svc.buildStudyState('javascript');

    expect(db.insertLesson).not.toHaveBeenCalled();
    expect(state.cached.map((m) => m.id)).not.toContain('vibes-based-search:0');
  });
});

// =============================================================================
describe('slotKey — a track seq-0 slot shares its primer key', () => {
  it('records a failed primer against the seq-0 slot it blocks', async () => {
    llm.generatePrimer.mockRejectedValue(new Error('api down'));
    const slot = trackSlot('arrays', 0);

    await svc.ensureLesson(slot);

    expect(llm.generatePrimer).toHaveBeenCalledTimes(1);
    expect(svc.isSlotFailed(slot)).toBe(true);

    // The incident: without the shared key the failure lands on `primer:arrays`
    // while the feed checks `arrays:0`, so every request re-fires the call.
    svc.warmAhead('javascript', [slot]);
    await flush();
    expect(llm.generatePrimer).toHaveBeenCalledTimes(1);
  });

  it('reports the seq-0 slot as warming while its primer is in flight, and no other seq', async () => {
    const d = deferred<Primer>();
    llm.generatePrimer.mockReturnValue(d.promise);

    const pending = svc.ensurePrimer('arrays');

    expect(svc.isSlotWarming(trackSlot('arrays', 0))).toBe(true);
    expect(svc.isSlotWarming(trackSlot('arrays', 1))).toBe(false);
    expect(svc.isSlotWarming(trackSlot('hashing', 0))).toBe(false);

    d.resolve(PRIMER);
    await pending;
    expect(svc.isSlotWarming(trackSlot('arrays', 0))).toBe(false);
  });

  it('keeps a failed seq-1 body off the rest of the track', async () => {
    store.primers.set('arrays', PRIMER);
    store.outlines.set('arrays', [{ seq: 1, kind: 'concept', title: 'sliding', brief: 'b' }]);
    llm.generateLessonBody.mockRejectedValue(new Error('api down'));

    await svc.ensureLesson(trackSlot('arrays', 1));

    expect(svc.isSlotFailed(trackSlot('arrays', 1))).toBe(true);
    // Keying the failure by topic instead of slot would blackball the whole track.
    expect(svc.isSlotFailed(trackSlot('arrays', 0))).toBe(false);
    expect(svc.isSlotFailed(trackSlot('arrays', 2))).toBe(false);
  });
});

// =============================================================================
describe('failure cooldown — a dead slot is stepped over, not retried in a loop', () => {
  it('suppresses the slot for five minutes and re-admits it after', async () => {
    llm.generatePrimer.mockRejectedValue(new Error('api down'));
    const slot = trackSlot('arrays', 0);

    await svc.ensureLesson(slot);
    expect(svc.isSlotFailed(slot)).toBe(true);

    vi.setSystemTime(NOW + COOLDOWN_MS - 1000);
    expect(svc.isSlotFailed(slot)).toBe(true);

    vi.setSystemTime(NOW + COOLDOWN_MS + 1);
    expect(svc.isSlotFailed(slot)).toBe(false);
  });

  it('leaves the slot alone until the cooldown lapses, then retries once', async () => {
    llm.generatePrimer.mockRejectedValue(new Error('api down'));
    const slot = trackSlot('arrays', 0);

    svc.warmAhead('javascript', [slot]);
    await flush();
    expect(llm.generatePrimer).toHaveBeenCalledTimes(1);

    // Three more feed requests inside the window must not spend anything.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(NOW + 60_000 * (i + 1));
      svc.warmAhead('javascript', [slot]);
      await flush();
    }
    expect(llm.generatePrimer).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + COOLDOWN_MS + 1);
    svc.warmAhead('javascript', [slot]);
    await flush();
    expect(llm.generatePrimer).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
describe('once — one in-flight generation per key', () => {
  it('collapses concurrent callers onto a single API call', async () => {
    const d = deferred<TrackOutlineItem[]>();
    llm.generateTrackOutline.mockReturnValue(d.promise);

    const a = svc.ensureOutline('arrays');
    const b = svc.ensureOutline('arrays');

    expect(llm.generateTrackOutline).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // the same in-flight promise, not a second run

    d.resolve([{ seq: 1, kind: 'concept', title: 'sliding', brief: 'b' }]);
    await Promise.all([a, b]);

    expect(db.insertTrackOutline).toHaveBeenCalledTimes(1);
  });

  it('releases the key once the work settles so a later call can re-run', async () => {
    // An empty outline caches nothing, so the guard at the top of ensureOutline
    // still lets the second call through — it only gets through if the in-flight
    // entry was actually deleted.
    llm.generateTrackOutline.mockResolvedValue([]);

    await svc.ensureOutline('arrays');
    expect(svc.isSlotWarming(trackSlot('arrays', 1))).toBe(false);

    await svc.ensureOutline('arrays');
    expect(llm.generateTrackOutline).toHaveBeenCalledTimes(2);
  });

  it('does not spend anything on an already-cached primer or lesson', async () => {
    // Everything the generator would need is present, so the only thing keeping
    // these three calls free is the short-circuit at the top of each ensure*.
    store.primers.set('arrays', PRIMER);
    store.outlines.set('arrays', [
      { seq: 1, kind: 'concept', title: 'sliding', brief: 'b' },
      { seq: 2, kind: 'concept', title: 'two pointers', brief: 'b' },
    ]);
    store.lessons.set('arrays:1', lesson('arrays:1', { seq: 1 }));

    await svc.ensurePrimer('arrays'); // primer row already exists
    await svc.ensureLesson(trackSlot('arrays', 1)); // lesson row already exists
    await svc.ensureLesson(trackSlot('arrays', 2, { cached: true })); // planner says cached

    expect(llm.generatePrimer).not.toHaveBeenCalled();
    expect(llm.generateLessonBody).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('warmAhead — bounded lookahead behind the response', () => {
  it('warms the outlines of exactly the first two track topics in the queue', async () => {
    const queue = [
      trackSlot('arrays', 0),
      trackSlot('arrays', 1),
      trackSlot('hashing', 0),
      trackSlot('trees', 0),
    ];

    svc.warmAhead('javascript', queue, 0);
    await flush();

    const topics = llm.generateTrackOutline.mock.calls.map((c) => c[0]);
    expect(topics).toEqual(['arrays', 'hashing']);
  });

  it('ignores non-track slots when picking the topics to look ahead into', async () => {
    const queue = [
      mistakeSlot('off-by-one', 1, { topic: 'graphs' }),
      {
        ...trackSlot('greedy', 1100),
        source: 'walkthrough' as const,
        id: 'walkthrough:p1',
        problemId: 'p1',
      },
      trackSlot('arrays', 0),
    ];

    svc.warmAhead('javascript', queue, 0);
    await flush();

    // The personalized tail must not burn the two-topic outline budget.
    expect(llm.generateTrackOutline.mock.calls.map((c) => c[0])).toEqual(['arrays']);
  });

  it('does not refetch an outline that is already cached', async () => {
    store.outlines.set('arrays', [{ seq: 1, kind: 'concept', title: 'sliding', brief: 'b' }]);

    svc.warmAhead('javascript', [trackSlot('arrays', 0), trackSlot('hashing', 0)], 0);
    await flush();

    expect(llm.generateTrackOutline.mock.calls.map((c) => c[0])).toEqual(['hashing']);
  });

  it('generates at most `depth` slots and skips the ones already cached', async () => {
    const queue = [
      mistakeSlot('off-by-one', 1, { cached: true }),
      mistakeSlot('wrong-invariant', 1),
      mistakeSlot('missed-edge-case', 1),
      mistakeSlot('brute-forced', 1),
    ];

    svc.warmAhead('javascript', queue, 2);
    await flush();

    expect(llm.generateMistakeLesson).toHaveBeenCalledTimes(2);
    expect(llm.generateMistakeLesson.mock.calls.map((c) => c[0])).toEqual([
      'wrong-invariant',
      'missed-edge-case',
    ]);
  });

  it('steps over a recently failed slot and spends the budget on the next one', async () => {
    const dead = mistakeSlot('off-by-one', 1);
    const next = mistakeSlot('wrong-invariant', 1);
    llm.generateMistakeLesson.mockRejectedValueOnce(new Error('api down'));

    svc.warmAhead('javascript', [dead], 1);
    await flush();
    expect(svc.isSlotFailed(dead)).toBe(true);

    svc.warmAhead('javascript', [dead, next], 1);
    await flush();

    expect(llm.generateMistakeLesson).toHaveBeenCalledTimes(2);
    expect(llm.generateMistakeLesson.mock.calls[1][0]).toBe('wrong-invariant');
    expect(store.lessons.has(next.id)).toBe(true);
  });
});

// =============================================================================
describe('translation warm — one batched call per topic, and only when needed', () => {
  /** Give a topic a primer skeleton plus `n` lesson snippets in the corpus. */
  function stockTopic(topic: Topic, n: number): void {
    const rows = [{ sourceId: `primer:${topic}`, code: `template ${topic}` }];
    for (let i = 1; i <= n; i++) {
      rows.push({ sourceId: `lesson:${topic}:${i}`, code: `snippet ${topic} ${i}` });
    }
    store.snippets.set(topic, rows);
  }

  it('sends a topic`s whole snippet set in ONE call', async () => {
    // The economic argument for the shared corpus, asserted: nine snippets cost
    // one request, not nine. A per-snippet loop would spend an order of
    // magnitude more and lose the internal consistency a batch buys.
    stockTopic('arrays', 8);

    await svc.ensureTranslations('python', 'arrays');

    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);
    const [snippets, from, to] = llm.translateSnippets.mock.calls[0];
    expect(snippets).toHaveLength(9);
    expect(from).toBe('javascript');
    expect(to).toBe('python');
    expect(store.translations.get('python')?.size).toBe(9);
  });

  it('spends nothing when the active language IS the corpus language', async () => {
    stockTopic('arrays', 3);

    await svc.ensureTranslations('javascript', 'arrays');

    expect(llm.translateSnippets).not.toHaveBeenCalled();
  });

  it('spends nothing when the topic is already fully translated', async () => {
    stockTopic('arrays', 2);
    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);

    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);
  });

  it('re-translates only what is missing after the corpus grows', async () => {
    stockTopic('arrays', 1);
    await svc.ensureTranslations('python', 'arrays');

    // A new lesson lands in the topic — the usual case, since warm-lessons and
    // the feed keep writing bodies long after a topic was first translated.
    stockTopic('arrays', 2);
    await svc.ensureTranslations('python', 'arrays');

    expect(llm.translateSnippets).toHaveBeenCalledTimes(2);
    // The whole topic is SENT (context for consistency) but only the new row is
    // written, so an existing translation is never silently rewritten.
    expect(llm.translateSnippets.mock.calls[1][0]).toHaveLength(3);
    expect(store.translations.get('python')?.get('lesson:arrays:1')).toBe(
      'python:snippet arrays 1'
    );
  });

  it('collapses concurrent callers onto one call, per language and topic', async () => {
    stockTopic('arrays', 2);
    stockTopic('hashing', 2);

    const a = svc.ensureTranslations('python', 'arrays');
    const b = svc.ensureTranslations('python', 'arrays');
    const c = svc.ensureTranslations('java', 'arrays');
    const d = svc.ensureTranslations('python', 'hashing');
    await Promise.all([a, b, c, d]);

    expect(a).toBe(b); // the same in-flight promise
    expect(llm.translateSnippets).toHaveBeenCalledTimes(3);
  });

  it('backs off after a failure and retries only once the cooldown lapses', async () => {
    // It rides the same once() machinery as lesson generation, so a dead API
    // must not turn a reading session into a retry loop against it.
    stockTopic('arrays', 2);
    llm.translateSnippets.mockRejectedValue(new Error('api down'));

    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 60_000);
    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + COOLDOWN_MS + 1);
    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(2);
  });

  it('stores a partial batch rather than throwing the whole topic away', async () => {
    // A missing id degrades to the stored JavaScript snippet for that one
    // lesson. Discarding the batch would degrade the entire topic instead.
    stockTopic('arrays', 2);
    llm.translateSnippets.mockImplementation(async () =>
      new Map([['lesson:arrays:1', 'translated']])
    );

    await svc.ensureTranslations('python', 'arrays');

    expect(store.translations.get('python')?.size).toBe(1);
    expect(store.translations.get('python')?.get('lesson:arrays:1')).toBe('translated');
  });

  it('records a failure when NOTHING came back', async () => {
    stockTopic('arrays', 2);
    llm.translateSnippets.mockImplementation(async () => new Map());

    await svc.ensureTranslations('python', 'arrays');
    expect(store.translations.get('python')).toBeUndefined();

    // ...and the cooldown then protects the next request.
    await svc.ensureTranslations('python', 'arrays');
    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);
  });

  it('is LAZY: warmAhead translates the topics ahead, not the corpus', async () => {
    stockTopic('arrays', 2);
    stockTopic('hashing', 2);
    stockTopic('trees', 2);
    stockTopic('graphs', 2);

    // Four topics in the queue, a lookahead of two: only the two the reader is
    // about to reach get translated. Eager translation of the whole corpus is
    // exactly the 18-call bill this design exists to defer.
    svc.warmAhead(
      'python',
      [
        trackSlot('arrays', 1, { cached: true }),
        trackSlot('hashing', 1, { cached: true }),
        trackSlot('trees', 1, { cached: true }),
        trackSlot('graphs', 1, { cached: true }),
      ],
      2
    );
    await flush();

    expect(llm.translateSnippets).toHaveBeenCalledTimes(2);
    expect([...store.translations.get('python')!.keys()].some((k) => k.includes('trees'))).toBe(
      false
    );
  });

  it('warms the topic of a PERSONALIZED slot too, which has no outline to warm', async () => {
    // The outline warm walks track slots only. A mistake or walkthrough lesson
    // still carries a snippet, so the translation warm walks the whole window.
    stockTopic('graphs', 1);

    svc.warmAhead('python', [mistakeSlot('off-by-one', 1, { topic: 'graphs', cached: true })], 2);
    await flush();

    expect(llm.translateSnippets).toHaveBeenCalledTimes(1);
    expect(store.translations.get('python')?.has('primer:graphs')).toBe(true);
  });

  it('costs a JavaScript reader nothing at all', async () => {
    stockTopic('arrays', 4);

    svc.warmAhead('javascript', [trackSlot('arrays', 1, { cached: true })], 2);
    await flush();

    expect(llm.translateSnippets).not.toHaveBeenCalled();
  });
});
