// =============================================================================
// line-diff — the smallest diff that answers "what would I have written?"
// =============================================================================
// The coach's fix popover shows the candidate's own lines against the coach's
// corrected version. Rendering the two blocks side by side was the cheaper
// option and it is the wrong one: two four-line blocks that differ in one
// `<=` are visually identical, and the reader ends up doing the diff by eye —
// which is exactly the "map the prose back onto my code by hand" chore this
// whole feature exists to remove.
//
// LINE-LEVEL, NOT CHARACTER-LEVEL, and that is a deliberate ceiling. A
// character diff of code needs tokenisation to avoid producing confetti
// (`left` → `right` highlighted as `l`+`eft`→`r`+`ight`), tokenisation needs a
// grammar, and there are four languages here. A whole changed line reads fine
// in a four-to-twelve line block, which is the only size this ever renders.
//
// Pure, no imports, no DOM: the repo runs vitest with no jsdom, so this is the
// half of the popover that can actually be asserted in CI.

/** One row of the rendered diff. `text` is the line, without any glyph. */
export interface DiffRow {
  /** `del` = in the submission only, `ins` = in the fix only, `same` = both. */
  kind: 'del' | 'ins' | 'same';
  text: string;
}

/**
 * Above this many lines on either side we stop trying to be clever.
 *
 * The LCS table is O(n·m) cells and this runs synchronously inside a click
 * handler. A fix is at most a dozen lines by construction (`resolveAnchor`
 * refuses spans over 12), so the cap is never hit in practice — it exists so
 * that a malformed payload degrades to a slow-but-finite render rather than
 * locking up the tab.
 */
const MAX_LINES = 300;

/**
 * Split for diffing.
 *
 * Deliberately NOT `shared/code-lines.ts`'s `splitLines`: that one drops a
 * single trailing blank line because a phantom final line in a PROMPT wastes a
 * line number on nothing. Here a trailing blank line is content — "you left a
 * stray blank line at the end" is a legitimate thing for a diff to show — and
 * the two sides of this diff both come off the wire from the same server, so
 * they cannot disagree about it.
 */
function lines(src: string): string[] {
  return src.replace(/\r\n?/g, '\n').split('\n');
}

/**
 * Line-level diff of `before` against `after`.
 *
 * Classic LCS: build the table of longest-common-subsequence lengths, then walk
 * it backwards. The backward walk prefers an insertion on a tie (`>=`), which
 * — once the result is reversed — puts the deletions of a changed hunk BEFORE
 * its insertions, i.e. the `-` old line then the `+` new one, which is the
 * order every diff a programmer has ever read uses.
 *
 * Equality is exact, whitespace included. Indentation is meaningful in Python
 * and a re-indent is a real change in every language, so "same but for the
 * leading spaces" is not the same line.
 */
export function lineDiff(before: string, after: string): DiffRow[] {
  const a = lines(before);
  const b = lines(after);

  // Degenerate-but-honest fallback for absurd input: everything removed, then
  // everything added. Still correct, just not minimal.
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffRow => ({ kind: 'del', text })),
      ...b.map((text): DiffRow => ({ kind: 'ins', text })),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]. Built from the end so
  // the backward walk below reads it forwards, which keeps the indexing sane.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Dropping a[i] is at least as good as dropping b[j]: emit the deletion
      // first, so a replaced line reads `- old` / `+ new`.
      rows.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      rows.push({ kind: 'ins', text: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: 'del', text: a[i++] });
  while (j < b.length) rows.push({ kind: 'ins', text: b[j++] });
  return rows;
}
