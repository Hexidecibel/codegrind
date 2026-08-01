// =============================================================================
// Editor assistance ladder
// =============================================================================
// Four presets reconfigure Monaco from a blank whiteboard (Raw) to a full IDE
// (Assisted), mirroring real interview conditions. Six individual toggles let
// the user override any single dimension — flipping one switches the label to
// "Custom". `assistanceToMonacoOptions` is a pure function so it can be unit
// tested without a browser.

import type { editor } from 'monaco-editor';

export type AssistanceLevel = 1 | 2 | 3 | 4;

/** The six dimensions the user can individually toggle. */
export interface AssistanceOverrides {
  syntaxHighlighting: boolean;
  lineNumbers: boolean;
  autoIndent: boolean;
  autoCloseBrackets: boolean;
  bracketMatching: boolean;
  autocomplete: boolean;
}

export type MonacoLanguage = 'javascript' | 'plaintext';

export interface AssistanceSettings {
  /** The active preset, or 'custom' when a single toggle diverges. */
  level: AssistanceLevel | 'custom';
  overrides: AssistanceOverrides;
}

export const LEVEL_META: Record<
  AssistanceLevel,
  { label: string; blurb: string }
> = {
  1: { label: 'Raw', blurb: 'Notepad — no highlighting, no help.' },
  2: { label: 'Minimal', blurb: 'Highlighting + line numbers only.' },
  3: { label: 'Standard', blurb: 'Auto-indent & auto-close brackets.' },
  4: { label: 'Assisted', blurb: 'Full IDE — IntelliSense on.' },
};

export const OVERRIDE_META: {
  key: keyof AssistanceOverrides;
  label: string;
}[] = [
  { key: 'syntaxHighlighting', label: 'Syntax highlighting' },
  { key: 'lineNumbers', label: 'Line numbers' },
  { key: 'autoIndent', label: 'Auto-indent' },
  { key: 'autoCloseBrackets', label: 'Auto-close brackets' },
  { key: 'bracketMatching', label: 'Bracket matching' },
  { key: 'autocomplete', label: 'Autocomplete' },
];

/** The override booleans a given preset expands to. */
export function presetToOverrides(level: AssistanceLevel): AssistanceOverrides {
  switch (level) {
    case 1:
      return {
        syntaxHighlighting: false,
        lineNumbers: false,
        autoIndent: false,
        autoCloseBrackets: false,
        bracketMatching: false,
        autocomplete: false,
      };
    case 2:
      return {
        syntaxHighlighting: true,
        lineNumbers: true,
        autoIndent: false,
        autoCloseBrackets: false,
        bracketMatching: true,
        autocomplete: false,
      };
    case 3:
      return {
        syntaxHighlighting: true,
        lineNumbers: true,
        autoIndent: true,
        autoCloseBrackets: true,
        bracketMatching: true,
        autocomplete: false,
      };
    case 4:
      return {
        syntaxHighlighting: true,
        lineNumbers: true,
        autoIndent: true,
        autoCloseBrackets: true,
        bracketMatching: true,
        autocomplete: true,
      };
  }
}

/** True when `o` is exactly the preset for `level`. */
function overridesMatchPreset(
  o: AssistanceOverrides,
  level: AssistanceLevel,
): boolean {
  const p = presetToOverrides(level);
  return (
    o.syntaxHighlighting === p.syntaxHighlighting &&
    o.lineNumbers === p.lineNumbers &&
    o.autoIndent === p.autoIndent &&
    o.autoCloseBrackets === p.autoCloseBrackets &&
    o.bracketMatching === p.bracketMatching &&
    o.autocomplete === p.autocomplete
  );
}

/** Which preset (if any) a set of overrides corresponds to, else 'custom'. */
export function matchLevel(o: AssistanceOverrides): AssistanceLevel | 'custom' {
  for (const lvl of [1, 2, 3, 4] as AssistanceLevel[]) {
    if (overridesMatchPreset(o, lvl)) return lvl;
  }
  return 'custom';
}

/**
 * Pure mapping from a preset level (+ optional per-dimension overrides) to the
 * Monaco language and options object. Passing just a level yields that preset;
 * layering `overrides` produces a "Custom" configuration.
 */
export function assistanceToMonacoOptions(
  level: AssistanceLevel,
  overrides?: Partial<AssistanceOverrides>,
): { language: MonacoLanguage; options: editor.IStandaloneEditorConstructionOptions } {
  const o: AssistanceOverrides = { ...presetToOverrides(level), ...overrides };
  return { language: languageFor(o), options: overridesToOptions(o) };
}

/** Model language derived purely from the syntax-highlighting toggle. */
export function languageFor(o: AssistanceOverrides): MonacoLanguage {
  return o.syntaxHighlighting ? 'javascript' : 'plaintext';
}

/** Map resolved override booleans to a Monaco options object. */
export function overridesToOptions(
  o: AssistanceOverrides,
): editor.IStandaloneEditorConstructionOptions {
  return {
    lineNumbers: o.lineNumbers ? 'on' : 'off',
    autoIndent: o.autoIndent ? 'full' : 'none',
    autoClosingBrackets: o.autoCloseBrackets ? 'languageDefined' : 'never',
    autoClosingQuotes: o.autoCloseBrackets ? 'languageDefined' : 'never',
    matchBrackets: o.bracketMatching ? 'always' : 'never',
    quickSuggestions: o.autocomplete,
    suggestOnTriggerCharacters: o.autocomplete,
    wordBasedSuggestions: o.autocomplete ? 'currentDocument' : 'off',
    parameterHints: { enabled: o.autocomplete },
    suggest: { showWords: o.autocomplete },
    tabCompletion: o.autocomplete ? 'on' : 'off',
    // Cosmetic dimensions tied to the nearest toggle so Raw is truly bare.
    folding: o.syntaxHighlighting,
    occurrencesHighlight: o.bracketMatching ? 'singleFile' : 'off',
    renderLineHighlight: o.lineNumbers ? 'line' : 'none',
  };
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------
export const ASSISTANCE_STORAGE_KEY = 'codegrind.assistance';
export const DEFAULT_ASSISTANCE_LEVEL: AssistanceLevel = 3;

export function defaultAssistance(): AssistanceSettings {
  return {
    level: DEFAULT_ASSISTANCE_LEVEL,
    overrides: presetToOverrides(DEFAULT_ASSISTANCE_LEVEL),
  };
}
