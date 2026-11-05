// The post-submit "3-min fix" offer: rendered only when the coaching event
// carried one, and it links to Learn (where the fix lesson is written on an
// explicit click — the panel itself never triggers a generation).
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { CoachingBrief, CoachNudge } from '@/shared/types';
import { CoachPanel } from './CoachPanel';

const BRIEF: CoachingBrief = {
  approach: 'You looped twice.',
  missed: [],
  pattern: 'binary search',
  patternRecognition: 'Sorted input.',
  complexity: { yours: 'O(n)', optimal: 'O(log n)' },
  improvement: 'Pick one template.',
  mistakeTags: ['off-by-one'],
};

const OFFER: CoachNudge = {
  intent: 'fix',
  topic: 'binary-search',
  tag: 'off-by-one',
  reason: 'Because you slipped on off-by-one',
  lessonId: 'fix:off-by-one:binary-search',
  title: 'Fixing off-by-one in binary-search',
  kind: 'mistake',
  cached: false,
  practice: { topic: 'binary-search', difficulty: 'easy', tag: 'off-by-one' },
};

const render = (fixOffer?: CoachNudge) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <CoachPanel brief={BRIEF} fixOffer={fixOffer} />
    </MemoryRouter>,
  );

describe('CoachPanel fix offer', () => {
  it('shows "Slipped on X twice — 3-min fix →" linking to Learn', () => {
    const html = render(OFFER);
    expect(html).toContain('Slipped on off-by-one twice — 3-min fix →');
    expect(html).toContain('href="/study"');
  });

  it('is absent without an offer', () => {
    expect(render()).not.toContain('3-min fix');
  });
});
