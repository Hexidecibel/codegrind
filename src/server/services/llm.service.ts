import Anthropic from '@anthropic-ai/sdk';
import {
  TOPICS,
  MISTAKE_TAGS,
  type ProblemRecord,
  type CoachingBrief,
  type Hint,
  type HintLevel,
  type Topic,
  type Difficulty,
  type TestCase,
  type Example,
  type TestResult,
  type SessionPlan,
  type ChatTurn,
  type Prediction,
  type Primer,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Anthropic client — lazily constructed so importing this module never requires
// a key (e.g. for type-only usage or when the sandbox path is exercised alone).
// ---------------------------------------------------------------------------
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

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

function buildGenerateUserMessage(
  topic: Topic,
  difficulty: Difficulty,
  opts?: GenerateProblemOpts
): string {
  let msg = `Create one ${difficulty} problem for the topic/pattern "${topic}". Make it self-contained and deterministic so it can be auto-graded.`;
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
    max_tokens: 8000,
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
    model: ANTHROPIC_MODEL,
    max_tokens: 2500,
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
    max_tokens: 700,
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
const PLAN_SYSTEM = `You are an interview coach planning a SHORT focused practice session for a candidate grinding coding-interview patterns. You are given a snapshot of their per-topic mastery (attempts, solve rate, current difficulty, and which topics are weak or due for review).

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
  mastery: number;
  currentDifficulty: Difficulty;
  due: boolean;
  weak: boolean;
}

/** Plan the session arc once per sitting from the mastery snapshot. */
export async function planSession(snapshot: SessionSnapshotTopic[]): Promise<SessionPlan> {
  const anthropic = getAnthropic();

  const lines = snapshot.map((s) => {
    const tags = [s.weak ? 'WEAK' : '', s.due ? 'DUE' : ''].filter(Boolean).join(',');
    return `- ${s.topic}: ${s.solved}/${s.attempted} solved, mastery ${s.mastery.toFixed(
      2
    )}, at ${s.currentDifficulty}${tags ? ` [${tags}]` : ''}`;
  });
  const practiced = snapshot.filter((s) => s.attempted > 0).length;
  const userMessage =
    practiced === 0
      ? `The candidate is brand new — no history yet. Plan a gentle warm-up session on the fundamentals (arrays, hashing). Available topics: ${TOPICS.join(
          ', '
        )}.`
      : `Candidate mastery snapshot (per topic):\n${lines.join(
          '\n'
        )}\n\nPlan today's short session. Use the exact topic ids above for focus.`;

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 500,
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
const ASK_SYSTEM = `You are a patient, direct interview tutor. A candidate just worked a coding problem and wants to understand it better. You are given the problem, the reference solution, and the candidate's OWN submitted code, then a conversation.

Anchor every answer to the candidate's ACTUAL approach and the specific problem. Explain the "why" behind the pattern, how to RECOGNIZE or DERIVE the idea in a fresh problem, and when they say "I thought X would work," engage that honestly — say whether X can work, where it breaks, and what the cue was that points to the better idea. Be concise, concrete, and encouraging. No fluff, no restating the whole problem back. Use short paragraphs or tight bullets. Never dump a full alternative solution unless they explicitly ask for code.`;

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
 */
export async function askFollowup(
  problem: ProblemRecord,
  userCode: string,
  question: string,
  history: ChatTurn[]
): Promise<string> {
  const anthropic = getAnthropic();

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
\`\`\`

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
    model: ANTHROPIC_MODEL,
    max_tokens: 1000,
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
    max_tokens: 1500,
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
