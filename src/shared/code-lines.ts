// =============================================================================
// codegrind — line arithmetic for the coaching brief (shared by client + server)
// =============================================================================
// The coach's "What you missed" items point at lines of the candidate's own
// submission. This file is the whole of how that pointing works, and it is pure
// on purpose: no runtime imports, no DOM, no model, no database. That is not
// tidiness — it is the only way this logic gets tested at all. The repo runs
// vitest with no jsdom, so an editor decoration cannot be asserted in CI, but
// "which lines does this quote refer to" can be, exhaustively, here.
//
// THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM: an anchor is resolved
// from a QUOTED SNIPPET, never from a line number. Models miscount lines —
// reliably, and worse on long inputs. They are however very good at copying a
// line back verbatim. So the model quotes, the server locates, and the model's
// line number is demoted to a TIEBREAKER for when the quote appears more than
// once (`left++`, `}`, a bare `return`).
//
// AND WHEN IN DOUBT, REFUSE. A bullet with no anchor renders as plain text —
// exactly what shipped before this feature existed. A bullet anchored to the
// WRONG line actively teaches the reader something false about their own code.
// So every ambiguous case below resolves to `null` rather than guessing.

// The ONE import, and it is type-only: `LineAnchor` is an API contract (it
// crosses the wire inside a CoachingBrief) so it is declared in types.ts with
// the rest of the contract. `import type` erases at compile time, so this file
// still emits nothing and pulls in nothing at runtime.
import type { LineAnchor } from './types.js';

/**
 * Split source into lines, once, for everybody.
 *
 * `numberLines` (what the model is SHOWN) and `resolveAnchor` (what the model's
 * answer is resolved AGAINST) both go through here, which is the point: if they
 * split differently — one keeping a `\r`, one counting a trailing blank — then
 * line 7 in the prompt is line 6 in the resolver and the tiebreaker silently
 * points one line off. Sharing the function makes that disagreement impossible
 * rather than unlikely.
 *
 * CRLF is normalized away because a Windows browser posts CRLF and the model
 * quotes back what it was shown; a `\r` surviving into a comparison would make
 * every quote from such a submission fail to match.
 *
 * A single trailing newline yields no phantom final line. Editors do show that
 * empty last line, but numbering it in the prompt spends a line of context on
 * nothing and gives the model a line number that points at no code.
 */
export function splitLines(src: string): string[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Fixed-width gutter. 4 columns fits every submission that has ever been
 * written into a browser textarea, and being FIXED (rather than sized to the
 * input) means the gutter looks identical from one submit to the next, which is
 * one less thing for the model to have to parse afresh.
 *
 * Why a gutter is affordable at all: `cache_control` is on `system` only, and
 * this block lives in the USER message, which is unique per submit and was
 * never cacheable. The cost is ~5 tokens a line and nothing else.
 */
export function numberLines(src: string): string {
  return splitLines(src)
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

/** The source text a range covers, verbatim — the "before" half of a diff. */
export function sliceLines(src: string, range: LineAnchor): string {
  const lines = splitLines(src);
  const start = Math.max(1, Math.min(range.startLine, lines.length));
  const end = Math.max(start, Math.min(range.endLine, lines.length));
  return lines.slice(start - 1, end).join('\n');
}

/**
 * The longest span a single bullet is allowed to claim.
 *
 * A quote that runs longer than this is not "the line you got wrong", it is the
 * model pasting the function back at us — and painting twelve-plus lines of an
 * editor communicates nothing about which one to look at.
 */
const MAX_SPAN_LINES = 12;

/**
 * Comparison form of one line.
 *
 * `trim()` plus an internal-whitespace collapse, because indentation is the one
 * thing a model reliably renormalizes when it quotes, and `foo( a, b )` vs
 * `foo(a, b)` is the same line to a reader.
 *
 * DELIBERATELY NOT LOWERCASED. `Count` and `count` are two different variables
 * in every language this app serves, and a case-insensitive match would happily
 * anchor a bullet about one to a line declaring the other. Being case-sensitive
 * costs a handful of unresolved anchors (which degrade to plain text) and buys
 * the guarantee that a resolved anchor is a real textual match.
 */
function normalize(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * The gutter this file writes, matched so it can be taken back off.
 *
 * Applied to the model's QUOTE only, never to the source: models routinely
 * quote back what they were shown, gutter and all, and a `   7 | ` prefix would
 * make an otherwise perfect quote match nothing at all. The source is never
 * numbered, so stripping there could only ever corrupt real code (a line inside
 * a string literal that happens to look like a gutter).
 */
const GUTTER_PREFIX = /^\s*\d{1,6}\s*\|\s?/;

/** Every start index (0-based) at which `needle` appears as consecutive lines. */
function findAll(haystack: string[], needle: string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Locate `quote` inside `source`, or refuse.
 *
 * @param hintLine the model's own line number, used ONLY to break a tie between
 *   two identical matches. It is never trusted on its own — a hint pointing at
 *   a line the quote does not appear on is simply ignored.
 *
 * The algorithm, in order, and each step earns its place:
 *
 *  1. Normalize both sides line-by-line (see `normalize`), de-guttering the
 *     quote.
 *  2. Refuse a quote longer than MAX_SPAN_LINES before doing any work.
 *  3. Whole-quote match. Collect EVERY match, not the first — knowing there are
 *     two is the entire basis for refusing.
 *  4. Zero matches → retry with the FIRST quote line alone. Models mangle tails,
 *     not heads: a three-line quote whose third line lost a paren is still solid
 *     evidence about line one. The resulting anchor covers that one line only,
 *     because one line is all we actually matched.
 *  5. Exactly one match → anchor it.
 *  6. More than one → the match nearest `hintLine`, and only if a single match
 *     is strictly nearest. Two equidistant matches with a hint between them is
 *     as ambiguous as no hint at all.
 *
 * NOT DONE HERE, deliberately: substring matching (which would anchor a bullet
 * about `i++` to every line containing `i++`, including the correct ones), and
 * any language-aware token or comment stripping. The resolver is language-blind
 * — it serves four languages and would need four parsers to be otherwise.
 */
export function resolveAnchor(
  source: string,
  quote: string,
  hintLine?: number
): LineAnchor | null {
  const needle = splitLines(quote)
    .map((l) => normalize(l.replace(GUTTER_PREFIX, '')))
    .filter((l) => l.length > 0);
  if (needle.length === 0 || needle.length > MAX_SPAN_LINES) return null;

  const haystack = splitLines(source).map(normalize);
  if (haystack.length === 0) return null;

  let starts = findAll(haystack, needle);
  // The head-only retry. `span` tracks what we are actually entitled to claim.
  let span = needle.length;
  if (starts.length === 0) {
    starts = findAll(haystack, [needle[0]]);
    span = 1;
  }
  if (starts.length === 0) return null;

  let start: number;
  if (starts.length === 1) {
    start = starts[0];
  } else {
    if (typeof hintLine !== 'number' || !Number.isFinite(hintLine)) return null;
    const distance = (s: number) => Math.abs(s + 1 - hintLine);
    const best = Math.min(...starts.map(distance));
    const tied = starts.filter((s) => distance(s) === best);
    if (tied.length !== 1) return null;
    start = tied[0];
  }

  // Clamp to the document. A quote matched inside it cannot overrun, but `span`
  // is arithmetic and this is the one place the invariant is cheap to enforce.
  const startLine = start + 1;
  const endLine = Math.min(startLine + span - 1, haystack.length);
  if (endLine - startLine + 1 > MAX_SPAN_LINES) return null;
  return { startLine, endLine };
}
