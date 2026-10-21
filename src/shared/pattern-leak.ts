// =============================================================================
// pattern-leak — a problem statement must never name the technique
// =============================================================================
// Recognizing the pattern IS the skill being practised. A generated statement
// that says "Use a two-pointer approach…", "**Approach hint:** use a hash map"
// or "You must implement binary search" hands it over before the candidate has
// read the problem, and Recognize cannot be graded honestly on such a card.
// A review of the live bank (2026-10-21) found 40+ of 73 statements doing it.
//
// The generation prompt now forbids it, and this module is the deterministic
// backstop, applied to every newly generated problem and (by
// bin/strip-pattern-leaks) to the stored bank. It STRIPS rather than rejects:
// the problems are otherwise sound and regenerating them costs money.
//
// It only ever removes DIRECTIVE text — a technique named together with
// use/using/apply/hint/approach/technique, a hint section, a parenthetical
// aside. A bare mention is left alone, because a statement may legitimately be
// ABOUT a structure ("Implement a Trie", "a binary search tree", "a min-heap
// of tasks"). Pure, no I/O.

/** Algorithmic techniques — the things a candidate is supposed to spot. */
const TECHNIQUE =
  String.raw`(?:two[- ]pointers?|slow\/fast pointers?|fast\/slow pointers?|fast and slow pointers?|sliding[- ]window|binary[- ]search(?![- ]trees?)|prefix[ /-](?:sums?|products?|suffix)|prefix\/suffix|dynamic programming|memoi[sz]ation|greedy|backtracking|breadth[- ]first(?: search)?|depth[- ]first(?: search)?|\bBFS\b|\bDFS\b|union[- ]find|disjoint[- ]set|topological sort(?:ing)?|monotonic (?:stack|queue|deque)|hash ?maps?|hash ?sets?|hash ?tables?|hashing|frequency (?:map|count(?:er)?)|\bXOR(?:-ing)?\b|bit[- ]manipulation|cycle detection|seen[- ]sets?|(?:min|max)?[- ]?heap|priority queue|divide and conquer|kadane|floyd)`;

const TECH_RE = new RegExp(TECHNIQUE, 'i');
/** Words that turn a mention into an instruction. */
const DIRECTIVE_RE = /\b(?:use|uses|using|used|apply|applies|employ|via|approach|technique|strategy|hint|trick|should|must|solve (?:this|it) (?:with|using|by))\b/i;

/** Section headings whose whole section is a hint. */
const HINT_HEADING_RE = /^#{1,6}\s+.*\b(?:hint|approach|how .* (?:works|applies)|strategy|solution idea)\b.*$/i;
/** A bold/quoted lead-in that opens a hint paragraph: "**Hint:**", "> **Approach hint:**". */
const HINT_LEADIN_RE = /^\s*(?:>\s*)?(?:\*\*|__)\s*(?:approach |key )?(?:hint|approach|strategy|insight|idea)s?\s*(?:\(.*?\))?\s*:?\s*(?:\*\*|__)\s*:?|^\s*(?:>\s*)?(?:approach |key )?(?:hint|insight)s?\s*:/i;

/** True when this text names a technique as an instruction. */
export function findPatternLeak(text: string): string | null {
  if (!text) return null;
  for (const sentence of sentences(text)) {
    const m = sentence.match(TECH_RE);
    if (m && DIRECTIVE_RE.test(sentence)) return sentence.trim().slice(0, 200);
  }
  for (const line of text.split('\n')) {
    if (HINT_HEADING_RE.test(line) || HINT_LEADIN_RE.test(line)) {
      return line.trim().slice(0, 200);
    }
  }
  return null;
}

/** Sentences, roughly: split after . ! ? or a line break. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

/** Cut "(…two-pointer…)" asides and clauses like ", using a sliding window". */
function stripClauses(s: string): string {
  let out = s.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => (TECH_RE.test(inner) ? '' : whole));
  out = out.replace(
    new RegExp(String.raw`\s*(?:,\s*)?(?:by )?(?:using|via|with) (?:a |an |the )?(?:\*\*)?${TECHNIQUE}(?:\*\*)?(?: (?:techniques?|approach(?:es)?|sweeps?|pass(?:es)?|methods?))?\b(?:\s*\([^()]*\))?(?:\s+or (?:a |an |the )?${TECHNIQUE})?(?:\s+(?:that|which)\b[^.]*)?`, 'gi'),
    ''
  );
  return out;
}

/** One line of prose with the instruction taken out; '' when nothing is left worth keeping. */
function stripLine(line: string): string {
  if (!TECH_RE.test(line)) return line;
  const cut = stripClauses(line);
  if (!TECH_RE.test(cut) || !DIRECTIVE_RE.test(cut)) return cleanup(cut);
  // Still an instruction: drop the sentences that carry it, keep the rest.
  const lead = cut.match(/^(\s*(?:[-*+]|\d+\.)\s+|\s*>\s*)?/)?.[0] ?? '';
  const body = cut.slice(lead.length);
  const kept = body
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !(TECH_RE.test(s) && DIRECTIVE_RE.test(s)));
  const rest = kept.join(' ').trim();
  return rest ? cleanup(lead + rest) : '';
}

function cleanup(s: string): string {
  return s
    .replace(/\bimplement this\s*[—–-]\s*/gi, 'achieve ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\*\*\s*\*\*/g, '')
    .trimEnd();
}

/**
 * The statement with every technique instruction removed: hint sections,
 * hint paragraphs, directive sentences and asides. Idempotent.
 */
export function stripPatternLeaks(text: string): string {
  if (!text) return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipSection = 0; // heading level being skipped, 0 = not skipping
  let skipParagraph = false;
  let inFence = false;
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line);
    const heading = line.match(/^(#{1,6})\s/);
    if (!inFence && heading) {
      const level = heading[1].length;
      if (skipSection && level <= skipSection) skipSection = 0;
      if (!skipSection && HINT_HEADING_RE.test(line)) {
        skipSection = level;
        continue;
      }
    }
    if (skipSection) {
      if (fence) inFence = !inFence;
      continue;
    }
    if (fence) {
      inFence = !inFence;
      if (skipParagraph) continue;
      out.push(line);
      continue;
    }
    if (inFence) {
      if (!skipParagraph) out.push(line);
      continue;
    }
    if (!line.trim()) {
      skipParagraph = false;
      out.push(line);
      continue;
    }
    if (skipParagraph) continue;
    if (HINT_LEADIN_RE.test(line)) {
      skipParagraph = true;
      continue;
    }
    const kept = stripLine(line);
    if (kept.trim()) out.push(kept);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A title without its technique: "Palindrome Check with Two Pointers" → "Palindrome Check". */
export function stripTitleLeak(title: string): string {
  const cut = title
    .replace(new RegExp(String.raw`\s+(?:with|using|via|by)\s+(?:a |an |the )?${TECHNIQUE}(?:\s+(?:technique|approach))?\s*$`, 'i'), '')
    .replace(new RegExp(String.raw`\s*\((?:[^()]*${TECHNIQUE}[^()]*)\)\s*$`, 'i'), '')
    .trim();
  return cut || title;
}

const EXAMPLE_HEADING_RE = /^#{1,6}\s+(?:\*\*)?(?:worked )?examples?\b.*$/i;
const EXAMPLE_LEADIN_RE = /^\s*(?:\*\*|__)\s*examples?\b[^*_]*(?:\*\*|__)\s*:?\s*$|^\s*(?:\*\*|__)\s*examples?\b[^*_]*:\s*(?:\*\*|__)\s*$/i;

/**
 * The statement without its own worked-examples section(s). For a problem that
 * also carries structured examples[] (which the UI renders right under the
 * statement), so nothing is lost and nothing is printed twice. Removes a
 * heading section ("## Examples" up to the next heading of the same or higher
 * level) and a bold "**Example 1:**" lead-in with the fenced block and lines
 * that follow it up to the next blank line after the block. Idempotent.
 */
export function stripExampleSections(text: string): string {
  if (!text) return text;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipSection = 0;
  let skipLeadin: 'off' | 'before-fence' | 'in-fence' | 'after-fence' = 'off';
  let inFence = false;
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line);
    const heading = !inFence && line.match(/^(#{1,6})\s/);
    if (heading) {
      const level = heading[1].length;
      if (skipSection && level <= skipSection) skipSection = 0;
      skipLeadin = 'off';
      if (!skipSection && EXAMPLE_HEADING_RE.test(line)) {
        skipSection = level;
        continue;
      }
    }
    // A horizontal rule ends an examples section too: generated statements use
    // it to separate the examples from a closing "Goal:" line.
    if (skipSection && !inFence && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      skipSection = 0;
      continue;
    }
    if (skipSection) {
      if (fence) inFence = !inFence;
      continue;
    }
    if (skipLeadin !== 'off') {
      if (skipLeadin === 'before-fence') {
        if (fence) {
          skipLeadin = 'in-fence';
          inFence = true;
        } else if (!line.trim()) {
          // tolerate blank lines between the lead-in and its block
        } else if (/^\s*(?:input|output|explanation|[-*]\s)/i.test(line)) {
          // an inline example ("Input: …") — part of it
        } else {
          skipLeadin = 'off';
        }
        if (skipLeadin !== 'off') continue;
      } else if (skipLeadin === 'in-fence') {
        if (fence) {
          skipLeadin = 'after-fence';
          inFence = false;
        }
        continue;
      } else {
        if (!line.trim()) {
          skipLeadin = 'off';
          continue;
        }
        if (/^\s*(?:explanation|output)\b/i.test(line)) continue;
        skipLeadin = 'off';
      }
    }
    if (fence) inFence = !inFence;
    if (!inFence && EXAMPLE_LEADIN_RE.test(line)) {
      skipLeadin = 'before-fence';
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
