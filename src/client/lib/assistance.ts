// =============================================================================
// Editor assistance ladder
// =============================================================================
// Four presets reconfigure Monaco from a blank whiteboard (Raw) to a full IDE
// (Assisted), mirroring real interview conditions. Six individual toggles let
// the user override any single dimension — flipping one switches the label to
// "Custom". `assistanceToMonacoOptions` is a pure function so it can be unit
// tested without a browser.

import type { editor } from 'monaco-editor';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_META,
  type Language,
} from '@/shared/languages';

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

/**
 * A Monaco grammar id, or `plaintext` when highlighting is switched off.
 *
 * `Language` doubles as the id set because `LANGUAGE_META[l].monacoId` is the
 * same token for all three — Monaco's ids for JavaScript, Python and Java
 * happen to be exactly our language names. `monacoIdFor` below reads the meta
 * rather than the language, so the day one of them diverges (say a language
 * whose Monaco id is `csharp` but whose token is `c-sharp`) only that one
 * mapping changes.
 */
export type MonacoLanguage = Language | 'plaintext';

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
  language: Language = DEFAULT_LANGUAGE,
): { language: MonacoLanguage; options: editor.IStandaloneEditorConstructionOptions } {
  const o: AssistanceOverrides = { ...presetToOverrides(level), ...overrides };
  return { language: languageFor(o, language), options: overridesToOptions(o, language) };
}

/**
 * Model language: the problem's grammar when highlighting is on, `plaintext`
 * when it is off (the "Raw" rung is meant to be a notepad).
 *
 * `language` is defaulted rather than required, which is the opposite of the
 * rule the db accessors follow — and deliberately so. A missed call site there
 * is a silent cross-language READ; here it is a mis-coloured editor, which the
 * user can see. Requiring it would only add ceremony to the two pure-preset
 * call sites that have no problem in scope.
 */
export function languageFor(
  o: AssistanceOverrides,
  language: Language = DEFAULT_LANGUAGE,
): MonacoLanguage {
  return o.syntaxHighlighting ? monacoIdFor(language) : 'plaintext';
}

/** The Monaco grammar id for a language, read from the shared meta. */
export function monacoIdFor(language: Language): MonacoLanguage {
  return LANGUAGE_META[language].monacoId as MonacoLanguage;
}

/** Map resolved override booleans (+ the problem's language) to Monaco options. */
export function overridesToOptions(
  o: AssistanceOverrides,
  language: Language = DEFAULT_LANGUAGE,
): editor.IStandaloneEditorConstructionOptions {
  return {
    // Indent width is a property of the LANGUAGE, not of the assistance rung:
    // Python's 4 is its block structure rather than a preference.
    tabSize: LANGUAGE_META[language].indentSize,
    // Read from the language rather than pinned, because Go broke the
    // assumption this line used to encode.
    //
    // It WAS pinned true on the reasoning that no language here is better off
    // with a hard tab — true of JavaScript, Python and Java, and the stakes are
    // highest in Python, where a literal tab is a real failure and an invisible
    // one (the file looks correctly indented and raises TabError or, worse,
    // silently binds a block to the wrong suite). Go inverts it: gofmt indents
    // with tabs, so spaces are the deviation. The fact stays in LANGUAGE_META
    // so there is exactly one place that knows, and Python's `true` is asserted
    // by a test rather than by a comment.
    insertSpaces: LANGUAGE_META[language].insertSpaces,
    // Without this the two lines above are DECORATIVE. Monaco's
    // detectIndentation defaults to true, which re-derives tabSize and
    // insertSpaces from the model's own text and silently discards whatever was
    // configured — so a starter snippet that happened to contain one tab would
    // switch the editor to tabs for a Python problem.
    detectIndentation: false,
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
