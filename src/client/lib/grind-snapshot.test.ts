// =============================================================================
// grind-snapshot.test — the language-mismatch guard on the resumed session
// =============================================================================
// The bug this exists to close is silent by construction: the snapshot restores
// perfectly, the page renders perfectly, and the only thing wrong is that the
// problem on screen belongs to a language the app is no longer set to. Every
// run, submit and coaching call after it describes the other one.

import { describe, it, expect } from 'vitest';
import { staleForLanguage, type GrindSnapshot } from './grind-snapshot';
import type { Language } from '@/shared/languages';
import type { Problem } from '@/shared/types';

function snapshot(language: Language): GrindSnapshot {
  const problem = {
    id: 'p1',
    language,
    title: 'Two Sum',
    prompt: 'do the thing',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic: 'arrays',
    pattern: 'arrays',
    starterCode: '',
    functionName: 'f',
    sampleTests: [],
  } as unknown as Problem;

  return {
    sessionId: 's1',
    plan: { focus: 'arrays', why: '', slots: [] } as unknown as GrindSnapshot['plan'],
    problem,
    why: { kind: 'new-pattern', topic: 'arrays' } as unknown as GrindSnapshot['why'],
    solved: 2,
    streak: 2,
    topics: ['arrays'],
  };
}

describe('staleForLanguage', () => {
  it('drops a snapshot whose problem is in another language', () => {
    // The whole point: switch to Python in /manual, return to /grind, and the
    // JavaScript problem in localStorage must NOT be resumed.
    expect(staleForLanguage(snapshot('javascript'), 'python')).toBe(true);
    expect(staleForLanguage(snapshot('python'), 'javascript')).toBe(true);
    expect(staleForLanguage(snapshot('javascript'), 'java')).toBe(true);
  });

  it('keeps a snapshot that matches', () => {
    expect(staleForLanguage(snapshot('javascript'), 'javascript')).toBe(false);
    expect(staleForLanguage(snapshot('python'), 'python')).toBe(false);
  });

  it('keeps the session when the active language is unknown', () => {
    // null means "the settings request failed", not "no language". An
    // unreachable server must not cost the user a live session.
    expect(staleForLanguage(snapshot('javascript'), null)).toBe(false);
  });

  it('has nothing to say about an absent snapshot', () => {
    expect(staleForLanguage(null, 'python')).toBe(false);
    expect(staleForLanguage(null, null)).toBe(false);
  });

  it('reads the PROBLEM`s language, which is the only honest source', () => {
    // Not the session's and not the plan's: a problem's language is baked into
    // its reference solution and every `expected` derived from running it, so
    // the record itself is the only thing that cannot drift.
    const s = snapshot('python');
    expect(s.problem.language).toBe('python');
    expect(staleForLanguage(s, 'javascript')).toBe(true);
  });
});
