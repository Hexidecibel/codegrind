import { describe, it, expect } from 'vitest';
import { clipAtBoundary } from './clip.js';

describe('clipAtBoundary (Phase H: notes were cut mid-word)', () => {
  it('leaves text under the cap alone', () => {
    expect(clipAtBoundary('short note.', 50)).toBe('short note.');
  });
  it('stops at a sentence end when one is near the cap', () => {
    const s = 'First sentence is here. Second sentence runs on and on past the cap';
    expect(clipAtBoundary(s, 34)).toBe('First sentence is here.');
  });
  it('otherwise cuts at a word boundary, with an ellipsis, never mid-word', () => {
    const out = clipAtBoundary('handle them all correctly using passes over the array', 30);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
    expect('handle them all correctly using passes'.startsWith(out.slice(0, -1))).toBe(true);
    expect(out).not.toMatch(/correctl…$/);
  });
});
