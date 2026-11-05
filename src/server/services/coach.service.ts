// =============================================================================
// coach.service — the stateful half of coach.brain: read the tables, hand the
// pure brain its state. Generates nothing; no LLM import here on purpose.
// =============================================================================

import type { TierLevel, Topic } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
import { tierProgress } from './curriculum.js';
import { getCleanSolvesByTopic, getDueReviews, getSkillState, getTaggedAttempts } from './db.js';
import { buildStudyState } from './study.service.js';
import type { CoachSlip, CoachState } from './coach.brain.js';

export function buildCoachState(language: Language): CoachState {
  const base = buildStudyState(language);

  const tiers = new Map<Topic, TierLevel>();
  for (const [topic, counts] of getCleanSolvesByTopic(language)) {
    tiers.set(topic, tierProgress(counts).level);
  }

  const failed = new Set(
    getSkillState(language)
      .filter((s) => s.lastResult === 'failed')
      .map((s) => s.topic)
  );

  const slips: CoachSlip[] = [];
  for (const a of getTaggedAttempts(language)) {
    for (const tag of a.mistakeTags) {
      slips.push({
        tag,
        topic: a.topic ?? null,
        at: a.createdAt,
        problemId: a.problemId,
        problemTitle: a.problemTitle,
      });
    }
  }

  return {
    ...base,
    language,
    skills: base.skills.map((s) => (failed.has(s.topic) ? { ...s, lastFailed: true } : s)),
    slips,
    tiers,
    reviews: getDueReviews(language).map((r) => ({
      problemId: r.problemId,
      topic: r.topic,
      difficulty: r.difficulty,
      dueAt: r.dueAt,
      title: r.title,
    })),
  };
}
