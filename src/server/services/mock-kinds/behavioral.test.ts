// =============================================================================
// mock-kinds/behavioral — the spec: who sees what, the schemas, the coercers
// =============================================================================

import { describe, it, expect } from 'vitest';
import { BEHAVIORAL_SPEC, buildBehavioralContext, coerceQuestions, coerceStoryGaps } from './behavioral.js';
import { MOCK_KIND_SPECS } from './index.js';
import { MOCK_KIND_INFO, anyConceptLabel } from '../../../shared/mock-kinds.js';
import { BQ_COMPETENCIES } from '../../../shared/behavioral-questions.js';
import { SD_CONCEPTS } from '../../../shared/sd.js';
import { estimateMockCost } from '../../../shared/mock.js';
import type { MockPrep } from './types.js';

const RAW = {
  stories: [
    {
      id: 'story-secret',
      title: 'A story only the grader may see',
      status: 'confirmed',
      situation: 'SITUATION-TEXT',
      task: 't',
      action: 'a',
      result: 'r',
      numbers: ['NUMBER-42'],
      caveats: ['CAVEAT-TEXT'],
      unconfirmed: ['UNCONFIRMED-TEXT'],
      fits: ['influence without authority'],
      doesNotFit: [],
    },
  ],
  gaps: [{ type: 'disagreement or conflict', status: 'open' }],
};

const okFetch = (async () => new Response(JSON.stringify(RAW), { status: 200 })) as unknown as typeof fetch;
const downFetch = (async () => {
  throw new TypeError('connect ECONNREFUSED');
}) as unknown as typeof fetch;

async function prep(fetchImpl = okFetch, requested?: unknown): Promise<MockPrep> {
  return BEHAVIORAL_SPEC.prepare!({ level: 'staff', requested, history: [], recentQuestionIds: [], fetchImpl, rand: () => 0.5 });
}

describe('the behavioral kind', () => {
  it('is registered on both sides, with intro → q1..q4 → wrap and ~12 competencies', () => {
    expect(MOCK_KIND_SPECS.behavioral).toBe(BEHAVIORAL_SPEC);
    expect(BEHAVIORAL_SPEC.info).toBe(MOCK_KIND_INFO.behavioral);
    expect(BEHAVIORAL_SPEC.info.stages).toEqual(['intro', 'q1', 'q2', 'q3', 'q4', 'wrap']);
    expect(BQ_COMPETENCIES).toHaveLength(12);
    expect(BEHAVIORAL_SPEC.info.minutes).toBe(35);
  });

  it('keeps its concept ids disjoint from system design’s (drill cards carry no kind)', () => {
    for (const c of BQ_COMPETENCIES) expect((SD_CONCEPTS as readonly string[]).includes(c)).toBe(false);
    expect(anyConceptLabel('influence-without-authority')).toBe('Influence without authority');
  });

  it('prices a typical mock in the planned range', () => {
    const usd = estimateMockCost(MOCK_KIND_INFO.behavioral.typicalTurns, undefined, 'behavioral').usd;
    expect(usd).toBeGreaterThan(0.15);
    expect(usd).toBeLessThan(0.35);
    // The system-design estimate is the original shape.
    expect(estimateMockCost(25).usd).toBe(estimateMockCost(25, undefined, 'system-design').usd);
  });
});

describe('who sees the stories', () => {
  it('the interviewer context carries the plan and NOTHING from the bank', async () => {
    const p = await prep();
    const ctx = BEHAVIORAL_SPEC.buildContext(BEHAVIORAL_SPEC.info.pickPrompt([]), 'staff', p);
    for (const i of p.plan!.items) expect(ctx).toContain(`- ${i.stage}: competency ${i.concept}`);
    for (const secret of ['story-secret', 'SITUATION-TEXT', 'NUMBER-42', 'CAVEAT-TEXT', 'UNCONFIRMED-TEXT']) {
      expect(ctx).not.toContain(secret);
    }
    expect(BEHAVIORAL_SPEC.interviewerSystem).not.toMatch(/story bank/i);
  });

  it('the grader gets the bank through the graderContext hook, open questions tagged', async () => {
    const p = await prep();
    const g = BEHAVIORAL_SPEC.graderContext!({ graderContext: p.graderContext } as never)!;
    expect(g).toContain('<story id="story-secret">');
    expect(g.indexOf('UNCONFIRMED-TEXT')).toBeGreaterThan(g.indexOf('OPEN QUESTIONS (NOT facts'));
    expect(g).toContain('CAVEAT-TEXT');
    expect(p.plan!.storyBank).toMatchObject({ loaded: true, stories: 1, confirmed: 1 });
  });

  it('starts without a bank when resume-builder is down', async () => {
    const p = await prep(downFetch);
    expect(p.plan!.items).toHaveLength(4);
    expect(p.plan!.storyBank).toMatchObject({ loaded: false, error: expect.stringMatching(/ECONNREFUSED/) });
    expect(p.graderContext).toMatch(/^STORY BANK: UNAVAILABLE/);
  });

  it('builds the same context bytes from the same plan (frozen prefix)', async () => {
    const p = await prep(okFetch, { concepts: ['conflict', 'ownership', 'ambiguity', 'cross-team'] });
    expect(buildBehavioralContext('staff', p)).toBe(buildBehavioralContext('staff', JSON.parse(JSON.stringify(p))));
    expect(p.plan!.items.map((i) => i.concept)).toEqual(['conflict', 'ownership', 'ambiguity', 'cross-team']);
  });
});

/** Every object schema that is closed must list every property as required (strict mode). */
function assertStrict(node: unknown, path = '$'): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'object' && n.additionalProperties === false) {
    expect([...((n.required as string[]) ?? [])].sort(), path).toEqual(Object.keys(n.properties as object).sort());
  }
  for (const [k, v] of Object.entries(n)) {
    if (Array.isArray(v)) v.forEach((x, i) => assertStrict(x, `${path}.${k}[${i}]`));
    else assertStrict(v, `${path}.${k}`);
  }
}

describe('the grade tool', () => {
  it('adds questions and storyGaps right after stages, required, strict all the way down', () => {
    const props = Object.keys(BEHAVIORAL_SPEC.gradeTool.schema.properties);
    expect(props.slice(0, 5)).toEqual(['verdict', 'summary', 'stages', 'questions', 'storyGaps']);
    expect(BEHAVIORAL_SPEC.gradeTool.schema.required).toEqual(expect.arrayContaining(['questions', 'storyGaps']));
    expect(BEHAVIORAL_SPEC.gradeTool.exactSchema).toBe(true);
    assertStrict(BEHAVIORAL_SPEC.gradeTool.schema);
    expect(BEHAVIORAL_SPEC.gradeToolLean.exactSchema).toBe(false);
    expect(Object.keys(BEHAVIORAL_SPEC.gradeToolLean.schema.properties)).toContain('questions');
  });

  it('enumerates the behavioral vocabulary, not system design’s', () => {
    const s = JSON.stringify(BEHAVIORAL_SPEC.gradeTool.schema);
    expect(s).toContain('"influence-without-authority"');
    expect(s).not.toContain('"failure-ranking"');
    expect(JSON.stringify(BEHAVIORAL_SPEC.interviewerTool.schema)).toContain('"q4"');
  });

  it('asks for card fronts = the question and backs = story id + three beats, no open questions', () => {
    expect(BEHAVIORAL_SPEC.gradeSystem).toMatch(/title: the question exactly as asked/);
    expect(BEHAVIORAL_SPEC.gradeSystem).toMatch(/Best story: <story id>/);
    expect(BEHAVIORAL_SPEC.gradeSystem).toMatch(/ONLY confirmed bank material \(never an open question\)/);
    expect(BEHAVIORAL_SPEC.rubric('staff')).toMatch(/graded at Staff/);
  });
});

describe('coercion', () => {
  it('keeps valid questions in stage order, clamps numbers, defaults enums, drops junk', () => {
    const qs = coerceQuestions([
      { stage: 'q2', concept: 'conflict', question: 'Q2?', storyId: null, storyFit: 'none', star: { situation: true }, scope: 9, ownership: 'we', quantified: false, words: 412.4, length: 'long', fidelity: '', fix: 'f' },
      { stage: 'q1', concept: 'ownership', question: 'Q1?', storyId: ' story-a ', storyFit: 'bogus', star: {}, scope: 'x', ownership: '?', quantified: true, words: -3, length: '?', fidelity: 'left out $300', fix: '' },
      { stage: 'q1', concept: 'ownership' }, // duplicate stage
      { stage: 'intro', concept: 'ownership' }, // not a question stage
      { stage: 'q3', concept: 'failure-ranking' }, // system-design concept
      null,
    ]);
    expect(qs.map((q) => q.stage)).toEqual(['q1', 'q2']);
    expect(qs[0]).toMatchObject({ storyId: 'story-a', storyFit: 'ok', scope: 1, ownership: 'mixed', words: 0, length: 'ok', quantified: true });
    expect(qs[0].star).toEqual({ situation: false, task: false, action: false, result: false });
    expect(qs[1]).toMatchObject({ scope: 4, words: 412, length: 'long', storyFit: 'none', storyId: null });
  });

  it('keeps one story gap per known competency', () => {
    expect(
      coerceStoryGaps([
        { concept: 'conflict', note: 'capture a disagreement you had' },
        { concept: 'conflict', note: 'dup' },
        { concept: 'nope', note: 'x' },
      ])
    ).toEqual([{ concept: 'conflict', note: 'capture a disagreement you had' }]);
  });

  it('a full grade carries questions and storyGaps on top of the shared shape', () => {
    const g = BEHAVIORAL_SPEC.coerceGrade(
      {
        verdict: 'below',
        summary: 's',
        stages: [{ stage: 'q1', score: 2, evidence: '#4', atLevel: false, staffWouldAdd: 'x', principalWouldAdd: 'y' }],
        questions: [{ stage: 'q1', concept: 'conflict', question: 'Q', storyId: null, storyFit: 'none', star: {}, scope: 2, ownership: 'we', quantified: false, words: 120, length: 'short', fidelity: '', fix: 'f' }],
        storyGaps: [{ concept: 'conflict', note: 'n' }],
        skipped: [],
        gapsTaught: [],
        conceptObservations: [{ concept: 'conflict', signal: 'missing', note: 'n' }],
        drills: [],
        gaps: [{ concept: 'conflict', type: 'skill', title: 'Tell me about a time you disagreed with a peer.', answer: 'Best story: none in the bank yet. 1) a 2) b 3) c', turn: 4 }],
      },
      'staff',
      false
    );
    expect(g.stages.map((s) => s.stage)).toEqual(['intro', 'q1', 'q2', 'q3', 'q4', 'wrap']);
    expect(g.questions).toHaveLength(1);
    expect(g.storyGaps).toEqual([{ concept: 'conflict', note: 'n' }]);
    expect(g.gaps).toHaveLength(1);
    expect(g.conceptObservations).toHaveLength(1);
  });
});
