// llm.review — the pure halves of the Phase F calls: coercion, the "no answer"
// short-circuit, and the rendered inputs. The calls themselves are covered by
// the golden fixture (llm.golden.test.ts) and the route tests.
import { describe, it, expect } from 'vitest';
import {
  coerceCardCheck,
  coerceStepReview,
  isNoAnswer,
  renderCardCheckInput,
  renderStepReviewInput,
} from './llm.review.js';

describe('coerceCardCheck', () => {
  it('a string `missing` (a lax endpoint) becomes one item, and trailing tool markup is cut from why', () => {
    const markup = '<' + '/invoke>';
    expect(coerceCardCheck({ grade: 'shaky', missing: 'TTL on writes', why: `Close. ${markup}` })).toEqual({
      grade: 'shaky',
      why: 'Close.',
      missing: ['TTL on writes'],
    });
  });

  it('passes a well-formed answer through', () => {
    expect(coerceCardCheck({ grade: 'got', why: ' Named the mechanism. ', missing: ['a', '', 'b'] })).toEqual({
      grade: 'got',
      why: 'Named the mechanism.',
      missing: ['a', 'b'],
    });
  });

  it('never throws, and an unreadable grade is shaky (the user still confirms)', () => {
    expect(coerceCardCheck(null)).toEqual({ grade: 'shaky', why: '', missing: [] });
    expect(coerceCardCheck({ grade: 'GOT' }).grade).toBe('got');
    expect(coerceCardCheck({ grade: 'excellent', missing: 'x' })).toEqual({ grade: 'shaky', why: '', missing: ['x'] });
    expect(coerceCardCheck({ grade: 'missed', missing: ['1', '2', '3', '4', '5'] }).missing).toHaveLength(3);
  });
});

describe('isNoAnswer', () => {
  it('catches blank and "I don\'t know" in its usual dictated forms', () => {
    for (const a of ['', '  \n', "I don't know", 'i dont know.', 'I do not know!', 'idk', 'Dunno', 'no idea', 'Not sure.', 'pass']) {
      expect(isNoAnswer(a), a).toBe(true);
    }
  });

  it('does not swallow a real answer that starts the same way', () => {
    for (const a of ["I don't know the exact number, but sharding by user id keeps hot keys apart", 'No, because the write path is async', 'Use a heap']) {
      expect(isNoAnswer(a), a).toBe(false);
    }
  });
});

describe('rendered inputs', () => {
  it('card check: question, back, answer; the mock summary only when it adds something', () => {
    const text = renderCardCheckInput({ question: 'Q?', reference: 'Back.', summary: 'Q?', answer: 'Mine.' });
    expect(text).toBe("Card question: Q?\nCard back (model answer): Back.\n\nCandidate's answer:\nMine.");
    expect(renderCardCheckInput({ question: 'Q?', reference: '', summary: 'Missed X', answer: 'A' })).toContain(
      'What the mock exposed: Missed X'
    );
  });

  it('step review: digest lines and earlier notes', () => {
    const text = renderStepReviewInput({
      step: 'Problem 2',
      next: 'the mock interview',
      digest: ['"Two Sum" passed'],
      earlier: [{ step: 'Problem 1', note: 'Off by one.', carry: 'Trace the empty case.' }],
    });
    expect(text).toContain('Step just finished: Problem 2\nNext step: the mock interview');
    expect(text).toContain('- "Two Sum" passed');
    expect(text).toContain('Earlier today:\n- Problem 1: Off by one. Carry for this step: Trace the empty case.');
    // A note whose carry was not written for this step renders without one.
    expect(
      renderStepReviewInput({ step: 'Problem 2', next: 'x', digest: [], earlier: [{ step: 'Warm-up', note: 'Cards 3/3.', carry: '' }] })
    ).toContain('- Warm-up: Cards 3/3.');
    expect(coerceStepReview({ note: '  a\n b ', carry: 7 })).toEqual({ note: 'a b', carry: '' });
  });
});
