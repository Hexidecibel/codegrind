import { useCallback, useEffect, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
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

// ---------------------------------------------------------------------------
// The "what you missed" band
// ---------------------------------------------------------------------------
// Three pieces — an effect to set it, a field to hold it, a facet provider to
// draw it — and every one of them is DEFINED AT MODULE SCOPE, on purpose.
//
// CM6 identifies a state field by the field OBJECT, not by a name. Build the
// field inside the component (or inside `extensionsFor`) and every re-render
// that recomputes the extension array produces a *different* field, which the
// reconfigure below treats as a brand-new field with no prior value: the band
// vanishes the next time the assistance settings or the problem language
// change. Module scope makes the identity a property of the file.
//
// And they are pushed UNCONDITIONALLY into `extensionsFor`, never behind an
// assistance toggle, for the mirror-image reason. A field that is absent from
// the new configuration loses its value (and `state.field(f)` throws outright),
// so gating the band on, say, `o.lineNumbers` would mean flipping the
// assistance ladder mid-session silently drops the highlight — and at
// assistance level 1 there is no gutter at all, which is precisely the case a
// self-sufficient band exists to serve.

/**
 * Set (or, with `null`, clear) the band. Carries document positions.
 *
 * Exported, with BAND_EXTENSION, only so that CodeMirrorEditor.band.test.ts can
 * drive them against a headless `EditorState` — CM6's state layer needs no DOM,
 * which makes this the one part of either editor that this jsdom-less repo can
 * actually assert. Nothing else imports them.
 */
export const setBandEffect = StateEffect.define<{
  from: number;
  to: number;
} | null>();

/**
 * Where the band currently is, as document positions rather than line numbers.
 *
 * Positions are mapped through each transaction's changes so that typing above
 * the band moves it with its lines, the same tracking Monaco gives us for free
 * via decoration stickiness. `from` maps with assoc 1 and `to` with assoc -1,
 * which is CM's spelling of Monaco's NeverGrowsWhenTypingAtEdges: text typed
 * exactly at either edge lands outside the band instead of being swallowed by
 * it.
 *
 * NOTE THAT THIS IS NOT A RangeSet. The obvious implementation — hold a
 * `DecorationSet` and `.map(tr.changes)` it — is a trap for LINE decorations
 * specifically. `Decoration.line` ranges must be zero-length and are only ever
 * drawn when they sit exactly on a line start (`LineDecoration.range` throws
 * outright on a non-empty range; the content builder simply ignores one that
 * has drifted off a line start), and `LineDecoration`'s map mode is
 * `TrackBefore`, so an edit at the start of the band deletes it. Mapping
 * therefore fails SILENTLY — the band stops being painted and nothing says
 * why. Storing two plain numbers and re-deriving the lines at draw time cannot
 * land off a line start, because `doc.lineAt()` is what defines where a line
 * starts.
 */
const bandField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBandEffect)) value = effect.value;
    }
    if (!value) return null;
    if (!tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    return { from: Math.min(from, to), to: Math.max(from, to) };
  },
});

const bandLine = Decoration.line({ class: 'coach-missed-line' });

/**
 * Draw the band from the field's value, every time the field changes.
 *
 * `EditorView.decorations.compute` (a facet provider derived from state) rather
 * than a ViewPlugin: the value is pure state, and a plugin would add a second
 * place for it to live plus a lifecycle to keep in step with reconfiguration.
 */
const bandDecorations = EditorView.decorations.compute([bandField], (state) => {
  const band = state.field(bandField);
  if (!band) return Decoration.none;
  // Clamp into the document: `to` can survive a deletion that shortened the
  // doc past it, and `lineAt` throws on an out-of-range position.
  const end = state.doc.length;
  const from = Math.max(0, Math.min(band.from, end));
  const to = Math.max(from, Math.min(band.to, end));
  const ranges = [];
  let pos = from;
  for (;;) {
    const line = state.doc.lineAt(pos);
    ranges.push(bandLine.range(line.from));
    if (line.to >= to) break;
    pos = line.to + 1;
  }
  // `true` = the ranges are already sorted, which they are (walking forwards).
  return Decoration.set(ranges, true) as DecorationSet;
});

/** The band's three pieces as one extension, for `extensionsFor` to push. */
export const BAND_EXTENSION: Extension = [bandField, bandDecorations];

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
    // Unconditional — see the comment above BAND_EXTENSION. It costs one state
    // field holding `null` when nothing is highlighted, and being here rather
    // than in one of the `if (o.…)` blocks below is what makes the band survive
    // a change of assistance level.
    BAND_EXTENSION,
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
        highlightLines: (startLine, endLine) => {
          const doc = view.state.doc;
          if (startLine > doc.lines) {
            // Out of the document entirely — clear rather than clamp onto the
            // last line, which would confidently point at code the coach never
            // mentioned. Same rule as the Monaco side.
            view.dispatch({ effects: setBandEffect.of(null) });
            return;
          }
          const start = doc.line(Math.max(1, Math.min(startLine, doc.lines)));
          const end = doc.line(
            Math.max(start.number, Math.min(endLine, doc.lines)),
          );
          // Monaco has `revealLineInCenterIfOutsideViewport`; CM has `center`
          // (always jumps) and `nearest` (no-op when already visible) and no
          // combination of the two, so spell it out. Deciding here keeps the
          // two editors behaving the same way: if you can already see the
          // lines, the view does not move under you.
          const visible = view.visibleRanges.some(
            (r) => r.from <= start.from && r.to >= end.to,
          );
          view.dispatch({
            effects: [
              setBandEffect.of({ from: start.from, to: end.to }),
              // scrollIntoView is the one call here that moves the viewport,
              // and it does NOT move focus — which is the whole requirement
              // (see CodeEditorHandle.highlightLines).
              EditorView.scrollIntoView(start.from, {
                y: visible ? 'nearest' : 'center',
              }),
            ],
          });
          // Deliberately no view.focus().
        },
        clearHighlight: () => {
          // Guarded: this is called on every deselect, including ones that
          // happen while nothing is painted, and an empty dispatch still costs
          // a full state update and a re-measure on a phone.
          if (view.state.field(bandField)) {
            view.dispatch({ effects: setBandEffect.of(null) });
          }
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
