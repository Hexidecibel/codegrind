// =============================================================================
// mock-kinds — the registry the plumbing and the Mock page read per kind
// =============================================================================
// System design was the only kind before the registry; these pin that its
// registry entry is exactly the old vocabulary, and that lookups for unknown
// kinds, prompts and concepts degrade instead of throwing.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MOCK_KIND,
  MOCK_KINDS,
  MOCK_KIND_INFO,
  UPCOMING_MOCK_KINDS,
  anyConceptLabel,
  isMockConcept,
  isMockKind,
  isMockStage,
  mockKindInfo,
  mockPromptTitle,
  stageLabel,
} from './mock-kinds.js';
import { MOCK_MINUTES, MOCK_TURN_CAP } from './mock.js';
import { SD_CONCEPTS, SD_STAGES, SD_STAGE_META, conceptLabel } from './sd.js';
import { SD_PROMPTS } from './sd-prompts.js';

describe('the kind list', () => {
  it('has an entry for every kind, and system design is the default', () => {
    expect(Object.keys(MOCK_KIND_INFO).sort()).toEqual([...MOCK_KINDS].sort());
    for (const k of MOCK_KINDS) expect(MOCK_KIND_INFO[k].kind).toBe(k);
    expect(DEFAULT_MOCK_KIND).toBe('system-design');
  });

  it('accepts only exact kind ids', () => {
    expect(isMockKind('system-design')).toBe(true);
    for (const x of ['System-Design', 'nope', '', null, undefined, 3]) expect(isMockKind(x)).toBe(false);
  });

  it('never lists an upcoming kind as startable', () => {
    for (const u of UPCOMING_MOCK_KINDS) expect(isMockKind(u.id)).toBe(false);
  });

  it('reads an unknown kind as system design rather than throwing', () => {
    expect(mockKindInfo('nope')).toBe(MOCK_KIND_INFO['system-design']);
    expect(mockKindInfo(null)).toBe(MOCK_KIND_INFO['system-design']);
  });
});

describe('system design in the registry', () => {
  const sd = MOCK_KIND_INFO['system-design'];

  it('is the sd.ts vocabulary, unchanged', () => {
    expect(sd.stages).toEqual(SD_STAGES);
    expect(sd.stageMeta).toEqual(SD_STAGE_META);
    expect(sd.concepts).toEqual(SD_CONCEPTS);
    for (const c of SD_CONCEPTS) expect(sd.conceptLabel(c)).toBe(conceptLabel(c));
  });

  it('keeps the old limits', () => {
    expect(sd.minutes).toBe(45);
    expect(sd.turnCap).toBe(40);
    expect(MOCK_MINUTES).toBe(sd.minutes);
    expect(MOCK_TURN_CAP).toBe(sd.turnCap);
  });

  it('serves the static prompt bank', () => {
    expect(sd.prompts).toBe(SD_PROMPTS);
    expect(sd.promptById('url-shortener')?.title).toBe('A URL shortener');
    expect(sd.promptById('nope')).toBeNull();
    // The first mock ever is a familiar one.
    expect(sd.pickPrompt([], () => 0).familiar).toBe(true);
  });

  it('validates stages and concepts against its own lists', () => {
    expect(isMockStage('system-design', 'deep-dive')).toBe(true);
    expect(isMockStage('system-design', 'q1')).toBe(false);
    expect(isMockConcept('system-design', 'idempotency')).toBe(true);
    expect(isMockConcept('system-design', 'vibes')).toBe(false);
  });
});

describe('labels and titles', () => {
  it('looks a prompt title up in the kind it belongs to', () => {
    expect(mockPromptTitle('system-design', 'event-ticketing')).toBe('A ticketing system for events');
    expect(mockPromptTitle('system-design', 'nope')).toBeNull();
    expect(mockPromptTitle('system-design', null)).toBeNull();
  });

  it('labels a concept with no kind at hand, and de-hyphenates one nobody knows', () => {
    expect(anyConceptLabel('caching-invalidation')).toBe('caching / invalidation');
    expect(anyConceptLabel('some-new-thing')).toBe('some new thing');
  });

  it('labels a stage, falling back to its id', () => {
    expect(stageLabel('system-design', 'high-level')).toBe('High-level design');
    expect(stageLabel('system-design', 'q1')).toBe('q1');
  });
});
