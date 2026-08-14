// =============================================================================
// codegrind — the language registry (shared by client and server)
// =============================================================================
// Language is a property of the PROBLEM, not of the submission. A problem's
// `expected` values are derived by running its reference solution in the
// sandbox, so its test data is bound to the language that produced it. Every
// consequence in the schema follows from that one sentence: `problems.language`
// rather than a `problem_variants` table, a hard language filter on the bank,
// and `RunRequest`/`SubmitRequest` carrying no language at all — the server
// reads it off the problem, which makes running Python source against the JS
// harness structurally impossible rather than merely unlikely.
//
// WHAT IS DELIBERATELY NOT HERE: Docker image names, in-container run commands,
// source filenames, memory/pid caps, timeouts. Those live in bash
// (`bin/lib/languages.sh`, Phase 2) because bash is what invokes docker, and
// because `Solution.java` is a javac constraint rather than a UI one. Putting
// them here would give the client knowledge it has no business having and would
// create a second source of truth that drifts from the thing actually running.
// The rule: if the browser cannot use it, it does not belong in this file.

/**
 * Every language codegrind can serve. **Order is UI order** — this tuple drives
 * the language picker, so JavaScript stays first as the default and the
 * incumbent.
 *
 * `as const` is what makes `Language` a union of literals rather than `string`,
 * which is in turn what makes a missed call site a compile error once the db
 * accessors take a required `language` parameter.
 */
export const LANGUAGES = ['javascript', 'python', 'go', 'java'] as const;

export type Language = (typeof LANGUAGES)[number];

/**
 * The language every pre-multilanguage row is backfilled to, and the value the
 * `language` columns default to at the SQL level (`DEFAULT 'javascript'`).
 *
 * Those two facts must agree. If this constant ever changes, the column
 * defaults in `db.migrate.ts` do NOT follow it — a SQL default is baked into
 * the table definition at ALTER time and is not re-evaluated. Changing the
 * default language is therefore a migration, not an edit to this line.
 */
export const DEFAULT_LANGUAGE: Language = 'javascript';

/** Presentation and authoring facts about a language. No execution facts. */
export interface LanguageMeta {
  /** Human-facing name, for pickers and badges. */
  displayName: string;
  /**
   * Monaco's language id. The `python`, `go` and `java` grammars all ship in
   * monaco-editor's default ESM entry (verified against 0.56: `esm/vs/index.js`
   * imports `languages/definitions/<id>/register.js` for each) and none of them
   * needs a web worker, so the desktop editor costs nothing beyond this string.
   *
   * CodeMirror on mobile is the opposite — every grammar is a separate package
   * that must be imported to exist. See GRAMMARS in CodeMirrorEditor.tsx.
   */
  monacoId: string;
  /**
   * The info string for a fenced code block (```js). Used when rendering
   * lesson/primer snippets and when telling the model how to fence code.
   */
  codeFence: string;
  /** Extension including the dot — display and download affordances. */
  fileExtension: string;
  /**
   * Editor indent width. Python's 4 is not cosmetic: it is the language's
   * block structure.
   *
   * When `insertSpaces` is false this is the DISPLAY width of a tab rather than
   * a count of spaces to insert — which is why Go's is 4 and not 1. A tab shown
   * one column wide is unreadable, and nothing about gofmt's output cares how
   * many columns a tab occupies on screen.
   */
  indentSize: number;
  /**
   * Whether pressing Tab (and every auto-indent) inserts spaces or a hard tab.
   *
   * True for three of the four languages, and Go is the exception that forced
   * this field to exist at all. gofmt indents with tabs and reformats any file
   * it is given, so a Go answer written with spaces is a Go answer that does
   * not look like Go — while in Python a hard tab is a real failure and an
   * invisible one, and in JavaScript it is merely unfashionable.
   *
   * Deliberately explicit rather than derived from the language, because the
   * consumers (Monaco's `insertSpaces`, CodeMirror's `indentUnit`) both need
   * the answer and neither should re-derive it.
   */
  insertSpaces: boolean;
  /** Line-comment marker, for generated scaffolding and stub comments. */
  commentPrefix: string;
}

export const LANGUAGE_META: Record<Language, LanguageMeta> = {
  javascript: {
    displayName: 'JavaScript',
    monacoId: 'javascript',
    codeFence: 'js',
    fileExtension: '.js',
    indentSize: 2,
    insertSpaces: true,
    commentPrefix: '//',
  },
  python: {
    displayName: 'Python',
    monacoId: 'python',
    codeFence: 'python',
    fileExtension: '.py',
    indentSize: 4,
    insertSpaces: true,
    commentPrefix: '#',
  },
  go: {
    displayName: 'Go',
    monacoId: 'go',
    codeFence: 'go',
    fileExtension: '.go',
    // Tabs, at a display width of 4. Go is the one language here where
    // `insertSpaces` is false: gofmt indents with tabs, so spaces are the
    // deviation rather than the safe default.
    indentSize: 4,
    insertSpaces: false,
    commentPrefix: '//',
  },
  java: {
    displayName: 'Java',
    monacoId: 'java',
    codeFence: 'java',
    fileExtension: '.java',
    indentSize: 4,
    insertSpaces: true,
    commentPrefix: '//',
  },
};

/**
 * Narrow an untrusted string (a query param, a settings row, a database cell)
 * to a Language. Returns false for anything not in LANGUAGES — including
 * casing variants, because every stored value is written by code in this repo
 * and a `Python` in the database is a bug to surface, not to paper over.
 */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
