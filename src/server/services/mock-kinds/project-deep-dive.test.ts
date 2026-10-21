// =============================================================================
// mock-kinds/project-deep-dive — the spec's pure parts (Phase H4)
// =============================================================================
import { describe, it, expect } from 'vitest';
import { MOCK_KIND_INFO } from '../../../shared/mock-kinds.js';
import { DD_CONCEPTS, DD_STAGES } from '../../../shared/deep-dive.js';
import {
  DEEP_DIVE_GRADE_SYSTEM,
  DEEP_DIVE_INTERVIEWER_SYSTEM,
  DEEP_DIVE_SPEC,
  buildDeepDiveContext,
  coerceDimensions,
  coerceFidelity,
  projectOptions,
  resolveProject,
} from './project-deep-dive.js';
import { MockPrepError } from './types.js';
import { normalizeBank } from '../story-bank.js';

const bank = normalizeBank({
  stories: [{ id: 's1', title: 'Plugin system', employer: 'Sitehound', status: 'confirmed', situation: 's', task: 't', action: 'a', result: 'r', numbers: [], caveats: [], unconfirmed: [], fits: [], doesNotFit: [] }],
  gaps: [],
});
const resume = {
  summary: '',
  experience: [{ id: 'exp-x', company: 'Acme', title: 'CTO', start: '2019', end: 'present', highlights: ['Led a thing.', 'Built another thing.'] }],
  projects: [{ id: 'proj-a', name: 'Router', description: 'A router.' }],
};

describe('the deep-dive spec', () => {
  it('is registered with its own stages and dd- concepts', () => {
    expect(DEEP_DIVE_SPEC.info).toBe(MOCK_KIND_INFO['project-deep-dive']);
    expect([...DEEP_DIVE_SPEC.info.stages]).toEqual([...DD_STAGES]);
    expect(DD_CONCEPTS.every((c) => c.startsWith('dd-'))).toBe(true);
    expect(DEEP_DIVE_SPEC.info.projectPicker).toBe(true);
  });

  it('drills ~5 levels and never invents; the grader carries the confirmed facts and the fidelity rule', () => {
    for (const s of ['architecture', 'alternatives', 'hardest-problem', 'failure', 'numbers', 'alignment', 'retro']) {
      expect(DEEP_DIVE_INTERVIEWER_SYSTEM).toContain(`- ${s}:`);
    }
    expect(DEEP_DIVE_INTERVIEWER_SYSTEM).toMatch(/NEVER INVENT/);
    expect(DEEP_DIVE_GRADE_SYSTEM).toMatch(/not a "migration"/);
    expect(DEEP_DIVE_GRADE_SYSTEM).toMatch(/NO live customers/);
    expect(DEEP_DIVE_GRADE_SYSTEM).toMatch(/NEVER CREDIT UNVERIFIED CLAIMS/);
    expect(DEEP_DIVE_SPEC.rubric('staff')).toMatch(/dd-failure-honesty/);
  });

  it('adds dimensions and fidelity to the strict grade tool, right after stages', () => {
    const schema = DEEP_DIVE_SPEC.gradeTool.schema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required.slice(0, 5)).toEqual(['verdict', 'stages', 'dimensions', 'fidelity', 'skipped']);
    expect(DEEP_DIVE_SPEC.gradeTool.exactSchema).toBe(true);
    expect(DEEP_DIVE_SPEC.gradeToolLean.schema.required).toContain('fidelity');
  });

  it('coerces dimensions (rubric order, clamped, deduped, unknown dropped) and fidelity', () => {
    expect(
      coerceDimensions([
        { concept: 'dd-quantification', score: 9, note: 'n' },
        { concept: 'dd-depth', score: 0, note: 'd' },
        { concept: 'dd-depth', score: 3, note: 'dup' },
        { concept: 'conflict', score: 3, note: 'other kind' },
      ])
    ).toEqual([
      { concept: 'dd-depth', score: 1, note: 'd' },
      { concept: 'dd-quantification', score: 4, note: 'n' },
    ]);
    expect(coerceFidelity([{ claim: 'sharded by tenant', status: 'weird', note: 'x' }, { claim: '', status: 'unverified' }])).toEqual([
      { claim: 'sharded by tenant', status: 'unverified', note: 'x' },
    ]);
    const g = DEEP_DIVE_SPEC.coerceGrade({ verdict: 'at', summary: 's', dimensions: [], fidelity: [] }, 'staff', false);
    expect(g.dimensions).toEqual([]);
    expect(g.fidelity).toEqual([]);
    expect(g.stages).toHaveLength(DD_STAGES.length);
  });

  it('offers and resolves projects; refuses a bad choice with MockPrepError', () => {
    expect(projectOptions(bank, resume).map((o) => o.id)).toEqual(['s1', 'exp-x#0', 'exp-x#1', 'proj-a']);
    expect(resolveProject({ source: 'story', id: 's1' }, bank, resume)).toMatchObject({ title: 'Plugin system', line: 'Plugin system (Sitehound)' });
    expect(resolveProject({ source: 'resume', id: 'exp-x#1' }, bank, resume)).toMatchObject({ line: 'Built another thing. (Acme)' });
    expect(resolveProject({ source: 'typed', text: '  a   model   router  ' }, null, null)).toMatchObject({ source: 'typed', line: 'a model router' });
    expect(() => resolveProject({ source: 'story', id: 'nope' }, bank, resume)).toThrow(MockPrepError);
    expect(() => resolveProject({ source: 'typed', text: 'x' }, null, null)).toThrow(MockPrepError);
    expect(() => resolveProject(undefined, bank, resume)).toThrow(MockPrepError);
  });

  it('frames the context: resume lines are known to the interviewer, stories are not', () => {
    expect(buildDeepDiveContext('staff', { source: 'resume', line: 'L' })).toMatch(/from their resume/);
    expect(buildDeepDiveContext('staff', { source: 'story', line: 'L' })).toMatch(/they will tell you the rest/);
  });
});
