// =============================================================================
// The diff behind the coach's fix popover
// =============================================================================
// This is the whole reason `line-diff.ts` is a separate pure module: the repo
// runs vitest with no jsdom, so the popover it feeds cannot be opened in a test,
// but "given these two blocks, which lines are marked - and +" can be pinned
// exactly. The properties below are the ones a reader depends on without ever
// thinking about them — that unchanged lines survive as context, that a
// one-character change marks one line rather than the whole block, and that a
// replacement reads `- old` then `+ new` rather than the other way round.

import { describe, it, expect } from 'vitest';
import { lineDiff, type DiffRow } from './line-diff';

/** Compact rendering, so an expectation reads like the diff it describes. */
const render = (rows: DiffRow[]) =>
  rows.map((r) => `${r.kind === 'del' ? '-' : r.kind === 'ins' ? '+' : ' '}${r.text}`);

describe('lineDiff', () => {
  it('marks nothing when the two sides are the same', () => {
    const rows = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('keeps the unchanged lines as context rather than dropping them', () => {
    // The popover shows the whole (small) block, not just the changed lines —
    // a fix reads as code you could have written, which needs its surroundings.
    expect(render(lineDiff('a\nb\nc', 'a\nB\nc'))).toEqual([' a', '-b', '+B', ' c']);
  });

  it('puts the deletion before the insertion for a replaced line', () => {
    // Every diff a programmer has ever read is `- old` / `+ new`. Getting this
    // backwards is not a crash, it is a subtly misleading popover.
    const rows = lineDiff('while (l < r)', 'while (l <= r)');
    expect(rows.map((r) => r.kind)).toEqual(['del', 'ins']);
  });

  it('marks a pure insertion as insertions only', () => {
    expect(render(lineDiff('a\nc', 'a\nb\nc'))).toEqual([' a', '+b', ' c']);
  });

  it('marks a pure deletion as deletions only', () => {
    expect(render(lineDiff('a\nb\nc', 'a\nc'))).toEqual([' a', '-b', ' c']);
  });

  it('finds the minimal change rather than replacing the whole block', () => {
    const before = 'for (const x of xs) {\n  total += x;\n}';
    const after = 'for (const x of xs) {\n  total += x * 2;\n}';
    const rows = lineDiff(before, after);
    expect(rows.filter((r) => r.kind !== 'same')).toHaveLength(2);
  });

  it('treats a re-indent as a real change', () => {
    // Indentation IS the syntax in Python, and a re-indent is a real edit in
    // every other language this app serves. "Same but for the leading spaces"
    // must not be reported as unchanged.
    const rows = lineDiff('if x:\n  return 1', 'if x:\n    return 1');
    expect(rows.map((r) => r.kind)).toEqual(['same', 'del', 'ins']);
  });

  it('handles either side being empty', () => {
    expect(lineDiff('', 'a')).toEqual([
      { kind: 'del', text: '' },
      { kind: 'ins', text: 'a' },
    ]);
    expect(lineDiff('a\nb', '').map((r) => r.kind)).toEqual(['del', 'del', 'ins']);
  });

  it('normalizes CRLF so a Windows-typed submission diffs against a fix', () => {
    // The "before" half is the candidate's own text, which a Windows browser
    // posts with CRLF; the "after" is model output, which never has it. Without
    // the normalization every single line would read as changed.
    expect(lineDiff('a\r\nb', 'a\nb').every((r) => r.kind === 'same')).toBe(true);
  });

  it('keeps a trailing blank line as content', () => {
    // Unlike the prompt-numbering split in shared/code-lines.ts, which drops it:
    // here "you left a stray blank line" is a legitimate thing to show.
    expect(lineDiff('a\n', 'a').map((r) => r.kind)).toEqual(['same', 'del']);
  });

  it('degrades to remove-all/add-all rather than hanging on absurd input', () => {
    // The O(n·m) table runs synchronously inside a click handler. A fix is
    // twelve lines by construction, so this is a guard, not a path.
    const before = Array.from({ length: 400 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `a${i}`).join('\n');
    const rows = lineDiff(before, after);
    expect(rows).toHaveLength(800);
    expect(rows.some((r) => r.kind === 'same')).toBe(false);
  });
});
