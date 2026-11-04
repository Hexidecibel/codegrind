// =============================================================================
// integrations — which OPTIONAL integrations this install has configured
// =============================================================================
// App reads GET /api/setup/state once on mount; its `integrations` block lands
// here so any screen can hide an entry point without another request.
//
// The default (no provider, or a failed request) is OFF: a fresh clone has no
// companion services, and an entry point that only errors is worse than none.

import { createContext, useContext } from 'react';
import type { SetupState } from '@/shared/types';

export type Integrations = SetupState['integrations'];

export const INTEGRATIONS_OFF: Integrations = { storyBank: false };

/** The block from a setup-state answer; null (unreachable server) = all off. */
export function integrationsFrom(s: Partial<Pick<SetupState, 'integrations'>> | null): Integrations {
  if (!s) return INTEGRATIONS_OFF;
  // A server older than this flag sent no `integrations` and always had the
  // story bank on; keep that until it restarts onto the code that answers.
  return s.integrations ?? { storyBank: true };
}

export const IntegrationsContext = createContext<Integrations>(INTEGRATIONS_OFF);

/** Is the optional story-bank integration (story forge, job-posting links) configured? */
export function useStoryBankEnabled(): boolean {
  return useContext(IntegrationsContext).storyBank;
}
