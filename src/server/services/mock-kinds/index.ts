// =============================================================================
// mock-kinds — the server-side registry: kind → spec
// =============================================================================
// The client-safe half of each kind is src/shared/mock-kinds.ts; the spec here
// adds what only the model sees. Record<MockKind, …> makes a kind that exists
// on one side and not the other a compile error.

import { DEFAULT_MOCK_KIND, isMockKind, type MockKind } from '../../../shared/mock-kinds.js';
import { SYSTEM_DESIGN_SPEC } from './system-design.js';
import { BEHAVIORAL_SPEC } from './behavioral.js';
import type { MockKindSpec } from './types.js';

export type { MockKindSpec, MockPrep, MockPrepareArgs } from './types.js';

export const MOCK_KIND_SPECS: Readonly<Record<MockKind, MockKindSpec>> = {
  'system-design': SYSTEM_DESIGN_SPEC,
  behavioral: BEHAVIORAL_SPEC,
};

/** The spec for a kind. An unknown kind (an old or hand-edited row) reads as system design. */
export function mockKindSpec(kind: string | null | undefined): MockKindSpec {
  return isMockKind(kind) ? MOCK_KIND_SPECS[kind] : MOCK_KIND_SPECS[DEFAULT_MOCK_KIND];
}
