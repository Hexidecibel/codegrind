import { describe, it, expect } from 'vitest';
import { findPatternLeak, stripExampleSections, stripPatternLeaks, stripTitleLeak } from './pattern-leak.js';

// Real statements from the live bank (2026-10-21 review), trimmed.
describe('the pattern-leak filter (Phase H)', () => {
  it('drops a directive sentence that names the technique', () => {
    const s = 'Find two numbers that add up to `target`.\n\nUse the **two-pointer** technique for an O(n) time, O(1) space solution.';
    expect(stripPatternLeaks(s)).toBe('Find two numbers that add up to `target`.');
  });

  it('drops a hint paragraph and a hint section', () => {
    const s = [
      'Return the index of the first unique character.',
      '',
      '**Approach hint:** Use a hash map to count character frequencies in one pass.',
      '',
      '## How Binary Search Works (hint)',
      '',
      '1. Start with `left = 0`.',
      '',
      '## Constraints',
      '- n <= 10^5',
    ].join('\n');
    const out = stripPatternLeaks(s);
    expect(out).not.toMatch(/hash map|Binary Search|left = 0/i);
    expect(out).toMatch(/first unique character/);
    expect(out).toMatch(/## Constraints\n- n <= 10\^5/);
  });

  it('cuts asides and clauses but keeps the real requirement', () => {
    expect(stripPatternLeaks('**Your solution must use O(1) extra space** (i.e., use the two-pointer technique, not a hash map).')).toBe(
      '**Your solution must use O(1) extra space**.'
    );
    expect(stripPatternLeaks('Solution should run in O(n) time using a sliding window')).toBe('Solution should run in O(n) time');
    expect(stripPatternLeaks('**You must implement this using binary search — O(log n) time complexity.**')).toBe(
      '**You must achieve O(log n) time complexity.**'
    );
  });

  it('leaves a bare mention of a structure alone — a statement may be ABOUT one', () => {
    for (const s of ['Implement a Trie with insert and search.', 'Given the root of a binary search tree, return its height.', 'Tasks sit in a min-heap ordered by deadline.']) {
      expect(stripPatternLeaks(s)).toBe(s);
      expect(findPatternLeak(s)).toBeNull();
    }
  });

  it('detects what it strips, and is idempotent', () => {
    const s = 'Given nums, return the pair.\n\n> **Hint:** Use a hash map to remember what you have seen.';
    expect(findPatternLeak(s)).not.toBeNull();
    const once = stripPatternLeaks(s);
    expect(findPatternLeak(once)).toBeNull();
    expect(stripPatternLeaks(once)).toBe(once);
  });

  it('takes the technique out of a title', () => {
    expect(stripTitleLeak('Palindrome Check with Two Pointers')).toBe('Palindrome Check');
    expect(stripTitleLeak('Two-Sum Sorted (Two-Pointer)')).toBe('Two-Sum Sorted');
    expect(stripTitleLeak('Merge Intervals')).toBe('Merge Intervals');
  });

  it('removes the statement’s own worked examples, up to the next heading or rule', () => {
    const s = 'Reverse it in place.\n\n## Example\n```\nInput: [1,2]\nOutput: [2,1]\n```\n\n---\n**Goal:** return the array.';
    expect(stripExampleSections(s)).toBe('Reverse it in place.\n\n**Goal:** return the array.');
    const bold = 'Find the pair.\n\n**Example:**\n```\n[2,7] → [0,1]\n```\n\nNotes follow.';
    expect(stripExampleSections(bold)).toBe('Find the pair.\n\nNotes follow.');
  });
});
