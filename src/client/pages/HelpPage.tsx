// =============================================================================
// Help — the manual for someone who has never seen this app
// =============================================================================
// codegrind's best ideas are all mechanisms, and every one of them is invisible
// from the outside. You cannot tell by looking that the tests you are being
// graded against were re-derived by running the model's own reference solution;
// that the problem you were handed was chosen by arithmetic over your own
// history rather than by a model; that `mastery 42%` is three completed tiers
// away from meaning anything you would guess. A feature list would not fix any
// of that, because in each case the mechanism IS the reassurance.
//
// So this page explains how things work, in the order a new user meets them,
// and it names real numbers. Every number comes from help-facts.ts, which a test
// pins to the code it describes — see that file's header for the arrangement.
//
// Layout note, same as ProgressPage: this component is the direct child of
// `<main>` and owns its own `h-full overflow-y-auto`. Wrapping it in anything
// makes the scroller size to its content and the page clips instead of
// scrolling.

import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Quote } from 'lucide-react';
import { Card } from '@/client/components/ui/card';
import { VERDICT_META } from '@/client/components/ResultsPanel';
import { KIND_META } from '@/client/components/CoachBanner';
import {
  HELP_SECTIONS,
  helpSection,
  type HelpSectionId,
} from '@/client/lib/help-content';
import {
  ASSISTANCE_LADDER,
  DIFFICULTY_LADDER,
  MASTERY_TIERS,
  MAX_GEN_ATTEMPTS,
  MAX_HINT_LEVEL,
  MIN_HIDDEN_TESTS,
  MIN_SAMPLE_TESTS,
  REVIEW_LADDER_DAYS,
  SANDBOX_CPUS,
  SANDBOX_FLAGS,
  SANDBOX_LANGUAGES,
  SANDBOX_MEMORY,
  SANDBOX_TIMEOUT_SECONDS,
  SCHEDULER_INTENT_KINDS,
  SRS_BOX_HOURS,
  TIER_LADDER,
  TIER_REQUIREMENT,
  UNLOCK_TIER,
  VERDICTS,
  boxIntervalLabel,
  languageName,
  reviewLadderPhrase,
} from '@/client/lib/help-facts';
import { cn } from '@/lib/utils';

// -----------------------------------------------------------------------------
// Page furniture
// -----------------------------------------------------------------------------

/**
 * One section, anchored on its id.
 *
 * The id comes from HELP_SECTIONS rather than from a literal, which is what
 * makes `helpHref('numbers')` a link that cannot point at nothing: the same
 * closed set feeds the anchors, the contents list and every hint's destination,
 * and a test asserts the page renders one heading per declared section.
 */
function HelpBlock({ id, children }: { id: HelpSectionId; children: ReactNode }) {
  const section = helpSection(id);
  return (
    // scroll-mt so a deep link from a hint does not park the heading under the
    // top of the scroller.
    <section id={id} className="scroll-mt-6 space-y-3">
      <div className="space-y-1">
        <h2 className="text-xl font-bold tracking-tight">{section.title}</h2>
        <p className="text-sm text-muted-foreground">{section.summary}</p>
      </div>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

/** The one sentence a section is really about. Used sparingly — twice. */
function KeyIdea({ children }: { children: ReactNode }) {
  return (
    <Card className="flex gap-3 border-primary/25 bg-primary/[0.05] p-4">
      <Quote aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <p className="text-sm leading-relaxed text-foreground">{children}</p>
    </Card>
  );
}

/** A term/definition list. Denser than prose where the content is genuinely a table. */
function Terms({ children }: { children: ReactNode }) {
  return <dl className="space-y-2.5">{children}</dl>;
}

function Term({
  label,
  icon,
  children,
  className,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[10.5rem_1fr]">
      <dt
        className={cn(
          'flex items-center gap-1.5 font-semibold text-foreground',
          className,
        )}
      >
        {icon}
        {label}
      </dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  );
}

/** Inline code / literal values, so a flag or a field name reads as one. */
function Lit({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em] text-foreground">
      {children}
    </code>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="ml-4 list-decimal space-y-1.5 text-muted-foreground marker:text-muted-foreground/60">
      {children}
    </ol>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return (
    <ul className="ml-4 list-disc space-y-1.5 text-muted-foreground marker:text-muted-foreground/60">
      {children}
    </ul>
  );
}

// -----------------------------------------------------------------------------

export function HelpPage() {
  const { hash } = useLocation();

  // Deep links from the contextual hints arrive as `/help#numbers`. The router
  // does not scroll for us, and the scroller here is this component rather than
  // the window, so `scrollIntoView` is the only thing that works: window.scrollTo
  // would move a window that never scrolls.
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    // `auto` rather than `smooth`: arriving mid-glide from another route reads
    // as the page still loading.
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [hash]);

  const sandboxTimeouts = [
    ...new Set(SANDBOX_LANGUAGES.map((l) => SANDBOX_TIMEOUT_SECONDS[l])),
  ].sort((a, b) => a - b);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-10 p-4 pb-24 sm:p-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Help</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            codegrind writes its own interview problems with a model you choose,
            runs your code in a throwaway container, and grades it against tests
            it verified itself. This page is how all of that actually works —
            because the mechanism is the reason to trust any of it.
          </p>
        </header>

        {/* Contents. Generated from the same list that produces the anchors, so
            it cannot list a section that isn't there or miss one that is. */}
        <nav aria-label="Help contents">
          <ol className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {HELP_SECTIONS.map((s, i) => (
              <li key={s.id} className="flex gap-2 text-sm">
                <span className="tabular-nums text-muted-foreground/60">
                  {i + 1}.
                </span>
                <a
                  href={`#${s.id}`}
                  className="text-foreground underline-offset-4 hover:text-primary hover:underline"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* ==================================================================== */}
        <HelpBlock id="loop">
          <p>
            There is one thing to do here: solve problems, one after another, and
            let the app decide which ones. Everything else exists to serve that.
          </p>
          <Terms>
            <Term label="Grind">
              Sit down and be handed a problem. No topic picking, no difficulty
              picking — a scheduler reads your history and chooses. This is the
              tab to live in.
            </Term>
            <Term label="Manual">
              Pick a topic and a difficulty yourself, for when you know exactly
              what you want to drill.
            </Term>
            <Term label="Reflect">
              Where you are in the curriculum, what opens next, and whether the
              grind is working. Numbers, a prerequisite tree, and your recent
              attempts.
            </Term>
            <Term label="Study">
              A continuous reading feed of written lessons over the same
              curriculum, for when you would rather read than type.
            </Term>
            <Term label="Settings">
              Which model writes your problems, and which language you practise
              in.
            </Term>
          </Terms>
          <p>
            Inside a problem the loop is always the same: read the statement,
            write a solution, hit <strong>Run</strong> to check it against the
            visible examples, then <strong>Submit</strong> to be graded against
            hidden tests and coached on what you wrote. Hints are there if you
            want them, and they cost something specific — see{' '}
            <a href="#hints" className="text-primary underline-offset-4 hover:underline">
              Hints, the answer, and cold review
            </a>
            .
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="scheduler">
          <p>
            Every problem in Grind arrives with a label saying why you got it.
            There are {SCHEDULER_INTENT_KINDS.length} reasons, and they are the
            whole vocabulary:
          </p>
          <Terms>
            {SCHEDULER_INTENT_KINDS.map((kind) => {
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              return (
                <Term
                  key={kind}
                  label={meta.label}
                  icon={<Icon aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />}
                >
                  {INTENT_EXPLANATION[kind]}
                </Term>
              );
            })}
          </Terms>
          <KeyIdea>
            A due review outranks everything. Before any of the other five
            reasons is even scored, the scheduler checks the review queue — if
            something is waiting there, that is what you get.
          </KeyIdea>
          <p>
            Otherwise it builds a candidate for every topic that qualifies,
            scores each one from your own state (how weak the topic is, whether
            you missed it last time, how long since you touched it, whether a
            tier just opened the next rung), keeps the top four and picks one of
            them at weighted random. The randomness is why two identical-looking
            sittings do not serve the same order; the shortlist of four is why it
            never wanders.
            It also avoids serving the same topic twice in a row unless there is
            nothing else.
          </p>
          <p>
            <strong>None of this involves a model.</strong> It is arithmetic over
            your own database — free, instant, and the same with your API key
            removed. The only model call anywhere near it is the one-per-sitting
            session plan, which nudges a few topics up the ranking and cannot
            override a review.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="problems">
          <p>
            Problems are not a fixed set shipped with the app; they are written
            on demand and kept in a local bank. When the scheduler wants
            something you have never seen — a new pattern, the next difficulty,
            a fresh variation — a model writes one.
          </p>
          <p>
            The model is not asked to reply in prose. It is given a tool called{' '}
            <Lit>emit_problem</Lit> and forced to call it exactly once, with the
            statement, examples, constraints, the function name, a{' '}
            <strong>reference solution</strong>, sample tests and hidden tests.
            There is nothing to parse and nothing to go wrong in the formatting.
          </p>
          <p>
            Then comes the part that matters, and the reason the bank can be
            trusted at all. Before the problem is stored, every test is{' '}
            <strong>canonicalized</strong>:
          </p>
          <Steps>
            <li>
              The model&rsquo;s own reference solution is run in the same sandbox
              that will later run yours.
            </li>
            <li>
              Each test&rsquo;s arguments are passed to it exactly as the model
              wrote them — the inputs are never rewritten.
            </li>
            <li>
              Whatever the reference <em>returns</em> becomes the expected value.
              The model&rsquo;s hand-written expected value is discarded.
            </li>
            <li>
              Any test the reference errors on, or returns nothing usable for, is
              dropped entirely.
            </li>
          </Steps>
          <KeyIdea>
            The stored problem is self-consistent by construction: the reference
            solution always passes its own tests, because its own output is what
            the tests were built from.
          </KeyIdea>
          <p>
            This exists because models routinely author an expected value that
            disagrees with their own, correct, reference solution. It is worst on
            problems with more than one valid answer — return any valid pair,
            return the indices in any order — where the model writes one answer
            into the test and its code produces a different, equally correct one.
            Without canonicalization you write a correct solution, fail, and are
            told you are wrong by a problem that was broken before you opened it.
          </p>
          <p>
            The rule has a price and the app pays it: at least{' '}
            {MIN_SAMPLE_TESTS} sample test and {MIN_HIDDEN_TESTS} hidden tests
            must survive, or the whole problem is thrown away and regenerated, up
            to {MAX_GEN_ATTEMPTS} times. A problem whose reference cannot run is
            never served — in every language but JavaScript, generation fails
            loudly rather than storing something no one could solve.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="run-submit">
          <Terms>
            <Term label="Run">
              Runs the <strong>sample tests</strong> — the ones printed in the
              problem statement. No model is called, nothing is recorded, and
              nothing about your progress moves. Use it as much as you like.
            </Term>
            <Term label="Submit">
              Runs the <strong>hidden tests</strong>. This is the one that
              counts: it writes an attempt, updates your tier credits, your
              spaced repetition and the review queue, and sends your code to the
              coach for a written brief.
            </Term>
          </Terms>
          <p>
            A failed submit shows you the test name, <em>your</em> output and any
            error — everything about what your code did — but never the expected
            value. That is deliberate: printing the hidden answers would be
            enough to hardcode a pass, and enough to turn your second attempt
            into a copying exercise. The value is stripped from the server&rsquo;s
            response, not merely hidden on screen. Solve it and the reference
            solution is handed to you immediately.
          </p>
          <p>Both end in one of {VERDICTS.length} verdicts:</p>
          <Terms>
            {VERDICTS.map((verdict) => {
              const meta = VERDICT_META[verdict];
              const Icon = meta.icon;
              return (
                <Term
                  key={verdict}
                  label={meta.label}
                  className={meta.textClass}
                  icon={<Icon aria-hidden className="h-3.5 w-3.5" />}
                >
                  {VERDICT_EXPLANATION[verdict]}
                </Term>
              );
            })}
          </Terms>
          <p>
            <strong>Compile Error is its own verdict on purpose.</strong> The
            runner reports how far it got — did the source parse, did it load,
            did your function actually get called — and only Compile Error means
            no test was ever run. &ldquo;This never became runnable code&rdquo; is
            a different thing to be told than &ldquo;your code ran and got the
            wrong answer&rdquo;, and the three languages express it in three
            unrelated ways (a JavaScript <Lit>SyntaxError</Lit>, a Python{' '}
            <Lit>IndentationError</Lit>, a Go compiler diagnostic), so the runner
            is the only layer that can tell them apart.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="hints">
          <p>
            Hints come in {MAX_HINT_LEVEL} levels, and you climb them one at a
            time — each press gives you the next rung, never a bigger jump.
          </p>
          <Terms>
            <Term label="Hint 1">
              Names the pattern to consider and why the problem points at it.
              No algorithm.
            </Term>
            <Term label="Hint 2">
              The key insight — the trick that unlocks the approach — still
              without writing the solution.
            </Term>
            <Term label="Hint 3">
              A short outline of the approach, step by step. Still no complete
              code and no full function body. There is no rung above this one.
            </Term>
          </Terms>
          <p>
            Taking a hint has one specific consequence:{' '}
            <strong>
              that problem can no longer earn tier credit, and it goes into the
              review queue
            </strong>
            . It does not fail you, it does not hide your verdict, and it does
            not follow you around. It means the problem comes back later, cold.
          </p>
          <p>
            The <strong>Answer</strong> button is separate and always available,
            including in review. It takes two taps — the first states the price,
            the second pays it — because nobody should give up a clean solve to a
            mis-tap next to Hint. The charge is recorded on the server the moment
            you ask, so reloading the page, closing the tab or clearing storage
            does not undo it: the attempt is counted as assisted exactly like a
            hint.
          </p>
          <p>
            A problem you missed or leaned on comes back as a{' '}
            <strong>cold review</strong>, and in that mode the Hint button is
            gone. That is the point of the exercise: the question being asked is
            whether you can now do it unaided, and a hint would answer a
            different question. Solve it clean and it leaves the queue for good.
            Miss it again and it is pushed further out — {reviewLadderPhrase()}{' '}
            between attempts.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="numbers">
          <KeyIdea>
            One tier credit = one <strong>distinct</strong> problem solved with{' '}
            <strong>zero hints</strong>. {TIER_REQUIREMENT} credits complete a
            tier.
          </KeyIdea>
          <p>
            Credits are counted per problem, not per submission: re-submitting a
            solution that already passes earns nothing. Tiers are cumulative —{' '}
            {TIER_LADDER.join(' → ')} — so {TIER_REQUIREMENT} clean medium solves
            with an unfinished easy tier still leaves you at{' '}
            <Lit>{TIER_LADDER[0]}</Lit>. The difficulty you are served is
            whichever tier you are currently working on, and at the top of the
            ladder it stays there and keeps counting, which is why a topic can
            read <Lit>expert ×7</Lit>.
          </p>
          <Terms>
            <Term label="Mastery">
              A display number, nothing more. It is completed tiers plus your
              progress toward the next, over {MASTERY_TIERS} — so a quarter of a
              bar is exactly one completed tier. Nothing in the app gates on it;
              unlocking and difficulty both compare tiers.
            </Term>
            <Term label="Tiers cleared">
              Every tier ever completed, summed over all {DIFFICULTY_LADDER.length}{' '}
              difficulties and every topic. The one number with no ceiling.
            </Term>
            <Term label="Hint-free">
              The share of your <em>submissions</em> made without a hint or a
              reveal — failed ones included. It is not a solve rate.
            </Term>
            <Term label="Review due">
              How many problems are waiting in the review queue right now. The
              scheduler serves them before anything else.
            </Term>
            <Term label="Skill tree">
              A topic unlocks when at least one of its prerequisites has
              completed the <Lit>{UNLOCK_TIER}</Lit> tier. The four roots —
              arrays, hashing, math and bit manipulation — have no prerequisites
              and are open from the first minute.
            </Term>
          </Terms>
          <p>
            Two separate clocks decide when things come back, and they are easy
            to confuse:
          </p>
          <Terms>
            <Term label="Review queue">
              Per <strong>problem</strong>. A missed or hinted problem is queued
              due immediately; each further miss pushes it out on a{' '}
              {REVIEW_LADDER_DAYS.map((d) => `${d}d`).join(' → ')} ladder. A clean
              unaided solve clears it.
            </Term>
            <Term label="Repetition boxes">
              Per <strong>topic</strong>. Clean solves move a topic up through
              boxes of{' '}
              {SRS_BOX_HOURS.map((h) => boxIntervalLabel(h)).join(', ')}; a miss
              pulls it back. When a topic falls overdue, the scheduler starts
              biasing toward reinforcing it.
            </Term>
          </Terms>
          <p>
            <strong>Reflect shows one language at a time</strong> — the active
            one. Solved, tiers cleared, hint-free, review due and the whole tree
            are that language&rsquo;s own. Two numbers are not: lessons read (the
            Study corpus is shared, so a lesson you read is read) and your day
            streak (practising one language yesterday and another today is two
            consecutive days of practice, not two broken streaks).
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="assistance">
          <p>
            The <strong>Assist</strong> control reconfigures the editor across
            four presets, and any of its six individual switches can be flipped
            on top of one (which shows as <em>Custom</em>):
          </p>
          <Terms>
            {ASSISTANCE_LADDER.map((rung) => (
              <Term key={rung.level} label={`${rung.level}. ${rung.label}`}>
                {rung.blurb}
              </Term>
            ))}
          </Terms>
          <p>
            It exists because interviews are not run under one set of conditions.
            A phone screen might be a shared text pad with no highlighting, no
            autocomplete and no bracket matching; an onsite might hand you a
            laptop with your own IDE on it. If you only ever practise at the top
            rung, the first time you write code without autocomplete is the time
            it counts.
          </p>
          <p>
            The setting changes the editor and nothing else. It is stored in your
            browser, it is not recorded against your attempts, and it has no
            effect on grading, hints or tier credit.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="sandbox">
          <p>
            Every Run and every Submit starts a fresh Docker container, runs your
            code inside it, and destroys it. Nothing is reused between
            submissions, and your code never executes on the host.
          </p>
          <Bullets>
            <li>
              <Lit>{SANDBOX_FLAGS[0]}</Lit> — no network interface at all.
              Nothing your code does can reach the internet, your machine, or the
              app&rsquo;s own database.
            </li>
            <li>
              <Lit>{SANDBOX_FLAGS[1]}</Lit> — the filesystem is read-only. The
              only writable surface is a small in-memory <Lit>/tmp</Lit> that
              disappears with the container.
            </li>
            <li>
              <Lit>{SANDBOX_FLAGS[2]}</Lit> and <Lit>{SANDBOX_FLAGS[3]}</Lit> —
              every Linux capability dropped, and no way to acquire more.
            </li>
            <li>
              Your source and the test data are mounted read-only; the container
              runs as an unprivileged user.
            </li>
            <li>
              {SANDBOX_CPUS} CPU and a hard memory ceiling (
              {SANDBOX_LANGUAGES.map(
                (l) => `${SANDBOX_MEMORY[l]} for ${languageName(l)}`,
              ).join(', ')}
              ), plus a process-count limit.
            </li>
            <li>
              A hard wall-clock kill at {sandboxTimeouts.join('–')} seconds
              depending on the language, followed by a forced removal of the
              container.
            </li>
          </Bullets>
          <p>
            So an infinite loop is not a problem you have to be careful about. It
            runs for a few seconds on one core, gets killed, and comes back as{' '}
            <strong>{VERDICT_META.timeout.label}</strong>. Write the naive
            version, submit it, and find out.
          </p>
          <p className="text-muted-foreground">
            Languages with a runner in this build:{' '}
            {SANDBOX_LANGUAGES.map(languageName).join(', ')}. Java is recognised
            but deliberately has no runner here, so it cannot be selected.
          </p>
        </HelpBlock>

        {/* ==================================================================== */}
        <HelpBlock id="models">
          <p>
            codegrind is not tied to one vendor. It talks to Anthropic, or to any
            OpenAI-compatible endpoint — including a model running on your own
            hardware with no API key at all. The one hard requirement is that the
            endpoint can be <em>forced</em> to call a tool, because almost every
            call this app makes is a forced tool call rather than a request for
            prose.
          </p>
          <p>There are two jobs, routed independently:</p>
          <Terms>
            <Term label="The workhorse">
              Writes problems, hints, session plans, pattern primers and Study
              lessons, and grades your submissions. Most of the calls, and all
              of the long ones.
            </Term>
            <Term label="The coach">
              Answers your follow-up questions in the chat below a submission.
              One call per question you actually ask.
            </Term>
          </Terms>
          <p>
            They can point at different models, and on Anthropic they do by
            default — the coach defaults to the larger, pricier model, on the
            grounds that it is the conversation you judge the app by. Settings
            shows the routing that is actually in effect and offers to point the
            coach at the workhorse&rsquo;s model instead. Run both on a local
            endpoint and there is no second bill and no second behaviour.
          </p>
          <KeyIdea>
            Every model call is something you clicked. Nothing polls, nothing runs
            on a timer, and an idle tab costs nothing.
          </KeyIdea>
          <p>
            Choosing your next problem, the tier ladder, everything on Reflect
            and running your code are all free — no model is involved in any of
            them. The expensive click is <strong>Next problem</strong> when the
            bank has nothing suitable and one has to be written: that is tens of
            seconds on a hosted model and can be several minutes on a local one,
            which is why the button tells you which kind of wait you are in.
          </p>
        </HelpBlock>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Copy that is keyed on a closed vocabulary
// -----------------------------------------------------------------------------
// These two maps are `Record<Union, string>`, which is the point: add a verdict
// or an intent kind and the compiler demands a sentence for it here. The labels
// and icons are NOT repeated — those come from VERDICT_META and KIND_META, the
// same constants the results panel and the coach banner draw with, so Help can
// never call a chip by a name the app does not use.

const INTENT_EXPLANATION: Record<(typeof SCHEDULER_INTENT_KINDS)[number], string> = {
  review:
    'A problem you missed or took help on, served cold. This one jumps the queue ahead of everything else.',
  'warm-up':
    'A topic you are solid on, one difficulty below where you are working. Something to get moving on.',
  reinforce:
    'A topic that is weak, that you missed last time, or that spaced repetition says is overdue.',
  variation:
    'The same technique as something you just solved, in a shape you have not seen. Always freshly written.',
  'level-up':
    'You just completed a tier on this topic, so the next difficulty starts here.',
  'new-pattern':
    'A topic you have never attempted, now that a prerequisite has completed its tier. Arrives with a primer.',
};

const VERDICT_EXPLANATION: Record<(typeof VERDICTS)[number], string> = {
  accepted: 'Every test passed.',
  wrong_answer:
    'Your code ran fine and returned the wrong thing for at least one test.',
  runtime_error: 'Your code threw an exception part-way through.',
  compile_error:
    'The source never became runnable code, so no test was called at all.',
  timeout:
    'The sandbox killed it for running too long — usually an infinite loop, sometimes an algorithm too slow for the constraints.',
  error:
    'The sandbox itself could not run anything. This one is about the install, not about your code.',
};
