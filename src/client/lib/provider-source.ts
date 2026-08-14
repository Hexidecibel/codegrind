// =============================================================================
// Saying where a routing value came from
// =============================================================================
// `GET /api/providers` reports a `source` per field — env, settings, default —
// and the Settings page has to turn that into words a person can act on. The
// distinction is not decorative: an `env` value ALWAYS WINS over anything the
// browser saves, so a screen that offered to change one would be offering to
// write a row that never takes effect. Everything here exists to keep the UI
// from implying otherwise.

import type { LlmFieldSource, LlmRoleStatus } from '@/shared/types';

/**
 * The words for one field's origin.
 *
 * Phrased from the reader's side rather than the schema's: "settings" is a table
 * name, "you set this" is an answer to the question they are actually asking,
 * which is why a model they did not choose is the one answering.
 */
export function sourceLabel(source: LlmFieldSource): string {
  switch (source) {
    case 'env':
      return 'your deploy set this';
    case 'settings':
      return 'you set this';
    case 'default':
      return "codegrind's default";
  }
}

/**
 * Is this field owned by the environment, i.e. not editable from the browser?
 *
 * The one question the render path asks; kept as a named function so that "does
 * the deploy own it" is never re-derived as a string comparison at the call
 * site, where a typo reads as "editable".
 */
export function isEnvPinned(source: LlmFieldSource): boolean {
  return source === 'env';
}

/**
 * Does the environment own ANY field of this role?
 *
 * `LlmStatus.envLocked` answers this across both roles, which is the right
 * question for "may the form be shown at all". This is the per-role version, for
 * the routing panel's per-role note.
 */
export function roleIsEnvPinned(role: LlmRoleStatus): boolean {
  return (
    isEnvPinned(role.source.provider) ||
    isEnvPinned(role.source.model) ||
    isEnvPinned(role.source.endpoint) ||
    isEnvPinned(role.source.endpointKey)
  );
}
