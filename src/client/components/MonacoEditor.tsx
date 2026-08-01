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
  tabSize: 2,
  automaticLayout: true,
  fixedOverflowWidgets: true,
};

/** Desktop editor (≥ lg). Mobile gets CodeMirror 6 — see CodeEditor.tsx. */
export function MonacoEditor({
  value,
  onChange,
  settings,
  onRun,
  onSubmit,
  onReady,
}: CodeEditorImplProps) {
  const language = languageFor(settings.overrides);
  const options = useMemo<editor.IStandaloneEditorConstructionOptions>(
    () => ({ ...BASE_OPTIONS, ...overridesToOptions(settings.overrides) }),
    [settings.overrides],
  );

  // Refs keep the commands off the re-registration path (and out of stale closures).
  const handlers = useRef({ onRun, onSubmit });
  handlers.current = { onRun, onSubmit };

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
      });
    },
    [onReady],
  );

  useEffect(() => () => onReady(null), [onReady]);

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
