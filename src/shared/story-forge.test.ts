// =============================================================================
// story-forge — the pure rules (Phase H4)
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  draftSavable,
  enforceSaidNumbers,
  forgeDay,
  numberTokens,
  retellCard,
  retellLength,
  type StoryDraft,
} from './story-forge.js';

const D: StoryDraft = {
  title: 'One runner for every platform',
  question: 'Tell me about a time you got other teams to adopt a change you could not mandate.',
  situation: 'Local and CI test runs disagreed on four platforms.',
  task: 'I was a contractor asked to fix flaky CI.',
  action: 'I made repo-owned scripts the single entry point and rewired Jenkins to call them.',
  result: 'Local and CI runs became the same commands.',
  complication: 'The iOS team resisted at first.',
  beats: ['Local and CI became identical across four platforms.', 'A four-week contract on flaky CI.', 'Repo-owned scripts; Jenkins calls them.'],
  numbers: ['four platforms', '4 weeks'],
  caveats: [],
  unconfirmed: [],
  fits: ['influence without authority'],
};

describe('the never-invent rule (deterministic half)', () => {
  it('reads numbers out of text, normalized', () => {
    expect(numberTokens('$3,000/month to ~$300, 90% lower, 2.5x, 5-10 engineers')).toEqual(['3000', '300', '90', '2.5', '5', '10']);
  });

  it('keeps numbers the candidate said and moves coach-invented ones to unconfirmed', () => {
    const draft = { ...D, numbers: ['4 weeks', '30% fewer flaky runs'], result: 'Flaky runs fell 30% and local matched CI.' };
    const { draft: out, moved } = enforceSaidNumbers(draft, ['it was a 4 week contract', 'flaky runs went way down']);
    expect(out.numbers).toEqual(['4 weeks']);
    expect(moved).toEqual(['30% fewer flaky runs', '30']);
    expect(out.unconfirmed.join('\n')).toMatch(/Confirm the number \(the coach wrote it, you did not say it\): 30% fewer flaky runs/);
    expect(out.unconfirmed.join('\n')).toMatch(/Confirm 30 in the result/);
    // The prose is never rewritten: the claim stays visible, flagged.
    expect(out.result).toBe(draft.result);
  });

  it('leaves a draft alone when every number was said', () => {
    const { draft: out, moved } = enforceSaidNumbers({ ...D, numbers: ['4 weeks'] }, ['four platforms, about 4 weeks']);
    expect(moved).toEqual([]);
    expect(out.unconfirmed).toEqual([]);
  });

  it('needs a title, situation, action and result to save', () => {
    expect(draftSavable(D)).toBe(true);
    expect(draftSavable({ ...D, result: ' ' })).toBe(false);
    expect(draftSavable(null)).toBe(false);
  });
});

describe('retell cards', () => {
  it('front = "2-minute retell: Tell me about a time…", back = three beats + the number', () => {
    const c = retellCard(D, 'influence-without-authority');
    expect(c.title).toBe('2-minute retell: Tell me about a time you got other teams to adopt a change you could not mandate.');
    expect(c.answer).toMatch(/^Story: One runner for every platform\. 1\) Local and CI.* 2\) A four-week.* 3\) Repo-owned.* The number: four platforms\.$/);
  });

  it('falls back to the catalog question and first sentences, and says when no number is confirmed', () => {
    const c = retellCard({ ...D, question: 'How did you…', beats: [], numbers: [] }, 'conflict');
    expect(c.title).toMatch(/^2-minute retell: Tell me about a time/);
    expect(c.answer).toMatch(/1\) Local and CI runs became the same commands\./);
    expect(c.answer).toMatch(/The number: none confirmed yet/);
  });

  it('checks the dictated length against the two-minute band', () => {
    expect(retellLength('word '.repeat(100)).verdict).toBe('short');
    expect(retellLength('word '.repeat(300))).toMatchObject({ verdict: 'ok', words: 300 });
    expect(retellLength('word '.repeat(600)).verdict).toBe('long');
  });
});

describe('Today: the forge-day rule', () => {
  // 2026-10-21 is day 20747 since the epoch: 20747 % 3 = 2, % 2 = 1.
  const base = { openGaps: 2, behavioralLoopDays: null, repDoneToday: false, forgeDoneToday: false };
  it('open gaps → every third day', () => {
    expect(forgeDay({ ...base, date: '2026-10-21' })).toBe(false);
    expect(forgeDay({ ...base, date: '2026-10-22' })).toBe(true);
    expect(forgeDay({ ...base, date: '2026-10-23' })).toBe(false);
    expect(forgeDay({ ...base, date: '2026-10-25' })).toBe(true);
  });
  it('no gaps → never; unknown gaps count as gaps', () => {
    expect(forgeDay({ ...base, openGaps: 0, date: '2026-10-22' })).toBe(false);
    expect(forgeDay({ ...base, openGaps: null, date: '2026-10-22' })).toBe(true);
  });
  it('a behavioral round within 7 days → every other day, gaps or not', () => {
    const near = { ...base, openGaps: 0, behavioralLoopDays: 5 };
    expect(forgeDay({ ...near, date: '2026-10-22' })).toBe(true);
    expect(forgeDay({ ...near, date: '2026-10-23' })).toBe(false);
    expect(forgeDay({ ...near, behavioralLoopDays: 9, date: '2026-10-22' })).toBe(false);
  });
  it('what was done today keeps the day', () => {
    expect(forgeDay({ ...base, date: '2026-10-22', repDoneToday: true })).toBe(false);
    expect(forgeDay({ ...base, date: '2026-10-21', forgeDoneToday: true })).toBe(true);
  });
});
