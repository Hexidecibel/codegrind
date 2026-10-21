import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import {
  TOPICS,
  toPlayerProblem,
  type Topic,
  type SchedulerWhy,
  type SessionPlan,
  type SessionStartResponse,
  type GrindProblem,
} from '../../shared/types.js';
import {
  getSkillState,
  getCleanSolvesByTopic,
  createSession,
  getSession,
  bumpSession,
  getActiveLanguage,
  snoozeReview,
} from '../services/db.js';
import type { Language } from '../../shared/languages.js';
import { TIER_REQUIREMENT, WEAK_SCORE, tierProgress } from '../services/curriculum.js';
import { planSession, type SessionSnapshotTopic } from '../services/llm.service.js';
import { nextIntent, peekUpNext, type SchedulerIntent } from '../services/scheduler.service.js';
import { getAdaptiveProblem } from '../services/bank.service.js';
import { errorBody } from '../services/explain.service.js';
import { dailyFocus, todayMissTopics } from '../services/today.service.js';

export const sessionRoutes = new Hono();

const DEFAULT_PLAN: SessionPlan = {
  theme: 'Adaptive practice',
  coachIntro: "Let's get some focused reps in — I'll pick problems as we go.",
  focus: [],
};

/**
 * Build the per-topic tier snapshot the session planner reasons over. Same
 * ladder the scheduler uses (curriculum.tierProgress) — this route used to
 * hand-roll its own `solveRate * 0.8 + recency * 0.2` copy of the old formula.
 */
function buildSnapshot(language: Language): SessionSnapshotTopic[] {
  const skill = new Map(getSkillState(language).map((s) => [s.topic, s]));
  const clean = getCleanSolvesByTopic(language);
  const now = Date.now();
  return TOPICS.map((topic): SessionSnapshotTopic => {
    const s = skill.get(topic);
    const attempted = s?.attempts ?? 0;
    const tier = tierProgress(clean.get(topic));
    const due = s?.dueAt ? new Date(s.dueAt).getTime() <= now : false;
    return {
      topic,
      attempted,
      solved: s?.solved ?? 0,
      tier: tier.level,
      towardNext: tier.towardNext,
      tierRequirement: TIER_REQUIREMENT,
      nextTier: tier.next,
      currentDifficulty: tier.working,
      due: attempted > 0 && due,
      weak: attempted > 0 && tier.score < WEAK_SCORE,
    };
  });
}

function intentToWhy(intent: SchedulerIntent): SchedulerWhy {
  return {
    kind: intent.kind,
    text: intent.rationale,
    topic: intent.topic,
    difficulty: intent.difficulty,
  };
}

// POST /api/session/start — plan the sitting, serve the first adaptive problem.
sessionRoutes.post('/session/start', async (c) => {
  try {
    const sessionId = nanoid();

    // The sitting's language is decided ONCE, here, and then stored on the
    // session row. Every later /next reads it back off that row rather than
    // re-reading the setting, so flipping the picker mid-sitting cannot serve a
    // problem the plan (and the tier state behind it) was never built for.
    const language = getActiveLanguage();

    // Plan the session arc once (best-effort — fall back to a default plan).
    let plan: SessionPlan;
    try {
      plan = await planSession(buildSnapshot(language));
    } catch (err) {
      console.warn('[session/start] planSession failed, using default plan:', err instanceof Error ? err.message : err);
      plan = DEFAULT_PLAN;
    }

    // The last debrief's tomorrowFocus: a light lean, never a pin.
    const focus = dailyFocus();
    // Today's Recognize / drill-card misses: a smaller same-day lean.
    const misses = todayMissTopics();
    const intent = nextIntent({ language, plan, dailyFocus: focus, missFocus: misses });
    const record = await getAdaptiveProblem(intent);

    createSession(language, sessionId, plan);
    bumpSession(sessionId, intent.topic);

    const payload: SessionStartResponse = {
      sessionId,
      plan,
      problem: toPlayerProblem(record),
      why: intentToWhy(intent),
      upNext: peekUpNext({ language, plan, avoidTopic: intent.topic, dailyFocus: focus, missFocus: misses }),
    };
    return c.json(payload);
  } catch (err) {
    // Explained, not echoed: a cold generation that fails does so with an
    // internal sentence about canonicalization, max_tokens or raw docker
    // output, and this route is the one a player is staring at when it happens.
    // Full detail still reaches the journal and rides along as `detail`.
    return c.json(errorBody('session/start', err), 500);
  }
});

// POST /api/session/:id/next — pick + serve the next adaptive problem.
sessionRoutes.post('/session/:id/next', async (c) => {
  try {
    const id = c.req.param('id');
    const session = getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    // "Next" on a review the player did not attempt is a SKIP. The client names
    // the review it is leaving; snooze it BEFORE the pick, or nextIntent finds
    // the same earliest-due row and serves the same problem back, forever.
    // snoozeReview only touches a row that is still due, so a review that was
    // just solved (cleared) or just missed (already pushed out) is untouched.
    //
    // Read leniently: the body is optional, and a client cached from before
    // this field existed sends `{}` — that must keep working, not 400.
    const body = (await c.req.json().catch(() => null)) as { skipProblemId?: unknown } | null;
    const skipProblemId = body?.skipProblemId;
    if (typeof skipProblemId === 'string' && skipProblemId) snoozeReview(skipProblemId);

    const focus = dailyFocus();
    const misses = todayMissTopics();
    const intent = nextIntent({
      // The language the sitting STARTED in — see createSession above.
      language: session.language,
      plan: session.plan,
      avoidTopic: session.lastTopic ?? undefined,
      dailyFocus: focus,
      missFocus: misses,
    });
    const record = await getAdaptiveProblem(intent);
    bumpSession(id, intent.topic);

    const payload: GrindProblem = {
      sessionId: id,
      problem: toPlayerProblem(record),
      why: intentToWhy(intent),
      upNext: peekUpNext({
        language: session.language,
        plan: session.plan,
        avoidTopic: intent.topic,
        dailyFocus: focus,
        missFocus: misses,
      }),
    };
    return c.json(payload);
  } catch (err) {
    // Explained, not echoed: a cold generation that fails does so with an
    // internal sentence about canonicalization, max_tokens or raw docker
    // output, and this route is the one a player is staring at when it happens.
    // Full detail still reaches the journal and rides along as `detail`.
    return c.json(errorBody('session/next', err), 500);
  }
});

// GET /api/session/:id — resume: plan + counters.
sessionRoutes.get('/session/:id', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) return c.json({ error: 'session not found' }, 404);
  return c.json({
    sessionId: session.id,
    language: session.language,
    createdAt: session.createdAt,
    plan: session.plan,
    served: session.served,
    lastTopic: session.lastTopic as Topic | null,
  });
});
