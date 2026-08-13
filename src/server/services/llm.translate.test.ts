// =============================================================================
// llm.translate.test — what a translation batch is allowed to write
// =============================================================================
// translateSnippets is the only call in the app whose OUTPUT is stored as part
// of the study corpus, so its unwrapping is the last thing standing between a
// model's improvisation and 130 rows nobody reads again for months. Everything
// asserted here is about that boundary: which ids may be written, what a
// missing one means, and what happens when the model ignores "no fences".
//
// The Anthropic SDK is replaced wholesale — the module builds its client lazily
// on first CALL, so the fake never has to be a real client and no key is needed
// beyond the presence check.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const create = vi.fn();
  return { create };
});

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

const { translateSnippets } = await import('./llm.service.js');

/** The shape the SDK returns: one forced tool_use block. */
function toolResponse(translations: unknown) {
  return {
    content: [{ type: 'tool_use', name: 'emit_translations', input: { translations } }],
  };
}

const SNIPPETS = [
  { id: 'primer:arrays', code: 'let i = 0;' },
  { id: 'lesson:arrays:1', code: 'const total = nums.reduce((a, b) => a + b, 0);' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
describe('the request', () => {
  it('is ONE call carrying every snippet, with thinking disabled', async () => {
    mocks.create.mockResolvedValue(
      toolResponse([
        { id: 'primer:arrays', code: 'i = 0' },
        { id: 'lesson:arrays:1', code: 'total = sum(nums)' },
      ])
    );

    await translateSnippets(SNIPPETS, 'javascript', 'python');

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const req = mocks.create.mock.calls[0][0];
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'emit_translations' });
    // Both snippets and both ids in the single user message — this is the
    // batching the shared-corpus decision is paid for with.
    expect(req.messages[0].content).toContain('primer:arrays');
    expect(req.messages[0].content).toContain('lesson:arrays:1');
    expect(req.messages[0].content).toContain('const total = nums.reduce');
  });

  it('names both languages in a cached system prompt built once per pair', async () => {
    mocks.create.mockResolvedValue(toolResponse([{ id: 'primer:arrays', code: 'i = 0' }]));

    await translateSnippets(SNIPPETS, 'javascript', 'python');
    await translateSnippets(SNIPPETS, 'javascript', 'python');

    const first = mocks.create.mock.calls[0][0].system[0];
    const second = mocks.create.mock.calls[1][0].system[0];
    expect(first.text).toContain('JavaScript');
    expect(first.text).toContain('Python');
    expect(first.cache_control).toEqual({ type: 'ephemeral' });
    // Referential identity: the memo, not a rebuild. A prompt reassembled per
    // call is where an interpolated topic would sneak into a cached prefix.
    expect(second.text).toBe(first.text);
  });

  it('carries the TARGET language`s house style, not the source`s', async () => {
    mocks.create.mockResolvedValue(toolResponse([]));

    await translateSnippets(SNIPPETS, 'javascript', 'python');
    expect(mocks.create.mock.calls[0][0].system[0].text).toContain('4-space indentation');
  });

  it('spends nothing when there is nothing to do', async () => {
    expect((await translateSnippets(SNIPPETS, 'python', 'python')).size).toBe(0);
    expect((await translateSnippets([], 'javascript', 'python')).size).toBe(0);
    expect(
      (await translateSnippets([{ id: 'lesson:x', code: '  ' }], 'javascript', 'python')).size
    ).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('the response', () => {
  it('keys the result by the id it sent', async () => {
    mocks.create.mockResolvedValue(
      toolResponse([
        { id: 'primer:arrays', code: 'i = 0' },
        { id: 'lesson:arrays:1', code: 'total = sum(nums)' },
      ])
    );

    const out = await translateSnippets(SNIPPETS, 'javascript', 'python');
    expect(out.get('primer:arrays')).toBe('i = 0');
    expect(out.get('lesson:arrays:1')).toBe('total = sum(nums)');
  });

  it('drops an id it never asked for', async () => {
    // A hallucinated sourceId would be stored against a lesson that has no such
    // translation, and would then be served in place of a real snippet forever.
    mocks.create.mockResolvedValue(
      toolResponse([
        { id: 'primer:arrays', code: 'i = 0' },
        { id: 'lesson:trees:9', code: 'root = None' },
      ])
    );

    const out = await translateSnippets(SNIPPETS, 'javascript', 'python');
    expect(out.has('lesson:trees:9')).toBe(false);
    expect(out.size).toBe(1);
  });

  it('returns a PARTIAL batch rather than failing', async () => {
    // A missing id is not an error: the read path falls back to the stored
    // JavaScript snippet, so one untranslated lesson stays one untranslated
    // lesson instead of taking its topic down with it.
    mocks.create.mockResolvedValue(toolResponse([{ id: 'primer:arrays', code: 'i = 0' }]));

    const out = await translateSnippets(SNIPPETS, 'javascript', 'python');
    expect(out.size).toBe(1);
    expect(out.has('lesson:arrays:1')).toBe(false);
  });

  it('strips the fence the prompt told it not to emit', async () => {
    // Stored verbatim, a fenced snippet renders as literal backticks inside the
    // lesson's <pre> — it reads as a corrupted corpus rather than as a model
    // that over-formatted.
    mocks.create.mockResolvedValue(
      toolResponse([{ id: 'primer:arrays', code: '```python\ni = 0\n```' }])
    );

    expect((await translateSnippets(SNIPPETS, 'javascript', 'python')).get('primer:arrays')).toBe(
      'i = 0'
    );
  });

  it('never stores an empty or non-string translation', async () => {
    mocks.create.mockResolvedValue(
      toolResponse([
        { id: 'primer:arrays', code: '   ' },
        { id: 'lesson:arrays:1', code: 42 },
      ])
    );

    expect((await translateSnippets(SNIPPETS, 'javascript', 'python')).size).toBe(0);
  });

  it('survives a malformed payload instead of throwing into the warm job', async () => {
    mocks.create.mockResolvedValue(toolResponse('not an array'));
    expect((await translateSnippets(SNIPPETS, 'javascript', 'python')).size).toBe(0);

    mocks.create.mockResolvedValue(toolResponse([null, 'nope', { code: 'no id' }]));
    expect((await translateSnippets(SNIPPETS, 'javascript', 'python')).size).toBe(0);
  });

  it('throws when the model did not call the tool at all', async () => {
    // The one case that SHOULD be loud: once() catches it, records the cooldown
    // and the reader keeps getting JavaScript snippets rather than nothing.
    mocks.create.mockResolvedValue({ content: [{ type: 'text', text: 'I would rather not.' }] });

    await expect(translateSnippets(SNIPPETS, 'javascript', 'python')).rejects.toThrow(
      /emit_translations/
    );
  });
});
