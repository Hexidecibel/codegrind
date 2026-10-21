// =============================================================================
// mock-kinds (server) — one spec per kind, and system design is the old code
// =============================================================================
// The golden fixture in llm.mock.test.ts pins the system-design request bytes;
// this pins the registry around it: every kind has a spec, specs agree with the
// client-safe registry, and the state machine reads the kind's vocabulary.

import { describe, it, expect } from 'vitest';
import { MOCK_KINDS, MOCK_KIND_INFO } from '../../../shared/mock-kinds.js';
import { sdPrompt } from '../../../shared/sd-prompts.js';
import { MOCK_KIND_SPECS, mockKindSpec } from './index.js';
import { SYSTEM_DESIGN_SPEC, buildSdContext } from './system-design.js';
import { initialState, renderCandidateMessage, renderTranscript, turnAllowed } from '../mock.state.js';

describe('the spec registry', () => {
  it('has a spec for every kind, carrying that kind’s client-safe info', () => {
    expect(Object.keys(MOCK_KIND_SPECS).sort()).toEqual([...MOCK_KINDS].sort());
    for (const k of MOCK_KINDS) {
      expect(MOCK_KIND_SPECS[k].kind).toBe(k);
      expect(MOCK_KIND_SPECS[k].info).toBe(MOCK_KIND_INFO[k]);
    }
  });

  it('keeps every concept id unique across ALL kinds (drill cards carry a concept, not a kind)', () => {
    const all = MOCK_KINDS.flatMap((k) => [...MOCK_KIND_INFO[k].concepts]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('has nothing left in the “coming soon” list once coding shipped', async () => {
    const { UPCOMING_MOCK_KINDS } = await import('../../../shared/mock-kinds.js');
    expect(MOCK_KINDS).toContain('coding');
    expect(UPCOMING_MOCK_KINDS.map((k) => k.id)).not.toContain('coding');
  });

  it('reads an unknown kind as system design', () => {
    expect(mockKindSpec('nope')).toBe(SYSTEM_DESIGN_SPEC);
    expect(mockKindSpec(undefined)).toBe(SYSTEM_DESIGN_SPEC);
  });

  it('builds tool enums from the kind’s own vocabulary', () => {
    const props = (SYSTEM_DESIGN_SPEC.interviewerTool.schema as { properties: Record<string, { enum?: string[] }> })
      .properties;
    expect(props.stage.enum).toEqual([...MOCK_KIND_INFO['system-design'].stages]);
  });

  it('builds the system-design context from a bare catalog entry exactly as from the full prompt', () => {
    const p = sdPrompt('event-ticketing')!;
    const bare = { id: p.id, title: p.title, brief: p.brief, familiar: p.familiar };
    expect(SYSTEM_DESIGN_SPEC.buildContext(bare, 'staff')).toBe(buildSdContext(p, 'staff'));
  });
});

describe('the state machine, per kind', () => {
  const T0 = new Date('2026-10-15T12:00:00Z');

  it('starts on the kind’s first stage', () => {
    expect(initialState(T0, 'system-design').stage).toBe('requirements');
  });

  it('renders the same bytes with an explicit kind as with the default', () => {
    const s = { ...initialState(T0), candidateTurns: 37 };
    const at = new Date(T0.getTime() + 41 * 60_000);
    const input = { content: 'x', action: 'teach_me' as const, concept: 'idempotency' };
    expect(renderCandidateMessage(input, s, at, 'system-design')).toEqual(renderCandidateMessage(input, s, at));
    expect(turnAllowed({ ...s, candidateTurns: 40 }, 'system-design')).toBe(false);
  });

  it('labels transcript stages from the kind, and survives a stage it does not know', () => {
    const base = { createdAt: '', role: 'interviewer' as const, kind: 'question' as const };
    const text = renderTranscript([
      { ...base, seq: 1, content: 'a', stage: 'api' },
      { ...base, seq: 2, content: 'b', stage: 'mystery' },
    ]);
    expect(text).toContain('--- stage: api (API) ---');
    expect(text).toContain('--- stage: mystery (mystery) ---');
  });
});
