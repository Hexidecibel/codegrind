// =============================================================================
// GradeReport — every stage is shown, and taught material is labelled unscored
// =============================================================================
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GradeReport } from './GradeReport';
import { SD_STAGES, SD_STAGE_META } from '@/shared/sd';
import type { MockGrade } from '@/shared/mock';

const GRADE: MockGrade = {
  level: 'staff',
  verdict: 'below',
  summary: 'Strong questions, no ranking.',
  stages: SD_STAGES.map((stage, i) => ({
    stage,
    score: i < 2 ? 3 : 0,
    evidence: i < 2 ? `evidence ${i}` : 'not reached',
    atLevel: i === 0,
    staffWouldAdd: i === 0 ? 'Rank the failures.' : '',
    principalWouldAdd: '',
  })),
  skipped: ['api'],
  gapsTaught: [{ concept: 'idempotency', summary: 'did not know keys' }],
  conceptObservations: [{ concept: 'failure-ranking', signal: 'weak', note: 'n' }],
  drills: [{ concept: 'failure-ranking', prompt: 'Say your ranking sentence for a URL shortener.', why: 'weak' }],
};

const html = renderToStaticMarkup(<GradeReport grade={GRADE} usage={{ calls: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.31, models: [] }} />);

describe('the grade report', () => {
  it('shows every stage, reached or not', () => {
    for (const s of SD_STAGES) expect(html).toContain(SD_STAGE_META[s].label);
    expect(html).toContain('not reached');
    expect(html).toContain('skipped');
  });

  it('lists the drills and labels taught concepts as not scored', () => {
    expect(html).toContain('Say your ranking sentence for a URL shortener.');
    expect(html).toContain('Taught during the mock (not scored)');
    expect(html).toContain('idempotency');
  });

  it('names the verdict, the level and the cost', () => {
    expect(html).toContain('Below level');
    expect(html).toContain('Staff');
    expect(html).toContain('$0.31');
  });
});
