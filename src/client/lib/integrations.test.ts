// =============================================================================
// integrations — the client side of the optional-integration switch
// =============================================================================
import { describe, it, expect } from 'vitest';
import { INTEGRATIONS_OFF, integrationsFrom } from './integrations';

describe('integrationsFrom', () => {
  it('no setup state (server unreachable) means everything off', () => {
    expect(integrationsFrom(null)).toEqual(INTEGRATIONS_OFF);
    expect(INTEGRATIONS_OFF.storyBank).toBe(false);
  });

  it('passes the server flag through', () => {
    expect(integrationsFrom({ integrations: { storyBank: false } })).toEqual({ storyBank: false });
    expect(integrationsFrom({ integrations: { storyBank: true } })).toEqual({ storyBank: true });
  });

  it('a server older than the flag (no integrations block) keeps the story bank on', () => {
    expect(integrationsFrom({})).toEqual({ storyBank: true });
  });
});
