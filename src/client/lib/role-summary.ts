// =============================================================================
// Which model does which job — and whether one of them costs more
// =============================================================================
// codegrind routes two roles independently (llm.client.ts): the **workhorse**
// writes problems, hints, plans, primers, lessons and grades, and the **tutor**
// answers the coach chat behind POST /api/ask.
//
// THE THING THIS MODULE EXISTS TO STOP BEING INVISIBLE. On the Anthropic path
// those two have never been the same model. `llm.client` defaults the workhorse
// to `claude-sonnet-5` and the tutor to `claude-opus-5` — deliberately, because
// the tutor is one call per question actually asked and it is the conversation a
// person judges the app by. But `storeProviderConfig` writes the SAME row for
// both roles, so nothing the user did chose that, and nothing on screen said it:
// every "ask the coach" follow-up ran on the pricier model and the first anyone
// knew was the invoice. The decision is to KEEP Opus and SAY SO.
//
// Nothing here hardcodes a model id. Every string comes from `GET /api/providers`
// — the RESOLVED routing, after the environment has won field by field — which
// is the only source that stays right when the defaults in llm.client change.
//
// AND IT MUST STAY HONEST ON THE LOCAL PATH. When both roles resolve to the same
// self-hosted model there is no second bill and no second behaviour, so
// `coachCostsExtra` is false and the UI prints nothing. A cost warning that does
// not apply is worse than no warning: it teaches people to ignore the next one.

import type { LlmStatus } from '@/shared/types';

export interface RoleSummary {
  /** The model writing problems, hints, lessons and grades. */
  writerModel: string;
  /** The model answering the coach chat. */
  coachModel: string;
  /** Both roles resolve to the same model: one behaviour, one bill. */
  sameModel: boolean;
  /** The coach's calls are billed by a vendor rather than run on your hardware. */
  coachIsPaid: boolean;
  /** The same question for the model writing problems. */
  writerIsPaid: boolean;
  /**
   * The coach runs on a PAID model that is not the one writing problems — i.e.
   * there is a cost the user did not pick and would not expect. The only state
   * that earns a sentence about money.
   */
  coachCostsExtra: boolean;
  /** The coach's model came from a stored choice rather than the role default. */
  coachPinned: boolean;
  /**
   * Whether Settings may offer to pin the coach to the writer's model.
   *
   * Both roles on Anthropic (a local endpoint has no second model to offer),
   * neither model pinned by the environment (a row written under an env-pinned
   * field is a row that never takes effect), and the two currently differ or
   * there is a stored pin to undo.
   */
  canChooseCoachModel: boolean;
  /** The id to offer as "back to the default", from the API, never a literal. */
  coachDefaultModel: string;
}

export function summariseRoles(llm: LlmStatus): RoleSummary {
  const { workhorse: w, tutor: t } = llm;
  const sameModel = w.provider === t.provider && w.model === t.model;
  const coachIsPaid = t.provider === 'anthropic';

  const bothAnthropic = w.provider === 'anthropic' && t.provider === 'anthropic';
  const modelsEditable = w.source.model !== 'env' && t.source.model !== 'env';
  const coachPinned = t.source.model === 'settings';

  return {
    writerModel: w.model,
    coachModel: t.model,
    sameModel,
    coachIsPaid,
    writerIsPaid: w.provider === 'anthropic',
    coachCostsExtra: coachIsPaid && !sameModel,
    coachPinned,
    canChooseCoachModel:
      bothAnthropic && modelsEditable && Boolean(w.model) && (!sameModel || coachPinned),
    coachDefaultModel: t.defaultModel,
  };
}

/**
 * One sentence naming both models by the job they do.
 *
 * Built here rather than in JSX so the wizard's Ready screen and the Settings
 * page cannot drift into saying two different things about the same routing.
 * Returns null when there is nothing worth a sentence — one model doing both
 * jobs is the unremarkable case and does not need narrating.
 */
export function coachCostSentence(s: RoleSummary): string | null {
  if (!s.coachCostsExtra) return null;
  // Two genuinely different situations, and one sentence cannot serve both. When
  // the problems are written locally, the coach is not "bigger" — it is the only
  // thing on the bill at all, which is a much more surprising fact.
  if (!s.writerIsPaid) {
    return (
      `Coach chat runs on ${s.coachModel} at Anthropic, while your problems are written ` +
      `on your own hardware by ${s.writerModel}. The coach is the only part of this ` +
      `install that costs money. Change it in Settings.`
    );
  }
  return (
    `Coach chat runs on ${s.coachModel}, a larger and more expensive model than the ` +
    `${s.writerModel} writing your problems. That is on purpose — it is one call per ` +
    `question you actually ask — but you can point it at ${s.writerModel} in Settings.`
  );
}
