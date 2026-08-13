import Anthropic from '@anthropic-ai/sdk';
import {
  TOPICS,
  MISTAKE_TAGS,
  LESSON_KINDS,
  type ProblemRecord,
  type CoachingBrief,
  type Hint,
  type HintLevel,
  type Topic,
  type Difficulty,
  type TierLevel,
  type TestCase,
  type Example,
  type TestResult,
  type SessionPlan,
  type ChatTurn,
  type Prediction,
  type Primer,
  type Lesson,
  type LessonKind,
  type TrackOutlineItem,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Anthropic client — lazily constructed so importing this module never requires
// a key (e.g. for type-only usage or when the sandbox path is exercised alone).
// ---------------------------------------------------------------------------
/**
 * Two models, split by what the call is for.
 *
 * `ANTHROPIC_MODEL` is the workhorse: generation, forced-tool-use extraction,
 * lesson writing, and the per-submit coaching brief — everything that runs on
 * a schedule the user doesn't control.
 *
 * `ANTHROPIC_CHAT_MODEL` is the teaching model, used by `askFollowup` alone:
 * one call per question actually asked, the lowest-frequency and
 * highest-value call in the app, and the one where the model has to reason
 * about *how to explain* before it answers. `coach` is the other teaching call
 * but fires on every submit, so it stays on the workhorse model and buys its
 * quality with thinking instead — see the note at that call site.
 *
 * NOTE on thinking: on both defaults below, omitting `thinking` runs ADAPTIVE
 * thinking, and `max_tokens` caps thinking + visible text together. Every call
 * site in this file therefore sets `thinking` explicitly — `disabled` for the
 * cheap forced-tool-use calls where reasoning adds nothing and would eat the
 * budget, `adaptive` for the two teaching calls (`coach`, `askFollowup`).
 */
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-opus-5';

/** Forced-tool-use calls get nothing from thinking; keep the whole budget for output. */
const NO_THINKING = { type: 'disabled' } as const satisfies Anthropic.ThinkingConfigParam;
/** Teaching calls reason about how to explain before they answer. */
const ADAPTIVE_THINKING = { type: 'adaptive' } as const satisfies Anthropic.ThinkingConfigParam;

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set — provision it via bin/inject.');
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/** Pull the single forced tool_use block out of a response, or throw. */
function extractToolInput(
  response: Anthropic.Message,
  toolName: string
): Record<string, unknown> {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === toolName
  );
  if (!toolUse) {
    throw new Error(`Claude did not call ${toolName} as expected.`);
  }
  return (toolUse.input ?? {}) as Record<string, unknown>;
}

// ===========================================================================
// 1. generateProblem
// ===========================================================================
const GENERATE_SYSTEM = `You are an expert interview coach and problem author. You produce ONE self-contained LeetCode-style coding problem for a candidate practicing interview patterns in JavaScript.

Hard requirements — the problem MUST be auto-gradeable:
- The solution is a single PURE, DETERMINISTIC JavaScript function. No I/O, no randomness, no Date/network, no global state.
- Provide a clear function signature via starterCode: a named function declaration with the right parameters and an empty body (or a "// your code here" comment and a reasonable default return). Use plain JS (no TypeScript types).
- The exported/tested function name must exactly match the name in starterCode.
- Every test is { name, args, expected } where args is the ARGUMENT LIST (array) spread into the function, and expected is the exact return value (deep-equal compared). Inputs and outputs must be JSON-serializable (numbers, strings, booleans, null, arrays, plain objects).
- Provide 2-3 visible sampleTests and 8-12 hiddenTests. Hidden tests MUST cover edge cases (empty input, single element, duplicates, negatives, boundaries, large-but-deterministic cases) beyond the samples.
- referenceSolution is COMPLETE, CORRECT JavaScript defining the same function name; it must pass every sample and hidden test. Return ONLY the function definition(s), no surrounding prose or exports.
- The prompt is Markdown: a concise problem statement. examples[] are human-readable illustrations. constraints[] are short bullet strings.
- pattern is the underlying algorithmic pattern tag (e.g. "two-pointer", "sliding-window", "hashing", "binary-search", "dynamic-programming").

Match the requested topic and difficulty. Keep it crisp and fair — the kind of question that actually shows up in interviews. Return your problem by calling the emit_problem tool exactly once.`;

const EMIT_PROBLEM_TOOL: Anthropic.Tool = {
  name: 'emit_problem',
  description: 'Emit one complete, auto-gradeable coding problem.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short problem title.' },
      prompt: { type: 'string', description: 'Full problem statement in Markdown.' },
      pattern: { type: 'string', description: 'Underlying algorithmic pattern tag.' },
      examples: {
        type: 'array',
        description: 'Human-readable illustrative examples.',
        items: {
          type: 'object',
          properties: {
            input: { type: 'string' },
            output: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['input', 'output'],
        },
      },
      constraints: {
        type: 'array',
        description: 'Short constraint bullet strings.',
        items: { type: 'string' },
      },
      functionName: {
        type: 'string',
        description: 'The exact function name the tests call (must match starterCode).',
      },
      starterCode: {
        type: 'string',
        description: 'JS starter: named function signature with an empty/stub body.',
      },
      sampleTests: {
        type: 'array',
        description: '2-3 visible test cases.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            args: { type: 'array', description: 'Argument list spread into the function.' },
            expected: {},
          },
          required: ['name', 'args', 'expected'],
        },
      },
      hiddenTests: {
        type: 'array',
        description: '8-12 hidden edge-case test cases.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            args: { type: 'array' },
            expected: {},
          },
          required: ['name', 'args', 'expected'],
        },
      },
      referenceSolution: {
        type: 'string',
        description: 'Complete correct JS defining functionName; passes all tests.',
      },
    },
    required: [
      'title',
      'prompt',
      'pattern',
      'examples',
      'constraints',
      'functionName',
      'starterCode',
      'sampleTests',
      'hiddenTests',
      'referenceSolution',
    ],
  },
};

function coerceTests(raw: unknown): TestCase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t, i) => {
      const tt = (t ?? {}) as Record<string, unknown>;
      const args = Array.isArray(tt.args) ? tt.args : [];
      const name = typeof tt.name === 'string' && tt.name.trim() ? tt.name : `test_${i + 1}`;
      return { name, args, expected: tt.expected };
    })
    .filter((t): t is TestCase => Array.isArray(t.args));
}

function coerceExamples(raw: unknown): Example[] {
  if (!Array.isArray(raw)) return [];
  const out: Example[] = [];
  for (const e of raw) {
    const ee = (e ?? {}) as Record<string, unknown>;
    const input = typeof ee.input === 'string' ? ee.input : '';
    const output = typeof ee.output === 'string' ? ee.output : '';
    if (!input && !output) continue;
    out.push({
      input,
      output,
      explanation: typeof ee.explanation === 'string' ? ee.explanation : undefined,
    });
  }
  return out;
}

function coerceStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string');
}

export interface GeneratedProblem {
  title: string;
  prompt: string;
  pattern: string;
  examples: Example[];
  constraints: string[];
  functionName: string;
  starterCode: string;
  sampleTests: TestCase[];
  hiddenTests: TestCase[];
  referenceSolution: string;
}

/** Options that steer generation toward variations / novelty / no repeats. */
export interface GenerateProblemOpts {
  /** Drill the SAME core technique as this solved problem, in a new scenario. */
  variationOf?: { title: string; pattern: string; prompt?: string };
  /** Titles the new problem must not reuse. */
  avoidTitles?: string[];
  /** Extra freeform steer (e.g. "introduce this pattern gently at easy"). */
  noveltyHint?: string;
}

// ---------------------------------------------------------------------------
// Per-difficulty rubric. Appended to the USER message, not the cached system
// prompt, so adding a rung never invalidates the prompt cache.
//
// `expert` is the whole reason the tier exists. Without a rubric the model
// writes a hard problem with a bigger `n` and calls it expert, which would make
// the top of the ladder a lie. The three demands below — composition, a
// non-obvious reduction, and constraints that actually force the complexity —
// are what separate it from `hard`, and the hidden tests are asked to be
// adversarial rather than merely thorough.
//
// `hard` needs a rubric for the mirror-image reason: unbriefed, the model
// reaches for composition here too, and a first hard-tier problem that demands
// two unfamiliar techniques at once (binary-search-on-the-answer AND an O(n)
// counting trick) teaches neither. Hard is ONE hard idea, carefully
// implemented; composition is what `expert` is for.
// ---------------------------------------------------------------------------
const DIFFICULTY_BRIEF: Partial<Record<Difficulty, string>> = {
  hard: `This is a HARD problem — one rung below expert. Hard means ONE hard idea, implemented carefully. Every one of these must hold:

- EXACTLY ONE HARD IDEA: the intended solution turns on a single non-obvious insight — one reduction, one invariant, one data structure used in a way the candidate hasn't had to reach for before. The difficulty comes from seeing that idea and implementing it correctly, not from how many ideas are stacked.
- DO NOT COMPOSE TWO UNFAMILIAR TECHNIQUES: composition is what makes a problem EXPERT, and it is the wrong shape here. Never require the candidate to discover two techniques they have not met before and make them cooperate — e.g. binary-search-over-the-answer wrapped around an O(n) two-pointer counting trick is two hard ideas at once, and at this rung it is brutal rather than instructive. If the intended solution needs a second technique, that second technique must be a routine one they already own (a sort, a hash map, a prefix sum), used in the ordinary way.
- CAREFUL IMPLEMENTATION IS PART OF THE DIFFICULTY: bounds, tie-breaks, the update order inside the loop, the degenerate cases. A correct idea implemented sloppily should fail the hidden tests.
- CONSTRAINTS THAT RULE OUT BRUTE FORCE: put concrete numeric bounds in constraints[] chosen so the naive approach is definitively too slow and the intended complexity survives.
- DEPTH, NOT BULK: one idea plus careful implementation. Never several easy sub-tasks stapled together, never a multi-part "also return X" chore. The statement stays short; the thinking is what is long.

hiddenTests must probe the implementation of that one idea: the exact boundary where an off-by-one flips the answer, ties and duplicates, and the degenerate cases (empty, single element, all-identical, sorted, reverse-sorted). referenceSolution must be the intended solution, not a brute force.`,

  expert: `This is an EXPERT problem — the top rung of the ladder. A hard problem with bigger inputs is NOT expert. Every one of these must hold:

- COMPOSITION: the intended solution must combine AT LEAST TWO distinct techniques that have to cooperate — e.g. binary search on the answer wrapped around a greedy feasibility check; a monotonic stack whose output feeds a prefix-sum sweep; hashing to canonicalize plus a two-pointer invariant to scan; sorting by one key while maintaining a heap on another. One textbook pattern applied cleanly is a MEDIUM problem. Do not write that.
- A NON-OBVIOUS REDUCTION: the first idea a strong candidate reaches for should be the WRONG one. The intended approach should turn on a reframing — an invariant, counting complements instead of matches, processing in an unexpected order, transforming to differences/prefix space, or solving the dual. The prompt must make the reduction discoverable but must never state it.
- CONSTRAINTS THAT FORCE THE OPTIMAL COMPLEXITY: put concrete numeric bounds in constraints[] (e.g. "1 <= n <= 2*10^5", "|values| <= 10^9") chosen so the obvious brute force is definitively too slow and only the intended complexity survives. The bounds are a filter, not decoration — pick them deliberately.
- DEPTH, NOT BULK: exactly one hard idea plus careful implementation. Never several easy sub-tasks stapled together, never a multi-part "also return X" chore. The statement stays short; the thinking is what is long.

hiddenTests must be ADVERSARIAL — aimed at the plausible-but-wrong solutions, not just at coverage. Include, at minimum:
- a case where the natural greedy/one-pass answer is wrong but looks right on the examples
- ties and duplicates where an unstable comparator or a >= vs > choice flips the result
- the exact boundary where an off-by-one in the reduction changes the answer
- degenerate structure: empty, single element, all-identical, strictly increasing, strictly decreasing, all-negative
- integer edges that stay inside JS safe-integer range (near ±2^31 and well inside ±(2^53-1)); never rely on overflow and never emit a value that loses precision
- one larger structured case of AT MOST ~200 elements, written out explicitly in args (it must stay JSON-serializable), built from a rule that punishes an accidental O(n^2) or a wrong tie-break. Keep it to 200: the whole problem is emitted as literal JSON in a single tool call, and a few thousand elements would truncate the response and throw the problem away. Punish wrong solutions structurally, not by sheer size

referenceSolution must be the INTENDED optimal solution, not a brute force, and the whole hidden suite must run comfortably inside a few seconds.`,
};

function buildGenerateUserMessage(
  topic: Topic,
  difficulty: Difficulty,
  opts?: GenerateProblemOpts
): string {
  let msg = `Create one ${difficulty} problem for the topic/pattern "${topic}". Make it self-contained and deterministic so it can be auto-graded.`;
  const brief = DIFFICULTY_BRIEF[difficulty];
  if (brief) msg += `\n\n${brief}`;
  if (opts?.variationOf) {
    msg += `\n\nThis should be a VARIATION that drills the SAME core technique as the problem titled "${opts.variationOf.title}" (pattern: ${opts.variationOf.pattern}) — but in a genuinely new scenario/shape (different framing, inputs, or domain), NOT a reworded copy.`;
    if (opts.variationOf.prompt) {
      msg += `\nFor reference, that problem's statement was:\n"""\n${opts.variationOf.prompt}\n"""\nDo NOT reuse its story or structure — only the underlying technique.`;
    }
  }
  if (opts?.avoidTitles && opts.avoidTitles.length) {
    msg += `\n\nDo NOT reuse any of these existing titles (pick a clearly different title and scenario): ${opts.avoidTitles
      .map((t) => `"${t}"`)
      .join(', ')}.`;
  }
  if (opts?.noveltyHint) {
    msg += `\n\n${opts.noveltyHint}`;
  }
  return msg;
}

export async function generateProblem(
  topic: Topic,
  difficulty: Difficulty,
  opts?: GenerateProblemOpts
): Promise<GeneratedProblem> {
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // A problem carries its whole hidden test suite as literal JSON, so the
    // output is far larger than any other call here. At 8000 a big adversarial
    // suite gets cut off mid-array and lands as "missing hidden tests".
    max_tokens: 16000,
    // Disabled deliberately: the whole output is one forced tool call of
    // literal JSON, and thinking here would compete with the test suite for
    // the same 16000 tokens — the exact truncation this budget exists to avoid.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: GENERATE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_PROBLEM_TOOL],
    tool_choice: { type: 'tool', name: 'emit_problem' },
    messages: [
      {
        role: 'user',
        content: buildGenerateUserMessage(topic, difficulty, opts),
      },
    ],
  });

  // Truncation is the single most likely generation failure, and without this
  // check it surfaces as a confusing downstream "missing tests" error. Name it
  // so the retry in bank.service logs the real cause.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `Generation truncated at max_tokens (${difficulty}/${topic}) — the emitted problem was cut off mid-tool-call.`
    );
  }

  const input = extractToolInput(response, 'emit_problem');

  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled Problem';
  const functionName =
    typeof input.functionName === 'string' && input.functionName.trim()
      ? input.functionName.trim()
      : 'solve';
  const starterCode =
    typeof input.starterCode === 'string' && input.starterCode.trim()
      ? input.starterCode
      : `function ${functionName}() {\n  // your code here\n}`;
  const referenceSolution =
    typeof input.referenceSolution === 'string' ? input.referenceSolution : '';

  const sampleTests = coerceTests(input.sampleTests);
  const hiddenTests = coerceTests(input.hiddenTests);

  if (sampleTests.length === 0 || hiddenTests.length === 0) {
    throw new Error('Generated problem is missing sample or hidden tests.');
  }
  if (!referenceSolution.trim()) {
    throw new Error('Generated problem is missing a reference solution.');
  }

  return {
    title,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    pattern: typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : topic,
    examples: coerceExamples(input.examples),
    constraints: coerceStrings(input.constraints),
    functionName,
    starterCode,
    sampleTests,
    hiddenTests,
    referenceSolution,
  };
}

// ===========================================================================
// 2. coach
// ===========================================================================
const COACH_SYSTEM = `You are a direct, encouraging technical interview coach. A candidate just submitted a JavaScript solution which was run against real hidden tests. You are given the problem, the reference solution, the candidate's code, and the ACTUAL per-test results.

Your job: a structured coaching brief focused on INTERVIEW PATTERN MASTERY.
- approach: paraphrase what the candidate's code actually does, in plain language. Be accurate about their real approach.
- missed: concrete things they got wrong or overlooked. TIE each item to the specific failing test(s) and the root cause. If everything passed, note remaining risks or edge cases they handled implicitly. Empty array only if truly flawless.
- pattern: name the underlying pattern this problem tests.
- patternRecognition: how to RECOGNIZE this pattern in a future problem — the signals/cues an interviewer plants. This is the most valuable part.
- complexity: the candidate's time & space complexity ("yours") vs the optimal ("optimal"), each as a short string like "O(n^2) time, O(1) space".
- improvement: one short, direct nudge on how to get better at this pattern.
- mistakeTags: choose ZERO OR MORE tags describing the recurring failure modes this submission shows, chosen ONLY from this fixed vocabulary: ${MISTAKE_TAGS.join(', ')}. Return an EMPTY array if the solution was clean. Do NOT invent tags outside this list.
- calibration: ONLY when the candidate provided a pre-solve prediction (given below). Write one short sentence comparing their PREDICTED approach/time/space against what their code ACTUALLY does — name the gap plainly (e.g. "You predicted O(n) but your nested scan is O(n^2)"). If they were right, affirm it briefly. If no prediction was provided, return an empty string.

Be specific and honest. Reference the real test names and outcomes. Call emit_coaching exactly once.`;

const EMIT_COACHING_TOOL: Anthropic.Tool = {
  name: 'emit_coaching',
  description: 'Emit the structured coaching brief.',
  input_schema: {
    type: 'object',
    properties: {
      approach: { type: 'string' },
      missed: { type: 'array', items: { type: 'string' } },
      pattern: { type: 'string' },
      patternRecognition: { type: 'string' },
      complexity: {
        type: 'object',
        properties: {
          yours: { type: 'string' },
          optimal: { type: 'string' },
        },
        required: ['yours', 'optimal'],
      },
      improvement: { type: 'string' },
      mistakeTags: {
        type: 'array',
        description: `Recurring failure-mode tags, chosen ONLY from: ${MISTAKE_TAGS.join(', ')}. Empty if clean.`,
        items: { type: 'string', enum: MISTAKE_TAGS as unknown as string[] },
      },
      calibration: {
        type: 'string',
        description:
          'Predicted-vs-actual complexity/approach note when a prediction was provided; empty string otherwise.',
      },
    },
    required: ['approach', 'missed', 'pattern', 'patternRecognition', 'complexity', 'improvement'],
  },
};

/** Keep only tags in the fixed vocabulary (defensive — the schema also constrains). */
const MISTAKE_TAG_SET = new Set<string>(MISTAKE_TAGS as readonly string[]);
function coerceMistakeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === 'string' && MISTAKE_TAG_SET.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function summarizeResults(results: TestResult[]): string {
  return results
    .map((r) => {
      const status = r.passed ? 'PASS' : 'FAIL';
      const parts = [`- [${status}] ${r.name} (${r.timeMs}ms)`];
      if (!r.passed) {
        if (r.expected !== undefined) parts.push(`    expected: ${r.expected}`);
        if (r.actual !== undefined) parts.push(`    actual:   ${r.actual}`);
        if (r.stderr) parts.push(`    error:    ${r.stderr}`);
      }
      return parts.join('\n');
    })
    .join('\n');
}

export async function coach(
  problem: ProblemRecord,
  userCode: string,
  results: TestResult[],
  prediction?: Prediction
): Promise<CoachingBrief> {
  const anthropic = getAnthropic();
  const passed = results.filter((r) => r.passed).length;

  const predictionBlock = prediction
    ? `\n\nCANDIDATE'S PRE-SOLVE PREDICTION (compare against their actual code for the calibration field):
- intended approach: ${prediction.approach || '(none given)'}
- predicted time: ${prediction.predTime || '(none)'}
- predicted space: ${prediction.predSpace || '(none)'}
- confidence: ${prediction.confidence}/5`
    : '';

  const userMessage = `PROBLEM: ${problem.title} (pattern: ${problem.pattern}, difficulty: ${problem.difficulty})

Statement:
${problem.prompt}

Function under test: ${problem.functionName}

REFERENCE SOLUTION:
\`\`\`javascript
${problem.referenceSolution}
\`\`\`

CANDIDATE'S SUBMISSION:
\`\`\`javascript
${userCode}
\`\`\`

TEST RESULTS (${passed}/${results.length} passed):
${summarizeResults(results)}${predictionBlock}`;

  const response = await anthropic.messages.create({
    // Teaching call, but it fires on EVERY submit — so it stays on the
    // workhorse model and pays for thinking rather than for the bigger model.
    // (askFollowup fires only when the candidate actually asks, which is why
    // that one gets ANTHROPIC_CHAT_MODEL.) If coaching quality disappoints,
    // switching this to ANTHROPIC_CHAT_MODEL is the whole change.
    model: ANTHROPIC_MODEL,
    // 2500 was sized for a thinking-off model. With adaptive thinking the
    // budget covers thinking + the brief, so a tight cap truncates the tool
    // call mid-JSON and the whole brief is lost.
    max_tokens: 8000,
    thinking: ADAPTIVE_THINKING,
    system: [{ type: 'text', text: COACH_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_COACHING_TOOL],
    tool_choice: { type: 'tool', name: 'emit_coaching' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const input = extractToolInput(response, 'emit_coaching');
  const complexity = (input.complexity ?? {}) as Record<string, unknown>;

  const brief: CoachingBrief = {
    approach: typeof input.approach === 'string' ? input.approach : '',
    missed: coerceStrings(input.missed),
    pattern: typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern : problem.pattern,
    patternRecognition: typeof input.patternRecognition === 'string' ? input.patternRecognition : '',
    complexity: {
      yours: typeof complexity.yours === 'string' ? complexity.yours : 'unknown',
      optimal: typeof complexity.optimal === 'string' ? complexity.optimal : 'unknown',
    },
    improvement: typeof input.improvement === 'string' ? input.improvement : '',
    mistakeTags: coerceMistakeTags(input.mistakeTags),
  };
  // calibration only surfaces when a prediction was in play and the coach wrote one.
  if (prediction) {
    const cal = typeof input.calibration === 'string' ? input.calibration.trim() : '';
    if (cal) brief.calibration = cal;
  }
  return brief;
}

// ===========================================================================
// 3. hint
// ===========================================================================
const HINT_SYSTEM = `You are an interview coach giving a PROGRESSIVE hint. You are given the problem, the candidate's current code, and a hint level. NEVER reveal the full solution.

Level scoping (respect it strictly):
- Level 1: only name/point at which PATTERN to consider and why the problem hints at it. No algorithm.
- Level 2: the key INSIGHT that unlocks the approach (the trick), still without writing the solution.
- Level 3: a short APPROACH OUTLINE — the steps at a high level. Still no complete code and no full function body.

Keep it to a few sentences. Call emit_hint exactly once.`;

const EMIT_HINT_TOOL: Anthropic.Tool = {
  name: 'emit_hint',
  description: 'Emit a single level-scoped hint.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The hint, scoped to the requested level.' },
    },
    required: ['text'],
  },
};

export async function hint(
  problem: ProblemRecord,
  userCode: string,
  level: HintLevel
): Promise<Hint> {
  const anthropic = getAnthropic();

  const userMessage = `PROBLEM: ${problem.title} (pattern: ${problem.pattern})

Statement:
${problem.prompt}

Function under test: ${problem.functionName}

CANDIDATE'S CURRENT CODE:
\`\`\`javascript
${userCode || '(empty)'}
\`\`\`

Give a LEVEL ${level} hint.`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // A hint is a few sentences; 1000 is 700 plus tokenizer headroom.
    max_tokens: 1000,
    // Disabled: level-scoped nudges are a short forced tool call. Left on
    // adaptive, thinking could consume the whole budget and return empty text.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: HINT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_HINT_TOOL],
    tool_choice: { type: 'tool', name: 'emit_hint' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const input = extractToolInput(response, 'emit_hint');
  return {
    level,
    text: typeof input.text === 'string' ? input.text : '',
  };
}

// ===========================================================================
// 4. planSession — once-per-sitting session arc (cheap, forced tool-use)
// ===========================================================================
const PLAN_SYSTEM = `You are an interview coach planning a SHORT focused practice session for a candidate grinding coding-interview patterns. You are given a snapshot of their per-topic progress.

Read the snapshot like this: progress is a TIER LADDER — none -> easy -> medium -> hard -> expert. A tier is completed by solving 3 DISTINCT problems at that difficulty with zero hints, so "tier easy, 2/3 toward medium" means the easy tier is done and two distinct medium problems have been cleared cleanly. "top tier, still climbing" means every tier is complete and they are accumulating expert solves — there is always a next rep. WEAK means they have not completed even the easy tier; DUE means spaced repetition wants that topic today.

Plan the session ARC, not individual problems (a separate scheduler picks each problem):
- theme: a short, motivating name for today's session (a few words), tied to what they most need.
- coachIntro: 1-2 warm, direct sentences telling them what you'll focus on and why. No fluff.
- focus: 2-4 topics (from the provided list) to lightly bias the session toward — favor weak/due topics, but include at least one they're solid at to build confidence. Use the EXACT topic strings from the snapshot.

Call emit_session_plan exactly once.`;

const EMIT_SESSION_PLAN_TOOL: Anthropic.Tool = {
  name: 'emit_session_plan',
  description: 'Emit the session plan (theme, coach intro, focus topics).',
  input_schema: {
    type: 'object',
    properties: {
      theme: { type: 'string', description: 'Short session theme name.' },
      coachIntro: { type: 'string', description: '1-2 sentence coach intro.' },
      focus: {
        type: 'array',
        description: '2-4 topic strings to bias toward (exact topic ids).',
        items: { type: 'string' },
      },
    },
    required: ['theme', 'coachIntro', 'focus'],
  },
};

export interface SessionSnapshotTopic {
  topic: Topic;
  attempted: number;
  solved: number;
  /** Highest difficulty tier COMPLETED (3 distinct hint-free solves). */
  tier: TierLevel;
  /** Distinct hint-free solves banked toward the next tier. */
  towardNext: number;
  /** Solves that complete a tier — the denominator of `towardNext`. */
  tierRequirement: number;
  /** The tier being worked on now, or null at the top of the ladder. */
  nextTier: Difficulty | null;
  currentDifficulty: Difficulty;
  due: boolean;
  weak: boolean;
}

/** Plan the session arc once per sitting from the tier snapshot. */
export async function planSession(snapshot: SessionSnapshotTopic[]): Promise<SessionPlan> {
  const anthropic = getAnthropic();

  const lines = snapshot.map((s) => {
    const tags = [s.weak ? 'WEAK' : '', s.due ? 'DUE' : ''].filter(Boolean).join(',');
    const climbing = s.nextTier
      ? `${s.towardNext}/${s.tierRequirement} toward ${s.nextTier}`
      : `top tier, still climbing`;
    return `- ${s.topic}: ${s.solved}/${s.attempted} solved, tier ${s.tier}, ${climbing}${
      tags ? ` [${tags}]` : ''
    }`;
  });
  const practiced = snapshot.filter((s) => s.attempted > 0).length;
  const userMessage =
    practiced === 0
      ? `The candidate is brand new — no history yet. Plan a gentle warm-up session on the fundamentals (arrays, hashing). Available topics: ${TOPICS.join(
          ', '
        )}.`
      : `Candidate tier snapshot (per topic):\n${lines.join(
          '\n'
        )}\n\nPlan today's short session. Use the exact topic ids above for focus.`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // Theme + two sentences + a few topic ids; 800 is 500 plus tokenizer headroom.
    max_tokens: 800,
    // Disabled: the tightest budget in the file, and picking 2-4 focus topics
    // off a snapshot needs no deliberation.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: PLAN_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_SESSION_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'emit_session_plan' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const input = extractToolInput(response, 'emit_session_plan');
  const validTopics = new Set<string>(TOPICS as readonly string[]);
  const focus = coerceStrings(input.focus).filter((t): t is Topic => validTopics.has(t));

  return {
    theme: typeof input.theme === 'string' && input.theme.trim() ? input.theme.trim() : 'Adaptive practice',
    coachIntro:
      typeof input.coachIntro === 'string' && input.coachIntro.trim()
        ? input.coachIntro.trim()
        : "Let's get some focused reps in.",
    focus,
  };
}

// ===========================================================================
// 5. askFollowup — free-form conversational Q&A after solving (NOT tool-use)
// ===========================================================================
const ASK_SYSTEM = `You are a staff-level engineer explaining an algorithm to another senior engineer. They have just worked this coding problem. You are given the problem statement, the reference solution, their own submitted code, and — when they submitted — the real per-test results.

## Show code by default
For this reader a complete, annotated, working implementation IS the explanation. Lead with the whole algorithm as runnable code, then explain what each part does and why it is there. Do not withhold code, do not offer to show it "if you want", do not wait to be asked. Never show a fragment of one sub-loop: if you show code at all, show the algorithm end to end, in one block, so they can read the shape of the thing.

## State the whole shape before any detail
Open with what the algorithm does end to end — two or three sentences — plus its time and space complexity. Only then go into any individual step. Never explain a sub-step before the reader knows where it sits in the whole.

## Check the premise before you answer
Before answering, ask what the question presupposes about the algorithm. If it presupposes something false, correcting that false premise IS the answer — not a detour on the way to one. Answering a wrong-premise question on its own terms is worse than useless: a literally correct answer to "how do we get those distances?" teaches subtraction and confirms the belief that the distances get built somewhere, which is the exact belief blocking them.

Say the better question out loud, then answer it: "You're asking X. X assumes Y, and Y isn't true here — <what is actually true>. The question that unblocks you is Z." Then answer Z in full, with code. Be explicit about the redirect rather than quietly answering something adjacent; the reader needs to see where their model went wrong, not just receive a different answer than the one they asked for.

Track the misconception across the whole conversation, not just this turn. Several questions in the same area are evidence of ONE wrong belief, not several separate gaps — find the belief and name it as the root: "these three questions all assume the list of distances gets computed somewhere; that is the thing to unlearn." Then correct it once, completely.

None of this is Socratic. Do not answer a question with a question, do not ask "what do you think happens here?", and never withhold the answer to make them derive it. State plainly that the model is wrong, state exactly how it is wrong, give the correct model, and show the code.

## When an explanation does not land, change its FORM — never decompose it
This is the single most important rule here. "Back up", "I'm not following", "I'm lost", or the same question asked again means the *representation* failed, not that the explanation was too big. Re-explain THE WHOLE THING in a different form:
- the complete code, annotated
- a trace table over the real input (one column per variable, one row per iteration)
- the end-to-end algorithm in plain prose
- a different framing: the invariant being maintained, the question each step answers, or why the obvious simpler approach fails here

Never respond to confusion by zooming in further. Breaking the same explanation into smaller pieces is how an explanation collapses — the reader loses the whole picture and gains nothing. "Back up" is a request for the whole picture again, at once, differently — never for a smaller piece of it.

Never narrate arithmetic in prose as a substitute for code or explanation. A hand-trace has value only as a trace TABLE presented alongside the algorithm, never in place of it.

## Never ask the reader to localize their own confusion
Do not ask "is it A, B, or C that's unclear?" or "which part should I go over?". A confused reader cannot reliably point at the source of their confusion — that is what being confused is. Pick the most likely gap yourself and re-explain differently.

## Index vs value vs rank vs count — never conflate them
Be explicit and consistent about what every variable holds, every time. If \`right\` is an index, write "right is an index; right = 3, whose value is 7" — never "right = 7". Name the units of every number: an index into which array, the value at which position, a rank (the k-th something), a count of something, or a candidate answer. When an algorithm binary-searches over an answer range, say plainly that lo/hi/mid live in the ANSWER space (a distance, a capacity, a time) and not in the index space of the input, and re-state which space you are in every time you switch. Conflating these is the most common way an explanation fails, and it is invisible to the person writing it.

## Audience and register
A senior engineer. They want the mechanism, the invariant, and the complexity. Drop the encouragement — no "great question", no praise for asking, no reassurance. Do not end a turn with "does that make sense?" or "let me know if that helps": either the explanation stands on its own or their next message will say what is still missing. Stop when the explanation is done.

## Anchor to their work
Anchor to the candidate's ACTUAL submitted code and to this specific problem; don't re-quote the statement back at them. When they ask why theirs failed, use the real test results — name the failing case, its expected vs actual value, and the line in their code responsible. When they say "I thought X would work", engage it honestly: say whether X can work, exactly where it breaks (a concrete input, not a category), and what cue in the problem points at the better idea. Explain how to recognize or derive this idea in a fresh problem.`;

const MAX_HISTORY_TURNS = 10;

/** Extract and join the text blocks from a (non-tool-use) message response. */
function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Free-form follow-up Q&A anchored to the candidate's submission. The problem
 * context is folded into the first user turn, prior history is replayed
 * (capped), and the new question is the final user turn.
 *
 * `results` are the per-test outcomes of the most recent submission when the
 * caller has them. Without them "why did mine fail?" can only be answered by
 * re-deriving the failure from the code, i.e. by guessing.
 */
export async function askFollowup(
  problem: ProblemRecord,
  userCode: string,
  question: string,
  history: ChatTurn[],
  results: TestResult[] = []
): Promise<string> {
  const anthropic = getAnthropic();

  const resultsBlock = results.length
    ? `

MY TEST RESULTS (${results.filter((r) => r.passed).length}/${results.length} passed):
${summarizeResults(results)}`
    : '';

  const context = `Here is the problem I just worked on.

PROBLEM: ${problem.title} (pattern: ${problem.pattern}, difficulty: ${problem.difficulty})

Statement:
${problem.prompt}

Function under test: ${problem.functionName}

REFERENCE SOLUTION:
\`\`\`javascript
${problem.referenceSolution}
\`\`\`

MY SUBMITTED CODE:
\`\`\`javascript
${userCode || '(empty)'}
\`\`\`${resultsBlock}

I'll ask questions about it now.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: context },
    { role: 'assistant', content: "Got it — I've got your problem and your code in front of me. What's your question?" },
  ];

  // Replay the recent conversation (cap to the last N turns), skipping empties.
  const recent = history.filter((t) => t && typeof t.content === 'string' && t.content.trim());
  for (const t of recent.slice(-MAX_HISTORY_TURNS)) {
    messages.push({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.content });
  }

  messages.push({ role: 'user', content: question.trim() || 'Can you explain the key idea here?' });

  const response = await anthropic.messages.create({
    model: ANTHROPIC_CHAT_MODEL,
    // 1000 was the root cause of the tutor emitting fragments: there is no room
    // for a whole annotated algorithm in 1000 tokens, so it emitted whatever
    // piece fit. 8000 is room for the full solution plus the explanation, and
    // it also has to cover adaptive thinking.
    max_tokens: 8000,
    // The tutor should reason about HOW to explain — which representation, what
    // the reader already has — before it starts writing.
    thinking: ADAPTIVE_THINKING,
    system: [{ type: 'text', text: ASK_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const text = extractText(response);
  return text || "I couldn't generate an answer just now — try rephrasing your question.";
}

// ===========================================================================
// 6. generatePrimer — durable per-pattern cheat-sheet card (forced tool-use)
// ===========================================================================
const PRIMER_SYSTEM = `You are an expert coding-interview coach writing a concise, DURABLE primer that helps a candidate RECOGNIZE and APPLY one algorithmic pattern. This is a reusable cheat-sheet card, not tied to any single problem — write it to still be useful months from now.

Produce:
- recognitionCues: 3-6 short signals in a problem statement that should make the candidate reach for this pattern (the cues an interviewer plants).
- template: a reusable, GENERIC JavaScript code skeleton for the pattern — the canonical shape (loops, pointers, structures) with placeholder comments, NOT a solution to a specific problem. Plain JS, no TypeScript types.
- pitfalls: 3-5 common mistakes people make applying this pattern (off-by-one, wrong bounds, forgetting a case, etc.).
- example: ONE canonical example — a well-known problem title for this pattern and the single key insight that makes it click.

Be crisp and interview-focused. Call emit_primer exactly once.`;

const EMIT_PRIMER_TOOL: Anthropic.Tool = {
  name: 'emit_primer',
  description: 'Emit one durable pattern primer card.',
  input_schema: {
    type: 'object',
    properties: {
      recognitionCues: {
        type: 'array',
        description: '3-6 short prompt signals that point at this pattern.',
        items: { type: 'string' },
      },
      template: {
        type: 'string',
        description: 'Reusable generic JS code skeleton for the pattern (placeholders, not a specific solution).',
      },
      pitfalls: {
        type: 'array',
        description: '3-5 common mistakes applying this pattern.',
        items: { type: 'string' },
      },
      example: {
        type: 'object',
        description: 'One canonical example: a known problem title + the key insight.',
        properties: {
          title: { type: 'string' },
          insight: { type: 'string' },
        },
        required: ['title', 'insight'],
      },
    },
    required: ['recognitionCues', 'template', 'pitfalls', 'example'],
  },
};

/** Generate a durable primer card for one topic/pattern (caller caches it). */
export async function generatePrimer(topic: Topic): Promise<Primer> {
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // 2500: 1500 plus headroom for the new tokenizer (~30% more tokens for the
    // same text) — a truncated primer card is cached forever.
    max_tokens: 2500,
    // Disabled: a forced tool call emitting a cheat-sheet card, generated once
    // per pattern and cached. No reasoning step worth paying for.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: PRIMER_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_PRIMER_TOOL],
    tool_choice: { type: 'tool', name: 'emit_primer' },
    messages: [
      {
        role: 'user',
        content: `Write the primer card for the pattern "${topic}".`,
      },
    ],
  });

  const input = extractToolInput(response, 'emit_primer');
  const example = (input.example ?? {}) as Record<string, unknown>;

  return {
    pattern: topic,
    recognitionCues: coerceStrings(input.recognitionCues),
    template: typeof input.template === 'string' ? input.template : '',
    pitfalls: coerceStrings(input.pitfalls),
    example: {
      title: typeof example.title === 'string' ? example.title : topic,
      insight: typeof example.insight === 'string' ? example.insight : '',
    },
  };
}

// ===========================================================================
// 7. generateTrackOutline — the cheap "what's in this track" call (forced tool)
// ===========================================================================
const OUTLINE_SYSTEM = `You are an expert coding-interview coach designing a short READING TRACK for one algorithmic pattern. The reader is grinding interview prep and wants to read the track straight through, in order, at night — no exercises, no quizzes, just a sequence of one-screen lessons that build on each other.

Lesson 0 of every track already exists: it is the pattern's recognition primer (cues, the code skeleton, the classic pitfalls, one canonical example). Do NOT repeat it. Your outline starts AFTER that.

Produce 6-8 lessons that go somewhere: the core mechanic in depth, the two or three canonical problem shapes the pattern shows up as, the variations that trip people up, the complexity/trade-off story, and how this pattern combines with or gets confused for its neighbours.

Each lesson has:
- kind: one of concept | template | pitfall | walkthrough | variation
- title: a short, concrete title (not "Introduction", not "Conclusion")
- brief: ONE sentence saying exactly what the lesson covers, specific enough that a writer could draft it from the brief alone.

Order matters — earlier lessons must not depend on later ones. Call emit_outline exactly once.`;

const EMIT_OUTLINE_TOOL: Anthropic.Tool = {
  name: 'emit_outline',
  description: 'Emit the ordered lesson outline for one pattern reading track.',
  input_schema: {
    type: 'object',
    properties: {
      lessons: {
        type: 'array',
        description: '6-8 lessons in reading order (excluding the primer, which is lesson 0).',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['concept', 'template', 'pitfall', 'walkthrough', 'variation'],
              description: 'The kind of reading unit.',
            },
            title: { type: 'string', description: 'Short concrete lesson title.' },
            brief: { type: 'string', description: 'One sentence: exactly what this lesson covers.' },
          },
          required: ['kind', 'title', 'brief'],
        },
      },
    },
    required: ['lessons'],
  },
};

function coerceLessonKind(raw: unknown, fallback: LessonKind): LessonKind {
  return typeof raw === 'string' && (LESSON_KINDS as readonly string[]).includes(raw)
    ? (raw as LessonKind)
    : fallback;
}

/**
 * Plan a topic's reading track. Cheap relative to writing the bodies, and it
 * lets the feed show "arrays · 3/8" before a single lesson has been written.
 * Seq numbering starts at 1 — seq 0 is always derived from the cached Primer.
 */
export async function generateTrackOutline(topic: Topic): Promise<TrackOutlineItem[]> {
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // 2500: 1500 plus tokenizer headroom; a truncated outline is cached forever.
    max_tokens: 2500,
    // Disabled: 6-8 {kind,title,brief} triples in a forced tool call.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: OUTLINE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_OUTLINE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_outline' },
    messages: [
      {
        role: 'user',
        content: `Outline the reading track for the pattern "${topic}".`,
      },
    ],
  });

  const input = extractToolInput(response, 'emit_outline');
  const raw = Array.isArray(input.lessons) ? input.lessons : [];

  const out: TrackOutlineItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;
    out.push({
      seq: out.length + 1, // seq 0 is the primer-derived lesson
      kind: coerceLessonKind(item.kind, 'concept'),
      title,
      brief: typeof item.brief === 'string' ? item.brief : '',
    });
  }
  return out;
}

// ===========================================================================
// 8. generateLessonBody — one written lesson (forced tool, cached forever)
// ===========================================================================
const LESSON_SYSTEM = `You are an expert coding-interview coach writing ONE lesson in a reading track. The reader is in bed with their phone, reading straight through. Write for that: calm, direct, second person, no filler, no "in this lesson we will". Get to the substance in the first sentence.

Length: one screenful — roughly 200-350 words of Markdown. Use short paragraphs and at most two small headings (## level). Bullets are fine when the content is genuinely a list. NEVER put a fenced code block in the body; if the lesson needs code, put it in the separate \`code\` field and refer to it as "the snippet below".

You are given the pattern's primer (its recognition cues, canonical skeleton and pitfalls) so this lesson stays consistent with what the reader already read. Do not restate the primer — build on it.

Also produce:
- code: OPTIONAL plain JavaScript illustrating this lesson's specific point. Omit it entirely when prose alone is clearer. No TypeScript types, no imports, no console noise.
- takeaway: ONE sentence, the single thing to remember from this lesson.

Call emit_lesson exactly once.`;

const EMIT_LESSON_TOOL: Anthropic.Tool = {
  name: 'emit_lesson',
  description: 'Emit one written lesson body.',
  input_schema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        description: 'The lesson in Markdown, ~200-350 words. No fenced code blocks.',
      },
      code: {
        type: 'string',
        description: 'Optional plain-JS snippet illustrating this lesson. Omit when not needed.',
      },
      takeaway: {
        type: 'string',
        description: 'One sentence: the single thing to remember.',
      },
    },
    required: ['body', 'takeaway'],
  },
};

function primerContext(primer: Primer): string {
  return `PATTERN PRIMER (already read — build on it, don't restate it):
Recognition cues:
${primer.recognitionCues.map((c) => `- ${c}`).join('\n') || '- (none recorded)'}

Canonical skeleton:
\`\`\`javascript
${primer.template || '(none recorded)'}
\`\`\`

Known pitfalls:
${primer.pitfalls.map((p) => `- ${p}`).join('\n') || '- (none recorded)'}

Canonical example: ${primer.example.title} — ${primer.example.insight}`;
}

function unwrapLesson(
  response: Anthropic.Message,
  base: { id: string; topic: Topic; kind: LessonKind; seq: number; title: string }
): Lesson {
  const input = extractToolInput(response, 'emit_lesson');
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  return {
    ...base,
    body: typeof input.body === 'string' ? input.body : '',
    code: code || undefined,
    takeaway: typeof input.takeaway === 'string' ? input.takeaway : '',
  };
}

/** Write one track lesson from its outline item, grounded in the topic's primer. */
export async function generateLessonBody(
  topic: Topic,
  item: TrackOutlineItem,
  primer: Primer
): Promise<Lesson> {
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // 3000: 2000 plus tokenizer headroom — a lesson body is cached forever, so
    // a truncated one is permanent.
    max_tokens: 3000,
    // Disabled: a ~300-word body emitted as a forced tool call, written from a
    // brief that already says what the lesson must cover.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: LESSON_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_LESSON_TOOL],
    tool_choice: { type: 'tool', name: 'emit_lesson' },
    messages: [
      {
        role: 'user',
        content: `${primerContext(primer)}

Write lesson ${item.seq} of the "${topic}" track.
Title: ${item.title}
Kind: ${item.kind}
It must cover: ${item.brief}`,
      },
    ],
  });

  return unwrapLesson(response, {
    id: `${topic}:${item.seq}`,
    topic,
    kind: item.kind,
    seq: item.seq,
    title: item.title,
  });
}

// ===========================================================================
// 9. Personalized lessons — grounded in the reader's OWN attempt history
// ===========================================================================
/** Write a lesson about one of the reader's recurring mistake tags. */
export async function generateMistakeLesson(
  tag: string,
  topic: Topic,
  seq: number,
  ground: { problemTitle?: string; prompt?: string } = {}
): Promise<Lesson> {
  const anthropic = getAnthropic();

  const grounding = ground.problemTitle
    ? `The most recent time it bit them was on "${ground.problemTitle}":

${(ground.prompt ?? '').slice(0, 1200)}

Use that as the concrete example.`
    : 'You have no specific problem to anchor to — use a canonical example instead.';

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // 3000: 2000 plus tokenizer headroom — a lesson body is cached forever, so
    // a truncated one is permanent.
    max_tokens: 3000,
    // Disabled: a ~300-word body emitted as a forced tool call, written from a
    // brief that already says what the lesson must cover.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: LESSON_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_LESSON_TOOL],
    tool_choice: { type: 'tool', name: 'emit_lesson' },
    messages: [
      {
        role: 'user',
        content: `This reader keeps making the same mistake: "${tag}" (most often while working ${topic} problems).

${grounding}

Write the lesson that fixes it for good: why this failure mode happens, the specific check or habit that prevents it, and how to catch it in 10 seconds before submitting. Be direct — this is their pattern, not a general audience's.`,
      },
    ],
  });

  return unwrapLesson(response, {
    id: `mistake:${tag}:${seq}`,
    topic,
    kind: 'mistake',
    seq,
    title: `Your recurring miss: ${tag}`,
  });
}

/** Walk one problem the reader leaned on hints for, canonically plus an alternate. */
export async function generateWalkthroughLesson(
  problem: ProblemRecord,
  seq: number
): Promise<Lesson> {
  const anthropic = getAnthropic();

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    // 3000: 2000 plus tokenizer headroom — a lesson body is cached forever, so
    // a truncated one is permanent.
    max_tokens: 3000,
    // Disabled: a ~300-word body emitted as a forced tool call, written from a
    // brief that already says what the lesson must cover.
    thinking: NO_THINKING,
    system: [{ type: 'text', text: LESSON_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [EMIT_LESSON_TOOL],
    tool_choice: { type: 'tool', name: 'emit_lesson' },
    messages: [
      {
        role: 'user',
        content: `The reader solved this ${problem.topic} problem slowly or with hints. Walk it: the canonical approach and WHY you'd reach for it from the prompt alone, then one genuinely different alternate approach and the trade-off between them.

PROBLEM: ${problem.title}
${problem.prompt}

REFERENCE SOLUTION:
\`\`\`javascript
${problem.referenceSolution}
\`\`\``,
      },
    ],
  });

  return unwrapLesson(response, {
    id: `walkthrough:${problem.id}`,
    topic: problem.topic,
    kind: 'walkthrough',
    seq,
    title: `Walkthrough: ${problem.title}`,
  });
}
