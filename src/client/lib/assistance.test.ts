import { describe, it, expect } from 'vitest';
import {
  assistanceToMonacoOptions,
  presetToOverrides,
  matchLevel,
  type AssistanceLevel,
} from './assistance';

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
