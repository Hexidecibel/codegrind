// =============================================================================
// Which languages the picker may actually offer
// =============================================================================
// `LANGUAGES` is the registry — every language codegrind knows how to talk
// about. It is NOT the list a picker may show, and the difference is not
// cosmetic: Java is in the registry and has no `test-harness/java/`, so
// selecting it stores a language whose every problem load spends three
// generation calls and then fails with a message blaming the model.
//
// Only the server can answer "does this build have a harness", because the
// answer is a directory on the server's disk (see harness.service.ts). It
// arrives in the browser as `SetupState.languages[].supported` — the same field
// the first-run wizard has always filtered on, and the same field the language
// PICKER now filters on instead of mapping the raw registry. It is a function
// rather than a `.filter()` in a render so that the rule has a test, and so that
// the two surfaces cannot drift into two slightly different rules.
//
// WHY AN UNSUPPORTED LANGUAGE CAN STILL APPEAR, UNSELECTABLE. A settings row
// written by an older build (or by a build whose harness was since removed) is
// still the ACTIVE language. Dropping it from the list entirely would leave the
// Select with a value matching no item, which renders as an empty trigger — the
// app would stop naming the language it is actually serving. So it is listed and
// it cannot be chosen, which is exactly its real status.

import { LANGUAGE_META, type Language } from '@/shared/languages';
import type { SetupLanguageState } from '@/shared/types';

export interface LanguageOption {
  language: Language;
  displayName: string;
  /**
   * Whether this build can run it. False only ever for a language that is
   * ALREADY the stored active one — never for something newly offered.
   */
  selectable: boolean;
}

/**
 * The options a language picker may render.
 *
 * @param languages `SetupState.languages`, or null when it has not loaded (or
 *   the request failed). Null deliberately does NOT fall back to the registry:
 *   "we could not ask" must not become "offer everything", or the one failure
 *   mode this function exists to prevent returns on exactly the flaky network
 *   where it is hardest to notice.
 * @param current the active language, or null before settings load.
 */
export function supportedLanguageOptions(
  languages: SetupLanguageState[] | null,
  current: Language | null
): LanguageOption[] {
  if (!languages) {
    return current
      ? [{ language: current, displayName: LANGUAGE_META[current].displayName, selectable: false }]
      : [];
  }

  const options: LanguageOption[] = languages
    .filter((l) => l.supported)
    .map((l) => ({
      language: l.language,
      displayName: l.displayName || LANGUAGE_META[l.language].displayName,
      selectable: true,
    }));

  if (current && !options.some((o) => o.language === current)) {
    options.unshift({
      language: current,
      displayName: LANGUAGE_META[current].displayName,
      selectable: false,
    });
  }

  return options;
}
