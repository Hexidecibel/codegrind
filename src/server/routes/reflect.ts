import { Hono } from 'hono';
import { TOPICS, type ReflectResponse, type ReflectTreeNode } from '../../shared/types.js';
import {
  getSkillState,
  getCleanSolvesByTopic,
  getAllTrackOutlines,
  getLessonReadCounts,
  getReviewDueCount,
  getAttemptsByProblem,
  getDailyActivity,
  getTaggedAttempts,
  getSolvedProblemCount,
  getHintFreeRate,
} from '../services/db.js';
import {
  PREREQS,
  TIER_REQUIREMENT,
  emptyCleanSolves,
  levelIndex,
  tierLabel,
} from '../services/curriculum.js';
import { trackSlotCount } from '../services/study.order.js';
import {
  ACTIVITY_DAYS,
  buildActivity,
  computeDayStreak,
  computeNextUnlock,
  computeTrend,
  curriculumOrder,
  skillTier,
  splitMistakes,
  topicDepth,
  treeStates,
  type ReflectSkill,
} from '../services/reflect.compute.js';

export const reflectRoutes = new Hono();

// GET /api/reflect — the whole progress dashboard in one payload. Everything is
// derived here (where the curriculum lives) so the client only ever renders.
reflectRoutes.get('/reflect', (c) => {
  try {
    const now = Date.now();

    // --- per-topic skill, one row per TOPIC (untouched topics get zeros) ------
    // cleanSolves is the tier ladder's only input; everything progress-shaped
    // (tier, score, served difficulty) is derived from it in reflect.compute.
    const skillByTopic = new Map(getSkillState().map((s) => [s.topic, s]));
    const cleanByTopic = getCleanSolvesByTopic();
    const skills: ReflectSkill[] = TOPICS.map((topic) => {
      const s = skillByTopic.get(topic);
      return {
        topic,
        attempts: s?.attempts ?? 0,
        solved: s?.solved ?? 0,
        cleanSolves: cleanByTopic.get(topic) ?? emptyCleanSolves(),
        box: s?.box ?? 0,
        streak: s?.streak ?? 0,
        lastSeenAt: s?.lastSeenAt ?? null,
      };
    });

    // --- the tree ------------------------------------------------------------
    const states = treeStates(skills);
    const depth = topicDepth();
    const outlines = getAllTrackOutlines();
    const reads = getLessonReadCounts();
    const byTopic = new Map(skills.map((s) => [s.topic, s]));

    let tiersCleared = 0;

    const tree: ReflectTreeNode[] = curriculumOrder().map((topic) => {
      const s = byTopic.get(topic)!;
      const tier = skillTier(s);
      tiersCleared += levelIndex(tier.level);
      return {
        topic,
        state: states.get(topic) ?? 'locked',
        mastery: tier.score,
        tier: tier.level,
        tierLabel: tierLabel(tier),
        nextTier: tier.next,
        towardNext: tier.towardNext,
        tierRequirement: TIER_REQUIREMENT,
        cleanSolves: tier.counts,
        solved: s.solved,
        attempts: s.attempts,
        // Derived from the tier, so Reflect always shows the difficulty the
        // scheduler will actually serve next.
        difficulty: tier.working,
        box: s.box,
        streak: s.streak,
        lessonsRead: reads.get(topic) ?? 0,
        lessonsTotal: trackSlotCount(outlines.get(topic)),
        prereqs: PREREQS[topic],
        depth: depth[topic],
      };
    });

    // --- the rest ------------------------------------------------------------
    const activity = buildActivity(getDailyActivity(ACTIVITY_DAYS), ACTIVITY_DAYS, now);
    let lessonsRead = 0;
    for (const n of reads.values()) lessonsRead += n;

    const payload: ReflectResponse = {
      tree,
      nextUnlock: computeNextUnlock(skills),
      tiles: {
        solved: getSolvedProblemCount(),
        topicsReached: tree.filter((n) => n.state !== 'locked').length,
        streak: computeDayStreak(activity),
        hintFreeRate: getHintFreeRate(),
        tiersCleared,
        lessonsRead,
        reviewDue: getReviewDueCount(),
      },
      activity,
      trend: computeTrend(getAttemptsByProblem()),
      mistakes: splitMistakes(getTaggedAttempts()),
    };

    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[reflect]', message);
    return c.json({ error: message }, 500);
  }
});
