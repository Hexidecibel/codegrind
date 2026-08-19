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
import type { Language } from '@/shared/languages';

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
  /**
   * Paint a band over lines `startLine`..`endLine` (1-based, inclusive) and
   * scroll them into view — the editor half of clicking a "what you missed"
   * bullet. Replaces any previous band; there is only ever one.
   *
   * NEVER TAKES FOCUS, and that is a hard requirement rather than a nicety.
   * This is called from a tap in the coach panel, and on a phone stealing focus
   * opens the soft keyboard over the very lines the user just asked to be shown
   * — plus `typing` (SolveSurface's focus-is-the-keyboard proxy) would fire and
   * collapse the results pane the bullet lives in.
   *
   * An out-of-range request clears the band rather than throwing: the caller
   * re-anchors against a live buffer, and "the lines are gone" is a normal
   * outcome there, not an error.
   */
  highlightLines(startLine: number, endLine: number): void;
  /** Remove the band, if any. Also never focuses. */
  clearHighlight(): void;
}

/** Props shared by every editor implementation. */
export interface CodeEditorImplProps {
  value: string;
  onChange: (value: string) => void;
  settings: AssistanceSettings;
  /**
   * The PROBLEM's language — grammar, indent width and (for Python, where it is
   * a correctness issue rather than a style one) spaces-not-tabs. It is read off
   * `Problem.language` rather than the active setting: the setting can be flipped
   * while a tab sits open on a problem in the other language, and the editor must
   * follow what is on screen.
   */
  language: Language;
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
    /**
     * The last band asked for, remembered across implementations.
     *
     * Every other method on the handle is fire-and-forget: if nothing is
     * mounted yet, dropping a `relayout()` costs nothing because the next
     * resize sends another one. A highlight is different — it is a piece of
     * STATE the host set once and expects to stay up — and there are two
     * moments where the delegator has no editor to hand it to:
     *
     *   1. the `lazy()` mount race. Clicking a bullet on a phone flips to the
     *      code pane, and on the very first flip the CodeMirror chunk may still
     *      be downloading. The call would land on a null ref and vanish.
     *   2. rotating the device across the `lg` breakpoint swaps Monaco for
     *      CodeMirror (or back). The new editor is a fresh instance with no
     *      decorations, so the band would silently disappear mid-session.
     *
     * So the range is stored here and replayed in `onReady`. `null` is stored
     * too — an explicit clear must not be undone by a later remount.
     */
    const bandRef = useRef<[number, number] | null>(null);

    const onReady = useCallback((h: CodeEditorHandle | null) => {
      handleRef.current = h;
      if (!h) return;
      const band = bandRef.current;
      if (band) h.highlightLines(band[0], band[1]);
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
        highlightLines: (startLine: number, endLine: number) => {
          bandRef.current = [startLine, endLine];
          handleRef.current?.highlightLines(startLine, endLine);
        },
        clearHighlight: () => {
          bandRef.current = null;
          handleRef.current?.clearHighlight();
        },
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
