// =============================================================================
// role-summary — the cost that must never be a surprise, and never a false alarm
// =============================================================================
// codegrind's two roles are routed independently, and on the Anthropic path they
// have never resolved to the same model: llm.client defaults the workhorse to
// `claude-sonnet-5` and the tutor to `claude-opus-5`. The wizard writes ONE
// configuration and provider.service lands it in BOTH rows, so nothing the user
// did chose that split and — until this module — nothing on screen mentioned it.
// Every "ask the coach" follow-up ran on the dearer model.
//
// The decision was to keep Opus and say so. Which makes this module's job two
// sentences that must both stay true:
//
//   1. SAY IT when the coach costs more than the writer.
//   2. SAY NOTHING when it does not. A local install runs both roles on the same
//      self-hosted model for nothing, and a cost warning printed there is how you
//      teach somebody to ignore the real one.
//
// No model id is written down here or in the module under test — every string
// comes off `GET /api/providers`, so this keeps working when the defaults in
// llm.client change.

import { describe, it, expect } from 'vitest';
import type { LlmRoleStatus, LlmStatus } from '@/shared/types';
import { summariseRoles, coachCostSentence } from './role-summary';

const EVERY_FIELD_DEFAULTED: LlmRoleStatus['source'] = {
  provider: 'default',
  model: 'default',
  endpoint: 'default',
  endpointKey: 'default',
};

/** One role, overridable field by field. `source` merges rather than replaces. */
function role(
  over: Partial<Omit<LlmRoleStatus, 'source'>> & {
    source?: Partial<LlmRoleStatus['source']>;
  } = {},
): LlmRoleStatus {
  const { source, ...rest } = over;
  return {
    provider: 'anthropic',
    model: 'writer-model',
    defaultModel: 'writer-model',
    endpoint: null,
    credential: { configured: false, source: null, suffix: null },
    ...rest,
    source: { ...EVERY_FIELD_DEFAULTED, ...source },
  };
}

function status(workhorse: LlmRoleStatus, tutor: LlmRoleStatus): LlmStatus {
  return { workhorse, tutor, envLocked: false, deny: [], needsAnthropicKey: true };
}

/** The shipping Anthropic shape: two roles, two different defaults. */
const CLAUDE = () =>
  status(
    role({ model: 'sonnet-ish', defaultModel: 'sonnet-ish' }),
    role({ model: 'opus-ish', defaultModel: 'opus-ish' }),
  );

/** A fully local install: one endpoint, one model, no bill. */
const LOCAL = () => {
  const local = (): LlmRoleStatus =>
    role({
      provider: 'openai-compatible',
      model: 'Qwen3-something',
      defaultModel: '',
      endpoint: 'http://127.0.0.1:9600/v1',
      source: { provider: 'settings', model: 'settings', endpoint: 'settings', endpointKey: 'default' },
    });
  return status(local(), local());
};

describe('the Anthropic split, which nobody chose', () => {
  it('reports both models by the job they do', () => {
    const s = summariseRoles(CLAUDE());
    expect(s.writerModel).toBe('sonnet-ish');
    expect(s.coachModel).toBe('opus-ish');
    expect(s.sameModel).toBe(false);
  });

  it('counts as an extra cost, and says so in one sentence', () => {
    const s = summariseRoles(CLAUDE());
    expect(s.coachCostsExtra).toBe(true);
    const said = coachCostSentence(s)!;
    expect(said).toContain('opus-ish');
    expect(said).toContain('sonnet-ish');
    expect(said).toMatch(/expensive/);
    expect(said).toMatch(/Settings/);
  });

  it('offers the choice, with the default named by the API and not by this code', () => {
    const s = summariseRoles(CLAUDE());
    expect(s.canChooseCoachModel).toBe(true);
    expect(s.coachDefaultModel).toBe('opus-ish');
  });
});

describe('and the cases that must stay quiet', () => {
  it('a local install warns about nothing', () => {
    const s = summariseRoles(LOCAL());
    expect(s.sameModel).toBe(true);
    expect(s.coachIsPaid).toBe(false);
    expect(s.coachCostsExtra).toBe(false);
    expect(coachCostSentence(s)).toBeNull();
    // There is no second model to offer, so there is no control either.
    expect(s.canChooseCoachModel).toBe(false);
  });

  it('a coach already pinned to the writer’s model warns about nothing', () => {
    const llm = CLAUDE();
    llm.tutor = role({ model: 'sonnet-ish', defaultModel: 'opus-ish', source: { model: 'settings' } });
    const s = summariseRoles(llm);
    expect(s.sameModel).toBe(true);
    expect(coachCostSentence(s)).toBeNull();
    // …but the control stays, so the choice can be undone.
    expect(s.coachPinned).toBe(true);
    expect(s.canChooseCoachModel).toBe(true);
    expect(s.coachDefaultModel).toBe('opus-ish');
  });

  it('an env-pinned model offers no control — a row written there never takes effect', () => {
    const llm = CLAUDE();
    llm.tutor = role({ model: 'opus-ish', defaultModel: 'opus-ish', source: { model: 'env' } });
    const s = summariseRoles(llm);
    // The cost is still real and still stated…
    expect(s.coachCostsExtra).toBe(true);
    expect(coachCostSentence(s)).not.toBeNull();
    // …it just cannot be changed from the browser.
    expect(s.canChooseCoachModel).toBe(false);
  });
});

describe('the mixed install: local problems, Claude coach', () => {
  // Supported and opt-in (CODEGRIND_CHAT_PROVIDER), and the surprise is a
  // different one — the coach is not "bigger", it is the only thing on the bill.
  const mixed = () =>
    status(
      role({
        provider: 'openai-compatible',
        model: 'Qwen3-something',
        defaultModel: '',
        endpoint: 'http://127.0.0.1:9600/v1',
        source: { provider: 'settings', model: 'settings', endpoint: 'settings', endpointKey: 'default' },
      }),
      role({ model: 'opus-ish', defaultModel: 'opus-ish', source: { provider: 'env' } }),
    );

  it('is flagged as costing money, with copy that does not claim it is bigger', () => {
    const s = summariseRoles(mixed());
    expect(s.writerIsPaid).toBe(false);
    expect(s.coachIsPaid).toBe(true);
    expect(s.coachCostsExtra).toBe(true);
    const said = coachCostSentence(s)!;
    expect(said).toContain('only part of this install that costs money');
    expect(said).not.toMatch(/larger/);
  });

  it('offers no pin — there is no shared provider to pin it to', () => {
    expect(summariseRoles(mixed()).canChooseCoachModel).toBe(false);
  });
});
