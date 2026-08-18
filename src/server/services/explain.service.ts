// =============================================================================
// explain — turning an internal failure into a sentence and a next action
// =============================================================================
// Every route in this app used to answer a 500 with `err.message`, and the
// client rendered it verbatim in a red bar. What that actually put in front of a
// player mid-session:
//
//   "Cannot generate a go problem: the sandbox failed, so the reference solution
//    was never run and every expected value would be unverified. Fix the sandbox
//    (bin/build-runner-image, bin/status) and retry. Cause: <raw docker exec output>"
//
//   "Generation truncated at max_tokens (expert/graphs) after 8000 output tokens
//    — the emitted problem was cut off mid-tool-call."
//
// Both are excellent SERVER LOG lines and neither is a user-facing message: the
// first buries its one actionable clause between two clauses of internal
// rationale and a wall of docker output, the second names a parameter the reader
// has never heard of and no action at all.
//
// The model for the fix already existed in two places — `explainSeedFailure`
// (seed.service.ts) and, better, `explainProbeFailure` (provider.service.ts),
// which writes a distinct genuinely-useful sentence per cause including the
// `--jinja` line that is the single highest-value string in this codebase.
// This is that treatment, generalised, for the routes a player travels.
//
// TWO RULES, BOTH LEARNED FROM THE MESSAGES ABOVE:
//
//   1. NOTHING IS DELETED. The raw message survives as `detail`, and the server
//      log still gets it in full. A player debugging their own homelab needs the
//      docker output; they just should not have to read it to find out that the
//      answer is "run bin/build-runner-image".
//   2. AN UNRECOGNISED ERROR IS PASSED THROUGH UNCHANGED. Inventing advice for a
//      failure we have never seen is worse than none — the same rule
//      `explainSeedFailure` already states.

import { LlmTimeoutError, LlmToolCallError } from './llm.types.js';

export interface ExplainedError {
  /** One plain sentence plus the next action. Safe to render verbatim. */
  message: string;
  /**
   * The original text, kept for the person who does want it. Absent when the
   * message IS the original (an unrecognised error), so the UI does not offer a
   * "details" affordance that repeats what is already on screen.
   */
  detail?: string;
}

/** Was this a Docker/sandbox problem rather than anything about the code? */
function looksLikeSandbox(message: string): boolean {
  return /no such image|unable to find image|image .* not found|cannot connect to the docker daemon|docker: |docker daemon|permission denied while trying to connect to the docker|run-submission|ENOENT.*run-submission/i.test(
    message
  );
}

/** Was this the model's endpoint being unreachable rather than the model failing? */
function looksUnreachable(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|connect ETIMEDOUT/i.test(
    message
  );
}

/**
 * Explain one failure in words a player can act on.
 *
 * Ordered most-specific-first: the typed LLM errors carry facts a regex cannot
 * recover (which model, what budget, whether the stop reason was max_tokens), so
 * they are matched before any string sniffing.
 */
export function explainError(err: unknown): ExplainedError {
  const raw = err instanceof Error ? err.message : String(err);

  // --- the model ran out of room ------------------------------------------
  // Two spellings of the same failure: llm.service's own `truncated()` message,
  // and the typed error the client layer throws when a tool call never landed
  // because the budget ran out first.
  const truncated =
    /truncated at max_tokens/i.test(raw) ||
    (err instanceof LlmToolCallError && err.meta.stop === 'max_tokens');
  if (truncated) {
    return {
      message:
        'The model ran out of room while writing this problem, so it came back half-finished. ' +
        'This is usually a reasoning model thinking out loud instead of answering — try again, ' +
        'and if it keeps happening pick a smaller difficulty or a model whose template honours ' +
        'enable_thinking:false.',
      detail: raw,
    };
  }

  // --- the model answered in prose ----------------------------------------
  // Ten of the eleven calls this app makes are FORCED tool calls, so a model
  // that ignores them cannot run codegrind at all. The `--jinja` clause is the
  // commonest real cause and is repeated from explainProbeFailure on purpose:
  // a player who hits this mid-session gets the same fix the wizard would give.
  if (err instanceof LlmToolCallError) {
    return {
      message:
        'The model replied with prose instead of the structured answer codegrind asked for. ' +
        'If it is a local llama.cpp server, it needs to be started with `--jinja` — tool calling ' +
        'is off without it. Otherwise pick a different model in Settings.',
      detail: raw,
    };
  }

  // --- the model took too long --------------------------------------------
  if (err instanceof LlmTimeoutError) {
    const seconds = Math.round(err.timeoutMs / 1000);
    return {
      message:
        `The model did not answer within ${seconds} seconds. If it was still loading, the next ` +
        'attempt is usually much faster — try again. If it keeps timing out, that model is too ' +
        'slow to use interactively.',
      detail: raw,
    };
  }

  // --- nothing was listening ----------------------------------------------
  if (looksUnreachable(raw)) {
    return {
      message:
        'Could not reach the model endpoint. Check that it is running and that the URL in ' +
        'Settings is right, then try again.',
      detail: raw,
    };
  }

  // --- the sandbox could not run ------------------------------------------
  // Same fix `explainSeedFailure` gives, and it is the one failure a first-run
  // user is genuinely likely to hit: `bin/setup` builds the runner images, and
  // anybody who started the app another way has none.
  if (looksLikeSandbox(raw)) {
    return {
      message:
        'The code sandbox could not run, so nothing could be verified. Build the runner image ' +
        '(`bin/build-runner-image <language>`) and check Docker is up (`bin/status`), then try again.',
      detail: raw,
    };
  }

  // --- the model wrote a problem it cannot solve itself --------------------
  // Already a plain sentence — bank.service says it in words. Passed through so
  // the "nothing is deleted" rule is not quietly broken by a worse paraphrase.
  if (/errored on too many of its own test inputs/i.test(raw)) {
    return {
      message:
        `${raw} Try again — this is usually one bad completion rather than a broken setup.`,
      detail: raw,
    };
  }

  // Unrecognised. Say exactly what happened and invent nothing.
  return { message: raw || 'Unknown error' };
}

/**
 * Log the full failure and return the body a route should answer with.
 *
 * One call site per catch block, so "the log keeps everything, the response
 * keeps the sentence" cannot drift apart route by route.
 */
export function errorBody(tag: string, err: unknown): { error: string; detail?: string } {
  const explained = explainError(err);
  // The stack matters here — this is the copy of the failure that a person
  // debugging their own install will actually read.
  console.error(`[${tag}]`, err instanceof Error ? err.stack || err.message : err);
  return explained.detail
    ? { error: explained.message, detail: explained.detail }
    : { error: explained.message };
}
