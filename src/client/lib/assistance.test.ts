import { describe, it, expect } from 'vitest';
import {
  assistanceToMonacoOptions,
  presetToOverrides,
  matchLevel,
  type AssistanceLevel,
} from './assistance';
import { LANGUAGES, LANGUAGE_META } from '@/shared/languages';

describe('assistanceToMonacoOptions', () => {
  it('level 1 (Raw) is a bare plaintext notepad', () => {
    const { language, options } = assistanceToMonacoOptions(1);
    expect(language).toBe('plaintext');
    expect(options.lineNumbers).toBe('off');
    expect(options.autoIndent).toBe('none');
    expect(options.autoClosingBrackets).toBe('never');
    expect(options.autoClosingQuotes).toBe('never');
    expect(options.matchBrackets).toBe('never');
    expect(options.quickSuggestions).toBe(false);
    expect(options.suggestOnTriggerCharacters).toBe(false);
    expect(options.wordBasedSuggestions).toBe('off');
    expect(options.parameterHints).toEqual({ enabled: false });
    expect(options.folding).toBe(false);
    expect(options.occurrencesHighlight).toBe('off');
    expect(options.renderLineHighlight).toBe('none');
  });

  it('level 2 (Minimal) adds highlighting, line numbers, bracket matching only', () => {
    const { language, options } = assistanceToMonacoOptions(2);
    expect(language).toBe('javascript');
    expect(options.lineNumbers).toBe('on');
    expect(options.matchBrackets).toBe('always');
    // still off:
    expect(options.autoIndent).toBe('none');
    expect(options.autoClosingBrackets).toBe('never');
    expect(options.quickSuggestions).toBe(false);
  });

  it('level 3 (Standard) adds auto-indent and auto-close', () => {
    const { options } = assistanceToMonacoOptions(3);
    expect(options.autoIndent).toBe('full');
    expect(options.autoClosingBrackets).toBe('languageDefined');
    expect(options.autoClosingQuotes).toBe('languageDefined');
    // suggestions still off:
    expect(options.quickSuggestions).toBe(false);
  });

  it('level 4 (Assisted) turns on IntelliSense', () => {
    const { options } = assistanceToMonacoOptions(4);
    expect(options.quickSuggestions).toBe(true);
    expect(options.suggestOnTriggerCharacters).toBe(true);
    expect(options.wordBasedSuggestions).toBe('currentDocument');
    expect(options.parameterHints).toEqual({ enabled: true });
  });

  it('overrides layer onto a preset and read back as custom', () => {
    // Start from Raw but flip syntax highlighting on -> not a clean preset.
    const { language } = assistanceToMonacoOptions(1, {
      syntaxHighlighting: true,
    });
    expect(language).toBe('javascript');
    const custom = { ...presetToOverrides(1), syntaxHighlighting: true };
    expect(matchLevel(custom)).toBe('custom');
  });

  it('each preset round-trips through matchLevel', () => {
    for (const lvl of [1, 2, 3, 4] as AssistanceLevel[]) {
      expect(matchLevel(presetToOverrides(lvl))).toBe(lvl);
    }
  });
});

describe('the problem language', () => {
  it('selects the grammar when highlighting is on', () => {
    expect(assistanceToMonacoOptions(3, undefined, 'python').language).toBe('python');
    expect(assistanceToMonacoOptions(3, undefined, 'java').language).toBe('java');
    expect(assistanceToMonacoOptions(3, undefined, 'javascript').language).toBe('javascript');
  });

  it('still falls back to plaintext at the Raw rung, whatever the language', () => {
    // Raw is a notepad on purpose; the language must not smuggle highlighting
    // back in through the side door.
    for (const l of LANGUAGES) {
      expect(assistanceToMonacoOptions(1, undefined, l).language).toBe('plaintext');
    }
  });

  it('defaults to JavaScript when no language is supplied', () => {
    // The default keeps the two pure-preset call sites (and every pre-existing
    // test above) honest without threading a problem through them.
    expect(assistanceToMonacoOptions(2).language).toBe('javascript');
  });

  it('takes the indent width from the language, not from the rung', () => {
    for (const l of LANGUAGES) {
      for (const lvl of [1, 2, 3, 4] as AssistanceLevel[]) {
        expect(assistanceToMonacoOptions(lvl, undefined, l).options.tabSize).toBe(
          LANGUAGE_META[l].indentSize,
        );
      }
    }
    expect(assistanceToMonacoOptions(3, undefined, 'python').options.tabSize).toBe(4);
    expect(assistanceToMonacoOptions(3, undefined, 'javascript').options.tabSize).toBe(2);
  });

  it('pins spaces-not-tabs for every language and every rung', () => {
    // In Python a literal tab is a real failure and an invisible one. This is
    // pinned rather than language-conditional precisely so no future edit can
    // make it conditional and get Python wrong.
    for (const l of LANGUAGES) {
      for (const lvl of [1, 2, 3, 4] as AssistanceLevel[]) {
        const { options } = assistanceToMonacoOptions(lvl, undefined, l);
        expect(options.insertSpaces, `${l}/${lvl}`).toBe(true);
        // Without this Monaco re-derives both settings from the buffer's own
        // text and discards the two above.
        expect(options.detectIndentation, `${l}/${lvl}`).toBe(false);
      }
    }
  });
});
