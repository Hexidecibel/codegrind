import { useCallback, useEffect, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type KeyBinding,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  insertNewline,
} from '@codemirror/commands';
import {
  bracketMatching,
  codeFolding,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';
import { oneDark } from '@codemirror/theme-one-dark';
import type { AssistanceOverrides } from '@/client/lib/assistance';
import type { CodeEditorImplProps } from '@/client/components/CodeEditor';
import { LANGUAGE_META, type Language } from '@/shared/languages';

/**
 * CM6 grammar per language. Unlike Monaco — whose default ESM entry registers
 * every grammar it ships, Python and Java included, at no extra cost — CM6
 * grammars are separate packages that must be imported to exist.
 *
 * `java` is absent on purpose: @codemirror/lang-java is not a dependency, and
 * Phase 5 adds it alongside the Java harness. A language with no entry here
 * falls back to no grammar at all, which is a plain (still editable, still
 * usable) buffer rather than a crash — the mobile editor degrades to the "Raw"
 * look for that one language instead of breaking the page.
 *
 * THAT GRACEFUL DEGRADATION IS ALSO A TRAP, which is why there is a test
 * asserting an entry exists for every language whose harness is built: a
 * forgotten `npm install` would not throw, it would just quietly serve an
 * unhighlighted buffer to every phone user of that language.
 */
const GRAMMARS: Partial<Record<Language, () => Extension>> = {
  javascript,
  python,
  go,
};

/**
 * Cosmetic layer over oneDark. 16px (vs Monaco's 14) is deliberate: iOS Safari
 * zooms the page whenever a focused field is under 16px, which on a phone reads
 * as the editor "jumping" every time the keyboard opens.
 */
const BASE_THEME = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '16px', backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      lineHeight: '1.55',
    },
    '.cm-content': { paddingTop: '12px', paddingBottom: '12px' },
    '.cm-gutters': { backgroundColor: 'transparent', borderRight: 'none' },
  },
  { dark: true },
);

/**
 * The assistance ladder, translated from Monaco options to CM6 extensions.
 * Mirrors `overridesToOptions` in lib/assistance.ts dimension for dimension:
 *
 *   syntaxHighlighting → JS grammar + oneDark highlight style (+ code folding)
 *   lineNumbers        → line-number gutter + active-line highlight
 *   autoIndent         → indentOnInput; when off, Enter drops to insertNewline
 *   autoCloseBrackets  → closeBrackets (covers Monaco's autoClosingQuotes too)
 *   bracketMatching    → bracketMatching + highlightSelectionMatches
 *   autocomplete       → autocompletion + any-word source + Tab to accept
 *
 * No CM6 analogue (documented gaps): Monaco's `parameterHints` (needs a language
 * service) and `fixedOverflowWidgets`. Folding is keyboard/command only — no fold
 * gutter, which would just be a mis-tap target at phone width.
 */
function extensionsFor(
  o: AssistanceOverrides,
  language: Language,
  onRun: () => void,
  onSubmit: () => void,
): Extension[] {
  // CM6's indentUnit is the string every indent command inserts (Enter, the
  // phone's indent buttons, indentOnInput), so it IS the tabs-vs-spaces policy
  // for the mobile editor — and the policy is the language's, not the editor's.
  // Spaces everywhere except Go, where gofmt uses tabs; `indentSize` is then a
  // display width rather than a count, which is why it is not used to build the
  // string in that branch.
  const meta = LANGUAGE_META[language];
  const indent = meta.insertSpaces ? ' '.repeat(meta.indentSize) : '\t';
  const ext: Extension[] = [
    history(),
    // Horizontal scrolling in a code editor is miserable on a phone; Monaco's
    // desktop default (no wrap) does not translate.
    EditorView.lineWrapping,
    EditorState.tabSize.of(meta.indentSize),
    indentUnit.of(indent),
    oneDark,
    BASE_THEME,
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];

  if (o.syntaxHighlighting) {
    const grammar = GRAMMARS[language];
    if (grammar) ext.push(grammar());
    ext.push(codeFolding(), keymap.of(foldKeymap));
  }
  if (o.lineNumbers) {
    ext.push(lineNumbers(), highlightActiveLineGutter(), highlightActiveLine());
  }
  if (o.autoIndent) ext.push(indentOnInput());
  if (o.autoCloseBrackets) {
    ext.push(closeBrackets(), keymap.of(closeBracketsKeymap));
  }
  if (o.bracketMatching) ext.push(bracketMatching(), highlightSelectionMatches());
  if (o.autocomplete) {
    ext.push(
      autocompletion(),
      keymap.of(completionKeymap),
      // Monaco's wordBasedSuggestions: 'currentDocument'.
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
    );
  }

  // Highest precedence so these beat defaultKeymap (which binds Mod-Enter and
  // Enter itself) regardless of what else is configured.
  const bindings: KeyBinding[] = [
    {
      key: 'Mod-Enter',
      preventDefault: true,
      run: () => {
        onRun();
        return true;
      },
    },
    {
      key: 'Mod-Shift-Enter',
      preventDefault: true,
      run: () => {
        onSubmit();
        return true;
      },
    },
  ];
  if (o.autocomplete) bindings.push({ key: 'Tab', run: acceptCompletion });
  bindings.push(indentWithTab);
  if (!o.autoIndent) {
    bindings.push({
      key: 'Enter',
      run: (view) => (o.autocomplete && acceptCompletion(view)) || insertNewline(view),
    });
  }
  ext.push(Prec.highest(keymap.of(bindings)));

  return ext;
}

/** Mobile editor (< lg). Desktop gets Monaco — see CodeEditor.tsx. */
export function CodeMirrorEditor({
  value,
  onChange,
  settings,
  language,
  onRun,
  onSubmit,
  onReady,
}: CodeEditorImplProps) {
  // Refs keep the keymap out of the reconfiguration path.
  const handlers = useRef({ onRun, onSubmit });
  handlers.current = { onRun, onSubmit };

  const extensions = useMemo(
    () =>
      extensionsFor(
        settings.overrides,
        language,
        () => handlers.current.onRun(),
        () => handlers.current.onSubmit(),
      ),
    [settings.overrides, language],
  );

  const handleCreate = useCallback(
    (view: EditorView) => {
      onReady({
        focus: () => view.focus(),
        relayout: () => view.requestMeasure(),
        revealCursor: () =>
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head, {
              y: 'nearest',
            }),
          }),
        indent: (direction) => {
          (direction > 0 ? indentMore : indentLess)(view);
          view.focus();
        },
        insert: (text) => {
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
            scrollIntoView: true,
          });
          view.focus();
        },
      });
    },
    [onReady],
  );

  useEffect(() => () => onReady(null), [onReady]);

  return (
    <CodeMirror
      className="h-full"
      height="100%"
      value={value}
      theme="none"
      basicSetup={false}
      indentWithTab={false}
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={handleCreate}
    />
  );
}
