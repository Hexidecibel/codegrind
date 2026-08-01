import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';
import { useIsDesktop } from '@/client/hooks/useMediaQuery';
import type { AssistanceSettings } from '@/client/lib/assistance';

/**
 * The imperative surface SolveSurface needs from whichever editor is mounted.
 * Both implementations satisfy it, so the host never learns which one it got.
 */
export interface CodeEditorHandle {
  focus(): void;
  /**
   * Re-measure after the container changed size or came back from
   * `display:none` — both editors measure 0×0 while hidden.
   */
  relayout(): void;
  /**
   * Scroll the caret back into view. Resizing (soft keyboard, results pane
   * collapsing) re-measures but never scrolls, so the caret can end up under
   * the fold until the next keystroke.
   */
  revealCursor(): void;
  /** Indent (+1) or dedent (-1) the selected lines — the phone has no Tab key. */
  indent(direction: 1 | -1): void;
  /** Insert text at the caret, replacing any selection. */
  insert(text: string): void;
}

/** Props shared by every editor implementation. */
export interface CodeEditorImplProps {
  value: string;
  onChange: (value: string) => void;
  settings: AssistanceSettings;
  /** ⌘/Ctrl+Enter. Must be referentially stable — it's baked into a keymap. */
  onRun: () => void;
  /** ⌘/Ctrl+Shift+Enter. Must be referentially stable. */
  onSubmit: () => void;
  /** Called with the handle on mount and `null` on unmount. */
  onReady: (handle: CodeEditorHandle | null) => void;
}

export type CodeEditorProps = Omit<CodeEditorImplProps, 'onReady'>;

// Both editors are code-split: a phone never downloads Monaco (megabytes), and
// a desktop never downloads CodeMirror.
const MonacoEditor = lazy(() =>
  import('@/client/components/MonacoEditor').then((m) => ({
    default: m.MonacoEditor,
  })),
);
const CodeMirrorEditor = lazy(() =>
  import('@/client/components/CodeMirrorEditor').then((m) => ({
    default: m.CodeMirrorEditor,
  })),
);

// [indent%, width%] pairs shaped like typical starter code, laid out at the
// mobile editor's metrics (16px mono, 1.55 line-height ⇒ 24.8px pitch, 12px
// top padding) so real content replaces the skeleton without a layout jump.
const SKELETON_LINES: Array<[number, number]> = [
  [0, 42], [0, 68], [0, 56], [0, 10], [0, 74], [6, 30],
  [6, 52], [6, 22], [12, 44], [6, 26], [0, 6], [0, 0],
  [0, 38], [6, 48], [6, 18],
];

const loading = (
  <div
    role="status"
    aria-label="Loading editor…"
    className="h-full overflow-hidden py-3 motion-safe:animate-pulse"
  >
    <span className="sr-only">Loading editor…</span>
    {SKELETON_LINES.map(([indent, width], i) => (
      <div
        key={i}
        aria-hidden
        className="flex h-[24.8px] items-center gap-4 pl-2 pr-4"
      >
        {/* gutter stand-in */}
        <div className="h-3 w-5 shrink-0 rounded-sm bg-muted/25" />
        {width > 0 && (
          <div
            className="h-3 rounded-sm bg-muted/40"
            style={{ marginLeft: `${indent}%`, width: `${width}%` }}
          />
        )}
      </div>
    ))}
  </div>
);

/**
 * Editor seam. Monaco at/above the `lg` breakpoint, CodeMirror 6 below it —
 * Monaco has no supported touch story (cursor placement, selection handles and
 * the soft keyboard all misbehave), CodeMirror 6 is built for it. The swap is
 * driven by `matchMedia`, never by user-agent, so rotation re-evaluates it.
 *
 * The code buffer lives in the host, so crossing the breakpoint keeps the work
 * (undo history does not — different editors, different stacks).
 */
export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  function CodeEditor(props, ref) {
    const isDesktop = useIsDesktop();
    const handleRef = useRef<CodeEditorHandle | null>(null);

    const onReady = useCallback((h: CodeEditorHandle | null) => {
      handleRef.current = h;
    }, []);

    // Delegate through a stable handle so the host's ref survives the swap.
    useImperativeHandle(
      ref,
      () => ({
        focus: () => handleRef.current?.focus(),
        relayout: () => handleRef.current?.relayout(),
        revealCursor: () => handleRef.current?.revealCursor(),
        indent: (direction: 1 | -1) => handleRef.current?.indent(direction),
        insert: (text: string) => handleRef.current?.insert(text),
      }),
      [],
    );

    const Impl = isDesktop ? MonacoEditor : CodeMirrorEditor;

    return (
      <Suspense fallback={loading}>
        <Impl {...props} onReady={onReady} />
      </Suspense>
    );
  },
);
