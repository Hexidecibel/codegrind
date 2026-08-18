// =============================================================================
// harness — which languages this BUILD can actually run
// =============================================================================
// `LANGUAGES` (src/shared/languages.ts) is the set of languages codegrind knows
// how to TALK about: display names, Monaco ids, indent rules, prompt wording.
// This file answers the narrower and much more load-bearing question — which of
// them does this checkout have a sandbox for?
//
// The two sets are not the same and conflating them is expensive rather than
// cosmetic. Java is in the registry and has no `test-harness/java/`. Choosing it
// spends MAX_GEN_ATTEMPTS generation calls per problem (bank.service.ts), each
// of which runs against a `codegrind-runner-java:latest` that was never built,
// gets stderr back for every test, has every test dropped by
// `canonicalizeTests`, and finally throws a message blaming the MODEL for
// erroring on its own test inputs. The user is then wedged: every problem load
// fails, and nothing on screen says why. So "supported" is a gate, not a hint,
// and it belongs on every surface that can select a language.
//
// THE ANSWER IS READ FROM THE FILESYSTEM, NOT FROM A LIST. Deliberately the same
// question `cg_buildable_languages` asks in bin/lib/languages.sh, and asked of
// the same directory. A hardcoded array here would be a second source of truth
// that goes stale the moment `test-harness/java/Dockerfile` lands; as written,
// that one file appearing is enough to make the wizard, the language picker and
// PUT /api/settings all start offering Java, with no edit to this file.
//
// It lives in services/ rather than in a route because it now has two callers —
// routes/setup.ts (the wizard's picture, and the seed gate) and
// routes/settings.ts (the write gate). A route importing another route to get at
// a helper is how the second copy gets written instead.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, LANGUAGE_META, isLanguage, type Language } from '../../shared/languages.js';

/**
 * The repo root, resolved from this module rather than from `process.cwd()`.
 *
 * The service is started by systemd with a WorkingDirectory, by `bin/start` from
 * the repo, and by a developer from wherever they happen to be standing. Only
 * one of those three is guaranteed.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Does a sandbox harness exist for this language in this build?
 *
 * Not cached. It is one `stat` on a path that is already in the page cache, and
 * a cached answer would mean a freshly added harness needs a restart to be
 * noticed — the opposite of the property this file exists to have.
 */
export function harnessExists(language: string): boolean {
  return existsSync(path.join(REPO_ROOT, 'test-harness', language, 'Dockerfile'));
}

/** The registry narrowed to what this build can actually run. Registry order. */
export function supportedLanguages(): Language[] {
  return LANGUAGES.filter((l) => harnessExists(l));
}

/**
 * Is this untrusted value a language this build can run?
 *
 * The stricter sibling of `isLanguage`. Every write path that accepts a language
 * from outside this repo wants THIS one: `isLanguage('java')` is true and always
 * will be, because Java is a real member of the registry.
 */
export function isSupportedLanguage(value: unknown): value is Language {
  return isLanguage(value) && harnessExists(value);
}

/**
 * What to tell someone who asked for a language this build cannot run.
 *
 * One sentence, one implementation, because two surfaces say it (the seed gate
 * and the settings write gate) and a user who hits both should not be told two
 * different stories about the same missing directory. It names the language and
 * the reason, and it does not blame the model.
 */
export function unsupportedLanguageMessage(language: Language): string {
  return `${LANGUAGE_META[language].displayName} has no sandbox harness in this build yet — pick another language.`;
}
