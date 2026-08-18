// =============================================================================
// The hints and the manual are one document, and this is the seam
// =============================================================================
// A contextual hint is a POINTER into a Help section, not a second explanation
// of the same thing — see help-content.ts for why. That arrangement only holds
// if two properties are enforced mechanically:
//
//   1. every hint's destination is a section that exists, and
//   2. every declared section is actually rendered by the page,
//
// because breaking either one produces the same symptom — a "read more" link
// that lands on nothing — and neither one is visible in a diff. Property 2 is
// asserted in HelpPage.test.tsx, which renders the page; property 1 and the copy
// invariants are here.

import { describe, it, expect } from 'vitest';
import {
  HELP_HINTS,
  HELP_HINT_IDS,
  HELP_ROUTE,
  HELP_SECTIONS,
  MAX_HINT_PARAGRAPHS,
  HINT_LEVELS,
  helpHref,
  helpSection,
  hintDestination,
  type HelpSectionId,
} from './help-content';
import { MAX_HINT_LEVEL } from './help-facts';

const SECTION_IDS = HELP_SECTIONS.map((s) => s.id);

describe('the section list', () => {
  it('has unique ids', () => {
    expect(new Set(SECTION_IDS).size).toBe(SECTION_IDS.length);
  });

  it('uses ids that are safe as URL fragments', () => {
    // They become `#anchors` and `getElementById` arguments. A space or a
    // capital here fails silently — the link works, the scroll does not.
    for (const id of SECTION_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('gives every section a title and a one-line summary', () => {
    for (const s of HELP_SECTIONS) {
      expect(s.title.trim(), s.id).not.toBe('');
      expect(s.summary.trim(), s.id).not.toBe('');
      // The summary sits in a two-column contents list; a paragraph there wraps
      // into the next row and stops reading as a list.
      expect(s.summary.length, s.id).toBeLessThan(120);
    }
  });

  it('throws on an unknown id rather than returning undefined', () => {
    // The ids are a closed union, so reaching this means a cast or a bad JSON
    // round-trip — and a silent `undefined` would render an empty heading.
    expect(() => helpSection('nope' as HelpSectionId)).toThrow(/unknown help section/);
  });

  it('builds hrefs against one route constant', () => {
    for (const id of SECTION_IDS) expect(helpHref(id)).toBe(`${HELP_ROUTE}#${id}`);
  });
});

describe('the hints', () => {
  it('all point at a section that exists', () => {
    for (const id of HELP_HINT_IDS) {
      expect(SECTION_IDS, `hint "${id}"`).toContain(HELP_HINTS[id].section);
      expect(hintDestination(id).id).toBe(HELP_HINTS[id].section);
    }
  });

  it('stay short enough to be a hint', () => {
    for (const id of HELP_HINT_IDS) {
      const hint = HELP_HINTS[id];
      expect(hint.body.length, `hint "${id}" has no body`).toBeGreaterThan(0);
      // Past three paragraphs it is not a hint any more, it is a section that
      // has been pasted into a popover.
      expect(hint.body.length, `hint "${id}"`).toBeLessThanOrEqual(MAX_HINT_PARAGRAPHS);
      for (const paragraph of hint.body) {
        expect(paragraph.trim(), `hint "${id}"`).not.toBe('');
      }
    }
  });

  it('have a title short enough to sit above the body', () => {
    for (const id of HELP_HINT_IDS) {
      expect(HELP_HINTS[id].title.trim(), id).not.toBe('');
      expect(HELP_HINTS[id].title.length, id).toBeLessThan(40);
    }
  });

  it('carry no markup — the popover renders them as plain text', () => {
    for (const id of HELP_HINT_IDS) {
      for (const paragraph of HELP_HINTS[id].body) {
        expect(paragraph, `hint "${id}"`).not.toMatch(/<[a-z/]|\[.+\]\(.+\)/i);
      }
    }
  });

  it('covers the surfaces a new user gets stuck on', () => {
    // Not an exhaustive list — a floor. These are the five words on Reflect, the
    // two signals on Grind and the two controls on the solve surface that mean
    // nothing without the mechanism behind them, and losing one of them to a
    // refactor should be a test failure rather than a discovery.
    expect(HELP_HINT_IDS.sort()).toEqual(
      [
        'assistance-level',
        'cold-review',
        'hint-free',
        'mastery',
        'review-due',
        'skill-tree',
        'tiers-cleared',
        'verdict',
        'why-this-problem',
      ].sort(),
    );
  });
});

describe('the hint-level ladder', () => {
  it('runs 1..MAX_HINT_LEVEL, which is pinned to the route that clamps it', () => {
    expect(HINT_LEVELS).toEqual([1, 2, 3]);
    expect(HINT_LEVELS.length).toBe(MAX_HINT_LEVEL);
    expect(HINT_LEVELS[HINT_LEVELS.length - 1]).toBe(MAX_HINT_LEVEL);
  });
});
