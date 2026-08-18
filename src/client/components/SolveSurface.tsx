import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Play,
  Send,
  Lightbulb,
  Loader2,
  X,
  MessageCircleQuestion,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  Target,
  Snowflake,
  FileText,
  Code2,
  ChevronRight,
  EyeOff,
  IndentIncrease,
  IndentDecrease,
  BookOpen,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  Problem,
  RunResult,
  SubmitResult,
  CoachingBrief,
  Hint,
  ChatTurn,
  Prediction,
  TestResult,
} from '@/shared/types';
import {
  ApiError,
  runCode,
  submitCode,
  getHint,
  askCoach,
  revealSolution,
} from '@/client/lib/api';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import {
  useControlSize,
  useIsDesktop,
  useIsShort,
} from '@/client/hooks/useMediaQuery';
import { useVisualViewportHeight } from '@/client/hooks/useAppHeight';
import {
  defaultAssistance,
  matchLevel,
  type AssistanceSettings,
} from '@/client/lib/assistance';
import { cn } from '@/lib/utils';
import { Button } from '@/client/components/ui/button';
import { ProblemPanel } from '@/client/components/ProblemPanel';
import {
  CodeEditor,
  type CodeEditorHandle,
} from '@/client/components/CodeEditor';
import { EditorSettings } from '@/client/components/EditorSettings';
import { ResultsPanel, VERDICT_META } from '@/client/components/ResultsPanel';
import { CoachPanel } from '@/client/components/CoachPanel';

/** localStorage-safe re-derivation of the active level from stored overrides. */
function normalizeAssistance(s: AssistanceSettings): AssistanceSettings {
  return { level: matchLevel(s.overrides), overrides: s.overrides };
}

export interface SolveSurfaceProps {
  problem: Problem;
  /** Toolbar controls slotted to the left of the Assist/Hint/Run/Submit cluster. */
  toolbarExtras?: ReactNode;
  /**
   * Whether `toolbarExtras` are controls the user needs to reach ('controls',
   * e.g. /manual's topic picker) or ambient context ('context', e.g. grind's
   * stats strip). Context is demoted below the problem statement on a phone.
   */
  toolbarExtrasKind?: 'controls' | 'context';
  /** Rendered full-width above the problem/editor columns (e.g. the coach banner). */
  banner?: ReactNode;
  /**
   * Fired as soon as the hidden tests finish (accepted or not) so hosts can
   * update session state. It carries the RESULT rather than the whole submit
   * response because it now fires before the coaching exists — the point of the
   * split is that nothing waits on that call.
   */
  onSubmitted?: (result: SubmitResult) => void;
  /**
   * Fired when the submit stream ENDS, i.e. once the server has finished
   * writing the attempt, the skill bump and the review-queue move.
   *
   * Separate from `onSubmitted` because those two moments are now minutes apart:
   * the verdict arrives with the tests, but the attempt row is written after the
   * coaching call (it stores the brief's mistakeTags). Anything reading
   * server-side derived state — the "N due for review" pill — has to wait for
   * this one or it reads the count from before the submit.
   */
  onSubmitRecorded?: () => void;
  /** Rendered as a sticky bar at the bottom of the workspace column (e.g. Next). */
  footer?: ReactNode;
  /**
   * Cold-review mode (retrieval loop): hides the Hint button and shows a
   * "solve it from scratch" note. The editor already resets to starter code.
   */
  reviewMode?: boolean;
}

const emptyPrediction = (): Prediction => ({
  approach: '',
  predTime: '',
  predSpace: '',
  confidence: 3,
});

/** Which pane the phone layout is showing; ignored at `lg` and up. */
type Pane = 'problem' | 'code';

/**
 * The shared solve loop: editor + Run/Submit/Hint + results/coach + Ask-the-coach.
 * Owns all interaction state; the host supplies the problem and optional chrome
 * (banner / toolbar extras / footer). Used by both manual and grind modes so the
 * logic lives in exactly one place.
 */
export function SolveSurface({
  problem,
  toolbarExtras,
  toolbarExtrasKind = 'controls',
  banner,
  onSubmitted,
  onSubmitRecorded,
  footer,
  reviewMode = false,
}: SolveSurfaceProps) {
  const [assistanceRaw, setAssistance] = useLocalStorage<AssistanceSettings>(
    'codegrind.assistance',
    defaultAssistance(),
  );
  const assistance = normalizeAssistance(assistanceRaw);

  // Below `lg` the two panes are tabbed instead of side-by-side; there simply
  // isn't room to stack a full problem statement above a usable editor.
  const isDesktop = useIsDesktop();
  const isShort = useIsShort();
  const controlSize = useControlSize();
  const viewportHeight = useVisualViewportHeight();
  const [pane, setPane] = useState<Pane>('problem');
  // Focus inside the editor is our proxy for "the soft keyboard is up" — the
  // one signal that works on both Android (which resizes the layout viewport)
  // and iOS (which doesn't).
  const [typing, setTyping] = useState(false);

  const [code, setCode] = useState(problem.starterCode);

  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [coaching, setCoaching] = useState<CoachingBrief | null>(null);
  /**
   * Where the coaching half of a submit has got to.
   *
   * Its own state because it is now its own arrival: `pending` is a labelled
   * placeholder inside the results pane (never a whole-screen spinner — the
   * verdict is already on screen and must stay readable), and `lost` covers the
   * stream ending without a coaching line at all, which would otherwise leave a
   * spinner turning forever.
   */
  const [coachPhase, setCoachPhase] = useState<
    'idle' | 'pending' | 'done' | 'lost'
  >('idle');
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [hints, setHints] = useState<Hint[]>([]);
  const [hintLoading, setHintLoading] = useState(false);

  // The reference solution, once it is legitimately visible: either earned by
  // an accepted submit (`earned`) or asked for (`revealed`, which the server
  // has already recorded as assistance).
  const [answer, setAnswer] = useState<{
    code: string;
    how: 'earned' | 'revealed';
  } | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  // Reveal is a two-tap control: the first tap states the price, the second pays
  // it. Nobody should give up a clean solve to a mis-tap next to Hint.
  const [confirmReveal, setConfirmReveal] = useState(false);

  // `detail` is the server's raw internal message, kept behind a disclosure —
  // see explain.service.ts: the sentence is for reading, the detail is for
  // debugging, and deleting the second to get the first was never the deal.
  const [error, setError] = useState<{
    message: string;
    detail?: string;
  } | null>(null);
  const showError = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      setError({ message: err.message, detail: err.detail });
    } else {
      setError({ message: err instanceof Error ? err.message : fallback });
    }
  }, []);
  // Phone only: the results pane collapses to its summary strip.
  const [resultsOpen, setResultsOpen] = useState(true);

  // Predict-before-solve (retrieval loop): a low-friction gate over the editor.
  //
  // Whether it opens AT ALL is a persisted local preference, following the same
  // convention as the assistance ladder (`codegrind.assistance`) and study's dim
  // mode (`codegrind.study.dim`). It used to open on every single problem with
  // only "Start solving" and "Skip" — a modal over the editor with no way to
  // stop it. Turning it off is reversible from the Assist popover, because a
  // preference you cannot undo is worse than the nag it removed.
  const [planGate, setPlanGate] = useLocalStorage<boolean>(
    'codegrind.predict.gate',
    true,
  );
  const [predictOpen, setPredictOpen] = useState(planGate);
  // Read through a ref inside the problem-change effect: putting `planGate` in
  // that effect's deps would make flipping the preference re-run it, and it
  // resets `code` to the starter — one toggle would silently delete whatever
  // you had typed.
  const planGateRef = useRef(planGate);
  planGateRef.current = planGate;
  const [prediction, setPrediction] = useState<Prediction>(emptyPrediction);
  const [submittedPrediction, setSubmittedPrediction] =
    useState<Prediction | null>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);

  // The inactive pane is display:none, so the editor measures 0×0 while it's
  // away — hand it back a size the frame after it becomes visible again.
  useEffect(() => {
    if (isDesktop || pane !== 'code') return;
    const id = requestAnimationFrame(() => editorRef.current?.relayout());
    return () => cancelAnimationFrame(id);
  }, [pane, isDesktop]);

  // Neither editor scrolls when it is merely resized, so the caret can end up
  // under the soft keyboard until the next keystroke. Re-reveal it whenever the
  // visual viewport moves or the results pane resizes around it.
  useEffect(() => {
    if (isDesktop || pane !== 'code') return;
    const id = requestAnimationFrame(() => editorRef.current?.revealCursor());
    return () => cancelAnimationFrame(id);
  }, [viewportHeight, typing, isDesktop, pane]);

  // Focus back in the editor => you're writing, not reading. Fold the verdict
  // away rather than letting it hold 40% of a keyboard-shrunk viewport.
  useEffect(() => {
    if (typing) setResultsOpen(false);
  }, [typing]);

  // Reset everything when the problem changes (grind "Next", manual "New", …).
  useEffect(() => {
    setCode(problem.starterCode);
    setPane('problem');
    setRunResult(null);
    setSubmitResult(null);
    setCoaching(null);
    setHints([]);
    setAnswer(null);
    setConfirmReveal(false);
    setError(null);
    setCoachPhase('idle');
    setPredictOpen(planGateRef.current);
    setPrediction(emptyPrediction());
    setSubmittedPrediction(null);
    setResultsOpen(true);
  }, [problem.id, problem.starterCode]);

  const startSolving = useCallback(() => {
    // Synchronously, inside the click task: iOS Safari only opens the soft
    // keyboard for a focus() that happens in the user-gesture task, so a
    // setTimeout here lands the caret but leaves the keyboard shut. The editor
    // is already mounted underneath the gate, so this is safe before the state
    // update that removes it.
    editorRef.current?.focus();
    setPrediction((p) => {
      const trimmed: Prediction = {
        approach: p.approach.trim(),
        predTime: p.predTime.trim(),
        predSpace: p.predSpace.trim(),
        confidence: p.confidence,
      };
      const hasContent =
        !!trimmed.approach || !!trimmed.predTime || !!trimmed.predSpace;
      setSubmittedPrediction(hasContent ? trimmed : null);
      return trimmed;
    });
    setPredictOpen(false);
  }, []);

  const skipPredict = useCallback(() => {
    editorRef.current?.focus(); // same gesture-task rule as startSolving
    setSubmittedPrediction(null);
    setPredictOpen(false);
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    // iOS Safari doesn't focus a <button> on tap, so the editor never blurs and
    // the keyboard stays up over the output you just asked for. Dismiss both
    // explicitly on a phone; desktop keeps focus where the user put it.
    if (!isDesktop) (document.activeElement as HTMLElement | null)?.blur();
    setError(null);
    setResultsOpen(true);
    setRunning(true);
    setSubmitResult(null);
    setCoaching(null);
    try {
      const r = await runCode(problem.id, code);
      setRunResult(r);
    } catch (err) {
      showError(err, 'Run failed');
    } finally {
      setRunning(false);
    }
  }, [problem.id, code, running, isDesktop, showError]);

  /**
   * Submit, and render each half the moment it lands.
   *
   * The response is an NDJSON stream: `result` as soon as the hidden tests
   * finish, `coaching` whenever the model is done. Awaiting the whole thing —
   * which is what this used to do — meant the verdict sat on the server for the
   * length of an 8000-token adaptive-thinking call (180s budget on Anthropic,
   * 300s on a local endpoint) behind one static line of copy.
   *
   * `submitting` stays true for the WHOLE stream on purpose: the attempt row is
   * written server-side after coaching, so a second submit fired in the gap
   * would record two attempts for one solve.
   */
  const submit = useCallback(async () => {
    if (submitting) return;
    if (!isDesktop) (document.activeElement as HTMLElement | null)?.blur();
    setError(null);
    setResultsOpen(true);
    setSubmitting(true);
    setRunResult(null);
    setSubmitResult(null);
    setCoaching(null);
    setCoachPhase('pending');
    try {
      await submitCode(
        problem.id,
        code,
        hints.length,
        submittedPrediction ?? undefined,
        (event) => {
          if (event.type === 'result') {
            setSubmitResult(event.result);
            // Solved it — the server hands back the reference solution with the
            // verdict. No need to ask, and no assistance recorded: it was earned.
            if (event.referenceSolution) {
              const earned = event.referenceSolution;
              setAnswer((prev) => prev ?? { code: earned, how: 'earned' });
              setConfirmReveal(false);
            }
            // Fires here rather than at the end of the stream: the host's
            // counters describe the verdict, and the verdict is in.
            onSubmitted?.(event.result);
          } else {
            setCoaching(event.coaching);
            setCoachPhase('done');
          }
        },
      );
    } catch (err) {
      showError(err, 'Submit failed');
      setCoachPhase('idle');
    } finally {
      setSubmitting(false);
      // The stream ended without a coaching line (a dropped socket, a server
      // restart mid-call). Say so rather than spinning forever.
      setCoachPhase((phase) => (phase === 'pending' ? 'lost' : phase));
      onSubmitRecorded?.();
    }
  }, [
    problem.id,
    code,
    hints.length,
    submitting,
    onSubmitted,
    onSubmitRecorded,
    submittedPrediction,
    isDesktop,
    showError,
  ]);

  const requestHint = useCallback(async () => {
    if (hintLoading || hints.length >= 3) return;
    // Same iOS blur rule as run/submit — you tapped this to read something.
    if (!isDesktop) (document.activeElement as HTMLElement | null)?.blur();
    setError(null);
    setResultsOpen(true);
    setHintLoading(true);
    const level = (hints.length + 1) as 1 | 2 | 3;
    try {
      const h = await getHint(problem.id, code, level);
      setHints((prev) => [...prev, h]);
    } catch (err) {
      showError(err, 'Hint failed');
    } finally {
      setHintLoading(false);
    }
  }, [problem.id, code, hints.length, hintLoading, isDesktop, showError]);

  const reveal = useCallback(async () => {
    if (answerLoading || answer) return;
    // First tap only states the price; the second one pays it.
    if (!confirmReveal) {
      setConfirmReveal(true);
      return;
    }
    if (!isDesktop) (document.activeElement as HTMLElement | null)?.blur();
    setError(null);
    setResultsOpen(true);
    setAnswerLoading(true);
    try {
      const res = await revealSolution(problem.id);
      setAnswer({ code: res.referenceSolution, how: 'revealed' });
      setConfirmReveal(false);
    } catch (err) {
      showError(err, 'Reveal failed');
    } finally {
      setAnswerLoading(false);
    }
  }, [problem.id, answer, answerLoading, confirmReveal, isDesktop, showError]);

  // Keyboard shortcuts baked into the editor's keymap — stable identities so a
  // re-render never re-registers them (refs avoid stale closures).
  const handlers = useRef({ run, submit });
  handlers.current = { run, submit };
  const editorRun = useCallback(() => handlers.current.run(), []);
  const editorSubmit = useCallback(() => handlers.current.submit(), []);

  const hasResults =
    !!runResult ||
    !!submitResult ||
    hints.length > 0 ||
    !!coaching ||
    coachPhase === 'pending' ||
    coachPhase === 'lost' ||
    !!answer;
  const canAsk = hasResults; // surface the coach chat once there's something to discuss
  // Whichever suite ran most recently (submit clears run and vice versa) — the
  // tutor needs the actual failures to answer "why did mine fail?".
  const lastResults: TestResult[] =
    submitResult?.results ?? runResult?.results ?? [];

  /**
   * The phone results strip: verdict at a glance — coloured icon, verdict
   * word, test counts — legible even collapsed. Announced politely as a unit.
   */
  const strip = (() => {
    // Only while the VERDICT is unknown. Once the tests are back the strip shows
    // them, even though `submitting` stays true through the coaching call — the
    // whole point of the split is that the verdict stops waiting on the essay.
    if (submitting && !submitResult)
      return {
        Icon: Loader2,
        spin: true,
        iconClass: 'text-primary',
        label: 'Running hidden tests…',
        labelClass: 'text-muted-foreground',
        detail: null as string | null,
      };
    if (submitResult) {
      const meta = VERDICT_META[submitResult.verdict];
      return {
        Icon: meta.icon,
        spin: false,
        iconClass: meta.textClass,
        label: meta.label,
        labelClass: meta.textClass,
        detail:
          coachPhase === 'pending'
            ? `${submitResult.passed}/${submitResult.total} hidden · coaching…`
            : `${submitResult.passed}/${submitResult.total} hidden`,
      };
    }
    if (runResult) {
      const meta = VERDICT_META[runResult.verdict];
      return {
        Icon: meta.icon,
        spin: false,
        iconClass: meta.textClass,
        label: meta.label,
        labelClass: meta.textClass,
        detail: `${runResult.passed}/${runResult.total} samples`,
      };
    }
    if (hintLoading)
      return {
        Icon: Loader2,
        spin: true,
        iconClass: 'text-amber-400',
        label: 'Fetching a hint…',
        labelClass: 'text-muted-foreground',
        detail: null,
      };
    if (hints.length > 0)
      return {
        Icon: Lightbulb,
        spin: false,
        iconClass: 'text-amber-400',
        label: `Hint ${hints.length} of 3`,
        labelClass: 'text-amber-400',
        detail: null,
      };
    return {
      Icon: MessageCircleQuestion,
      spin: false,
      iconClass: 'text-primary',
      label: 'Coach',
      labelClass: 'text-muted-foreground',
      detail: null,
    };
  })();

  // ---- Chrome shared by both layouts ---------------------------------------
  // Desktop keeps everything in the workspace column; the phone layout spreads
  // the same pieces across the column so Run/Submit and results stay reachable
  // from whichever pane is showing.

  // `grow` is the phone action bar: Run/Submit stretch (they're the primary
  // actions), Hint keeps its natural width, Assist collapses to an icon. The
  // desktop toolbar passes false everywhere and renders exactly as it always has.
  const hintButton = (grow = false) =>
    !reviewMode && (
      <Button
        variant="outline"
        size={controlSize}
        onClick={requestHint}
        disabled={hintLoading || hints.length >= 3}
        className={cn('min-w-0 gap-1.5 px-2 lg:px-3', grow && 'shrink-0')}
      >
        {hintLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Lightbulb className="h-4 w-4" />
        )}
        Hint {hints.length > 0 && `(${hints.length}/3)`}
      </Button>
    );

  // Always available — including in cold review, where the hint button is gone.
  // Two taps, and the second one costs the clean solve; the server records the
  // reveal, so the price is charged whatever the client does afterwards.
  const answerButton = (compact = false) =>
    !answer && (
      <Button
        variant={confirmReveal ? 'destructive' : 'outline'}
        size={controlSize}
        onClick={reveal}
        disabled={answerLoading}
        aria-label={
          confirmReveal
            ? 'Confirm: show the answer and mark this attempt assisted'
            : 'Show the answer (marks this attempt assisted)'
        }
        title={
          confirmReveal
            ? 'Tap again — this marks the attempt assisted, like a hint.'
            : "Show the reference solution. Counts as assistance, so it won't earn tier credit."
        }
        className={cn('min-w-0 gap-1.5 px-2 lg:px-3', compact && 'shrink-0')}
      >
        {answerLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <BookOpen className="h-4 w-4" />
        )}
        {compact ? confirmReveal && 'Sure?' : confirmReveal ? 'Sure? Counts as assisted' : 'Answer'}
      </Button>
    );

  const runSubmit = (grow = false) => (
    <>
      <Button
        variant="secondary"
        size={controlSize}
        onClick={run}
        disabled={running}
        className={cn('min-w-0 gap-1.5 px-2 lg:px-3', grow && 'flex-1')}
        title="Run sample tests (⌘/Ctrl+Enter)"
      >
        {running ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        Run
      </Button>
      <Button
        size={controlSize}
        onClick={submit}
        disabled={submitting}
        className={cn('min-w-0 gap-1.5 px-2 lg:px-3', grow && 'flex-1')}
        title="Submit against hidden tests (⌘/Ctrl+Shift+Enter)"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Send className="h-4 w-4" />
        )}
        Submit
      </Button>
    </>
  );

  const actions = (
    <>
      <EditorSettings
        settings={assistance}
        onChange={setAssistance}
        size={controlSize}
        planGate={planGate}
        onPlanGateChange={setPlanGate}
      />
      {hintButton()}
      {answerButton()}
      {runSubmit()}
    </>
  );

  const reviewNote = reviewMode && (
    <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/25 bg-rose-500/[0.07] px-4 py-1.5 text-xs text-rose-300/90">
      <Snowflake className="h-3.5 w-3.5 shrink-0 text-rose-400" />
      Cold review — no hints, solve it from scratch.
    </div>
  );

  const errorBar = error && (
    <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive-foreground">
      <div className="flex items-start gap-2">
        <span className="flex-1">{error.message}</span>
        <button
          onClick={() => setError(null)}
          aria-label="Dismiss error"
          // Negative margin keeps the 16px glyph looking the same while giving it
          // a 32px hit area.
          className="-m-2 shrink-0 p-2 opacity-70 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {/* Secondary, never deleted: the sentence above says what to do, this says
          exactly what happened for whoever is fixing their own install. */}
      {error.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
            Technical detail
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 text-[11px] leading-relaxed">
            {error.detail}
          </pre>
        </details>
      )}
    </div>
  );

  // The plan gate overlays the editor, so it inherits whatever height the editor
  // pane has — which is why the pane must never collapse to 0. The floor is
  // capped at 100% of the slot: a bare `9rem` outgrows the slot in landscape
  // with a keyboard up and paints underneath the opaque action bar.
  const editorPane = (
    <div
      className={cn(
        'relative flex-1',
        isDesktop ? 'min-h-0' : 'min-h-[min(9rem,100%)]',
      )}
      onFocus={() => setTyping(true)}
      onBlur={() => setTyping(false)}
    >
      <CodeEditor
        ref={editorRef}
        value={code}
        onChange={setCode}
        settings={assistance}
        // Off the PROBLEM, never off the active setting — flipping the language
        // while this tab is open must not re-colour or re-indent the problem
        // currently on screen, which is still graded by its own harness.
        language={problem.language}
        onRun={editorRun}
        onSubmit={editorSubmit}
      />
      {predictOpen && (
        <PlanPanel
          prediction={prediction}
          onChange={setPrediction}
          onStart={startSolving}
          onSkip={skipPredict}
          onNeverAsk={() => {
            setPlanGate(false);
            skipPredict();
          }}
          controlSize={controlSize}
        />
      )}
    </div>
  );

  const resultsBody = (
    <>
      {answer && <AnswerPanel code={answer.code} how={answer.how} />}

      {hints.length > 0 && (
        <div className="space-y-2">
          {hints.map((h) => (
            <div
              key={h.level}
              className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm"
            >
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div>
                <span className="font-semibold text-amber-400">
                  Hint {h.level}
                </span>
                <p className="mt-0.5 text-foreground/90">{h.text}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {runResult && <ResultsPanel result={runResult} mode="run" />}
      {submitResult && <ResultsPanel result={submitResult} mode="submit" />}

      {submitting && !submitResult && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Running the hidden tests…
        </div>
      )}

      {/* Scoped to the coaching section, not the screen: the verdict above is
          already final and readable while this fills in. */}
      {coachPhase === 'pending' && submitResult && (
        <div className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
          <div>
            <span className="font-semibold text-foreground">
              Coach is reading your solution…
            </span>
            <p className="mt-0.5 text-muted-foreground">
              Your results are above — this part takes a while, and you can start
              reading them now.
            </p>
          </div>
        </div>
      )}

      {coachPhase === 'lost' && !coaching && (
        <div className="rounded-xl border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          The coaching brief never arrived — your attempt was still recorded and
          the results above are final. Ask the coach below if you want to talk it
          through.
        </div>
      )}

      {coaching && <CoachPanel brief={coaching} />}

      {canAsk && (
        <CoachChat
          problem={problem}
          code={code}
          results={lastResults}
          controlSize={controlSize}
        />
      )}
    </>
  );

  // Desktop: unchanged — always expanded, capped at 46% of the column.
  const desktopResults = (hasResults || submitting) && (
    <div className="max-h-[46%] shrink-0 space-y-4 overflow-y-auto border-t border-border bg-background/60 p-4">
      {resultsBody}
    </div>
  );

  // Phone: a summary strip you can collapse to, so a stale verdict can't sit on
  // half the screen while you type. Auto-collapses when focus returns to the
  // editor; the strip itself announces the verdict.
  // A short landscape viewport has no room for this at all — it is reachable
  // again the moment the phone is upright.
  const phoneResults = !isShort && (hasResults || submitting) && (
    <div
      data-results-pane
      // The cap lives here, on a child of the fixed-height column: a percentage
      // max-height on the inner scroller would resolve against an auto-height
      // parent, i.e. not at all, and the zero-basis editor would eat the deficit.
      className={cn(
        'flex min-h-0 shrink flex-col border-t border-border bg-background/60',
        resultsOpen ? (typing ? 'max-h-[30%]' : 'max-h-[46%]') : 'shrink-0',
      )}
    >
      <button
        type="button"
        onClick={() => setResultsOpen((v) => !v)}
        aria-expanded={resultsOpen}
        className="flex min-h-11 w-full shrink-0 items-center gap-2 px-4 text-left text-xs"
      >
        <strip.Icon
          aria-hidden
          className={cn(
            'h-4 w-4 shrink-0',
            strip.iconClass,
            strip.spin && 'animate-spin',
          )}
        />
        <span
          aria-live="polite"
          className="flex min-w-0 flex-1 items-baseline gap-2"
        >
          <span className={cn('truncate font-semibold', strip.labelClass)}>
            {strip.label}
          </span>
          {strip.detail && (
            <span className="shrink-0 font-medium text-muted-foreground">
              {strip.detail}
            </span>
          )}
        </span>
        {resultsOpen ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {resultsOpen && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-border px-4 pb-4 pt-3">
          {resultsBody}
        </div>
      )}
    </div>
  );

  const footerBar = footer && (
    <div className="shrink-0 border-t border-border bg-card px-3 py-2.5">
      {footer}
    </div>
  );

  // ---- Desktop (≥ lg): the classic side-by-side split ------------------------
  if (isDesktop) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {banner}
        <div className="flex min-h-0 flex-1 flex-row">
          {/* Left — problem statement */}
          <div className="min-h-0 w-[42%] border-r border-border">
            <ProblemPanel problem={problem} />
          </div>

          {/* Right — workspace */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
              {toolbarExtras}
              <div className="ml-auto flex items-center gap-2">{actions}</div>
            </div>

            {reviewNote}
            {errorBar}
            {editorPane}
            {desktopResults}
            {footerBar}
          </div>
        </div>
      </div>
    );
  }

  // ---- Phone (< lg): Problem / Code tabs, actions pinned to the bottom -------
  // Both panes stay mounted (the editor keeps its buffer, cursor and undo stack);
  // the inactive one is display:none, which is why `pane` triggers a relayout.
  //
  // The Code tab owns the screen. Session plan, stats strip, cold-review notice
  // and "Next problem" are all *problem context* — stacked above the editor with
  // a keyboard up they left about two lines to type in. They live on the Problem
  // tab (one tap away, nothing becomes unreachable); the cold-review rule
  // survives on the Code tab as a ❄ on the tab itself.
  const onProblemTab = pane === 'problem';
  const accepted = submitResult?.verdict === 'accepted';
  // `toolbarExtras` is ambient context in grind mode (stats), but on /manual it
  // is the topic picker — the only way to choose a problem. Context gets demoted
  // below the statement; controls stay above the fold.
  const demoteExtras = toolbarExtrasKind === 'context';

  const paneTabs = (
    <>
      <PaneTab
        pane="problem"
        active={pane === 'problem'}
        onSelect={setPane}
        icon={<FileText className="h-4 w-4" />}
        label="Problem"
        compact={isShort}
      />
      <PaneTab
        pane="code"
        active={pane === 'code'}
        onSelect={setPane}
        icon={<Code2 className="h-4 w-4" />}
        label="Code"
        compact={isShort}
        badge={
          reviewMode ? (
            // A labelled pill, not a bare glyph — "cold" gives the snowflake
            // enough words to mean something on first sight; the full rule
            // lives in the aria-label/tooltip and the Problem-tab notice.
            <span
              aria-label="Cold review — no hints, solve it from scratch."
              className="ml-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-rose-300"
            >
              <Snowflake aria-hidden className="h-3 w-3 text-rose-400" />
              cold
            </span>
          ) : undefined
        }
        title={
          reviewMode
            ? 'Cold review — no hints, solve it from scratch.'
            : undefined
        }
      />
    </>
  );

  // Session/stats parked at the end of the problem scroll as collapsed
  // disclosures, so the statement itself starts near the top of the screen.
  const contextFooter = (banner || (toolbarExtras && demoteExtras)) && (
    <div className="space-y-2 border-t border-border px-4 py-4">
      {banner && <ContextDisclosure label="Session">{banner}</ContextDisclosure>}
      {toolbarExtras && demoteExtras && (
        <ContextDisclosure label="Stats">
          <div className="flex items-center gap-2 overflow-x-auto px-3 py-2.5">
            {toolbarExtras}
          </div>
        </ContextDisclosure>
      )}
    </div>
  );

  // No Tab key on a soft keyboard, so levels 1-2 (which bind Enter to a
  // non-indenting newline) have no way to indent at all, and no level can
  // dedent. These ride along in the tab row whenever the Code pane is up: that
  // row already exists, so they cost the editor zero height — a separate
  // accessory strip would have taken ~44px (nearly two lines) exactly when
  // height is scarcest. They also don't move, so the keyboard opening doesn't
  // reshuffle the controls under the user's thumb.
  // Rendered as one segmented cluster (single hairline border, inner divider,
  // quiet icons) so the row reads as "tabs + an editor tool", not four
  // unrelated buttons. Hit targets stay 44px in portrait.
  const indentKey = (direction: 1 | -1) => (
    <button
      type="button"
      // Keep focus (and the keyboard) in the editor.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editorRef.current?.indent(direction)}
      aria-label={direction > 0 ? 'Indent' : 'Dedent'}
      title={direction > 0 ? 'Indent selection' : 'Dedent selection'}
      className={cn(
        'flex items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent',
        isShort ? 'h-8 w-10' : 'h-11 w-11',
      )}
    >
      {direction > 0 ? (
        <IndentIncrease className="h-4 w-4" />
      ) : (
        <IndentDecrease className="h-4 w-4" />
      )}
    </button>
  );

  const indentKeys = (
    <div
      role="group"
      aria-label="Indentation"
      className="ml-1 flex shrink-0 items-center self-center overflow-hidden rounded-md border border-input"
    >
      {indentKey(1)}
      <div aria-hidden className="h-5 w-px bg-border" />
      {indentKey(-1)}
    </div>
  );

  // A phone in landscape with the keyboard up has ~180-250px to work with, so
  // the tab row and the action row merge into one bar — there's plenty of
  // horizontal room at that aspect ratio and no vertical room at all.
  const actionBar = (
    <div
      className={cn(
        'flex shrink-0 items-center gap-2 border-t border-border bg-card px-3',
        isShort ? 'py-1' : 'py-2',
      )}
    >
      {isShort && (
        <div className="flex shrink-0 items-center gap-1">
          {paneTabs}
          {!onProblemTab && indentKeys}
        </div>
      )}
      {/* One non-wrapping row (a `Hint (1/3)` counter can squeeze but never
          wrap it), weighted by importance: Assist collapses to an icon, Hint
          keeps its natural width, Run/Submit split the remainder — the two
          primary actions get the biggest targets instead of a flat 4-way. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <EditorSettings
          settings={assistance}
          onChange={setAssistance}
          size={controlSize}
          planGate={planGate}
          onPlanGateChange={setPlanGate}
          iconOnly
        />
        {hintButton(true)}
        {answerButton(true)}
        {runSubmit(true)}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarExtras && !demoteExtras && onProblemTab && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2">
          {toolbarExtras}
        </div>
      )}

      {!isShort && (
        <div
          role="tablist"
          aria-label="Solve panes"
          className="flex shrink-0 gap-1 border-b border-border bg-card px-2 py-1"
        >
          {paneTabs}
          {!onProblemTab && indentKeys}
        </div>
      )}

      {onProblemTab && reviewNote}
      {errorBar}

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          id="pane-problem"
          role="tabpanel"
          aria-labelledby="tab-problem"
          className={cn('min-h-0 flex-1', pane !== 'problem' && 'hidden')}
        >
          <ProblemPanel problem={problem} footer={contextFooter} />
        </div>
        {/* overflow-hidden: belt and braces so the editor can never paint
            outside its slot, whatever the floor above resolves to. */}
        <div
          id="pane-code"
          role="tabpanel"
          aria-labelledby="tab-code"
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden',
            pane !== 'code' && 'hidden',
          )}
        >
          {editorPane}
        </div>
      </div>

      {phoneResults}
      {/* "Next problem" is what you want when you're done, not a permanent band
          above the keyboard while you type — on the Code tab it appears once a
          submission is accepted. */}
      {(onProblemTab || accepted) && footerBar}
      {actionBar}
    </div>
  );
}

/**
 * The reference solution, once it is legitimately visible. `earned` follows an
 * accepted submit and costs nothing; `revealed` was asked for, and says plainly
 * that the attempt is now recorded as assisted.
 */
function AnswerPanel({
  code,
  how,
}: {
  code: string;
  how: 'earned' | 'revealed';
}) {
  const earned = how === 'earned';
  return (
    <div
      className={cn(
        'rounded-xl border p-4',
        earned
          ? 'border-emerald-500/25 bg-emerald-500/5'
          : 'border-amber-500/25 bg-amber-500/5',
      )}
    >
      <div className="flex items-center gap-2">
        <BookOpen
          className={cn(
            'h-4 w-4 shrink-0',
            earned ? 'text-emerald-400' : 'text-amber-400',
          )}
        />
        <span
          className={cn(
            'text-xs font-semibold uppercase tracking-wide',
            earned ? 'text-emerald-400' : 'text-amber-400',
          )}
        >
          Reference solution
        </span>
        <span className="text-xs text-muted-foreground">
          {earned
            ? 'you solved it — here it is'
            : 'revealed — this attempt counts as assisted'}
        </span>
      </div>
      <pre className="mt-2.5 overflow-x-auto rounded-lg border border-border bg-background/60 p-3 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Collapsed-by-default context parked under the problem statement. */
function ContextDisclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="group overflow-hidden rounded-lg border border-border bg-card/40">
      {/* Styled like the statement's EXAMPLES/CONSTRAINTS headers so these read
          as two more sections of the same page, just folded. */}
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        {label}
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}

/** One of the two phone-layout pane tabs. */
function PaneTab({
  pane,
  active,
  onSelect,
  icon,
  label,
  badge,
  title,
  compact,
}: {
  pane: Pane;
  active: boolean;
  onSelect: (pane: Pane) => void;
  icon: ReactNode;
  label: string;
  /** Trailing marker (e.g. the cold-review ❄) folded into the tab itself. */
  badge?: ReactNode;
  title?: string;
  /** Short landscape viewport: sits in the action bar, sized to match it. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${pane}`}
      aria-selected={active}
      aria-controls={`pane-${pane}`}
      title={title}
      onClick={() => onSelect(pane)}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
        compact ? 'h-8 shrink-0' : 'min-h-11 flex-1',
        active
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
      {badge}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Plan-your-attack — predict-before-solve gate overlaid on the editor.
// -----------------------------------------------------------------------------
function PlanPanel({
  prediction,
  onChange,
  onStart,
  onSkip,
  onNeverAsk,
  controlSize,
}: {
  prediction: Prediction;
  onChange: (p: Prediction) => void;
  onStart: () => void;
  onSkip: () => void;
  /** Skip this one AND stop opening the gate; reversible from Assist. */
  onNeverAsk: () => void;
  controlSize: 'sm' | 'touch';
}) {
  const touch = controlSize === 'touch';
  const set = <K extends keyof Prediction>(key: K, value: Prediction[K]) =>
    onChange({ ...prediction, [key]: value });

  return (
    <div className="absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-background/95 p-4 backdrop-blur-sm">
      <div className="mt-2 w-full max-w-lg space-y-4 rounded-xl border border-primary/25 bg-card p-5 shadow-lg">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Target className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-base font-bold">Plan your attack</h2>
            <p className="text-xs text-muted-foreground">
              Commit to a plan before you solve — it sharpens recall and
              calibrates your instincts.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-muted-foreground">
            Approach
          </label>
          <textarea
            value={prediction.approach}
            onChange={(e) => set('approach', e.target.value)}
            placeholder="One line: how will you tackle this?"
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground">
              Predicted time
            </label>
            <input
              value={prediction.predTime}
              onChange={(e) => set('predTime', e.target.value)}
              placeholder="O(n)"
              className={cn(
                'w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring',
                touch ? 'h-11' : 'h-9',
              )}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground">
              Predicted space
            </label>
            <input
              value={prediction.predSpace}
              onChange={(e) => set('predSpace', e.target.value)}
              placeholder="O(1)"
              className={cn(
                'w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring',
                touch ? 'h-11' : 'h-9',
              )}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-muted-foreground">
            Confidence
          </label>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => set('confidence', n)}
                className={cn(
                  'flex-1 rounded-md border text-sm font-semibold transition-colors',
                  touch ? 'h-11' : 'h-9',
                  prediction.confidence === n
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background text-muted-foreground hover:text-foreground',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>Guessing</span>
            <span>Certain</span>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={onStart}
            size={touch ? 'touch' : 'default'}
            className="gap-1.5"
          >
            <Play className="h-4 w-4" />
            Start solving
          </Button>
          {/* A real button, not a 22×16 text link. */}
          <Button
            variant="ghost"
            onClick={onSkip}
            size={touch ? 'touch' : 'default'}
            className="text-muted-foreground"
          >
            Skip
          </Button>
        </div>

        {/* The way out. Not a Button: "never show this again" is a decision, and
            giving it the same weight as "Start solving" invites the mis-tap that
            costs the feature. Says where to get it back in the same breath —
            an opt-out you cannot reverse is worse than the prompt it removed. */}
        <button
          type="button"
          onClick={onNeverAsk}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <EyeOff className="h-3.5 w-3.5" />
          Don&rsquo;t ask again — turn it back on under Assist
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Ask-the-coach — conversational follow-up Q&A anchored to this problem + code.
// -----------------------------------------------------------------------------
function CoachChat({
  problem,
  code,
  results,
  controlSize,
}: {
  problem: Problem;
  code: string;
  /** Last suite that ran — lets the tutor answer "why did mine fail?" from facts. */
  results: TestResult[];
  controlSize: 'sm' | 'touch';
}) {
  const touch = controlSize === 'touch';
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Fresh thread whenever the problem changes.
  useEffect(() => {
    setMessages([]);
    setInput('');
    setAsking(false);
    setError(null);
    setOpen(false);
  }, [problem.id]);

  // Keep the newest turn in view.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, asking]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || asking) return;
    setError(null);
    setAsking(true);
    const history = messages;
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setInput('');
    try {
      // Cap history to the last ~10 turns to keep the request small.
      const { answer } = await askCoach(
        problem.id,
        code,
        question,
        history.slice(-10),
        results,
      );
      setMessages((prev) => [...prev, { role: 'assistant', content: answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ask failed');
    } finally {
      setAsking(false);
    }
  }, [input, asking, messages, problem.id, code, results]);

  return (
    <div className="rounded-xl border border-border bg-muted/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left"
      >
        <MessageCircleQuestion className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Ask the coach</span>
        <span className="text-xs text-muted-foreground">
          why this approach? how would I know to reach for it?
        </span>
        {open ? (
          <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-4">
          {messages.length > 0 && (
            <div ref={threadRef} className="max-h-72 space-y-3 overflow-y-auto">
              {messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="prose-cg max-w-[90%] rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2 text-sm">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                ),
              )}
              {asking && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    Coach is thinking…
                  </div>
                </div>
              )}
            </div>
          )}

          {messages.length === 0 && !asking && (
            <p className="text-xs text-muted-foreground">
              Ask a follow-up about this problem, your code, or the pattern.
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive-foreground">{error}</p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the coach…"
              disabled={asking}
              className={cn(
                'flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50',
                touch ? 'h-11' : 'h-9',
              )}
            />
            <Button
              type="submit"
              size={touch ? 'touchIcon' : 'icon'}
              disabled={asking || !input.trim()}
              className="shrink-0"
              title="Send"
            >
              {asking ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
