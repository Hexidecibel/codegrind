// =============================================================================
// wait-copy — saying what the app is actually doing while you wait for it
// =============================================================================
// "Loading next…" was the entire message for a wait that is a database read
// (~50ms) about half the time and a model writing a whole problem the other
// half. The scheduler ALWAYS generates fresh for `variation`, `level-up` and
// `new-pattern` intents (bank.service.getAdaptiveProblem), which is 15-30
// seconds on Claude and 95+ on a local 35B model — and up to three times that
// when the reference solution fails its own tests and generation retries
// (MAX_GEN_ATTEMPTS = 3). Four words covering both cases is why a working app
// looks hung.
//
// WHY THIS IS DECIDED BY ELAPSED TIME RATHER THAN BY ASKING THE SERVER FIRST.
// The bank-hit path returns in tens of milliseconds and the generate path never
// returns in under ten seconds; there is no overlap to get wrong. A request
// still in flight after GENERATION_TELL_MS is generating, and saying so is a
// statement about what is observably happening rather than a prediction that
// can be wrong. (The scheduler's own `peekUpNext` is a PEEK — it re-scores
// candidates and can disagree with the pick that actually happens — so a UI
// built on it would sometimes promise a fresh problem and serve a banked one.)
// The caller that already knows, /manual's Generate button, says so from the
// first frame by passing `intent: 'generate'`.
//
// THE ESTIMATE IS MEASURED OR ABSENT. `estimateSeconds` comes from
// GET /api/bank, which reports this install's own generation times (or the
// provider probe's measurement, or null). A null renders as a shape rather than
// a made-up number: "this can take a couple of minutes on a local model" is
// true everywhere, "about 20 seconds" is a lie on half the installs this app
// runs on.

/**
 * How long a request may be in flight before it is called a generation.
 *
 * Comfortably above a bank hit (tens of ms, plus the round trip) and far below
 * the fastest real generation ever measured on this codebase (~15s on Claude).
 */
export const GENERATION_TELL_MS = 1200;

export type WaitIntent =
  /** The caller knows a model call is happening — /manual's Generate. */
  | 'generate'
  /** The bank is tried first; only elapsed time can tell which happened. */
  | 'bank-first';

export interface WaitCopy {
  /** True once the wait is long enough to be a generation. */
  generating: boolean;
  /** Short label for the button that is spinning. */
  label: string;
  /** The honest explanation, or null while the wait is still plausibly instant. */
  note: string | null;
}

/** "about 25 seconds" / "about 2 minutes", or null when nothing was measured. */
export function formatEstimate(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** "8s" / "1m 12s" — the elapsed counter, so a long wait still feels alive. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export interface DescribeWaitOptions {
  intent: WaitIntent;
  /** Milliseconds since the request went out. */
  elapsedMs: number;
  /** Measured seconds per generation on this install, or null if unknown. */
  estimateSeconds: number | null;
  /** What is being fetched, for the label. */
  subject: 'next problem' | 'problem';
}

/**
 * What to show while a problem request is in flight.
 *
 * Pure so the wording is testable — the components below it only render what
 * this returns.
 */
export function describeWait({
  intent,
  elapsedMs,
  estimateSeconds,
  subject,
}: DescribeWaitOptions): WaitCopy {
  const generating = intent === 'generate' || elapsedMs >= GENERATION_TELL_MS;
  if (!generating) {
    return {
      generating: false,
      label: subject === 'next problem' ? 'Loading next…' : 'Loading…',
      note: null,
    };
  }

  const estimate = formatEstimate(estimateSeconds);
  const opening =
    intent === 'generate'
      ? 'Writing you a fresh problem'
      : 'Nothing banked for this slot, so the model is writing you a fresh one';

  // Past roughly 1.5x the measured time this is no longer "about N seconds", and
  // saying nothing about that reads as a hang. The retry loop is the usual
  // cause and it is worth naming — it is also why the wait can triple.
  const overrun =
    estimateSeconds !== null && elapsedMs > estimateSeconds * 1500
      ? ' Taking longer than usual — a reference solution that fails its own tests makes it start over (up to 3 tries).'
      : '';

  const pace = estimate
    ? ` — usually ${estimate}.`
    : '. On a local model this can take a couple of minutes.';

  return {
    generating: true,
    label: 'Writing a problem…',
    note: `${opening}${pace} ${formatElapsed(elapsedMs)} so far.${overrun}`,
  };
}
