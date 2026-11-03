// The readiness detail must be reachable without hover: a finger cannot open a
// `title` tooltip. No jsdom here (see HelpHint.test.tsx), so the closed and open
// states are rendered statically via `defaultOpen`; the toggle itself is a plain
// useState flip on a real <button>.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadinessTile, readinessDetailLines } from './ReadinessTile';
import type { ReadinessArea } from '@/shared/today';

const AREA: ReadinessArea = {
  id: 'algos',
  label: 'Algorithms',
  verdict: 'not-yet',
  evidence: '14 unseen mediums',
  signals: [
    { id: 'pass', label: 'First-try pass', value: '42%', n: 12 },
    { id: 'trend', label: 'Trend', value: 'n/a', n: 0 },
  ],
  hint: 'One unseen medium a day.',
  inLoop: false,
};

describe('readinessDetailLines', () => {
  it('lists each signal with its sample size, and the loop note', () => {
    expect(readinessDetailLines(AREA)).toEqual([
      'First-try pass: 42% (n=12)',
      'Trend: n/a',
      'Not a round in your next interview.',
    ]);
  });

  it('omits the loop note when the round is in the loop or there is no loop', () => {
    expect(readinessDetailLines({ ...AREA, inLoop: true })).toHaveLength(2);
    expect(readinessDetailLines({ ...AREA, inLoop: null })).toHaveLength(2);
  });
});

describe('ReadinessTile', () => {
  it('closed: a real button with aria-expanded=false, detail kept as a mouse tooltip only', () => {
    const html = renderToStaticMarkup(<ReadinessTile area={AREA} />);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="readiness-algos-detail"');
    expect(html).toContain('title="First-try pass: 42% (n=12)');
    expect(html).not.toContain('<ul');
  });

  it('open: the signals render inline, so touch can read them', () => {
    const html = renderToStaticMarkup(<ReadinessTile area={AREA} defaultOpen />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="readiness-algos-detail"');
    expect(html).toContain('<li>First-try pass: 42% (n=12)</li>');
    expect(html).toContain('<li>Not a round in your next interview.</li>');
  });

  it('with nothing to disclose, it is not a button at all', () => {
    const html = renderToStaticMarkup(
      <ReadinessTile area={{ ...AREA, signals: [], inLoop: null }} />,
    );
    expect(html).not.toContain('<button');
    expect(html).toContain('Algorithms');
  });
});
