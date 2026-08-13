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
};

export const LANGUAGE_PROFILES: Record<Language, LanguageProfile> = {
  javascript: JAVASCRIPT,
  python: PYTHON,
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
