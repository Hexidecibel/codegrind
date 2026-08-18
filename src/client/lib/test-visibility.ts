// =============================================================================
// test-visibility — which parts of a failed test the player is allowed to see
// =============================================================================
// The results panel rendered `expected` for every failed test in both suites.
// On the Run path that is correct and deliberate: sample tests are printed in
// the problem statement, and seeing what was wanted is how you debug.
//
// On the SUBMIT path it hands over the hidden suite's answers. A failing submit
// would print the exact outputs the grader is checking, which is enough to
// hardcode a green run — and, more quietly, enough to destroy the attempt as
// retrieval practice, because the second try is now a copying exercise.
//
// The rule the owner settled on: for hidden tests show the test name, the
// player's own output and any stderr — everything about what THEIR code did —
// and withhold only the expected value. It is rendered as an explicit
// "— hidden —" rather than omitted, because a silently missing row reads as a
// bug in the app and invites a bug report instead of a second attempt.
//
// The server enforces the same rule on the wire (redactHiddenExpected in
// routes/submit.ts): a UI-only rule would still ship the answers in the network
// response, which is a rule about pixels rather than about information.

export type SuiteKind = 'sample' | 'hidden';

export type ExpectedDisplay =
  /** Show it: a sample test, whose expectations are public anyway. */
  | { kind: 'value'; text: string }
  /** Say it is withheld, on purpose, in as many words. */
  | { kind: 'hidden' }
  /** Nothing to show — the runner never reported one (a crash before compare). */
  | { kind: 'none' };

/**
 * What to render in the `expected` slot of one failed test row.
 *
 * Hidden wins over everything: a hidden test's expected value is withheld even
 * when one somehow arrived, so a stale client or a re-hydrated result can never
 * leak it back onto the screen.
 */
export function expectedDisplay(
  suite: SuiteKind,
  expected: string | undefined,
): ExpectedDisplay {
  if (suite === 'hidden') return { kind: 'hidden' };
  if (expected === undefined) return { kind: 'none' };
  return { kind: 'value', text: expected };
}

/** The suite a results panel is showing, from the mode it was rendered with. */
export function suiteFor(mode: 'run' | 'submit'): SuiteKind {
  return mode === 'submit' ? 'hidden' : 'sample';
}
