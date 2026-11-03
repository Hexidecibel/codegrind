// =============================================================================
// Five tabs and More still fit the header
// =============================================================================
// The nav is a fixed-width budget spent across breakpoints (Layout's own header
// comment does the arithmetic). Those decisions live entirely in Tailwind class
// strings, invisible to the compiler and the linter.
//
// A class-string assertion is a weak test in general. It is the right one HERE
// because the failure it guards is specific and silent: someone adds a sixth
// tab, or restores the wordmark below `sm`, and nothing goes wrong until a
// header overflows on a 390px phone that nobody is holding. There is no DOM in
// this test runner and therefore no layout to measure — so what is pinned is
// the BUDGET's terms.

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
  it('has exactly five tabs, Home first and Progress last', () => {
    expect(navHrefs(render())).toEqual(['/home', '/practice', '/mock', '/study', '/progress']);
  });

  it('keeps Settings and Help behind a More button, outside the tab row', () => {
    const html = render();
    expect(navHrefs(html)).not.toContain(HELP_ROUTE);
    expect(navHrefs(html)).not.toContain('/settings');
    expect(html).toMatch(/<button[^>]*aria-label="More"/);
  });

  it('renders the app children below it', () => {
    expect(render()).toContain('<p>content</p>');
  });

  it('marks the active tab from the current route, and the group tab on its members', () => {
    const tab = (path: string, href: string) => new RegExp(`<a[^>]*href="${href}"[^>]*>`).exec(render(path))?.[0] ?? '';
    expect(tab('/home', '/home')).toContain('bg-secondary');
    expect(tab('/today', '/home')).toContain('bg-secondary');
    for (const p of ['/grind', '/manual', '/practice', '/recognize', '/envelope', '/concept', '/stories']) {
      expect(tab(p, '/practice'), p).toContain('bg-secondary');
    }
    for (const p of ['/study', '/patterns', '/concepts', '/concepts/rag']) {
      expect(tab(p, '/study'), p).toContain('bg-secondary');
    }
    expect(tab('/grind', '/study')).not.toContain('bg-secondary');
    expect(/<button[^>]*aria-label="More"[^>]*>/.exec(render('/settings'))?.[0]).toContain('bg-secondary');
  });
});

describe('every tab is usable with no label showing', () => {
  it('names each one for a screen reader and for a hover tooltip', () => {
    const html = render();
    for (const label of ['Home', 'Practice', 'Mock', 'Learn', 'Progress', 'More']) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
    }
  });

  it('keeps a 44px touch target where the label is hidden', () => {
    const header = /<header [^>]*>([\s\S]*?)<\/header>/.exec(render())![1];
    const targets = [...header.matchAll(/<(?:a|button) [^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(targets).toHaveLength(6);
    for (const cls of targets) {
      expect(cls).toContain('min-h-11');
      expect(cls).toContain('min-w-11');
    }
  });

  it('only gives the 44px target up for a mouse (or the short landscape budget), never for width alone', () => {
    // A landscape iPad is past `sm` and `lg` and still driven by a finger.
    const header = /<header [^>]*>([\s\S]*?)<\/header>/.exec(render())![1];
    for (const [, cls] of header.matchAll(/<(?:a|button) [^>]*class="([^"]*)"/g)) {
      expect(cls).not.toMatch(/(^|\s)sm:min-h-0(\s|$)/);
      expect(cls).toContain('sm:pointer-fine:min-h-0');
    }
  });
});

describe('the sub-nav', () => {
  it('shows the Practice strip on a practice page and the Learn strip on a learn page', () => {
    expect(render('/grind')).toContain('Pick a problem');
    expect(render('/envelope')).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/practice"|<a[^>]*href="\/practice"[^>]*aria-current="page"/);
    expect(render('/patterns')).toContain('Pattern shapes');
    expect(render('/patterns')).not.toContain('Pick a problem');
  });

  it('is absent on Home, Mock and Progress', () => {
    for (const p of ['/home', '/mock', '/progress']) expect(render(p)).not.toContain('aria-label="Section"');
  });

  it('keeps 44px targets for a finger and hides in the short landscape budget', () => {
    const strip = /<nav aria-label="Section" class="([^"]*)"/.exec(render('/grind'));
    expect(strip![1]).toContain('short:hidden');
    expect(render('/grind')).toMatch(/<a[^>]*class="[^"]*min-h-11[^"]*sm:pointer-fine:min-h-9/);
  });
});

describe('the app shell', () => {
  it('follows the visual viewport at every width, so a tablet keyboard cannot cover the bottom bar', () => {
    // `lg:h-dvh` used to override --app-height from 1024px up, and iOS does not
    // shrink dvh for its keyboard. useAppHeight leaves the variable unset on a
    // mouse-driven desktop, which therefore still gets plain dvh.
    const shell = /<div class="([^"]*flex-col overflow-hidden[^"]*)"/.exec(render());
    expect(shell, 'no app shell').not.toBeNull();
    expect(shell![1]).toContain('h-[var(--app-height,100dvh)]');
    expect(shell![1]).not.toContain('lg:h-dvh');
  });
});

describe('the header budget', () => {
  const html = render();

  it('labels the five tabs and More from `md`', () => {
    const labelled = [...html.matchAll(/<span class="hidden (sm|md|lg):inline">([^<]+)<\/span>/g)];
    const byBreakpoint: Record<string, string[]> = { sm: [], md: [], lg: [] };
    for (const [, bp, label] of labelled) byBreakpoint[bp].push(label);
    expect(byBreakpoint.sm).toEqual([]);
    expect(byBreakpoint.md).toEqual(['Home', 'Practice', 'Mock', 'Learn', 'Progress', 'More']);
    expect(byBreakpoint.lg).toEqual([]);
  });

  it('drops the tab gaps on a phone', () => {
    expect(html).toMatch(/<nav class="[^"]*gap-0 sm:gap-1/);
  });

  it('hides the logo mark and the header gap below `sm`', () => {
    expect(html).toMatch(/<header class="[^"]*gap-0 sm:gap-4/);
    expect(html).toMatch(/<div class="hidden h-7 w-7[^"]*sm:flex/);
  });

  it('pays for the labels with the wordmark until `lg`, without hiding it from a reader', () => {
    // `sr-only`, not `hidden`: the app's name stays in the accessibility tree at
    // every width and only stops taking layout space on narrow screens.
    expect(html).toMatch(/class="sr-only[^"]*lg:not-sr-only[^"]*"[^>]*>\s*codegrind/);
    expect(html).not.toMatch(/class="hidden[^"]*"[^>]*>\s*codegrind/);
  });

  it('holds the tagline back to `xl`, where there is finally room for it', () => {
    // It used to appear at `sm`; at `md` the six labels and the wordmark have
    // already spent the row.
    const tagline = /<span class="([^"]*)">\s*AI-coached interview prep/.exec(html);
    expect(tagline, 'the tagline is gone').not.toBeNull();
    expect(tagline![1]).toContain('xl:inline');
    expect(tagline![1]).not.toContain('sm:inline');
  });
});
