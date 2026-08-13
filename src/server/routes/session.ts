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
} from '../services/db.js';
import { TIER_REQUIREMENT, WEAK_SCORE, tierProgress } from '../services/curriculum.js';
import { planSession, type SessionSnapshotTopic } from '../services/llm.service.js';
import { nextIntent, peekUpNext, type SchedulerIntent } from '../services/scheduler.service.js';
import { getAdaptiveProblem } from '../services/bank.service.js';

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
function buildSnapshot(): SessionSnapshotTopic[] {
  const skill = new Map(getSkillState().map((s) => [s.topic, s]));
  const clean = getCleanSolvesByTopic();
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

    // Plan the session arc once (best-effort — fall back to a default plan).
    let plan: SessionPlan;
    try {
      plan = await planSession(buildSnapshot());
    } catch (err) {
      console.warn('[session/start] planSession failed, using default plan:', err instanceof Error ? err.message : err);
      plan = DEFAULT_PLAN;
    }

    const intent = nextIntent({ plan });
    const record = await getAdaptiveProblem(intent);

    createSession(sessionId, plan);
    bumpSession(sessionId, intent.topic);

    const payload: SessionStartResponse = {
      sessionId,
      plan,
      problem: toPlayerProblem(record),
      why: intentToWhy(intent),
      upNext: peekUpNext({ plan, avoidTopic: intent.topic }),
    };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[session/start]', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/session/:id/next — pick + serve the next adaptive problem.
sessionRoutes.post('/session/:id/next', async (c) => {
  try {
    const id = c.req.param('id');
    const session = getSession(id);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const intent = nextIntent({
      plan: session.plan,
      avoidTopic: session.lastTopic ?? undefined,
    });
    const record = await getAdaptiveProblem(intent);
    bumpSession(id, intent.topic);

    const payload: GrindProblem = {
      sessionId: id,
      problem: toPlayerProblem(record),
      why: intentToWhy(intent),
      upNext: peekUpNext({ plan: session.plan, avoidTopic: intent.topic }),
    };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[session/next]', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/session/:id — resume: plan + counters.
sessionRoutes.get('/session/:id', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);
  if (!session) return c.json({ error: 'session not found' }, 404);
  return c.json({
    sessionId: session.id,
    createdAt: session.createdAt,
    plan: session.plan,
    served: session.served,
    lastTopic: session.lastTopic as Topic | null,
  });
});
