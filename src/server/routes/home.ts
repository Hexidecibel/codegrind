// =============================================================================
// routes/home — "This week" on the Home page
// =============================================================================
//   GET /api/home/weekly?days=7   (1..60)                               free
//
// The window is the last `days` LOCAL days (CODEGRIND_TZ), today included.
// Read-only and no model call: rows → services/weekly.compute, the same numbers
// bin/progress-report prints. Readiness and the refresh state come from
// today.service.getToday (never the kicking variant), so nothing is duplicated.

import { Hono } from 'hono';
import { TOPICS } from '../../shared/types.js';
import { clampWeeklyDays, type WeeklyResponse } from '../../shared/weekly.js';
import { db, getActiveLanguage, getCleanSolvesByTopic, getSkillState } from '../services/db.js';
import { emptyCleanSolves } from '../services/curriculum.js';
import { curriculumOrder, treeStates, type ReflectSkill } from '../services/reflect.compute.js';
import { getToday } from '../services/today.service.js';
import { dayStartMs, localDay, todayTz } from '../services/today.compute.js';
import { classifyGrind, pickTarget, reviewsByTopic, summarizeWindow } from '../services/weekly.compute.js';
import { loadReviewRows, loadWeeklyRows } from '../services/weekly.rows.js';

export const homeRoutes = new Hono();

const DAY = 86_400_000;

/** Topics whose gate is open for this language (Reflect's tree rule). */
function unlockedTopics(language: ReturnType<typeof getActiveLanguage>): Set<string> {
  const skillByTopic = new Map(getSkillState(language).map((s) => [s.topic, s]));
  const clean = getCleanSolvesByTopic(language);
  const skills: ReflectSkill[] = TOPICS.map((topic) => {
    const s = skillByTopic.get(topic);
    return {
      topic,
      attempts: s?.attempts ?? 0,
      solved: s?.solved ?? 0,
      cleanSolves: clean.get(topic) ?? emptyCleanSolves(),
      box: s?.box ?? 0,
      streak: s?.streak ?? 0,
      lastSeenAt: s?.lastSeenAt ?? null,
    };
  });
  const states = treeStates(skills);
  return new Set(TOPICS.filter((t) => states.get(t) !== 'locked'));
}

export function weekly(days: number, now = new Date()): WeeklyResponse {
  const tz = todayTz();
  const nowMs = now.getTime();
  const to = localDay(nowMs, tz);
  const from = localDay(nowMs - (days - 1) * DAY, tz);
  const since = dayStartMs(from, tz);
  const language = getActiveLanguage();

  const rows = loadWeeklyRows(db, new Date(since).toISOString());
  const grindIds = classifyGrind(rows.attempts, rows.sessions);
  const s = summarizeWindow({ ...rows, grindIds, since, now: nowMs, tz, language });
  const reviewDue = reviewsByTopic(loadReviewRows(db), nowMs, language);

  const order = curriculumOrder();
  const unlocked = unlockedTopics(language);
  const lastDifficulty = new Map<string, string>();
  for (const a of rows.attempts) {
    if (a.language === language && Date.parse(a.createdAt) >= since) lastDifficulty.set(a.pattern, a.difficulty);
  }

  // Readiness + refresh as Today computes them. A failure here costs only the
  // first two target branches, never the whole panel.
  let readiness: { id: string; verdict: string }[] = [];
  let refresh = null as Parameters<typeof pickTarget>[0]['refresh'];
  try {
    const t = getToday(now);
    readiness = t.readiness;
    refresh = t.refresh;
  } catch (err) {
    console.warn('[home] today state unavailable:', err instanceof Error ? err.message : err);
  }

  const untouched = order.filter((t) => s.untouched.includes(t) && unlocked.has(t));
  return {
    days,
    from,
    to,
    activeDays: s.practiceDays,
    daily: s.daily,
    volume: { subs: s.subs, problems: s.problems, grindSubs: s.grind.subs, freeSubs: s.free.subs },
    topics: s.topics,
    untouched,
    nearMisses: s.nearMisses,
    recognize: s.recognize,
    envelope: s.envelope,
    reviewDue,
    mocks: { thisWeek: s.mocks.inWindow, lastAt: s.mocks.lastAt },
    target: pickTarget({ summary: { topics: s.topics, untouched }, reviews: reviewDue, readiness, refresh, order, unlocked, lastDifficulty }),
  };
}

homeRoutes.get('/home/weekly', (c) => {
  try {
    return c.json(weekly(clampWeeklyDays(c.req.query('days'))));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[home]', message);
    return c.json({ error: message }, 500);
  }
});
