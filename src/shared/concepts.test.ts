import { describe, it, expect } from 'vitest';
import { AI_SD_CONCEPTS, SD_CONCEPTS, conceptLabel } from './sd.js';
import { AI_SD_PROMPTS, SD_PROMPTS, pickPrompt } from './sd-prompts.js';
import { CONCEPT_RUBRICS, CLASSIC_REP_CONCEPTS, REP_CONCEPTS, conceptRubric } from './concept-rubrics.js';
import {
  AI_UNLOCK_KNOWN,
  KNOWN_AFTER_DAYS,
  aiPromptsUnlocked,
  categoryOf,
  learningState,
  learningStates,
  pickCategory,
  pickConcept,
  type RepFact,
} from './concepts.js';
import { AI_ANCHORS, RUBRIC_TEXT } from '../server/services/sd-rubric.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-21T20:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const rep = (concept: string, grade: RepFact['grade'], daysAgo: number, primed = false): RepFact => ({
  concept,
  grade,
  primed,
  createdAt: iso(daysAgo * DAY),
});

describe('the AI system-design prompt catalog', () => {
  it('has the eight-plus AI prompts, each shaped like the rest', () => {
    expect(AI_SD_PROMPTS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SD_PROMPTS.map((p) => p.id)).size).toBe(SD_PROMPTS.length);
    for (const p of AI_SD_PROMPTS) {
      expect(p.title.length, p.id).toBeGreaterThan(10);
      expect(p.brief, p.id).toMatch(/^Design /);
      expect(p.twists.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.familiar, p.id).toBe(false);
    }
    const ids = AI_SD_PROMPTS.map((p) => p.id);
    for (const want of ['rag-company-docs', 'agent-with-tools-evals', 'llm-gateway', 'inference-serving', 'llm-eval-pipeline', 'llm-guardrails', 'embedding-search-at-scale']) {
      expect(ids).toContain(want);
    }
  });

  it('the AI concepts are in the closed SD vocabulary, with labels', () => {
    for (const c of AI_SD_CONCEPTS) {
      expect(SD_CONCEPTS).toContain(c);
      expect(conceptLabel(c)).not.toContain('-');
    }
  });

  it('the rubric carries AI anchors on the stages that need them, for every level', () => {
    expect(Object.keys(AI_ANCHORS)).toEqual(expect.arrayContaining(['requirements', 'capacity', 'deep-dive', 'tradeoffs']));
    for (const text of Object.values(RUBRIC_TEXT)) {
      expect(text).toContain('For an AI/LLM system: Numbers in tokens');
    }
  });
});

describe('pickPrompt — AI prompts are gated, then mixed in', () => {
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i / n);

  it('locked: the random pick never serves an AI prompt, even for an AI-focused loop', () => {
    for (const r of seq(40)) {
      expect(pickPrompt(['url-shortener'], () => r).ai).toBeFalsy();
      expect(pickPrompt(['url-shortener'], () => r, { aiFocus: true }).ai).toBeFalsy();
      expect(pickPrompt([], () => r, { aiFocus: true }).familiar).toBe(true);
    }
  });

  it('unlocked: an AI prompt when none of the last two mocks was one; the whole pool otherwise', () => {
    for (const r of seq(20)) expect(pickPrompt(['url-shortener', 'parking-city'], () => r, { aiUnlocked: true }).ai).toBe(true);
    const mixed = new Set(seq(40).map((r) => !!pickPrompt(['llm-gateway', 'url-shortener'], () => r, { aiUnlocked: true }).ai));
    expect(mixed).toEqual(new Set([true, false]));
  });

  it('unlocked + AI-focused loop: AI prompts every time one is fresh, and the first mock too', () => {
    for (const r of seq(20)) {
      expect(pickPrompt(['llm-gateway', 'rag-company-docs'], () => r, { aiUnlocked: true, aiFocus: true }).ai).toBe(true);
      expect(pickPrompt([], () => r, { aiUnlocked: true, aiFocus: true }).ai).toBe(true);
    }
  });

  it('still avoids the last five prompts', () => {
    const recent = AI_SD_PROMPTS.slice(0, 5).map((p) => p.id);
    for (const r of seq(20)) expect(recent).not.toContain(pickPrompt(recent, () => r, { aiUnlocked: true, aiFocus: true }).id);
  });
});

describe('concept rubrics', () => {
  it('cover every AI concept and a classic core, each complete', () => {
    expect(REP_CONCEPTS).toEqual(expect.arrayContaining([...AI_SD_CONCEPTS]));
    expect(CLASSIC_REP_CONCEPTS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(REP_CONCEPTS).size).toBe(REP_CONCEPTS.length);
    for (const r of CONCEPT_RUBRICS) {
      expect(SD_CONCEPTS, r.concept).toContain(r.concept);
      expect(r.prompts.length, r.concept).toBeGreaterThanOrEqual(2);
      expect(r.keyPoints.length, r.concept).toBeGreaterThanOrEqual(4);
      expect(r.keyPoints.length, r.concept).toBeLessThanOrEqual(5);
      expect(r.mistake.length, r.concept).toBeGreaterThan(30);
      expect(r.example, r.concept).toMatch(/\d/); // a worked example has numbers
      expect(r.primer.length, r.concept).toBeGreaterThan(60);
      for (const q of r.prompts) expect(q, r.concept).toMatch(/[?.]$/);
    }
    expect(conceptRubric('not-a-concept')).toBeNull();
  });

  it('never claims usage of the user\'s own product (dox has no customers)', () => {
    const all = JSON.stringify(CONCEPT_RUBRICS);
    expect(all).not.toMatch(/\b(dox|supdox)\b[^.]*\b(customers|users) (use|rely)/i);
  });
});

describe('learning state: new → learning → known', () => {
  const learnedAt = iso(5 * DAY);

  it('new until learned; learning until a cold got at least KNOWN_AFTER_DAYS later', () => {
    expect(learningState(null, [], 'eval-design')).toBe('new');
    expect(learningState(learnedAt, [], 'eval-design')).toBe('learning');
    // A got on the primed rep the day it was learned does not count.
    expect(learningState(learnedAt, [rep('eval-design', 'got', 5, true)], 'eval-design')).toBe('learning');
    // Nor does a cold got one day after learning.
    expect(learningState(learnedAt, [rep('eval-design', 'got', 4)], 'eval-design')).toBe('learning');
    expect(learningState(learnedAt, [rep('eval-design', 'got', 5 - KNOWN_AFTER_DAYS)], 'eval-design')).toBe('known');
  });

  it('a later cold miss drops it back to learning', () => {
    expect(learningState(learnedAt, [rep('eval-design', 'got', 2), rep('eval-design', 'missed', 0)], 'eval-design')).toBe('learning');
  });

  it(`AI prompts unlock at ${AI_UNLOCK_KNOWN} known AI concepts — classic ones do not count`, () => {
    const learned: Record<string, string> = {};
    const reps: RepFact[] = [];
    for (const c of [...AI_SD_CONCEPTS.slice(0, AI_UNLOCK_KNOWN - 1), ...CLASSIC_REP_CONCEPTS]) {
      learned[c] = iso(10 * DAY);
      reps.push(rep(c, 'got', 1));
    }
    expect(aiPromptsUnlocked(learningStates(learned, reps))).toBe(false);
    const c = AI_SD_CONCEPTS[AI_UNLOCK_KNOWN - 1];
    learned[c] = iso(10 * DAY);
    reps.push(rep(c, 'got', 1));
    expect(aiPromptsUnlocked(learningStates(learned, reps))).toBe(true);
  });
});

describe('pickConcept', () => {
  const base = { now: NOW, day: '2026-10-21', reps: [] as RepFact[], learned: {}, signals: [], aiFocus: false };

  it('a first day: an AI concept, new, teach-first, first in the track', () => {
    const p = pickConcept(base);
    expect(p.category).toBe('ai');
    expect(p.state).toBe('new');
    expect(p.concept).toBe(AI_SD_CONCEPTS[0]);
  });

  it('while AI is being learned, alternates AI and classic by the previous rep', () => {
    const afterAi = pickConcept({ ...base, reps: [rep('retrieval-quality', 'got', 1, true)], learned: { 'retrieval-quality': iso(DAY) } });
    expect(afterAi.category).toBe('classic');
    const afterClassic = pickConcept({ ...base, reps: [rep('idempotency', 'got', 1)] });
    expect(afterClassic.category).toBe('ai');
  });

  it('an AI-focused loop: AI two days in three', () => {
    expect(pickCategory({ reps: [rep('eval-design', 'got', 1)], aiFocus: true }, {})).toBe('ai');
    expect(pickCategory({ reps: [rep('eval-design', 'got', 1), rep('latency-budget', 'got', 2)], aiFocus: true }, {})).toBe('classic');
  });

  it('weights classic picks toward concepts weak in mocks', () => {
    const p = pickConcept({
      ...base,
      reps: [rep('retrieval-quality', 'got', 1, true)],
      signals: [
        { concept: 'rate-limiting', signal: 'missing' },
        { concept: 'rate-limiting', signal: 'weak' },
        { concept: 'idempotency', signal: 'nailed' },
      ],
    });
    expect(p.concept).toBe('rate-limiting');
    expect(p.why).toMatch(/weak in recent mocks/);
  });

  it('a learning AI concept comes back for its cold rep once due, ahead of a new one', () => {
    const p = pickConcept({
      ...base,
      reps: [rep('idempotency', 'got', 0.5), rep('eval-design', 'shaky', 3, true)],
      learned: { 'eval-design': iso(3 * DAY) },
    });
    expect(p.concept).toBe('eval-design');
    expect(p.state).toBe('learning');
    expect(p.promptIdx).toBe(1); // the second phrasing on the second rep
  });

  it('spacing: a concept repped yesterday and got is not picked again', () => {
    const p = pickConcept({
      ...base,
      reps: [rep('idempotency', 'got', 0.5)],
      signals: [{ concept: 'idempotency', signal: 'missing' }],
    });
    // The category is AI now (alternation), but even in a mixed pool it would not be idempotency.
    expect(p.concept).not.toBe('idempotency');
    const classic = pickConcept({ ...base, reps: [rep('retrieval-quality', 'got', 0.5, true), rep('idempotency', 'got', 1)], signals: [{ concept: 'idempotency', signal: 'missing' }] });
    expect(classic.concept).not.toBe('idempotency');
  });

  it('a second rep today excludes the first', () => {
    const p = pickConcept({ ...base, exclude: [AI_SD_CONCEPTS[0]] });
    expect(p.concept).not.toBe(AI_SD_CONCEPTS[0]);
  });

  it('categoryOf', () => {
    expect(categoryOf('eval-design')).toBe('ai');
    expect(categoryOf('idempotency')).toBe('classic');
  });
});
