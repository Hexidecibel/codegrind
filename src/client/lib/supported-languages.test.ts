// =============================================================================
// The picker's option list — the client half of "Java is not in this build"
// =============================================================================
// The bug this is the regression test for: LanguagePicker mapped `LANGUAGES`,
// which lists Java, which has no sandbox harness. Choosing it stored the
// language happily and then made every subsequent problem load spend three
// generation calls before failing with an error that blamed the model.
//
// Pure data in, pure data out — no DOM, no server, no jsdom. The rule under test
// is "an unsupported language is never selectable", which is a property of this
// function and not of any rendering.

import { describe, it, expect } from 'vitest';
import { supportedLanguageOptions } from './supported-languages';
import type { SetupLanguageState } from '@/shared/types';
import { LANGUAGES } from '@/shared/languages';

/** `GET /api/setup/state`'s `languages`, as this build really reports it. */
const STATE: SetupLanguageState[] = [
  { language: 'javascript', displayName: 'JavaScript', banked: 12, servable: 9, supported: true },
  { language: 'python', displayName: 'Python', banked: 4, servable: 4, supported: true },
  { language: 'go', displayName: 'Go', banked: 0, servable: 0, supported: true },
  { language: 'java', displayName: 'Java', banked: 0, servable: 0, supported: false },
];

describe('supportedLanguageOptions', () => {
  it('offers every supported language, in the order the server sent them', () => {
    const options = supportedLanguageOptions(STATE, 'javascript');
    expect(options.map((o) => o.language)).toEqual(['javascript', 'python', 'go']);
    expect(options.every((o) => o.selectable)).toBe(true);
  });

  it('never offers a language with no harness in this build', () => {
    // The whole point. Java is a real member of LANGUAGES and always will be.
    const options = supportedLanguageOptions(STATE, 'javascript');
    expect(options.map((o) => o.language)).not.toContain('java');
  });

  it('offers nothing it has not been told about rather than falling back to the registry', () => {
    // Null is "the request has not answered yet, or failed". Falling back to
    // LANGUAGES here would put Java back in the list on exactly the flaky
    // network where nobody would think to look for it.
    expect(supportedLanguageOptions(null, 'python')).toEqual([
      { language: 'python', displayName: 'Python', selectable: false },
    ]);
    expect(supportedLanguageOptions(null, null)).toEqual([]);
  });

  it('shows an unsupported ACTIVE language, unselectably, rather than an empty trigger', () => {
    // A row an older build wrote. Dropping it entirely leaves the Select with a
    // value matching no item, and the app stops naming the language it is
    // actually serving.
    const options = supportedLanguageOptions(STATE, 'java');
    expect(options[0]).toEqual({ language: 'java', displayName: 'Java', selectable: false });
    expect(options.filter((o) => o.selectable).map((o) => o.language)).toEqual([
      'javascript',
      'python',
      'go',
    ]);
  });

  it('lists no language twice when the active one is supported', () => {
    for (const l of LANGUAGES) {
      const options = supportedLanguageOptions(STATE, l);
      expect(new Set(options.map((o) => o.language)).size, l).toBe(options.length);
    }
  });

  it('starts offering a language the moment the server reports a harness for it', () => {
    // No edit to this file is needed when test-harness/java/ lands — the only
    // acceptable way for the gate to be undone.
    const withJava = STATE.map((l) => ({ ...l, supported: true }));
    expect(supportedLanguageOptions(withJava, 'javascript').map((o) => o.language)).toContain(
      'java'
    );
  });
});
