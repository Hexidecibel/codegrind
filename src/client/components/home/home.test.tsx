// The Home pieces render statically (no jsdom): closed/open states via props.

import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReadinessArea } from '@/shared/today';
import type { WeeklyResponse } from '@/shared/weekly';
import { MockNudge } from './MockNudge';
import { TargetCard } from './TargetCard';
import { LeverLine, leverArea, leverHref } from './LeverLine';
import { WeekPanel, weekdayOf } from './WeekPanel';
import { RefreshBanner } from './RefreshBanner';
import { WarmupChecklist, warmupItems } from './WarmupChecklist';
import type { TodayState } from '@/shared/today';

const html = (el: ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

function area(id: ReadinessArea['id'], verdict: ReadinessArea['verdict'], inLoop: boolean | null = true): ReadinessArea {
  return { id, label: id, verdict, evidence: 'e', signals: [], hint: `push ${id}`, inLoop };
}

const WEEK: WeeklyResponse = {
  days: 7,
  from: '2026-10-15',
  to: '2026-10-21',
  activeDays: 2,
  daily: ['15', '16', '17', '18', '19', '20', '21'].map((d, i) => ({
    date: `2026-10-${d}`,
    subs: i,
    grind: 0,
    solved: 0,
    practiced: i === 5 || i === 6,
  })),
  volume: { subs: 9, problems: 5, grindSubs: 4, freeSubs: 5 },
  topics: ['arrays', 'stack', 'trees', 'heap'].map((topic, i) => ({
    topic,
    attempts: 4 - i,
    free: 0,
    solved: 1,
    solvedPct: 25 * (i + 1),
    nearMisses: 0,
    hinted: 0,
    unaided: 1,
    trend: { before: { n: 0, solved: 0 }, after: { n: 0, solved: 0 } },
  })),
  untouched: ['hashing', 'two-pointer', 'sliding-window', 'binary-search', 'graphs'],
  nearMisses: { count: 3, fixed: 2, fixedUnaided: 1 },
  recognize: [],
  envelope: { n: 0, ok: 0, okPct: 0, days: 0 },
  reviewDue: [],
  mocks: { thisWeek: 0, lastAt: null },
  target: { kind: 'struggling', topic: 'stack', reason: 'Stack is under 50% this week.', href: '/manual?topic=stack&difficulty=easy' },
};

describe('MockNudge', () => {
  it('no mock: one sentence and a Start button to /mock', () => {
    const out = html(<MockNudge mocks={{ thisWeek: 0, lastAt: null }} />);
    expect(out).toContain('No mock this week');
    expect(out).toContain('One 45-min mock beats ten problems for readiness.');
    expect(out).toContain('href="/mock"');
  });
  it('a mock done: a quiet line, no button', () => {
    const out = html(<MockNudge mocks={{ thisWeek: 1, lastAt: '2026-10-20T00:00:00Z' }} />);
    expect(out).toContain('Mock done this week');
    expect(out).not.toContain('href=');
  });
});

describe('MockNudge during the Pattern Refresh', () => {
  it('a quiet line with the refresh day, no button, even with no mock this week', () => {
    const out = html(<MockNudge mocks={{ thisWeek: 0, lastAt: null }} refresh={{ day: 3, total: 9 }} />);
    expect(out).toContain('Mocks pick back up after the refresh (day 3 of 9)');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('No mock this week');
  });
  it('refresh off (null): the normal nudge', () => {
    expect(html(<MockNudge mocks={{ thisWeek: 0, lastAt: null }} refresh={null} />)).toContain('No mock this week');
  });
});

const REFRESH = {
  on: true, day: 3, total: 9, label: 'Sliding window', pattern: 'sliding-window', topic: 'sliding-window',
  prevLabel: null, completedThrough: 2, dayComplete: false, finishedAt: null,
} as unknown as TodayState['refresh'];

describe('RefreshBanner', () => {
  it('one row: the pattern links to its shape, the day and nine dots, a ⋯ menu', () => {
    const out = html(<RefreshBanner r={REFRESH} busy={false} onTurnOff={() => undefined} />);
    expect(out).toContain('Sliding window');
    expect(out).toContain('href="/patterns#sliding-window"');
    expect(out).toContain('Refresh day 3 of 9');
    expect(out.match(/h-1\.5 w-1\.5 rounded-full/g)).toHaveLength(9);
    expect(out).toContain('aria-label="Refresh options"');
    expect(out).not.toContain('done · next pattern tomorrow');
  });
  it('the day settled: a done chip', () => {
    expect(html(<RefreshBanner r={{ ...REFRESH, dayComplete: true, completedThrough: 3 }} busy={false} onTurnOff={() => undefined} />)).toContain(
      'done · next pattern tomorrow',
    );
  });
});

describe('warmupItems / WarmupChecklist', () => {
  const env = { daily: 3, doneToday: 1, correctToday: 1, due: 2, remaining: 2, done: false, href: '/envelope?n=2' };
  const base = {
    envelope: env,
    recognize: null,
    refresh: { on: false },
    patternRecallDue: 0,
    warmupDue: { cards: 1, reviews: 0 },
  } as unknown as TodayState;
  it('one count wording: "2 of 3 left", drill cards first', () => {
    const items = warmupItems(base);
    expect(items.map((i) => i.key)).toEqual(['cards', 'envelope']);
    expect(items[1].count).toBe('2 of 3 left');
    expect(items[0].count).toBe('1 due');
  });
  it('past the daily reps, only due cards: "1 due"', () => {
    const items = warmupItems({ ...base, envelope: { ...env, doneToday: 7, due: 1, remaining: 1 } } as TodayState);
    expect(items.find((i) => i.key === 'envelope')?.count).toBe('1 due');
  });
  it('rows are links with no buttons, so the step keeps the one Start', () => {
    const out = html(<WarmupChecklist items={warmupItems(base)} />);
    expect(out).toContain('href="/envelope?n=2"');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('Start');
  });
});

describe('TargetCard', () => {
  it('shows the reason and links to the target', () => {
    const out = html(<TargetCard target={WEEK.target} />);
    expect(out).toContain('Target next');
    expect(out).toContain('Stack is under 50% this week.');
    expect(out).toContain('href="/manual?topic=stack&amp;difficulty=easy"');
    expect(out).toContain('Practice it');
  });
});

describe('leverArea', () => {
  it('picks the lowest verdict, skips rounds not in the loop, ties keep order', () => {
    expect(leverArea([area('algos', 'close'), area('behavioral', 'not-yet', false), area('coding', 'not-enough')])?.id).toBe('coding');
    expect(leverArea([area('algos', 'not-yet'), area('coding', 'not-yet')])?.id).toBe('algos');
    expect(leverArea([area('algos', 'ready')])).toBeNull();
  });
  it('maps each area to a place to practise', () => {
    expect(leverHref(area('algos', 'close'))).toBe('/grind');
    expect(leverHref(area('system-design', 'close'))).toBe('/mock?kind=system-design');
  });
});

describe('LeverLine', () => {
  const areas = [area('algos', 'close'), area('system-design', 'not-yet')];
  it('closed: the hint, one quiet link and the dot row, no tiles', () => {
    const out = html(<LeverLine areas={areas} />);
    expect(out).toContain('push system-design');
    expect(out).toContain('href="/mock?kind=system-design"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('id="readiness-tiles"');
  });
  it('open: the full tiles render', () => {
    const out = html(<LeverLine areas={areas} defaultOpen />);
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('id="readiness-tiles"');
  });
  it('all ready: a calm line, no Start', () => {
    const out = html(<LeverLine areas={[area('algos', 'ready')]} />);
    expect(out).toContain('Every area reads ready.');
    expect(out).not.toContain('Start');
  });
  it('no areas: renders nothing', () => {
    expect(html(<LeverLine areas={[]} />)).toBe('');
  });
});

describe('WeekPanel', () => {
  const out = html(<WeekPanel week={WEEK} />);
  it('counts days and draws 7 dots', () => {
    expect(out).toMatch(/>2<\/span> of 7 days/);
    expect(out.match(/rounded-full bg-emerald-400/g)).toHaveLength(2);
    expect(out).toContain('aria-label="2026-10-15: no practice"');
  });
  it('labels the daily/free split approximate', () => {
    expect(out).toContain('4 daily, 5 free (approx.)');
  });
  it('shows the top 3 topics only', () => {
    expect(out).toContain('Trees');
    expect(out).not.toContain('Heap');
  });
  it('near misses with the unaided fixes', () => {
    expect(out).toContain('3 near-misses');
    expect(out).toContain('1 fixed on your own');
  });
  it('caps untouched chips at 4', () => {
    expect(out).toContain('Binary-Search');
    expect(out).not.toContain('Graphs');
  });
  it('weekdayOf reads the local date', () => {
    expect(weekdayOf('2026-10-21')).toBe('Wed');
  });
});
