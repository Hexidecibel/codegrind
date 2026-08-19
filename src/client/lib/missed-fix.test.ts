// =============================================================================
// Re-anchoring a coaching bullet onto the buffer the user is actually looking at
// =============================================================================
// `resolveMissedRange` is the only place in the client half where being wrong is
// worse than doing nothing. Its output is a band painted over the user's own
// code with the implicit claim "the coach was talking about THESE lines"; if
// that claim is false there is nothing on screen to say so, and the reader
// learns something untrue about code they wrote. So most of what is asserted
// below is the refusals.
//
// This is also the half of the feature that a test can actually reach. The repo
// has no jsdom, so neither editor's decoration can be inspected in CI — but
// "which range would we ask it to paint" is a pure function, and it is here.

import { describe, it, expect } from 'vitest';
import { resolveMissedRange, toMissedViews } from './missed-fix';
import type { MissedItem } from '@/shared/types';

const SRC = ['function f(xs) {', '  let total = 0;', '  for (const x of xs) {', '    total += x;', '  }', '  return total;', '}'].join('\n');

describe('toMissedViews', () => {
  it('marks an item with a usable anchor as interactive and one without as not', () => {
    const views = toMissedViews([
      { note: 'reset left when the window shrinks', anchor: { startLine: 2, endLine: 3 } },
      { note: 'no early-exit guard for an empty input' },
    ]);
    expect(views.map((v) => v.interactive)).toEqual([true, false]);
  });

  it('drops blank and whitespace-only notes', () => {
    // A blank bullet renders as a lone dot with nothing beside it — visibly
    // broken, and the model does emit them.
    const views = toMissedViews([
      { note: '   ' },
      { note: '' },
      { note: ' real ' },
    ] as MissedItem[]);
    expect(views).toEqual([{ note: 'real', anchor: undefined, fixId: undefined, interactive: false }]);
  });

  it('refuses an anchor that is not a whole, positive, non-inverted range', () => {
    const bad: MissedItem[] = [
      { note: 'a', anchor: { startLine: 0, endLine: 2 } },
      { note: 'b', anchor: { startLine: 5, endLine: 3 } },
      { note: 'c', anchor: { startLine: 1.5, endLine: 2 } },
    ];
    expect(toMissedViews(bad).every((v) => !v.interactive)).toBe(true);
  });

  it('drops a fixId whose anchor did not survive', () => {
    // There is no UI for "corrected code for lines I cannot show you", and
    // offering the fetch anyway would charge assistance for half a feature.
    const views = toMissedViews([{ note: 'a', fixId: 'abc' }]);
    expect(views[0].fixId).toBeUndefined();
  });

  it('survives a server that sent nothing at all', () => {
    expect(toMissedViews(undefined)).toEqual([]);
    expect(toMissedViews([] as MissedItem[])).toEqual([]);
  });
});

describe('resolveMissedRange — the buffers agree', () => {
  it('returns the anchor verbatim, without searching', () => {
    // The overwhelmingly common case: the brief lands seconds after a submit
    // that just blurred the editor. No search means no chance of a mis-match.
    expect(resolveMissedRange(SRC, SRC, { startLine: 4, endLine: 4 })).toEqual({
      startLine: 4,
      endLine: 4,
    });
  });
});

describe('resolveMissedRange — the buffer moved', () => {
  it('follows lines inserted above', () => {
    // "I added an import while the coach was thinking" — the realistic edit,
    // and the whole reason this function exists rather than trusting the
    // original line numbers.
    const live = `import x from 'x';\n\n${SRC}`;
    expect(resolveMissedRange(SRC, live, { startLine: 4, endLine: 4 })).toEqual({
      startLine: 6,
      endLine: 6,
    });
  });

  it('follows a multi-line anchor as a block', () => {
    const live = `// note\n${SRC}`;
    expect(resolveMissedRange(SRC, live, { startLine: 3, endLine: 5 })).toEqual({
      startLine: 4,
      endLine: 6,
    });
  });

  it('refuses when the lines are gone', () => {
    const live = SRC.split('\n').filter((l) => !l.includes('total +=')).join('\n');
    expect(resolveMissedRange(SRC, live, { startLine: 4, endLine: 4 })).toBeNull();
  });

  it('refuses when the target now appears twice', () => {
    // One of the two matches is right and there is no way to tell which. A 50%
    // chance of teaching a falsehood is a bad trade against a one-line note
    // saying "you've edited since you submitted".
    const live = `${SRC}\n    total += x;`;
    expect(resolveMissedRange(SRC, live, { startLine: 4, endLine: 4 })).toBeNull();
  });

  it('treats a re-indent as a move it cannot follow', () => {
    // Comparison is exact on purpose. Both strings came out of the same buffer
    // minutes apart, so there is no formatting difference to be forgiving
    // about, and being strict turns "I reformatted everything" into an honest
    // refusal rather than a possible mis-paint.
    const live = SRC.replace('    total += x;', '        total += x;');
    expect(resolveMissedRange(SRC, live, { startLine: 4, endLine: 4 })).toBeNull();
  });
});

describe('resolveMissedRange — bad input never throws', () => {
  it('refuses an anchor past the end of the submitted source rather than clamping', () => {
    // `sliceLines` clamps, which is right for rendering a "before" block and
    // wrong here: clamping line 999 of a 7-line file to line 7 would find line
    // 7 in the live buffer and paint a confident band over code the coach never
    // mentioned.
    expect(resolveMissedRange(SRC, SRC, { startLine: 99, endLine: 99 })).toBeNull();
    expect(resolveMissedRange(SRC, SRC, { startLine: 6, endLine: 400 })).toBeNull();
  });

  it('refuses a malformed anchor', () => {
    expect(resolveMissedRange(SRC, SRC, { startLine: 0, endLine: 1 })).toBeNull();
    expect(resolveMissedRange(SRC, SRC, { startLine: 4, endLine: 2 })).toBeNull();
    expect(
      resolveMissedRange(SRC, SRC, { startLine: NaN, endLine: NaN }),
    ).toBeNull();
  });

  it('refuses against an empty buffer', () => {
    expect(resolveMissedRange('', SRC, { startLine: 1, endLine: 1 })).toBeNull();
    expect(resolveMissedRange(SRC, '', { startLine: 4, endLine: 4 })).toBeNull();
  });
});
