// The `phone:` CSS variant and PHONE_QUERY answer the same question in two
// places (chrome switches by class, content swaps by hook). If they drift, the
// tab bar shows while Home still renders the iPad layout, or the reverse.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PHONE_QUERY } from './useMediaQuery';

describe('PHONE_QUERY', () => {
  it('matches the media queries of the `phone:` variant in index.css', () => {
    const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
    const block = /@custom-variant phone \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    const fromCss = [...block.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim());
    expect(fromCss).toHaveLength(2);
    expect(PHONE_QUERY.split(',').map((q) => q.trim())).toEqual(fromCss);
  });

  it('is keyed on a coarse pointer, never on width alone', () => {
    for (const q of PHONE_QUERY.split(',')) expect(q).toContain('(pointer: coarse)');
  });
});
