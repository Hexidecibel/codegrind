import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
// JavaScript IntelliSense + syntax validation (the "Assisted" rung) lives in the
// TypeScript language feature; it is not part of the editor core.
import 'monaco-editor/languages/features/typescript/register.js';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
import {
  languageFor,
  overridesToOptions,
} from '@/client/lib/assistance';
import type { CodeEditorImplProps } from '@/client/components/CodeEditor';

// Monaco is bundled, not CDN-loaded. Without this, @monaco-editor/react falls
// back to its AMD loader and pulls the whole editor from cdn.jsdelivr.net at
// runtime — which dies on any filtered or egress-less network.
window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'javascript' || label === 'typescript') return new tsWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });

/** Cosmetic options that stay constant regardless of assistance level. */
const BASE_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontSize: 14,
  fontLigatures: false,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  padding: { top: 12, bottom: 12 },
  automaticLayout: true,
  fixedOverflowWidgets: true,
  // tabSize / insertSpaces / detectIndentation deliberately absent: they are a
  // property of the problem's LANGUAGE, so overridesToOptions owns them. Having
  // a default here too would mean two sources of truth for Python's indentation,
  // and the wrong one wins whenever the spread order changes.
};

/** Desktop editor (≥ lg). Mobile gets CodeMirror 6 — see CodeEditor.tsx. */
export function MonacoEditor({
  value,
  onChange,
  settings,
  language: problemLanguage,
  onRun,
  onSubmit,
  onReady,
}: CodeEditorImplProps) {
  const language = languageFor(settings.overrides, problemLanguage);
  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({ ...BASE_OPTIONS, ...overridesToOptions(settings.overrides, problemLanguage) }),
    [settings.overrides, problemLanguage],
  );

  // Refs keep the commands off the re-registration path (and out of stale closures).
  const handlers = useRef({ onRun, onSubmit });
  handlers.current = { onRun, onSubmit };

  /**
   * The "what you missed" band, as a decorations collection.
   *
   * `createDecorationsCollection` rather than `deltaDecorations`: the latter is
   * deprecated in Monaco 0.5x, and it makes the caller carry an array of opaque
   * decoration ids from one call to the next — state we would then have to keep
   * in sync with mounts and unmounts by hand. A collection owns its own ids and
   * `.clear()`/`.set()` are the whole API.
   */
  const band = useRef<editor.IEditorDecorationsCollection | null>(null);

  const handleMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
        handlers.current.onRun(),
      );
      ed.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
        () => handlers.current.onSubmit(),
      );
      // Desktop never needs revealCursor/indent/insert (there's a real Tab key
      // and no soft keyboard), but the handle stays symmetric so the host can
      // stay editor-agnostic.
      onReady({
        focus: () => ed.focus(),
        relayout: () => ed.layout(),
        revealCursor: () => {
          const pos = ed.getPosition();
          if (pos) ed.revealPositionInCenterIfOutsideViewport(pos);
        },
        indent: (direction) =>
          ed.trigger(
            'codegrind',
            direction > 0 ? 'editor.action.indentLines' : 'editor.action.outdentLines',
            null,
          ),
        insert: (text) => {
          const sel = ed.getSelection();
          if (sel) ed.executeEdits('codegrind', [{ range: sel, text, forceMoveMarkers: true }]);
          ed.focus();
        },
        highlightLines: (startLine, endLine) => {
          // Clamp to the document and refuse the impossible. The caller has
          // already re-anchored against the live buffer, but the buffer can
          // have shrunk again between that resolve and this paint, and
          // `setModelMarkers`-style APIs in Monaco throw on an invalid range.
          const model = ed.getModel();
          if (!model) return;
          const last = model.getLineCount();
          const start = Math.max(1, Math.min(startLine, last));
          const end = Math.max(start, Math.min(endLine, last));
          if (startLine > last) {
            // Not "clamp to the last line" — the range is simply not in this
            // document any more, and a band on the wrong lines is the one
            // outcome this whole feature is built to avoid.
            band.current?.clear();
            return;
          }
          const decoration: editor.IModelDeltaDecoration = {
            // To the end line's LAST column, not to its column 1. `isWholeLine`
            // paints every line the range touches, and a range that stops at
            // column 1 of the end line is the classic off-by-one that drops the
            // last line of a multi-line band.
            range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
            options: {
              isWholeLine: true,
              className: 'coach-missed-line',
              // Typing at the first or last column of the band must not drag
              // the band along with it. The default (AlwaysGrowsWhenTypingAtEdges)
              // would extend the highlight onto whatever the user types next,
              // which reads as the coach commenting on brand-new code.
              stickiness:
                monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              // The scrollbar mark is the answer to "where did it go?" after the
              // user scrolls away — without it the band is only findable by
              // hunting, and the editor is taller than the viewport by design.
              overviewRuler: {
                color: 'rgba(251, 113, 133, 0.65)',
                position: monaco.editor.OverviewRulerLane.Full,
              },
            },
          };
          if (band.current) band.current.set([decoration]);
          else band.current = ed.createDecorationsCollection([decoration]);
          // …IfOutsideViewport, the file's existing idiom (see revealCursor
          // above): if the lines are already on screen, do not yank the view
          // out from under someone who was mid-read.
          ed.revealLineInCenterIfOutsideViewport(start);
          // Deliberately no ed.focus() — see CodeEditorHandle.highlightLines.
        },
        clearHighlight: () => band.current?.clear(),
      });
    },
    [onReady],
  );

  useEffect(
    () => () => {
      onReady(null);
      // The collection belongs to the editor instance that just went away;
      // holding the reference would make the next mount call `.set()` on a
      // disposed model instead of creating a fresh collection.
      band.current = null;
    },
    [onReady],
  );

  return (
    <Editor
      language={language}
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={options}
      onMount={handleMount}
      loading={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading editor…
        </div>
      }
    />
  );
}
