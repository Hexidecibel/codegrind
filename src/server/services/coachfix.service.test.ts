// =============================================================================
// coachfix.service — a bounded stash, and what "bounded" has to mean
// =============================================================================
// This map holds unverified model output for as long as a coaching brief is
// plausibly still on screen. It is not a cache in front of anything, so a miss
// has no slow path to fall back to — a miss is a 404 and a sentence in the UI.
// That makes the two numbers below (200 entries, 6h) the entire design, and the
// only failure modes worth testing are the ones where the bound stops applying:
// an unbounded map in a long-lived process, or an entry that outlives the brief
// it hangs off and gets revealed months later against a problem the player has
// since solved cleanly.
//
// No timers are involved on purpose (a setInterval here would hold the event
// loop open and have to be torn down in every test), so expiry is asserted by
// moving the clock rather than by waiting.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stashFix, getFix, clearFixes, fixCount } from './coachfix.service.js';

beforeEach(() => clearFixes());
afterEach(() => vi.useRealTimers());

describe('stashFix / getFix', () => {
  it('round-trips a fix under an opaque handle', () => {
    const id = stashFix('p1', { before: 'a', after: 'b' });
    expect(id).toMatch(/^\S+$/);
    expect(getFix(id)).toEqual({ problemId: 'p1', before: 'a', after: 'b' });
  });

  it('mints a distinct handle per fix, so one brief\'s bullets never collide', () => {
    const a = stashFix('p1', { before: 'a', after: 'b' });
    const b = stashFix('p1', { before: 'a', after: 'b' });
    expect(a).not.toBe(b);
  });

  it('returns null for an unknown handle rather than throwing', () => {
    expect(getFix('nope')).toBeNull();
  });

  it('does not consume the entry — the reveal is already paid for', () => {
    // A destructive read would turn an accidental double-click into a 404 on
    // something the player was charged for a moment ago.
    const id = stashFix('p1', { before: 'a', after: 'b' });
    expect(getFix(id)).not.toBeNull();
    expect(getFix(id)).not.toBeNull();
  });
});

describe('the bound', () => {
  it('evicts oldest-first once past 200 entries', () => {
    const first = stashFix('p1', { before: 'oldest', after: 'x' });
    for (let i = 0; i < 200; i++) stashFix('p1', { before: `f${i}`, after: 'x' });
    expect(fixCount()).toBe(200);
    // The head of a Map's insertion order is the oldest thing in it.
    expect(getFix(first)).toBeNull();
  });

  it('expires an entry older than the TTL, checked on read', () => {
    vi.useFakeTimers();
    const id = stashFix('p1', { before: 'a', after: 'b' });
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    expect(getFix(id)).toBeNull();
  });

  it('keeps an entry that is merely old, not expired', () => {
    vi.useFakeTimers();
    const id = stashFix('p1', { before: 'a', after: 'b' });
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(getFix(id)).not.toBeNull();
  });
});
