// =============================================================================
// codegrind — what the MODEL needs to know about a language
// =============================================================================
// Three files now describe a language, and the split is deliberate:
//
//   src/shared/languages.ts   presentation + authoring facts, shared with the
//                             BROWSER (display name, Monaco id, fence, indent).
//   bin/lib/languages.sh      the DOCKER facts (image, source filename, run
//                             command, memory/pid/time budgets). Bash owns them
//                             because bash is what invokes docker.
//   this file                 the PROMPT facts — the sentences that go to Claude.
//
// A prompt fact is not a UI fact. "Return ONLY the function definition(s), no
// surrounding prose or exports" is not something a code editor can act on, and
// "Python's ints are arbitrary precision" is not something a Docker flag can
// express. Putting them in either of the other two files would ship a paragraph
// of authoring rules to the browser, or hide them in a shell script nobody
// greps for prompt text.
//
// WHY A PROFILE AND NOT A FIND-AND-REPLACE. The obvious implementation is to
// take the JavaScript prompts and substitute the word. That works for exactly
// the sites where the language appears as a NAME ("a pure, deterministic
// JavaScript function") and fails everywhere it appears as a CONSTRAINT. A
// substituted `- Use plain JS (no TypeScript types)` becomes `- Use plain
// Python (no TypeScript types)`, which is noise at best. The rules below are
// therefore authored per language, not derived.
//
// EVERY JAVASCRIPT STRING HERE IS THE PRE-EXISTING TEXT, BYTE FOR BYTE. That is
// the whole regression argument for this change: JavaScript generation, coaching
// and hinting must produce the same prompts they produced before the file
// existed, so anything that changed is visibly Python's fault and not a silent
// rewrite of the incumbent.

import { LANGUAGES, DEFAULT_LANGUAGE, type Language } from '../../shared/languages.js';

export interface LanguageProfile {
  language: Language;
  /** How prose NAMES the language: "a pure, deterministic {displayName} function". */
  displayName: string;
  /**
   * The info string on a fenced block inside a PROMPT.
   *
   * Deliberately not `LANGUAGE_META.codeFence`, which is "js" — that one renders
   * lesson snippets in the browser, where the short form is idiomatic. Here the
   * existing prompts say ```javascript, and keeping them byte-identical is worth
   * more than sharing a string with a different consumer.
   */
  promptFence: string;
  /**
   * The starterCode bullet in the generation system prompt: how the model is
   * told to express a function signature with an empty body.
   */
  signatureRule: string;
  /**
   * Extra authoring bullets appended after the shared ones — the constraints
   * that only exist because of this language. Empty for JavaScript, which is
   * what the shared rules were written against.
   */
  authoringRules: string[];
  /** How the referenceSolution field is described, in prose and in the tool schema. */
  referenceRule: string;
  /** Tool-schema description for `starterCode`. */
  starterCodeSchema: string;
  /** Tool-schema description for `referenceSolution`. */
  referenceSolutionSchema: string;
  /**
   * The integer bullet in the `expert` rubric.
   *
   * This is the one site that could NOT be string-substituted, because the
   * original sentence conflates two different limits. The ±(2^53-1) bound is a
   * property of the HARNESS — every `expected` is stored and compared after a
   * round-trip through Node's JSON.parse — so it binds all three languages
   * equally. What differs is why the model would breach it and what happens when
   * it does, and that is a different paragraph per language rather than a
   * different noun.
   */
  integerRubric: string;
  /** Fallback starter when the model omits one. */
  starterStub: (functionName: string) => string;
  /** How a code snippet inside a written lesson is described. */
  snippetRule: string;
  /** How a primer's reusable pattern skeleton is described. */
  templateRule: string;
  /**
   * What a corpus snippet must LOOK like in this language, as one sentence.
   *
   * `snippetRule` and `templateRule` are authoring instructions — they open
   * with "OPTIONAL" and "omit it entirely when prose alone is clearer", which
   * is exactly wrong for a translator that has been handed a snippet and must
   * return it. This field is the style half of those sentences with the
   * authoring half removed, so the translation prompt can state the house style
   * without also telling the model it may decline to translate.
   */
  snippetStyle: string;
}

// -----------------------------------------------------------------------------
// The shared preamble of the integer rubric. Identical in all three, because the
// constraint itself is identical in all three — it is the transport that imposes
// it, not the language.
// -----------------------------------------------------------------------------
const INTEGER_TRANSPORT_BOUND =
  'Every expected value is stored and compared only after a round-trip through ' +
  "Node's JSON.parse, so this bound belongs to the harness and holds no matter " +
  'what the language itself could represent.';

const JAVASCRIPT: LanguageProfile = {
  language: 'javascript',
  displayName: 'JavaScript',
  promptFence: 'javascript',
  signatureRule:
    '- Provide a clear function signature via starterCode: a named function declaration with the right parameters and an empty body (or a "// your code here" comment and a reasonable default return). Use plain JS (no TypeScript types).',
  authoringRules: [],
  referenceRule:
    '- referenceSolution is COMPLETE, CORRECT JavaScript defining the same function name; it must pass every sample and hidden test. Return ONLY the function definition(s), no surrounding prose or exports.',
  starterCodeSchema: 'JS starter: named function signature with an empty/stub body.',
  referenceSolutionSchema: 'Complete correct JS defining functionName; passes all tests.',
  integerRubric:
    `- integer edges that stay well inside ±(2^53-1). ${INTEGER_TRANSPORT_BOUND} ` +
    'In JavaScript that is also the language\'s own ceiling, and breaching it is silent: ' +
    'arithmetic past 2^53 loses precision rather than raising, so a test whose answer ' +
    'exceeds it is simply wrong and nothing anywhere reports why. Probe near ±2^31 to ' +
    'exercise the boundary, never rely on overflow, and never emit a value that loses precision.',
  starterStub: (fn) => `function ${fn}() {\n  // your code here\n}`,
  snippetRule:
    "code: OPTIONAL plain JavaScript illustrating this lesson's specific point. Omit it entirely when prose alone is clearer. No TypeScript types, no imports, no console noise.",
  templateRule:
    '- template: a reusable, GENERIC JavaScript code skeleton for the pattern — the canonical shape (loops, pointers, structures) with placeholder comments, NOT a solution to a specific problem. Plain JS, no TypeScript types.',
  snippetStyle:
    'Plain JavaScript with no TypeScript types, no imports or exports, and no console noise. Two-space indentation.',
};

const PYTHON: LanguageProfile = {
  language: 'python',
  displayName: 'Python',
  promptFence: 'python',
  signatureRule:
    '- Provide a clear function signature via starterCode: a top-level `def` with the right parameters and a body of just `pass` (or a "# your code here" comment and a reasonable default return). Plain Python 3 — type hints are allowed but never required.',
  authoringRules: [
    // Every one of these is a failure the Python harness can actually produce,
    // written as a rule the author can follow.
    '- The solution is ONE top-level function. No classes to instantiate, no module-level side effects, and NEVER an `if __name__ == "__main__":` block — the harness loads your source under a different module name precisely so such a block cannot fire, so anything hidden in one is dead code.',
    '- The standard library only, and no imports that touch the outside world: no `input()`, no `open()`, no `random`, no `datetime.now`, no network. `math`, `collections`, `heapq`, `bisect`, `itertools` and `functools` are all fine and are usually the right answer.',
    '- Return plain data. A tuple is accepted and compares equal to the JSON array it is written as, and a set compares without regard to order — but a returned generator, dataclass or numpy array has no JSON form and the harness will report it as an error rather than as a wrong answer.',
    '- Indentation is syntax. Emit 4 spaces per level and never a tab; a tab in Python source is a real failure and an invisible one.',
  ],
  referenceRule:
    '- referenceSolution is COMPLETE, CORRECT Python 3 defining the same function name; it must pass every sample and hidden test. Return ONLY the function definition(s) and any imports they need, no surrounding prose, no test harness, no print statements.',
  starterCodeSchema: 'Python starter: a top-level `def` with the right parameters and a stub body.',
  referenceSolutionSchema:
    'Complete correct Python 3 defining functionName (plus any imports); passes all tests.',
  integerRubric:
    `- integer edges that stay well inside ±(2^53-1). ${INTEGER_TRANSPORT_BOUND} ` +
    "Python is the language where this is easiest to breach by accident, because its ints are " +
    'arbitrary precision: 2**70 computes exactly, looks perfectly correct in Python, and then ' +
    'becomes a DIFFERENT number on the way into the stored expected value — after which the ' +
    'problem can never be solved again by anyone. The harness refuses to serialize an integer ' +
    'outside the range rather than let that happen, so a problem whose answer grows past it is ' +
    'simply broken. Probe near ±2^31 to exercise the boundary, and never make the answer depend ' +
    'on unbounded integer growth (no unbounded factorials, powers or Fibonacci indices).',
  starterStub: (fn) => `def ${fn}():\n    # your code here\n    pass`,
  snippetRule:
    "code: OPTIONAL plain Python 3 illustrating this lesson's specific point. Omit it entirely when prose alone is clearer. No imports beyond the standard library, no print noise, 4-space indentation.",
  templateRule:
    '- template: a reusable, GENERIC Python 3 code skeleton for the pattern — the canonical shape (loops, pointers, structures) with placeholder comments, NOT a solution to a specific problem. Plain Python, 4-space indentation.',
  snippetStyle:
    'Plain Python 3 with 4-space indentation and never a tab, no imports beyond the standard library, and no print noise.',
};

// GO IS THE FIRST COMPILED LANGUAGE, and its profile is where that shows.
//
// Every rule below is a failure the Go harness can actually produce, and the
// three that matter most have no analogue in the interpreted profiles:
//
//   1. THE TYPE ALLOWLIST. Args arrive as untyped JSON and are unmarshalled
//      into whatever the user's own signature declares. That is what makes "no
//      type metadata anywhere" work — and it means a parameter type json cannot
//      fill is a problem nobody can solve. Unbriefed, the model invents a
//      `TreeNode` for the trees topic and the problem is simply unrunnable.
//   2. SINGLE RETURN VALUE. `(result, error)` is the most natural thing a Go
//      author can write, and there is nowhere for the error to go. The harness
//      rejects it with an authored message rather than a reflect panic, but a
//      rejected problem still cost a generation call.
//   3. UNUSED IMPORTS AND VARIABLES ARE COMPILE ERRORS. Unique among the four
//      languages here, and the single cheapest generation failure to prevent:
//      a leftover `import "sort"` after a rewrite fails the whole build.
const GO: LanguageProfile = {
  language: 'go',
  displayName: 'Go',
  promptFence: 'go',
  signatureRule:
    '- Provide a clear function signature via starterCode: the line `package main`, a blank line, then one top-level `func` with the right parameters, one return value, and a body containing just a `// your code here` comment and a zero-value return. starterCode must be a COMPLETE, COMPILABLE Go file — it is the exact text the candidate starts editing and the exact text that gets compiled.',
  authoringRules: [
    '- The solution is ONE top-level function in package main, plus any helper functions it needs. Both starterCode and referenceSolution open with `package main` and are complete compilable files — the candidate\'s file is compiled exactly as written, with nothing wrapped around it, which is also why every compiler error points at the line they are looking at.',
    '- Never write `func main()`. The harness supplies one, and a second is a redeclaration error that fails the build before any test runs.',
    '- RETURN EXACTLY ONE VALUE. The (result, error) idiom cannot be graded: there is no expected value to compare an error against. Signal an impossible input with a sentinel the problem defines (-1, an empty slice) instead.',
    '- PARAMETER AND RETURN TYPES ARE LIMITED TO: int, float64, string, bool, and slices and maps built from those — []int, []string, []float64, [][]int, []bool, map[string]int, map[string][]int, map[string]string. Nothing else. No custom structs (no TreeNode, no ListNode, no Pair), no pointers, no interfaces, no `any`, no channels, no generics or type parameters, no variadic parameters, no rune or byte or int64 or float32. A type outside this list has no JSON form and the problem cannot be run at all.',
    '- Unused imports and unused local variables are COMPILE ERRORS in Go, not warnings. Every import must be used and every declared variable must be read.',
    '- The standard library only, and nothing that touches the outside world: no fmt.Scan, no os, no time.Now, no math/rand, no network. sort, strings, strconv, math and container/heap are all fine and are usually the right answer.',
    '- Return a slice rather than a nil slice where the answer is "nothing" — though the harness treats a nil slice as an empty one, so an idiomatic `var out []int` accumulator is safe.',
    '- Indent with TABS, as gofmt does.',
  ],
  referenceRule:
    '- referenceSolution is a COMPLETE, COMPILABLE Go file defining the same function name; it must pass every sample and hidden test. Open with `package main`, then any imports it needs, then the function definition(s) — no surrounding prose and no func main.',
  starterCodeSchema:
    'Go starter: `package main`, then one top-level func with the right parameters, a single return value and a stub body. Must compile as-is.',
  referenceSolutionSchema:
    'Complete correct Go (package main + imports + funcs) defining functionName; passes all tests.',
  integerRubric:
    `- integer edges that stay well inside ±(2^53-1). ${INTEGER_TRANSPORT_BOUND} ` +
    "Go's `int` is 64-bit on every platform this runs on, so it reaches far past what a JSON " +
    'number survives and does so without a murmur: 1<<62 computes exactly, prints correctly, and ' +
    'is then a DIFFERENT number on the far side of the round-trip — after which the problem can ' +
    'never be solved again by anyone. The harness refuses to serialize an integer outside the ' +
    'range rather than let that happen, so a problem whose answer grows past it is simply broken. ' +
    'Probe near ±2^31 to exercise the boundary, and never make the answer depend on unbounded ' +
    'growth (no unbounded factorials, powers or Fibonacci indices).',
  starterStub: (fn) => `package main\n\nfunc ${fn}() int {\n\t// your code here\n\treturn 0\n}`,
  snippetRule:
    "code: OPTIONAL plain Go illustrating this lesson's specific point. Omit it entirely when prose alone is clearer. A bare function or statements, no package clause unless the point needs one, no fmt.Println noise, tab-indented.",
  templateRule:
    '- template: a reusable, GENERIC Go code skeleton for the pattern — the canonical shape (loops, pointers, structures) with placeholder comments, NOT a solution to a specific problem. Tab-indented, no package clause.',
  snippetStyle:
    'Plain Go indented with tabs, no package clause unless the point needs one, only standard-library imports, and no printing noise.',
};

// Phase 5 owns this one. It is authored rather than left empty because
// `Record<Language, LanguageProfile>` is exhaustive by construction — a missing
// key is a compile error, which is exactly the property that stops a language
// from being half-added. The rules below are a starting point and are NOT the
// finished Java contract: the type allowlist (which parameter and return types
// gson can marshal from the user's own signature), the ban on custom node
// classes like TreeNode/ListNode, and the fixed `class Solution` authoring shape
// all land with the Java harness itself. Nothing generates Java today —
// `test-harness/java/` does not exist, so bin/build-runner-image cannot build
// it and bank.service throws before a Java problem can be stored.
const JAVA: LanguageProfile = {
  language: 'java',
  displayName: 'Java',
  promptFence: 'java',
  signatureRule:
    '- Provide a clear method signature via starterCode: a `public class Solution` containing one public method with the right parameters and a stub body. The class name is fixed to Solution.',
  authoringRules: [
    '- The class name is exactly `Solution` and the tested method is a public method on it. (Phase 5: the parameter/return type allowlist lands with the Java harness.)',
  ],
  referenceRule:
    '- referenceSolution is COMPLETE, COMPILABLE Java defining the same class and method; it must pass every sample and hidden test. Return ONLY the class definition, no package statement and no surrounding prose.',
  starterCodeSchema: 'Java starter: `public class Solution` with the tested method stubbed out.',
  referenceSolutionSchema: 'Complete correct Java class Solution defining functionName; passes all tests.',
  integerRubric:
    `- integer edges that stay well inside ±(2^53-1). ${INTEGER_TRANSPORT_BOUND} ` +
    "Java pulls against this from the other side: `int` wraps silently at ±(2^31-1), so a test " +
    'whose intended answer depends on wraparound encodes a bug as the correct answer, while ' +
    '`long` reaches far past what a JSON number survives. Both limits bind at once — stay inside ' +
    'the JSON bound AND never let the answer depend on 32-bit overflow. Probe near ±2^31 to ' +
    'exercise the boundary, never to cross it.',
  starterStub: (fn) =>
    `public class Solution {\n    public Object ${fn}() {\n        // your code here\n        return null;\n    }\n}`,
  snippetRule:
    "code: OPTIONAL plain Java illustrating this lesson's specific point. Omit it entirely when prose alone is clearer. No package statement, no imports beyond java.util, no println noise.",
  templateRule:
    '- template: a reusable, GENERIC Java code skeleton for the pattern — the canonical shape (loops, pointers, structures) with placeholder comments, NOT a solution to a specific problem. No package statement.',
  snippetStyle:
    'Plain Java with no package statement, no imports beyond java.util, and no println noise. Four-space indentation.',
};

export const LANGUAGE_PROFILES: Record<Language, LanguageProfile> = {
  javascript: JAVASCRIPT,
  python: PYTHON,
  go: GO,
  java: JAVA,
};

export function profileFor(language: Language): LanguageProfile {
  return LANGUAGE_PROFILES[language];
}

/**
 * The language the SHARED STUDY CORPUS is authored in.
 *
 * Lesson and primer PROSE is language-free by construction (LESSON_SYSTEM
 * forbids fenced code in a body and puts code in a separate field), so the
 * corpus is written once and only its snippets are language-bound. Phase 4
 * translates those snippets into `code_translations` and overlays them at read
 * time; until then a lesson's `code` is whatever the corpus language produced.
 *
 * This is why the lesson and primer prompts are NOT built per language: writing
 * them three times would fork the corpus, which is the single most expensive
 * thing this plan avoids (18 batched translation calls instead of 90-180
 * generation calls per language).
 */
export const CORPUS_LANGUAGE: Language = DEFAULT_LANGUAGE;

/**
 * Build one value per language at module load.
 *
 * The system prompts below carry `cache_control: { type: 'ephemeral' }`, which
 * caches the tools-plus-system prefix of the request. Building that text inside
 * the call would work today and would keep working right up until somebody
 * interpolated a topic, a difficulty or a timestamp into it — at which point
 * every request is a cache miss and nothing anywhere reports it. Precomputing
 * makes a dynamic value impossible to reach: there is no per-call scope to read
 * one from.
 */
export function perLanguage<T>(build: (profile: LanguageProfile) => T): Record<Language, T> {
  const out = {} as Record<Language, T>;
  for (const language of LANGUAGES) out[language] = build(LANGUAGE_PROFILES[language]);
  return out;
}
