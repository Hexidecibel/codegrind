import { describe, it, expect } from 'vitest';
import { TOPICS, type Difficulty, type Topic } from '../../shared/types.js';
import { PREREQS, ROOT_TOPICS, TIER_REQUIREMENT, UNLOCK_TIER } from './curriculum.js';
import {
  topicDepth,
  curriculumOrder,
  treeState,
  treeStates,
  levelMap,
  skillTier,
  solvesToUnlock,
  computeNextUnlock,
  computeTrend,
  splitMistakes,
  buildActivity,
  computeDayStreak,
  type ReflectSkill,
  type ReflectProblemAttempts,
} from './reflect.compute.js';

const NOW = Date.parse('2026-08-12T00:30:00.000Z');

/** A never-touched topic. */
function blank(topic: Topic): ReflectSkill {
  return {
    topic,
    attempts: 0,
    solved: 0,
    cleanSolves: {},
    box: 0,
    streak: 0,
    lastSeenAt: null,
  };
}

/**
 * A practised topic. `cleanSolves` is the ONLY progress input — tier, score and
 * served difficulty are derived from it, so a fixture cannot claim a tier its
 * counts don't support.
 */
function practised(
  topic: Topic,
  cleanSolves: Partial<Record<Difficulty, number>>,
  attempts = 12,
  solved = 8
): ReflectSkill {
  return { ...blank(topic), attempts, solved, cleanSolves };
}

/** Every topic blank except the ones supplied. */
function skillSet(...overrides: ReflectSkill[]): ReflectSkill[] {
  const by = new Map(overrides.map((s) => [s.topic, s]));
  return TOPICS.map((t) => by.get(t) ?? blank(t));
}

/**
 * THE LIVE SHAPE, distinct hint-free solves as modelled against the real
 * database before this change:
 *
 *   arrays         easy=5 medium=1  -> easy tier complete
 *   two-pointer    easy=5 medium=1  -> easy tier complete
 *   binary-search  easy=3 medium=3  -> MEDIUM tier complete
 *
 * The hard requirement on this change is that none of those regress and the
 * same five topics stay unlocked. If this fixture ever disagrees with the
 * running app, the rule is wrong — not the fixture.
 */
function liveSkills(): ReflectSkill[] {
  return skillSet(
    practised('arrays', { easy: 5, medium: 1 }, 19, 10),
    practised('two-pointer', { easy: 5, medium: 1 }, 24, 11),
    practised('binary-search', { easy: 3, medium: 3 }, 13, 9)
  );
}

/** The five topics that must be open on the live shape. */
const LIVE_UNLOCKED: Topic[] = [
  'sliding-window',
  'intervals',
  'stack',
  'linked-list',
  'greedy',
];

// -----------------------------------------------------------------------------
describe('topicDepth', () => {
  it('puts every prerequisite strictly above its dependent', () => {
    const depth = topicDepth();
    for (const topic of TOPICS) {
      for (const prereq of PREREQS[topic]) {
        expect(
          depth[prereq],
          `${prereq} (prereq of ${topic}) must be shallower than ${topic}`
        ).toBeLessThan(depth[topic]);
      }
    }
  });

  it('gives every root depth 0 and nothing else depth 0', () => {
    const depth = topicDepth();
    for (const t of TOPICS) {
      expect(depth[t] === 0).toBe(ROOT_TOPICS.includes(t));
    }
  });

  it('takes the LONGEST path, not the shortest', () => {
    const depth = topicDepth();
    // sliding-window sits on arrays (0) and two-pointer (1) — the deeper one wins.
    expect(depth['two-pointer']).toBe(1);
    expect(depth['sliding-window']).toBe(2);
    // greedy sits on arrays (0) and intervals (2).
    expect(depth.intervals).toBe(2);
    expect(depth.greedy).toBe(3);
  });

  it('curriculumOrder is a topological order over PREREQS', () => {
    const order = curriculumOrder();
    expect(order).toHaveLength(TOPICS.length);
    const position = new Map(order.map((t, i) => [t, i]));
    for (const topic of TOPICS) {
      for (const prereq of PREREQS[topic]) {
        expect(position.get(prereq)!).toBeLessThan(position.get(topic)!);
      }
    }
  });
});

// -----------------------------------------------------------------------------
describe('treeState', () => {
  it('never locks a root, whatever the rest of the tree looks like', () => {
    for (const skills of [skillSet(), liveSkills()]) {
      const states = treeStates(skills);
      for (const root of ROOT_TOPICS) {
        expect(states.get(root), `${root} must not be locked`).not.toBe('locked');
      }
    }
    // Cold start: every root is available and everything else is locked.
    const cold = treeStates(skillSet());
    for (const t of TOPICS) {
      expect(cold.get(t)).toBe(ROOT_TOPICS.includes(t) ? 'available' : 'locked');
    }
  });

  it('classifies the live shape — nothing regresses, nothing re-locks', () => {
    const skills = liveSkills();
    const states = treeStates(skills);
    const tier = (t: Topic) => skillTier(skills.find((s) => s.topic === t)!);

    // The three practised topics, at the tiers the live data earns.
    expect(tier('arrays').level).toBe('easy');
    expect(tier('two-pointer').level).toBe('easy');
    expect(tier('binary-search').level).toBe('medium');
    expect(states.get('arrays')).toBe('tiered');
    expect(states.get('two-pointer')).toBe('tiered');
    expect(states.get('binary-search')).toBe('tiered');

    // ...and exactly the five topics that must be open, are open.
    for (const t of LIVE_UNLOCKED) {
      expect(states.get(t), `${t} must be unlocked`).toBe('available');
    }
    expect(states.get('hashing')).toBe('available'); // untouched root
    expect(states.get('trees')).toBe('locked'); // linked-list untouched
    expect(states.get('heap')).toBe('locked');

    // Nothing outside {practised} ∪ {roots} ∪ LIVE_UNLOCKED is reachable yet.
    const open = TOPICS.filter((t) => states.get(t) !== 'locked');
    expect([...open].sort()).toEqual(
      [
        ...ROOT_TOPICS,
        'two-pointer',
        'binary-search',
        ...LIVE_UNLOCKED,
      ].sort()
    );
  });

  it('an extra medium solve does not change the tier or the unlocks', () => {
    // The live DB has moved on by one clean arrays medium solve since the
    // fixture above was modelled. That is progress toward medium, not a tier
    // change — and it must not disturb anything.
    const bumped = skillSet(
      practised('arrays', { easy: 5, medium: 2 }, 20, 11),
      practised('two-pointer', { easy: 5, medium: 1 }, 24, 11),
      practised('binary-search', { easy: 3, medium: 3 }, 13, 9)
    );
    const before = treeStates(liveSkills());
    const after = treeStates(bumped);
    for (const t of TOPICS) expect(after.get(t)).toBe(before.get(t));
    expect(skillTier(bumped[0]).level).toBe('easy');
    expect(skillTier(bumped[0]).towardNext).toBe(2);
  });

  it('opens a topic as soon as ONE prerequisite reaches the unlock tier', () => {
    // sliding-window needs arrays AND two-pointer on paper; the scheduler's
    // new-pattern rule only ever required one of them.
    const levels = levelMap(skillSet(practised('arrays', { easy: 3 })));
    expect(treeState(blank('sliding-window'), levels)).toBe('available');
    expect(treeState(blank('trees'), levels)).toBe('locked'); // linked-list untouched
  });

  it('is `practiced`, not `tiered`, one clean solve short of the easy tier', () => {
    const nearly = practised('arrays', { easy: TIER_REQUIREMENT - 1 });
    expect(treeState(nearly, levelMap([nearly]))).toBe('practiced');
    // ...and that topic opens nothing.
    expect(treeState(blank('stack'), levelMap([nearly]))).toBe('locked');
  });

  it('grinding one problem forever never opens anything', () => {
    // The exploit, end to end: 30 clean re-solves of ONE problem is one credit.
    const spammed = practised('arrays', { easy: 1 }, 30, 30);
    const levels = levelMap([spammed]);
    expect(treeState(spammed, levels)).toBe('practiced');
    expect(treeState(blank('stack'), levels)).toBe('locked');
  });
});

// -----------------------------------------------------------------------------
describe('solvesToUnlock', () => {
  it('is 0 for a topic already at or past the unlock tier', () => {
    expect(solvesToUnlock(practised('binary-search', { easy: 3, medium: 3 }))).toBe(0);
    expect(solvesToUnlock(practised('arrays', { easy: 5, medium: 1 }))).toBe(0);
  });

  it('counts what is LEFT of the easy tier, and nothing else', () => {
    expect(solvesToUnlock(blank('hashing'))).toBe(TIER_REQUIREMENT);
    expect(solvesToUnlock(practised('hashing', { easy: 1 }))).toBe(2);
    expect(solvesToUnlock(practised('hashing', { easy: 2 }))).toBe(1);
  });

  it('ignores solves at other difficulties — the gate is the easy tier', () => {
    expect(solvesToUnlock(practised('hashing', { medium: 9, hard: 9 }))).toBe(TIER_REQUIREMENT);
    expect(UNLOCK_TIER).toBe('easy');
  });

  it('is unmoved by a wall of attempts that earned no credit', () => {
    const buried: ReflectSkill = { ...blank('arrays'), attempts: 500, solved: 0 };
    expect(solvesToUnlock(buried)).toBe(TIER_REQUIREMENT);
  });
});

// -----------------------------------------------------------------------------
describe('computeNextUnlock', () => {
  it('points past the arrays tier on the live shape — that wall is already down', () => {
    // arrays and two-pointer have both completed the easy tier, so everything
    // they gate is already open. The next wall is `trees`, behind an untouched
    // but reachable `linked-list` — a full easy tier away.
    const skills = liveSkills();
    const next = computeNextUnlock(skills);
    expect(next).not.toBeNull();
    expect(next!.topic).toBe('linked-list');
    expect(next!.cleanSolvesNeeded).toBe(TIER_REQUIREMENT);
    expect(next!.currentMastery).toBe(0);
    expect(next!.unlocks).toContain('trees');
  });

  it('lists the unlocked topics in curriculum order', () => {
    const next = computeNextUnlock(liveSkills())!;
    const position = new Map(curriculumOrder().map((t, i) => [t, i]));
    const positions = next.unlocks.map((t) => position.get(t)!);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('never points at a topic the user cannot practice yet', () => {
    const next = computeNextUnlock(liveSkills())!;
    expect(treeStates(liveSkills()).get(next.topic)).not.toBe('locked');
    for (const t of next.unlocks) expect(PREREQS[t]).toContain(next.topic);
  });

  it('picks the cheapest reachable prerequisite', () => {
    // arrays is 1 clean solve from the easy tier; two-pointer is 3. Both gate
    // `intervals`, so the answer must be arrays.
    const skills = skillSet(
      practised('arrays', { easy: 2 }),
      practised('two-pointer', { easy: 0 })
    );
    const next = computeNextUnlock(skills)!;
    expect(next.topic).toBe('arrays');
    expect(next.cleanSolvesNeeded).toBe(1);
    expect(next.unlocks).toEqual(
      expect.arrayContaining<Topic>(['stack', 'linked-list', 'intervals'])
    );
  });

  it('is null when nothing is locked', () => {
    // Take every root plus the structural spine to the unlock tier — enough
    // that the any-prereq rule opens the whole tree.
    const spine: Topic[] = [
      ...ROOT_TOPICS,
      'linked-list',
      'trees',
      'bfs-dfs',
      'backtracking',
      'intervals',
    ];
    const skills = skillSet(...spine.map((t) => practised(t, { easy: 3 })));
    expect([...treeStates(skills).values()]).not.toContain('locked');
    expect(computeNextUnlock(skills)).toBeNull();
  });

  it('answers at cold start — the roots are always reachable', () => {
    const next = computeNextUnlock(skillSet());
    expect(next).not.toBeNull();
    expect(ROOT_TOPICS).toContain(next!.topic);
    expect(next!.cleanSolvesNeeded).toBe(TIER_REQUIREMENT);
    expect(next!.currentMastery).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('computeTrend', () => {
  const problem = (
    problemId: string,
    attempts: ReflectProblemAttempts['attempts']
  ): ReflectProblemAttempts => ({ problemId, title: `P ${problemId}`, topic: 'arrays', attempts });

  it('reports submitsToPass: null for a problem that was never solved', () => {
    const [point] = computeTrend([
      problem('never', [
        { solved: false, testsPassed: 1, testsTotal: 4, createdAt: '2026-08-01T10:00:00.000Z' },
        { solved: false, testsPassed: 3, testsTotal: 4, createdAt: '2026-08-01T10:20:00.000Z' },
      ]),
    ]);
    expect(point.submitsToPass).toBeNull();
    expect(point.minutesToSolve).toBeNull();
    expect(point.firstSubmitRatio).toBe(0.25);
    expect(point.at).toBe('2026-08-01T10:00:00.000Z');
  });

  it('counts submits 1-indexed and measures minutes from the first submit', () => {
    const [point] = computeTrend([
      problem('third', [
        { solved: false, testsPassed: 0, testsTotal: 5, createdAt: '2026-08-02T09:00:00.000Z' },
        { solved: false, testsPassed: 3, testsTotal: 5, createdAt: '2026-08-02T09:07:30.000Z' },
        { solved: true, testsPassed: 5, testsTotal: 5, createdAt: '2026-08-02T09:12:00.000Z' },
      ]),
    ]);
    expect(point.submitsToPass).toBe(3);
    expect(point.minutesToSolve).toBe(12);
    expect(point.firstSubmitRatio).toBe(0);
  });

  it('handles a first-try solve (0 minutes, 1 submit, ratio 1)', () => {
    const [point] = computeTrend([
      problem('clean', [
        { solved: true, testsPassed: 6, testsTotal: 6, createdAt: '2026-08-03T09:00:00.000Z' },
      ]),
    ]);
    expect(point).toMatchObject({ submitsToPass: 1, minutesToSolve: 0, firstSubmitRatio: 1 });
  });

  it('orders points chronologically and sorts out-of-order attempt rows', () => {
    const trend = computeTrend([
      problem('late', [
        { solved: true, testsPassed: 2, testsTotal: 2, createdAt: '2026-08-05T09:00:00.000Z' },
      ]),
      problem('early', [
        // deliberately reversed — the newest row arrives first
        { solved: true, testsPassed: 2, testsTotal: 2, createdAt: '2026-08-01T09:30:00.000Z' },
        { solved: false, testsPassed: 0, testsTotal: 2, createdAt: '2026-08-01T09:00:00.000Z' },
      ]),
    ]);
    expect(trend.map((p) => p.problemId)).toEqual(['early', 'late']);
    expect(trend[0].firstSubmitRatio).toBe(0); // the 09:00 row is the first submit
    expect(trend[0].submitsToPass).toBe(2);
  });

  it('does not divide by zero when a submit recorded no tests', () => {
    const [point] = computeTrend([
      problem('harness-error', [
        { solved: false, testsPassed: 0, testsTotal: 0, createdAt: '2026-08-04T09:00:00.000Z' },
      ]),
    ]);
    expect(point.firstSubmitRatio).toBe(0);
  });

  it('skips a problem with no attempts at all', () => {
    expect(computeTrend([problem('empty', [])])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('splitMistakes', () => {
  const at = (day: number, tags: string[]) => ({
    mistakeTags: tags,
    createdAt: `2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`,
  });

  it('splits tag counts into earlier and recent halves', () => {
    const rows = splitMistakes([
      at(1, ['off-by-one']),
      at(2, ['off-by-one', 'brute-force-only']),
      at(3, ['brute-force-only']),
      at(4, ['brute-force-only']),
    ]);
    const byTag = new Map(rows.map((r) => [r.tag, r]));
    expect(byTag.get('off-by-one')).toEqual({
      tag: 'off-by-one',
      count: 2,
      earlier: 2,
      recent: 0,
    });
    expect(byTag.get('brute-force-only')).toEqual({
      tag: 'brute-force-only',
      count: 3,
      earlier: 1,
      recent: 2,
    });
    // earlier + recent always reconstructs count.
    for (const r of rows) expect(r.earlier + r.recent).toBe(r.count);
  });

  it('ranks by count desc, then tag asc, and is order-independent', () => {
    const input = [at(3, ['b']), at(1, ['a', 'b']), at(2, ['b', 'c'])];
    const rows = splitMistakes(input);
    expect(rows.map((r) => r.tag)).toEqual(['b', 'a', 'c']);
    expect(splitMistakes([...input].reverse())).toEqual(rows);
  });

  it('gives the odd attempt to the recent half', () => {
    const rows = splitMistakes([at(1, ['x']), at(2, ['x']), at(3, ['x'])]);
    expect(rows[0]).toEqual({ tag: 'x', count: 3, earlier: 1, recent: 2 });
  });

  it('is empty for no tagged attempts', () => {
    expect(splitMistakes([])).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
describe('buildActivity', () => {
  it('returns a dense window ending today, oldest first', () => {
    const days = buildActivity([{ date: '2026-08-10', attempts: 3, solved: 1 }], 84, NOW);
    expect(days).toHaveLength(84);
    expect(days[days.length - 1].date).toBe('2026-08-12'); // NOW's UTC day
    expect(days[0].date).toBe('2026-05-21'); // 83 days earlier
    for (let i = 1; i < days.length; i++) {
      expect(days[i].date > days[i - 1].date).toBe(true);
    }
    expect(days.find((d) => d.date === '2026-08-10')).toEqual({
      date: '2026-08-10',
      attempts: 3,
      solved: 1,
    });
    expect(days.find((d) => d.date === '2026-08-09')).toEqual({
      date: '2026-08-09',
      attempts: 0,
      solved: 0,
    });
  });

  it('ignores rows outside the window rather than widening it', () => {
    const days = buildActivity([{ date: '2020-01-01', attempts: 9, solved: 9 }], 7, NOW);
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.attempts === 0)).toBe(true);
  });
});

describe('computeDayStreak', () => {
  const day = (date: string, attempts: number) => ({ date, attempts, solved: 0 });

  it('counts back from today and forgives an empty today', () => {
    expect(
      computeDayStreak([
        day('2026-08-08', 1),
        day('2026-08-09', 0),
        day('2026-08-10', 2),
        day('2026-08-11', 1),
        day('2026-08-12', 0), // today, not over yet
      ])
    ).toBe(2);
  });

  it('breaks on a gap that is not today', () => {
    expect(
      computeDayStreak([day('2026-08-10', 1), day('2026-08-11', 0), day('2026-08-12', 1)])
    ).toBe(1);
  });

  it('is 0 with no activity', () => {
    expect(computeDayStreak([day('2026-08-11', 0), day('2026-08-12', 0)])).toBe(0);
    expect(computeDayStreak([])).toBe(0);
  });
});
