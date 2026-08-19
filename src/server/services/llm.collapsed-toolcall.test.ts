// =============================================================================
// The coaching call that stops being JSON at `missed`
// =============================================================================
// EVERY FIXTURE IN THIS FILE IS A REAL RESPONSE. They were captured from five
// live calls to claude-sonnet-5, all against the SAME real broken binary-search
// submission, and they are stored verbatim in
// `__fixtures__/collapsed-coaching-calls.json` rather than retyped, because the
// exact bytes are the evidence.
//
// WHAT THEY MEASURED. `missed` had just grown from `string[]` to an array of
// objects (note/quote/line/fix). With that schema, four calls out of four came
// back structurally broken; with `missed` back to `string[]`, the fifth came
// back perfectly clean. Peak output was 2101 tokens against a 16000 budget and
// every call reported 0 thinking tokens, so it was neither truncation nor
// budget. It was the shape:
//
//   call 1  stop_reason tool_use  `missed` a STRING of `<item><note>…</note>…`,
//                                 and `patternRecognition` ending
//                                 `…</patternRecognition>\n<complexity>\n<yours>`
//   call 2  stop_reason END_TURN  only `approach` and `missed`; the other six
//                                 fields never emitted at all
//   call 3  stop_reason tool_use  caught by the existing leak guard
//   call 4  stop_reason tool_use  `missed` a STRING, its subfields `note`,
//                                 `line`, `fix` promoted to the TOP LEVEL, and
//                                 `complexity` a STRING as well
//   call 5  old schema            clean, all seven fields, correct types
//
// WHY NOTHING CAUGHT IT. Two gaps, and this file pins both:
//
//   * `findLeakedToolCallFraming` knew only the tool's TOP-LEVEL property
//     names, so `<parameter name="note">` — a subfield of a `missed` item —
//     named nothing it recognized. And its corroboration regex only accepted
//     `function_calls|invoke|parameter`, so the bare field-name dialect
//     (`</patternRecognition>` followed by `<complexity>`) was not corroborated
//     either.
//   * Nothing compared the answer against the DECLARED TYPES. `missed` declared
//     `array` and arriving as `string` fell into `coerceMissed`'s
//     `if (!Array.isArray(raw)) return []`, and `complexity` declared `object`
//     and arriving as `string` fell into `(input.complexity ?? {})`. Both are
//     correct defences in isolation; together they render a confident,
//     complete-looking brief with an empty "What you missed" and
//     "unknown / unknown" next to it. That is the panel the user reported.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProblemRecord, TestResult } from '../../shared/types.js';
import {
  findLeakedToolCallFraming,
  findSchemaTypeViolation,
  looksLikeToolCallFraming,
  schemaFieldNames,
  LlmToolCallError,
  type ToolSpec,
} from './llm.types.js';

interface CapturedCall {
  meta: { servedModel: string; stop: string | null; usage: { outputTokens: number } };
  keys: string[];
  input: Record<string, unknown>;
}

const CAPTURED: Record<string, CapturedCall> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./__fixtures__/collapsed-coaching-calls.json', import.meta.url)), 'utf8')
);

const CALL1 = CAPTURED['call1-missed-item-dialect'];
const CALL2 = CAPTURED['call2-end-turn'];
const CALL4 = CAPTURED['call4-subfields-flattened'];
const CALL5 = CAPTURED['call5-old-schema-clean'];
/** Post-fix, live, strict on: a complete brief with markup in its last field. */
const CALL6 = CAPTURED['call6-strict-brief-dirty-calibration'];
/** Post-fix, live, strict on: structurally perfect and semantically empty. */
const CALL7 = CAPTURED['call7-strict-degenerate'];

// -----------------------------------------------------------------------------
// The tool, as the app defines it — imported rather than retyped.
// -----------------------------------------------------------------------------
// A schema-aware detector tested against a hand-copied schema proves something
// about the copy. `coachToolFor` reaches into the real request body the real
// adapter builds, so a future edit to EMIT_COACHING_TOOL is reflected here for
// free — and the drift that would otherwise make this file quietly meaningless
// cannot happen.
const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

const llm = await import('./llm.service.js');

const PROBLEM: ProblemRecord = {
  id: 'book-allocation',
  language: 'javascript',
  title: 'Minimum Pages Per Day',
  prompt: 'Given pages[] and days, return the smallest daily page limit that finishes in time.',
  examples: [{ input: '[12,34,67,90], 2', output: '113' }],
  constraints: ['1 <= days <= pages.length'],
  difficulty: 'medium',
  topic: 'binary-search',
  pattern: 'binary search on the answer',
  starterCode: 'function minPagesPerDay(pages, days) {}',
  functionName: 'minPagesPerDay',
  sampleTests: [{ name: 's1', args: [[12, 34, 67, 90], 2], expected: 113 }],
  hiddenTests: [{ name: 'single book single day', args: [[42], 1], expected: 42 }],
  referenceSolution: 'function minPagesPerDay(pages, days) { return 0; }',
  canonicalized: true,
  used: true,
  createdAt: '2026-08-18T00:00:00.000Z',
};

/** The real submission every one of these calls was coaching. */
const USER_CODE = [
  'function minPagesPerDay(pages, days) {',
  '  const max = Math.max(...pages)',
  '  const sum = pages.reduce((a,b)=>{return a+b}, 0);',
  '  let cnt = Math.floor((sum-max)/2)',
  '  let potential;',
  '  return potential;',
  '}',
].join('\n');

const RESULTS: TestResult[] = [
  { name: 'single book single day', passed: false, expected: '42', actual: 'undefined', timeMs: 0 },
];

/** Answer each call from a queue, so a first and a second attempt can differ. */
function answerWith(...inputs: Record<string, unknown>[]) {
  mocks.create.mockReset();
  let n = 0;
  mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
    model: 'claude-sonnet-5',
    stop_reason: 'tool_use',
    usage: { input_tokens: 1894, output_tokens: 1789, cache_read_input_tokens: 2202 },
    content: [
      {
        type: 'tool_use',
        name: (body.tool_choice as { name?: string } | undefined)?.name,
        input: inputs[Math.min(n++, inputs.length - 1)],
      },
    ],
  }));
}

/** The emit_coaching ToolSpec as it is actually sent, recovered from a real call. */
async function coachToolFor(attempt: 0 | 1): Promise<ToolSpec> {
  const body = mocks.create.mock.calls[attempt][0] as {
    tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  };
  const t = body.tools[0];
  return { name: t.name, description: t.description, schema: t.input_schema as unknown as ToolSpec['schema'] };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

// =============================================================================
describe('the declared-type check, against the real payloads', () => {
  let RICH: ToolSpec;
  let PLAIN: ToolSpec;

  beforeEach(async () => {
    // One throwaway call to recover both schemas exactly as they go on the wire.
    answerWith(CALL1.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    RICH = await coachToolFor(0);
    PLAIN = await coachToolFor(1);
  });

  it('catches `missed` arriving as a string in every broken call', () => {
    for (const call of [CALL1, CALL2, CALL4]) {
      const hit = findSchemaTypeViolation(call.input, RICH);
      expect(hit).not.toBeNull();
      expect(hit?.field).toBe('missed');
      expect(hit?.declared).toBe('array');
    }
  });

  it('catches `complexity` arriving as a string — the field that rendered "unknown"', () => {
    // Call 4 breaks at `missed` first, so `missed` is what a single walk
    // reports. `complexity` is the SECOND collapsed field in the same payload
    // and would have silently become unknown/unknown on its own.
    const { missed: _dropped, ...rest } = CALL4.input;
    const hit = findSchemaTypeViolation(rest, RICH);
    expect(hit?.field).toBe('complexity');
    expect(hit?.declared).toBe('object');
    expect(hit?.got).toContain('parameter name');
  });

  it('leaves the clean call alone, under BOTH schemas', () => {
    // Call 5 is the old `string[]` shape. Under the plain schema it is exactly
    // right; under the rich one its elements are strings where objects were
    // declared — and that must NOT be a violation, because it is the shape a
    // small local model answers with and `coerceMissed` renders it on purpose.
    expect(findSchemaTypeViolation(CALL5.input, PLAIN)).toBeNull();
    expect(findSchemaTypeViolation(CALL5.input, RICH)).toBeNull();
  });

  it('is not a JSON Schema validator — an omitted field is not an error', () => {
    expect(findSchemaTypeViolation({ approach: 'fine' }, RICH)).toBeNull();
  });
});

// =============================================================================
describe('the widened leak detector, against the real payloads', () => {
  let RICH: ToolSpec;

  beforeEach(async () => {
    answerWith(CALL1.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    RICH = await coachToolFor(0);
  });

  it('knows the NESTED property names, which is what `<parameter name="note">` needs', () => {
    const fields = schemaFieldNames(RICH.schema);
    for (const nested of ['note', 'quote', 'line', 'fix', 'yours', 'optimal']) {
      expect(fields.has(nested)).toBe(true);
    }
  });

  it('catches the bare field-name dialect in `patternRecognition`', () => {
    // `…reach for binary search on the answer.</patternRecognition>\n<complexity>`
    // — not one `<parameter>` in it, which is why the old corroboration regex
    // let the whole dialect through.
    const leak = findLeakedToolCallFraming({ patternRecognition: CALL1.input.patternRecognition }, RICH);
    expect(leak?.field).toBe('patternRecognition');
    expect(leak?.marker).toBe('</patternRecognition>');
  });

  it('catches `<parameter name="note">` — a SUBFIELD name — inside the missed blob', () => {
    const leak = findLeakedToolCallFraming({ missed: CALL4.input.missed }, RICH);
    expect(leak?.field).toBe('missed');
    expect(leak?.marker).toContain('name="note"');
  });

  it('still passes the clean call', () => {
    expect(findLeakedToolCallFraming(CALL5.input, RICH)).toBeNull();
  });
});

// =============================================================================
describe('coach() end to end on the captured calls', () => {
  it('refuses each broken payload instead of rendering an empty brief', async () => {
    for (const call of [CALL1, CALL2, CALL4]) {
      answerWith(call.input);
      await expect(llm.coach(PROBLEM, USER_CODE, RESULTS)).rejects.toBeInstanceOf(LlmToolCallError);
    }
  });

  it('degrades to the plain schema and RETURNS A BRIEF — the point of the retry', async () => {
    // Broken first, then the clean call-5 payload: this is what a real degraded
    // submit looks like end to end. The player gets every bullet, tied to the
    // failing tests, with no anchor and no suggested fix — which is the brief
    // this app shipped for two weeks and is a great deal better than an error.
    answerWith(CALL4.input, CALL5.input);
    const { brief, fixes } = await llm.coach(PROBLEM, USER_CODE, RESULTS);

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(brief.missed.length).toBeGreaterThan(0);
    expect(brief.missed[0].note).toContain('potential');
    expect(brief.missed.every((m) => m.anchor === undefined)).toBe(true);
    expect(fixes.size).toBe(0);
    // And the fields that the collapse had swallowed are really there.
    expect(brief.complexity.yours).not.toBe('unknown');
    expect(brief.patternRecognition).not.toBe('');
  });

  it('says so in the log when it degrades — a silent fallback is a lie', async () => {
    answerWith(CALL4.input, CALL5.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS);
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(
      /emit_coaching failed structurally.*plain-string "missed"/s
    );
  });

  it('sends the rich schema first and the plain one second, and never a third', async () => {
    answerWith(CALL1.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const missedOf = async (i: 0 | 1) =>
      ((await coachToolFor(i)).schema.properties.missed as { items: { type: string } }).items.type;
    expect(await missedOf(0)).toBe('object');
    expect(await missedOf(1)).toBe('string');
  });

  it('does not retry a TRUNCATED call — a smaller schema does not buy back a budget', async () => {
    mocks.create.mockReset();
    mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
      model: 'claude-sonnet-5',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1894, output_tokens: 16000, cache_read_input_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          name: (body.tool_choice as { name?: string } | undefined)?.name,
          input: { approach: 'cut off here' },
        },
      ],
    }));
    await expect(llm.coach(PROBLEM, USER_CODE, RESULTS)).rejects.toThrow(/max_tokens/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
describe('the request that goes out asks to be validated exactly', () => {
  it('sets strict on the tool itself, alongside name/description/input_schema', async () => {
    answerWith(CALL5.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    const body = mocks.create.mock.calls[0][0] as {
      tools: { strict?: boolean; input_schema: Record<string, unknown> }[];
      tool_choice: Record<string, unknown>;
    };
    expect(body.tools[0].strict).toBe(true);
    // NOT on tool_choice, which is the plausible wrong place to put it.
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'emit_coaching' });
    // Strict's two obligations on the schema.
    expect(body.tools[0].input_schema.additionalProperties).toBe(false);
    expect(body.tools[0].input_schema.required).toEqual(
      Object.keys(body.tools[0].input_schema.properties as Record<string, unknown>)
    );
  });

  it('keeps quote/line/fix omittable IN EFFECT by typing them nullable', async () => {
    answerWith(CALL5.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    const item = (
      (mocks.create.mock.calls[0][0] as {
        tools: { input_schema: { properties: { missed: { items: Record<string, never> } } } }[];
      }).tools[0].input_schema.properties.missed.items
    ) as unknown as { properties: Record<string, { type: unknown }>; required: string[] };
    expect(item.required).toEqual(['note', 'quote', 'line', 'fix']);
    expect(item.properties.note.type).toBe('string');
    expect(item.properties.quote.type).toEqual(['string', 'null']);
    expect(item.properties.line.type).toEqual(['number', 'null']);
    expect(item.properties.fix.type).toEqual(['string', 'null']);
  });

  it('treats an explicit null exactly as it treats an absent field', async () => {
    // The whole reason nullable is acceptable: `line: null` must not become the
    // finite, confident line hint 0 that `Number(null)` would produce.
    answerWith({
      ...(CALL5.input as Record<string, unknown>),
      missed: [
        { note: 'no line to point at', quote: null, line: null, fix: null },
        { note: 'this one has one', quote: '  let potential;', line: 5, fix: '  let potential = Infinity;' },
      ],
    });
    const { brief, fixes } = await llm.coach(PROBLEM, USER_CODE, RESULTS);
    expect(brief.missed[0]).toEqual({ note: 'no line to point at' });
    expect(brief.missed[1].anchor).toEqual({ startLine: 5, endLine: 5 });
    expect(fixes.get(1)?.after).toBe('  let potential = Infinity;');
  });

  it('does not put strict on the tools that did not ask for it', async () => {
    mocks.create.mockReset();
    mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
      model: 'claude-sonnet-5',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          name: (body.tool_choice as { name?: string } | undefined)?.name,
          input: { text: 'Think about what sortedness buys you.' },
        },
      ],
    }));
    await llm.hint(PROBLEM, USER_CODE, 1);
    const tool = (mocks.create.mock.calls[0][0] as { tools: { strict?: boolean }[] }).tools[0];
    expect(tool.strict).toBeUndefined();
    expect('strict' in tool).toBe(false);
  });
});

// =============================================================================
// What strict tool use actually changed, measured live after the fix
// =============================================================================
// Two more real responses, captured from the same submission with `strict: true`
// on the tool. They are the reason `leakSink` exists.
//
//   call 6  the fix WORKING: all eight fields, all correct types, `missed` four
//           real anchored objects — and `calibration` holding
//           `</antml>\n\n<invoke name="emit_coaching">\n`. The model wrote the
//           whole brief and then, with nowhere else for a grammar-constrained
//           decoder to put it, parked its closing markup in the last string.
//   call 7  the residual: every field present and correctly typed, and the
//           content degenerate — `missed: []`, `patternRecognition: " "`,
//           `improvement: "placeholder"`. Structurally indistinguishable from a
//           terse brief, and NOT something a type check can see. Pinned here so
//           the next person knows it was observed rather than imagined.
describe('strict tool use, measured live', () => {
  let RICH: ToolSpec;
  beforeEach(async () => {
    answerWith(CALL6.input);
    await llm.coach(PROBLEM, USER_CODE, RESULTS).catch(() => {});
    RICH = await coachToolFor(0);
    RICH.exactSchema = true;
    RICH.leakSink = 'calibration';
  });

  it('call 6 arrives with every field and every type correct — the fix', () => {
    expect(CALL6.keys).toEqual([
      'approach', 'missed', 'pattern', 'patternRecognition',
      'complexity', 'improvement', 'mistakeTags', 'calibration',
    ]);
    expect(Array.isArray(CALL6.input.missed)).toBe(true);
    expect((CALL6.input.missed as { note: string }[]).length).toBe(4);
    expect(typeof CALL6.input.complexity).toBe('object');
    expect(findSchemaTypeViolation(CALL6.input, RICH)).toBeNull();
  });

  it('does NOT reject it over the markup in `calibration`', () => {
    expect(CALL6.input.calibration).toContain('<invoke name="emit_coaching">');
    expect(findLeakedToolCallFraming(CALL6.input, RICH)).toBeNull();
  });

  it('still rejects the SAME markup in a field that is not the sink', () => {
    // Nothing about the marker is excused — only its position, and only because
    // nothing follows the last field for it to have swallowed.
    const leak = findLeakedToolCallFraming(
      { ...CALL6.input, improvement: CALL6.input.calibration },
      RICH
    );
    expect(leak?.field).toBe('improvement');
  });

  it('does not excuse the sink when the schema is NOT validated exactly', () => {
    // A promise the endpoint never made cannot be relied on: without
    // `exactSchema` the later fields really may be missing, so the guard fires.
    const loose: ToolSpec = { ...RICH, exactSchema: false };
    expect(findLeakedToolCallFraming(CALL6.input, loose)?.field).toBe('calibration');
  });

  it('delivers call 6 as a real brief, in ONE call, with its anchors', async () => {
    answerWith(CALL6.input);
    const { brief } = await llm.coach(PROBLEM, USER_CODE, RESULTS);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(brief.missed.length).toBe(4);
    expect(brief.missed[0].note).toContain('potential');
    expect(brief.complexity.optimal).toContain('log');
    expect(brief.calibration).toBeUndefined();
  });

  it('drops a contaminated calibration rather than rendering it to the player', async () => {
    answerWith(CALL6.input);
    const { brief } = await llm.coach(PROBLEM, USER_CODE, RESULTS, {
      approach: 'binary search',
      predTime: 'O(n log n)',
      predSpace: 'O(1)',
      confidence: 4,
    });
    // A prediction WAS given, so the field would have rendered. It does not.
    expect(brief.calibration).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain('tool-call markup');
  });

  it('keeps a calibration that is an actual sentence', async () => {
    answerWith({ ...CALL6.input, calibration: 'You predicted O(n) but your walk is O(range).' });
    const { brief } = await llm.coach(PROBLEM, USER_CODE, RESULTS, {
      approach: 'binary search',
      predTime: 'O(n)',
      predSpace: 'O(1)',
      confidence: 3,
    });
    expect(brief.calibration).toBe('You predicted O(n) but your walk is O(range).');
  });

  it('catches the SPACED form the model also emitted — `</antml :parameter>`', () => {
    expect(looksLikeToolCallFraming(CALL7.input.calibration as string)).toBe(true);
    // And a real calibration sentence is not swept up with it.
    expect(looksLikeToolCallFraming('You predicted O(n) but your nested scan is O(n^2).')).toBe(false);
    expect(looksLikeToolCallFraming('You said lo < hi would terminate; it does not.')).toBe(false);
  });

  it('call 7 is the RESIDUAL: valid, empty, and beyond any structural check', () => {
    // Recorded, not fixed. Every guard in this file passes it, because there is
    // nothing structurally wrong with it — the model simply had nothing to say
    // and said so in eight correctly-typed fields.
    expect(findSchemaTypeViolation(CALL7.input, RICH)).toBeNull();
    expect(findLeakedToolCallFraming(CALL7.input, RICH)).toBeNull();
    expect(CALL7.input.missed).toEqual([]);
    expect((CALL7.input.improvement as string)).toBe('placeholder');
  });
});
