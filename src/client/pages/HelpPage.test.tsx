// =============================================================================
// The manual renders every section it advertises
// =============================================================================
// HELP_SECTIONS is the single list that produces the contents at the top of the
// page, the `id` on each anchored heading, and the destination of every
// contextual hint's "read more" link. Those three uses are what make it worth
// declaring as data — and they are also three ways for a hint to end up pointing
// at an anchor that does not exist, none of which fails a typecheck.
//
// So: render the real page and check that every declared section is actually
// there, with the heading its declaration promised.
//
// The page is rendered with `renderToStaticMarkup` (no jsdom in this repo, see
// HelpHint.test.tsx). Effects do not run, which is fine — the only effect here
// is the deep-link scroll, and what matters for that is the anchors, which are
// markup.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { HelpPage } from './HelpPage';
import { HELP_HINTS, HELP_HINT_IDS, HELP_SECTIONS } from '@/client/lib/help-content';
import {
  MAX_HINT_LEVEL,
  MIN_HIDDEN_TESTS,
  REVIEW_LADDER_DAYS,
  SANDBOX_FLAGS,
  TIER_REQUIREMENT,
} from '@/client/lib/help-facts';
import { VERDICT_META } from '@/client/components/ResultsPanel';
import { KIND_META } from '@/client/components/CoachBanner';

const html = renderToStaticMarkup(
  <MemoryRouter initialEntries={['/help']}>
    <HelpPage />
  </MemoryRouter>,
);

describe('the anchors', () => {
  it('renders one section per declaration, with its declared heading', () => {
    for (const section of HELP_SECTIONS) {
      expect(html, `no <section id="${section.id}">`).toContain(`id="${section.id}"`);
      expect(html, `no heading for ${section.id}`).toContain(section.title);
      expect(html, `no summary for ${section.id}`).toContain(section.summary);
    }
  });

  it('lands every hint\'s "read more" link on a real anchor', () => {
    for (const id of HELP_HINT_IDS) {
      expect(html, `hint "${id}" points at a missing section`).toContain(
        `id="${HELP_HINTS[id].section}"`,
      );
    }
  });

  it('lists every section in the contents, and nothing else', () => {
    const contents = /<nav aria-label="Help contents">([\s\S]*?)<\/nav>/.exec(html);
    expect(contents, 'no contents nav').not.toBeNull();
    const linked = [...contents![1].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(linked).toEqual(HELP_SECTIONS.map((s) => s.id));
  });
});

describe('the closed vocabularies are explained in full', () => {
  it('gives every verdict its own line, under the label the app draws', () => {
    for (const meta of Object.values(VERDICT_META)) {
      expect(html, `verdict "${meta.label}" is undocumented`).toContain(meta.label);
    }
  });

  it('gives every scheduler intent kind its own line', () => {
    for (const meta of Object.values(KIND_META)) {
      expect(html, `intent "${meta.label}" is undocumented`).toContain(meta.label);
    }
  });
});

describe('the numbers on the page come from the pinned facts', () => {
  // Not a re-test of help-facts.test.ts (which pins the facts to the CODE) —
  // this checks the page actually prints them rather than quietly wording its
  // way around them, which is how prose goes stale while the constants stay
  // right.
  it('states the tier requirement', () => {
    expect(html).toContain(`${TIER_REQUIREMENT} credits complete a`);
  });

  it('states the hidden-test floor and the hint ceiling', () => {
    expect(html).toContain(`${MIN_HIDDEN_TESTS} hidden tests`);
    expect(html).toContain(`${MAX_HINT_LEVEL} levels`);
  });

  it('prints the review ladder in full', () => {
    for (const days of REVIEW_LADDER_DAYS) expect(html).toContain(`${days}d`);
  });

  it('quotes the sandbox flags verbatim, so the claim can be grepped for', () => {
    for (const flag of SANDBOX_FLAGS) {
      // The page renders them inside <code>; HTML-escape the one that needs it.
      expect(html, flag).toContain(flag.replace(/&/g, '&amp;'));
    }
  });
});

describe('the page is self-contained', () => {
  it('needs no data fetch to render', () => {
    // Deliberate: Help is where you send someone whose install is misconfigured
    // and whose every other page is showing an error. A loading state here would
    // mean the manual can fail for the same reason the app did.
    expect(html).not.toContain('Loading');
    expect(html.length).toBeGreaterThan(4000);
  });
});
