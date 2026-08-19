// =============================================================================
// code-lines — the resolver that decides which line a coaching bullet points at
// =============================================================================
// Two of the tests below are POLICY, not behaviour, and they are the reason the
// file exists in this shape:
//
//   * two matches and no line hint resolves to NULL. Not "the first one", not
//     "the closest to the middle". A wrong highlight teaches the reader
//     something false about their own code, and the fallback — plain text — is
//     exactly what shipped before any of this existed.
//   * `Count` does not match `count`. Whitespace is normalized, case never is.
//     Identifiers are case-sensitive in all four languages this app serves.
//
// If either of those ever needs to change, it is a product decision about how
// wrong an anchor is allowed to be, not a tidy-up.

import { describe, it, expect } from 'vitest';
import { splitLines, numberLines, sliceLines, resolveAnchor } from './code-lines.js';

const SOURCE = [
  'function longest(s) {',
  '  let left = 0;',
  '  let best = 0;',
  '  const seen = new Set();',
  '  for (let right = 0; right < s.length; right++) {',
  '    while (seen.has(s[right])) {',
  '      seen.delete(s[left]);',
  '      left++;',
  '    }',
  '    seen.add(s[right]);',
  '    best = Math.max(best, right - left + 1);',
  '  }',
  '  return best;',
  '}',
].join('\n');

describe('splitLines', () => {
  it('normalizes CRLF, so a Windows submission indexes like every other one', () => {
    expect(splitLines('a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
    // A lone CR too — some clipboards still produce it.
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
  });

  it('does not invent a final empty line for a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    // Two trailing newlines DO mean one genuinely blank line; only the
    // terminator is dropped.
    expect(splitLines('a\nb\n\n')).toEqual(['a', 'b', '']);
  });

  it('treats the empty document as one empty line rather than zero lines', () => {
    // Guards the `lines.length > 1` condition: popping here would leave a
    // zero-length array, and every clamp downstream assumes at least one line.
    expect(splitLines('')).toEqual(['']);
  });
});

describe('numberLines', () => {
  it('writes a fixed-width gutter the resolver knows how to strip back off', () => {
    expect(numberLines('a\nb')).toBe('   1 | a\n   2 | b');
  });

  it('numbers from the same split resolveAnchor indexes from', () => {
    // THE PROPERTY THE WHOLE TIEBREAKER RESTS ON. If numbering and resolution
    // disagreed about CRLF or a trailing newline, the model's line number would
    // be off by one against the resolver's, silently, and only for the
    // submissions that happened to end in a newline.
    const crlf = SOURCE.replace(/\n/g, '\r\n') + '\r\n';
    const gutter = numberLines(crlf).split('\n');
    for (let i = 0; i < splitLines(SOURCE).length; i++) {
      const anchor = resolveAnchor(crlf, splitLines(SOURCE)[i], i + 1);
      // Not every line is unique (`}` is not), so only assert where it resolved.
      if (anchor) expect(gutter[anchor.startLine - 1]).toContain(splitLines(SOURCE)[i].trim());
    }
    expect(gutter).toHaveLength(splitLines(SOURCE).length);
  });
});

describe('sliceLines', () => {
  it('returns the lines verbatim, indentation included', () => {
    expect(sliceLines(SOURCE, { startLine: 2, endLine: 3 })).toBe(
      '  let left = 0;\n  let best = 0;'
    );
  });

  it('clamps a range that runs off the end instead of padding with undefined', () => {
    expect(sliceLines(SOURCE, { startLine: 13, endLine: 999 })).toBe('  return best;\n}');
  });
});

describe('resolveAnchor — the policy cases', () => {
  it('refuses two matches with no line hint', () => {
    // `  }` appears twice (lines 9 and 12). Nothing distinguishes them, so
    // there is no honest answer and the bullet renders as plain text.
    expect(resolveAnchor(SOURCE, '}')).toBeNull();
  });

  it('does not resolve `Count` against `count` — case is never normalized away', () => {
    const src = 'let count = 0;\ncount += 1;';
    expect(resolveAnchor(src, 'let Count = 0;')).toBeNull();
    // …and the same quote with the right case resolves, so the null above is
    // about the case and not about the line being unfindable.
    expect(resolveAnchor(src, 'let count = 0;')).toEqual({ startLine: 1, endLine: 1 });
  });
});

describe('resolveAnchor — matching', () => {
  it('anchors a unique line', () => {
    expect(resolveAnchor(SOURCE, '      left++;')).toEqual({ startLine: 8, endLine: 8 });
  });

  it('anchors a unique multi-line quote across its whole span', () => {
    expect(resolveAnchor(SOURCE, '  let left = 0;\n  let best = 0;')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });

  it('collapses whitespace runs and indentation, but never deletes whitespace', () => {
    // Models reindent and re-space when they quote; refusing on that alone
    // would lose most anchors for nothing. Note what this does NOT do: a run of
    // whitespace collapses to one space, it is never deleted, so
    // `seen.add( s[right] )` still does not match `seen.add(s[right])`. That is
    // the honest line — pretending otherwise means matching on tokens, which
    // needs a parser per language.
    expect(resolveAnchor(SOURCE, '\tlet  left   =  0;')).toEqual({
      startLine: 2,
      endLine: 2,
    });
    expect(resolveAnchor(SOURCE, 'seen.add( s[right] );')).toBeNull();
  });

  it('strips the gutter it was shown, because models quote it back', () => {
    expect(resolveAnchor(SOURCE, '   8 |       left++;')).toEqual({ startLine: 8, endLine: 8 });
  });

  it('uses the line hint only to pick between duplicates', () => {
    expect(resolveAnchor(SOURCE, '  }', 12)).toEqual({ startLine: 12, endLine: 12 });
    expect(resolveAnchor(SOURCE, '  }', 9)).toEqual({ startLine: 9, endLine: 9 });
  });

  it('refuses when the hint sits exactly between two duplicates', () => {
    // Lines 9 and 12, hint 10.5 is not expressible — but a hint equidistant
    // from both (here: neither is nearer) is as useless as none.
    const src = 'x\ny\nx';
    expect(resolveAnchor(src, 'x', 2)).toBeNull();
  });

  it('ignores a hint that points nowhere near the quote', () => {
    // The quote is unique, so the hint is never consulted. A model that
    // miscounted must not be able to turn a good quote into no anchor.
    expect(resolveAnchor(SOURCE, '      left++;', 99)).toEqual({ startLine: 8, endLine: 8 });
  });

  it('falls back to the first quoted line when the tail was mangled', () => {
    // Models mangle tails, not heads. The anchor covers ONE line, because one
    // line is all that actually matched.
    const quote = '  const seen = new Set();\n  for (let right = 0; right < s.len';
    expect(resolveAnchor(SOURCE, quote)).toEqual({ startLine: 4, endLine: 4 });
  });

  it('returns null for a quote that appears nowhere', () => {
    expect(resolveAnchor(SOURCE, 'return new Map();')).toBeNull();
  });

  it('returns null for a blank or whitespace-only quote', () => {
    expect(resolveAnchor(SOURCE, '')).toBeNull();
    expect(resolveAnchor(SOURCE, '   \n\t')).toBeNull();
  });

  it('refuses a quote longer than the 12-line span cap', () => {
    // This is the model pasting the function back at us. Painting 13 lines says
    // nothing about which one to look at.
    const thirteen = splitLines(SOURCE).slice(0, 13).join('\n');
    expect(resolveAnchor(SOURCE, thirteen)).toBeNull();
  });

  it('skips blank lines inside a quote rather than failing on them', () => {
    // A blank line in a quote is formatting, not content; dropping it keeps a
    // quote that straddles a paragraph break resolvable.
    expect(resolveAnchor(SOURCE, '  let left = 0;\n\n  let best = 0;')).toEqual({
      startLine: 2,
      endLine: 3,
    });
  });
});
