// Answer inputs on a phone. Markup and pure helpers only (no DOM here): which
// keyboard each step asks for, which chips it offers and that they only show on
// a phone, that the direction buttons send words the checker accepts, and that
// every answer box turns off autocorrect.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ALL_KINDS, generateItem, seedItems } from '@/shared/envelope';
import { checkStep, guidedPlan } from '@/shared/envelope-learn';
import { AnswerChips, chipsFor, inputModeFor, insertAt } from './AnswerChips';

const everyPlan = () =>
  [...seedItems(), ...ALL_KINDS.flatMap((k) => Array.from({ length: 60 }, (_, i) => generateItem(k, i * 7919 + 1)))]
    .map((i) => guidedPlan(i))
    .filter((p) => p !== null);

describe('keyboards', () => {
  it('small math gets the decimal pad, the rest a text keyboard', () => {
    expect(inputModeFor('small')).toBe('decimal');
    for (const t of ['split', 'back', 'unit', null] as const) expect(inputModeFor(t)).toBe('text');
  });

  it('exponents can be negative, so the number pad comes with a minus chip', () => {
    const negative = everyPlan().some((p) => p.some((s) => s.expect.kind === 'exponent' && s.expect.value < 0));
    expect(negative).toBe(true);
    expect(inputModeFor('exponent')).toBe('numeric');
    expect(chipsFor('exponent', 'GB')).toEqual([{ label: '−', insert: '-' }]);
  });

  it('a minus from the chip passes the exponent checker', () => {
    const step = everyPlan()
      .flat()
      .find((s) => s.expect.kind === 'exponent' && s.expect.value < 0)!;
    expect(checkStep(step, insertAt('', null, null, '-').value + step.answer.replace('-', '')).ok).toBe(true);
  });
});

describe('chips', () => {
  it('offer × 10^ to split, scale letters and the unit to back, everything to the answer', () => {
    expect(chipsFor('split', 'GB').map((c) => c.label)).toEqual(['× 10^']);
    expect(chipsFor('back', 'GB').map((c) => c.label)).toEqual(['K', 'M', 'B', 'T', 'GB']);
    expect(chipsFor('unit', 'TB').map((c) => c.label)).toEqual(['× 10^', 'K', 'M', 'B', 'T', 'TB']);
    expect(chipsFor('unit', '').map((c) => c.label)).toEqual(['× 10^', 'K', 'M', 'B', 'T']);
    expect(chipsFor('direction', 'GB')).toEqual([]);
  });

  it('insert at the caret without doubling spaces', () => {
    expect(insertAt('5', 1, 1, ' × 10^')).toEqual({ value: '5 × 10^', caret: 7 });
    expect(insertAt('5 ', 2, 2, ' × 10^')).toEqual({ value: '5 × 10^', caret: 7 });
    expect(insertAt('', null, null, ' × 10^')).toEqual({ value: '× 10^', caret: 5 });
    expect(insertAt('30', 2, 2, 'M')).toEqual({ value: '30M', caret: 3 });
    expect(insertAt('8', 1, 1, ' TB')).toEqual({ value: '8 TB', caret: 4 });
  });

  it('only show on a phone, as 44px targets', () => {
    const html = renderToStaticMarkup(
      <AnswerChips chips={chipsFor('unit', 'GB')} inputRef={{ current: null }} value="" onChange={() => {}} />,
    );
    expect(html).toMatch(/^<div class="hidden [^"]*phone:flex/);
    expect(html.match(/<button/g)).toHaveLength(6);
    expect(html).toContain('h-11 min-w-11');
  });
});

describe('direction buttons', () => {
  it('send words the checker reads, right and wrong', () => {
    for (const p of everyPlan().slice(0, 200)) {
      const d = p.find((s) => s.type === 'direction')!;
      const other = d.answer === 'divide' ? 'multiply' : 'divide';
      expect(checkStep(d, d.answer).ok).toBe(true);
      expect(checkStep(d, other).ok).toBe(false);
      // GuidedRunner hides this exact tail on a phone, where buttons replace typing.
      expect(d.prompt.endsWith(' Type divide or multiply.')).toBe(true);
    }
  });
});

describe('every answer box', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  it.each([
    ['GuidedRunner', './GuidedRunner.tsx', 'ANSWER_INPUT'],
    ['AnchorDrill', './AnchorDrill.tsx', 'ANSWER_INPUT'],
    ['SpeedRound', './SpeedRound.tsx', 'ANSWER_INPUT'],
    ['EnvelopePage', '../../pages/EnvelopePage.tsx', 'ANSWER_INPUT'],
    ['RecognizePage', '../../pages/RecognizePage.tsx', 'ANSWER_TEXTAREA'],
    ['GapCards', '../GapCards.tsx', 'ANSWER_TEXTAREA'],
  ])('%s spreads the no-autocorrect props', (_name, path, spread) => {
    expect(src(path)).toContain(`{...${spread}}`);
  });

  it('anchor cards and the speed round have a phone-only Check button', () => {
    for (const p of ['./AnchorDrill.tsx', './SpeedRound.tsx']) {
      expect(src(p)).toMatch(/aria-label="Check"\s+className="hidden h-11 w-14 shrink-0 phone:inline-flex"/);
    }
  });
});
