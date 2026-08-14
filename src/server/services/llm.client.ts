// =============================================================================
// llm.client — which model answers which kind of call
// =============================================================================
// The call sites in llm.service.ts say WHAT they want (`structured`, `text`) and
// what KIND of call it is (`role`). This file is the only place that turns a
// role into a configured client, which is what keeps the word "provider" out of
// llm.service.ts entirely — a rule that exists because the alternative is
// visible one directory over, in soulseek-helper, where an `if` per function
// went out of step function by function.
//
// Today every role resolves to Anthropic. That is the whole of the change: a
// second implementation adds a branch HERE, in one function, and no call site
// learns about it.

import { createAnthropicClient } from './llm.anthropic.js';
import type {
  CallRole,
  LlmClient,
  StructuredRequest,
  StructuredResult,
  TextRequest,
  TextResult,
} from './llm.types.js';

export { NO_API_KEY_MESSAGE } from './llm.anthropic.js';

/**
 * Two models, split by what the call is for.
 *
 * `ANTHROPIC_MODEL` is the workhorse: generation, forced-tool-use extraction,
 * lesson writing, corpus translation, and the per-submit coaching brief —
 * everything that runs on a schedule the user doesn't control.
 *
 * `ANTHROPIC_CHAT_MODEL` is the teaching model, used by `askFollowup` alone: one
 * call per question actually asked, the lowest-frequency and highest-value call
 * in the app, and the one where the model has to reason about *how to explain*
 * before it answers. `coach` is the other teaching call but fires on every
 * submit, so it stays on the workhorse model and buys its quality with thinking
 * instead — see the note at that call site.
 *
 * Read at module load, as they always have been: these are deployment
 * configuration, not something a request may change underneath a running server.
 */
const WORKHORSE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const TUTOR_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-5';

let workhorse: LlmClient | null = null;
let tutor: LlmClient | null = null;

/**
 * The client for a role.
 *
 * `workhorse` and `small` are the same model on purpose — they differ in their
 * token budget and their timeout, not in who answers. `tutor` is separate
 * because it is the one call worth a bigger model.
 */
export function clientFor(role: CallRole): LlmClient {
  if (role === 'tutor') {
    return (tutor ??= createAnthropicClient(TUTOR_MODEL));
  }
  return (workhorse ??= createAnthropicClient(WORKHORSE_MODEL));
}

/** A forced-tool-use call: the tool's schema IS the response schema. */
export function structured(req: StructuredRequest): Promise<StructuredResult> {
  return clientFor(req.role).structured(req);
}

/** A prose call. Exactly one call site in the app uses it: the tutor chat. */
export function text(req: TextRequest): Promise<TextResult> {
  return clientFor(req.role).text(req);
}
