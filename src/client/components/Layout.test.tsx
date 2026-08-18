// =============================================================================
// Six tabs still fit the header
// =============================================================================
// The nav is a fixed-width budget spent across four breakpoints (Layout's own
// header comment does the arithmetic). Adding Help was the sixth tab, and paying
// for it meant taking pixels back from the wordmark and the tagline — decisions
// that live entirely in Tailwind class strings and are therefore invisible to
// the compiler, to the linter, and to every other test in this repo.
//
// A class-string assertion is a weak test in general. It is the right one HERE
// because the failure it guards is specific and silent: someone adds a seventh
// tab, or re-labels Settings from `md`, or restores the wordmark below `sm`, and
// nothing goes wrong until a header overflows on a 390px phone that nobody is
// holding. There is no DOM in this test runner and therefore no layout to
// measure — so what is pinned is the BUDGET's terms, one assertion per thing
// that was traded away, each naming what it paid for.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';
import { HELP_ROUTE } from '@/client/lib/help-content';

function render(path = '/') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Layout>
        <p>content</p>
      </Layout>
    </MemoryRouter>,
  );
}

/** Every `href` in the rendered header nav, in document order. */
function navHrefs(html: string): string[] {
  const nav = /<nav [^>]*>([\s\S]*?)<\/nav>/.exec(html);
  if (!nav) throw new Error('no <nav> in the rendered Layout');
  return [...nav[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
}

describe('the nav', () => {
  it('has exactly six destinations, Help last', () => {
    expect(navHrefs(render())).toEqual([
      '/',
      '/manual',
      '/progress',
      '/study',
      '/settings',
      HELP_ROUTE,
    ]);
  });

  it('renders the app children below it', () => {
    expect(render()).toContain('<p>content</p>');
  });

  it('marks the active tab from the current route', () => {
    // NavLink's own job, but it is what makes six identical glyphs navigable at
    // all on a phone, where five of them have no label.
    const help = /<a[^>]*href="\/help"[^>]*>/.exec(render(HELP_ROUTE));
    expect(help?.[0]).toContain('bg-secondary');
    const grind = /<a[^>]*href="\/help"[^>]*>/.exec(render('/'));
    expect(grind?.[0]).not.toContain('bg-secondary');
  });
});

describe('every tab is usable with no label showing', () => {
  it('names each one for a screen reader and for a hover tooltip', () => {
    // Below `sm` the nav is six bare glyphs. Without these it is six unlabelled
    // links, which is unusable rather than merely terse.
    const html = render();
    for (const label of ['Grind', 'Manual', 'Reflect', 'Study', 'Settings', 'Help']) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
    }
  });

  it('keeps a 44px touch target where the label is hidden', () => {
    // With no label the text line-box no longer sets the height; without
    // min-h/min-w these collapse to roughly 40×28.
    const anchors = [...render().matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(anchors).toHaveLength(6);
    for (const cls of anchors) {
      expect(cls).toContain('min-h-11');
      expect(cls).toContain('min-w-11');
    }
  });
});

describe('the header budget', () => {
  const html = render();

  it('labels the four content tabs from `sm` and the two utility tabs from `md`', () => {
    // Six labels do not fit `sm`. The two that wait are the gear and the
    // question mark — the only two glyphs that already mean their word.
    const labelled = [...html.matchAll(/<span class="hidden (sm|md):inline">([^<]+)<\/span>/g)];
    const byBreakpoint: Record<string, string[]> = { sm: [], md: [] };
    for (const [, bp, label] of labelled) byBreakpoint[bp].push(label);
    expect(byBreakpoint.sm).toEqual(['Grind', 'Manual', 'Reflect', 'Study']);
    expect(byBreakpoint.md).toEqual(['Settings', 'Help']);
  });

  it('pays for the sixth tab with the wordmark, without hiding it from a reader', () => {
    // `sr-only`, not `hidden`: the app's name stays in the accessibility tree at
    // every width and only stops taking layout space on a phone.
    expect(html).toMatch(/class="sr-only[^"]*sm:not-sr-only[^"]*"[^>]*>\s*codegrind/);
    expect(html).not.toMatch(/class="hidden[^"]*"[^>]*>\s*codegrind/);
  });

  it('holds the tagline back to `lg`, where there is finally room for it', () => {
    // It used to appear at `sm`; at `md` the six labels and the wordmark have
    // already spent the row.
    const tagline = /<span class="([^"]*)">\s*AI-coached interview prep/.exec(html);
    expect(tagline, 'the tagline is gone').not.toBeNull();
    expect(tagline![1]).toContain('lg:inline');
    expect(tagline![1]).not.toContain('sm:inline');
  });
});
