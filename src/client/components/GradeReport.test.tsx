// =============================================================================
// GradeReport — every stage is shown, and taught material is labelled unscored
// =============================================================================
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
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

describe('the gaps section', () => {
  const gap = (id: number, type: 'fact' | 'skill', title: string) => ({
    id,
    mockId: 'm',
    seq: id,
    concept: 'api-design' as const,
    type,
    title,
    summary: 's',
    answer: `answer ${id}`,
    source: 'turn' as const,
    createdAt: 't',
  });
  const withGaps = renderToStaticMarkup(
    <GradeReport grade={GRADE} gaps={[gap(1, 'fact', '301 or 302?'), gap(2, 'skill', 'Rank the failures.')]} />
  );

  it('splits facts (cheap fixes) from skills (practice areas), skills first', () => {
    expect(withGaps).toContain('Cheap fixes');
    expect(withGaps).toContain('Practice areas');
    expect(withGaps.indexOf('Practice areas')).toBeLessThan(withGaps.indexOf('Cheap fixes'));
    expect(withGaps).toContain('301 or 302?');
    expect(withGaps).toContain('answer 2');
  });

  it('is absent when there are no gaps', () => {
    expect(html).not.toContain('Cheap fixes');
  });
});

describe('a behavioral grade', () => {
  const B: MockGrade = {
    level: 'staff',
    verdict: 'below',
    summary: 'Good stories, buried results.',
    stages: ['intro', 'q1', 'q2', 'q3', 'q4', 'wrap'].map((stage) => ({
      stage, score: stage === 'q1' ? 2 : 0, evidence: 'e', atLevel: false, staffWouldAdd: '', principalWouldAdd: '',
    })),
    skipped: [],
    gapsTaught: [],
    conceptObservations: [],
    drills: [],
    questions: [
      {
        stage: 'q1', concept: 'conflict', question: 'Tell me about a time you disagreed with a peer.', storyId: 'story-saas-rebuild',
        storyFit: 'weak', star: { situation: true, task: true, action: true, result: false }, scope: 2, ownership: 'we',
        quantified: false, words: 412, length: 'long', fidelity: 'Left out the ~$300/month figure.', fix: 'Lead with the result.',
      },
    ],
    storyGaps: [{ concept: 'conflict', note: 'Capture a disagreement you personally had.' }],
  };
  const out = (bank?: { loaded: boolean; error?: string }) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <GradeReport
          grade={B}
          kind="behavioral"
          storyBank={bank ? { stories: 0, confirmed: 0, openGaps: [], ...bank } : undefined}
        />
      </MemoryRouter>
    );

  it('renders each question with STAR, I-vs-we, numbers, length, story fit and fidelity', () => {
    const h = out({ loaded: true });
    expect(h).toContain('Question by question');
    expect(h).toContain('Conflict &amp; disagreement');
    expect(h).toContain('412 words');
    expect(h).toContain('no number');
    expect(h).toContain('story: story-saas-rebuild');
    expect(h).toContain('Left out the ~$300/month figure.');
    expect(h).toContain('Lead with the result.');
    expect(h).toContain('Q1');
  });

  it('lists story gaps with a link to capture them, and notes a bank that was down', () => {
    const h = out({ loaded: false, error: 'resume-builder unreachable' });
    expect(h).toContain('Stories to capture');
    expect(h).toContain('https://resume.cush.rocks');
    // Phase H4: each gap links into the story forge, pre-set to its competency.
    expect(h).toContain('href="/stories?competency=conflict"');
    expect(h).toContain('story bank was unavailable');
    expect(out({ loaded: true })).not.toContain('story bank was unavailable');
  });
});

describe('the coding grade report', () => {
  const coding = (over: Partial<NonNullable<MockGrade['coding']>> = {}): MockGrade => ({
    ...GRADE,
    stages: [],
    coding: {
      patternMissed: true,
      patternNote: 'The sliding window came from a nudge.',
      complexityStated: 'O(n^2)',
      complexityOptimal: 'O(n) time, O(k) space',
      tests: { verdict: 'wrong_answer', passed: 7, total: 9, failing: ['hidden 4'], codeHash: 'h', at: '', source: 'end' },
      reviewQueued: true,
      ...over,
    },
  });

  it('shows the hidden tests, the pattern call, complexity and the review-queue note', () => {
    const h = renderToStaticMarkup(<GradeReport grade={coding()} kind="coding" />);
    expect(h).toContain('7/9 passed');
    expect(h).toContain('your final code, run at End');
    expect(h).toContain('Failing: hidden 4');
    expect(h).toContain('missed');
    expect(h).toContain('The sliding window came from a nudge.');
    expect(h).toContain('optimal: O(n) time, O(k) space');
    expect(h).toContain('on your review queue');
  });

  it('says so when nothing ran', () => {
    const h = renderToStaticMarkup(<GradeReport grade={coding({ tests: null, reviewQueued: false, patternMissed: false })} kind="coding" />);
    expect(h).toContain('never ran');
    expect(h).toContain('found it yourself');
    expect(h).not.toContain('review queue');
  });
});

describe('the project deep-dive grade report (Phase H4)', () => {
  it('shows the rubric dimensions and every fidelity flag', () => {
    const h = renderToStaticMarkup(
      <GradeReport
        grade={{
          ...GRADE,
          stages: [],
          dimensions: [{ concept: 'dd-tradeoffs', score: 2, note: 'No alternative named (#6).' }],
          fidelity: [{ claim: 'sharded by tenant id', status: 'unverified', note: 'Not in the bank or resume.' }],
        }}
        kind="project-deep-dive"
      />
    );
    expect(h).toContain('Deep-dive rubric');
    expect(h).toContain('Trade-off reasoning');
    expect(h).toContain('2/4');
    expect(h).toContain('sharded by tenant id');
    expect(h).toContain('unverified');
  });
});
