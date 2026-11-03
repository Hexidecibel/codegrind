// Home's top card: one Start / Continue for the current step; the step list's
// default open state. Static render, no jsdom.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { TodayState, TodayStep } from '@/shared/today';
import type { WeeklyResponse } from '@/shared/weekly';
import { CurrentStepCard, PhoneToday, phoneSessionItems, stepsOpenByDefault } from './HomePage';

function step(id: TodayStep['id'], status: TodayStep['status']): TodayStep {
  return { id, label: `Label ${id}`, status, href: `/x?from=today&step=${id}`, detail: `Detail ${id}`, result: null, ok: null };
}

function state(steps: TodayStep[], current: TodayState['current'], completed = 0): TodayState {
  return {
    steps,
    current,
    completed,
    total: steps.length,
    envelope: null,
    recognize: null,
    refresh: { on: false },
    stepNotes: {},
    aiPending: [],
  } as unknown as TodayState;
}

const render = (s: TodayState) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <CurrentStepCard state={s} busy={false} onSkip={() => undefined} />
    </MemoryRouter>,
  );

describe('stepsOpenByDefault', () => {
  it('closed before the first step, open mid-day, closed once complete', () => {
    expect(stepsOpenByDefault(state([step('warmup', 'current')], 'warmup', 0))).toBe(false);
    expect(stepsOpenByDefault(state([step('warmup', 'done'), step('problem1', 'current')], 'problem1', 1))).toBe(true);
    expect(stepsOpenByDefault(state([step('mock', 'in-progress')], 'mock', 0))).toBe(true);
    expect(stepsOpenByDefault(state([step('warmup', 'done')], null, 1))).toBe(false);
  });
});

describe('CurrentStepCard', () => {
  it('one big Start for the current step, with Skip', () => {
    const out = render(state([step('warmup', 'done'), step('problem1', 'current')], 'problem1', 1));
    expect(out).toContain('Label problem1');
    expect(out).toContain('href="/x?from=today&amp;step=problem1"');
    expect(out).toContain('Start');
    expect(out).toContain('Skip step');
    expect(out).not.toContain('Label warmup');
  });
  it('the warm-up: ONE primary Start; its piles are a checklist with one count wording', () => {
    const s = state([step('warmup', 'current'), step('problem1', 'todo')], 'warmup');
    Object.assign(s, {
      envelope: { daily: 3, doneToday: 1, correctToday: 1, due: 2, remaining: 2, done: false, href: '/envelope?n=2' },
      recognize: { recommended: false, reason: 'r', doneToday: 0, done: false, due: 0, href: '/recognize?n=5' },
      warmupDue: { cards: 1, reviews: 0 },
      patternRecallDue: 0,
    });
    const out = render(s);
    expect(out.match(/>Start\b/g)).toHaveLength(1);
    expect(out.match(/h-12/g)).toHaveLength(1);
    expect(out).toContain('aria-label="In the warm-up"');
    expect(out).toContain('2 of 3 left');
    expect(out).toContain('Drill cards');
    expect(out).toContain('Recognize ×5');
    expect(out).not.toContain('Detail warmup');
  });
  it('an in-progress step says Continue', () => {
    expect(render(state([step('mock', 'in-progress')], 'mock'))).toContain('Continue');
  });
  it('the day complete: a calm line and the debrief button', () => {
    const out = render(state([step('warmup', 'done'), step('debrief', 'done')], null, 2));
    expect(out).toContain('Day complete.');
    expect(out).toContain('Read the debrief');
  });
});

// -----------------------------------------------------------------------------
// The phone's Today
// -----------------------------------------------------------------------------

function phoneState(steps: TodayStep[], extra: Partial<TodayState> = {}): TodayState {
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const cur = steps.find((s) => s.status === 'current' || s.status === 'in-progress');
  return {
    ...state(steps, cur?.id ?? null, done),
    date: '2026-11-03',
    streak: 4,
    mockKind: 'behavioral',
    readiness: [{ id: 'algos', label: 'Algorithms', verdict: 'close', hint: 'A long hint sentence.', evidence: 'e' }],
    nextLoop: null,
    spend: { todayUsd: 0.12, monthUsd: 3.4, todayCalls: 2 },
    quick: false,
    endedEarly: false,
    patternRecallDue: 0,
    warmupDue: { cards: 0, reviews: 0 },
    recognize: { recommended: false, reason: 'r', doneToday: 0, done: false, due: 2, href: '/recognize?n=5' },
    envelope: { daily: 5, doneToday: 5, correctToday: 4, due: 0, remaining: 0, done: true, href: '/envelope' },
    ...extra,
  } as unknown as TodayState;
}

const week = {
  days: 7,
  activeDays: 3,
  daily: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-2${i}`, practiced: i % 2 === 0 })),
  volume: { subs: 9, problems: 4, grindSubs: 5, freeSubs: 4 },
  topics: [{ topic: 'arrays', solvedPct: 50, attempts: 4 }],
  nearMisses: { count: 1, fixedUnaided: 0 },
  untouched: ['graphs'],
  target: null,
  mocks: {},
  reviewDue: [],
} as unknown as WeeklyResponse;

const renderPhone = (s: TodayState) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <PhoneToday state={s} week={week} busy={false} onSkip={() => undefined} onTurnOffRefresh={() => undefined} />
    </MemoryRouter>,
  );

describe('PhoneToday', () => {
  const normal = [
    step('warmup', 'done'),
    step('concept', 'done'),
    step('problem1', 'current'),
    step('problem2', 'todo'),
    step('mock', 'todo'),
    step('debrief', 'locked'),
  ];

  it('one Start, and it points at the next PHONE step, past the coding ones', () => {
    const out = renderPhone(phoneState(normal));
    expect(out.match(/>Start\b/g)).toHaveLength(1);
    expect(out).toContain('href="/x?from=today&amp;step=mock"');
    expect(out).not.toContain('href="/x?from=today&amp;step=problem1"');
  });

  it('lists the phone steps, and folds the iPad ones into one closed row', () => {
    const out = renderPhone(phoneState(normal));
    const phoneList = /<ol aria-label="Phone steps"[\s\S]*?<\/ol>/.exec(out)![0];
    expect(phoneList).toContain('Label warmup');
    expect(phoneList).toContain('Label mock');
    expect(phoneList).not.toContain('Label problem1');
    expect(out).toMatch(/On iPad · <span[^>]*>2<\/span>/);
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('aria-label="On iPad"');
  });

  it('a coding mock: the phone is done, so the Phone session shows instead, with no Start', () => {
    const out = renderPhone(phoneState(normal, { mockKind: 'coding' } as Partial<TodayState>));
    expect(out).not.toMatch(/>Start\b/);
    expect(out).toContain('aria-label="Phone session"');
    expect(out).toContain('href="/recognize?n=5"');
    expect(out).toContain('href="/envelope?n=5"');
    expect(out).toContain('href="/study"');
    expect(out).toContain('2 due');
  });

  it('hides the big-screen detail: readiness hint, target, AI spend, end day early, the week\'s volume', () => {
    const out = renderPhone(phoneState(normal));
    expect(out).not.toContain('A long hint sentence.');
    expect(out).not.toContain('Work on it');
    expect(out).not.toContain('AI $');
    expect(out).not.toContain('End day early');
    expect(out).not.toContain('Target');
    expect(out).toContain('aria-label="Days practised"');
    expect(out).not.toContain('submits on');
  });

  it('the warm-up\'s Next card leaves the review problems to the iPad', () => {
    const s = phoneState([step('warmup', 'current'), step('concept', 'todo')], {
      warmupDue: { cards: 2, reviews: 3 },
      envelope: { daily: 5, doneToday: 0, correctToday: 0, due: 0, remaining: 5, done: false, href: '/envelope?n=5' },
    } as Partial<TodayState>);
    const out = renderPhone(s);
    expect(out).toContain('Drill cards');
    expect(out).not.toContain('Review problems');
  });
});

describe('phoneSessionItems', () => {
  it('adds pattern recall only when some are due, and always ends with one lesson', () => {
    const base = { recognize: null, envelope: null, patternRecallDue: 0 } as unknown as TodayState;
    expect(phoneSessionItems(base).map((i) => i.key)).toEqual(['recognize', 'envelope', 'lesson']);
    expect(phoneSessionItems({ ...base, patternRecallDue: 2 }).map((i) => i.key)).toEqual(['recognize', 'envelope', 'recall', 'lesson']);
  });
});
