import { describe, it, expect } from 'vitest';
import type { CoachNudge } from '@/shared/types';
import { TOPICS } from '@/shared/types';
import { activeGate, dismissGate, isGateDismissed, learnHref, pinFromSearch } from './read-first';

function memStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

const GATE: CoachNudge = {
  intent: 'pre-read',
  topic: 'arrays',
  reason: 'Read this first',
  lessonId: 'arrays:0',
  title: 'arrays — recognize and apply',
  kind: 'concept',
  cached: true,
  practice: { topic: 'arrays', difficulty: 'easy' },
};

describe('read-first gate dismissal', () => {
  it('stays dismissed for that topic only', () => {
    const s = memStore();
    expect(activeGate(GATE, s)).toBe(GATE);
    dismissGate('arrays', s);
    expect(isGateDismissed('arrays', s)).toBe(true);
    expect(activeGate(GATE, s)).toBeNull();
    expect(activeGate({ ...GATE, topic: 'hashing' }, s)).not.toBeNull();
  });

  it('survives broken or missing storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => dismissGate('arrays', throwing)).not.toThrow();
    expect(activeGate(GATE, throwing)).toBe(GATE);
    expect(activeGate(GATE, null)).toBe(GATE);
    const junk = memStore();
    junk.setItem('codegrind.readFirstDismissed', '{not json');
    expect(isGateDismissed('arrays', junk)).toBe(false);
  });

  it('no readFirst → no gate', () => {
    expect(activeGate(undefined, memStore())).toBeNull();
  });
});

describe('pinFromSearch / learnHref', () => {
  it('reads ?topic=&tag= and rejects unknown topics', () => {
    expect(pinFromSearch('?topic=binary-search&tag=off-by-one', TOPICS)).toEqual({ topic: 'binary-search', tag: 'off-by-one' });
    expect(pinFromSearch('?topic=arrays', TOPICS)).toEqual({ topic: 'arrays' });
    expect(pinFromSearch('?topic=nope', TOPICS)).toBeNull();
    expect(pinFromSearch('?from=today&step=problem1', TOPICS)).toBeNull();
  });

  it('sends a fix to the coach feed and a pre-read to its topic track', () => {
    expect(learnHref({ intent: 'fix', topic: 'arrays' })).toBe('/study');
    expect(learnHref({ intent: 'pre-read', topic: 'two-pointer' })).toBe('/study?topic=two-pointer');
  });
});
