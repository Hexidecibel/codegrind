// The phone's tab bar. No DOM in this runner, so what is pinned is the markup:
// five tabs, which one is lit, the tap-target and safe-area classes, and that
// the bar only ever shows on a phone.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BottomTabBar, activeTab, keyboardUp } from './BottomTabBar';
import { Layout } from './Layout';

function render(path = '/home') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <BottomTabBar />
    </MemoryRouter>,
  );
}

const tabs = (html: string) => [...html.matchAll(/<(a|button)\b[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
const current = (html: string) => /<a[^>]*aria-current="page"[^>]*href="([^"]+)"|<a[^>]*href="([^"]+)"[^>]*aria-current="page"/.exec(html);

describe('BottomTabBar', () => {
  it('has five tabs, each an icon and a label', () => {
    const t = tabs(render());
    expect(t).toHaveLength(5);
    const labels = t.map((x) => />([^<>]+)<\/span>/.exec(x)?.[1]);
    expect(labels).toEqual(['Home', 'Drills', 'Learn', 'Progress', 'More']);
    for (const x of t) expect(x).toContain('<svg');
    expect([...render().matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/home', '/practice', '/study', '/progress']);
  });

  it('lights the owning tab', () => {
    const lit = (p: string) => { const m = current(render(p)); return m ? m[1] ?? m[2] : null; };
    expect(lit('/home')).toBe('/home');
    expect(lit('/today')).toBe('/home');
    for (const p of ['/practice', '/recognize', '/envelope', '/concept', '/stories']) expect(lit(p), p).toBe('/practice');
    for (const p of ['/study', '/patterns', '/concepts', '/concepts/rag']) expect(lit(p), p).toBe('/study');
    expect(lit('/progress')).toBe('/progress');
    expect(lit('/mock')).toBeNull();
  });

  it('lights More for the places behind it', () => {
    for (const p of ['/mock', '/settings', '/help', '/grind', '/manual']) expect(activeTab(p), p).toBe('more');
    expect(activeTab('/somewhere')).toBeNull();
  });

  it('gives every tab a 56px target that shares the row', () => {
    for (const x of tabs(render())) {
      expect(x).toContain('min-h-14');
      expect(x).toContain('flex-1');
    }
  });

  it('sits above the home indicator, and only shows on a phone', () => {
    const nav = /<nav [^>]*class="([^"]*)"/.exec(render())![1];
    expect(nav).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(nav).toMatch(/(^|\s)hidden(\s|$)/);
    expect(nav).toContain('phone:flex');
  });

  it('comes after <main> in the shell, and the header hides on a phone', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/home']}><Layout><p>x</p></Layout></MemoryRouter>,
    );
    expect(html.indexOf('aria-label="Tabs"')).toBeGreaterThan(html.indexOf('</main>'));
    expect(/<header class="([^"]*)"/.exec(html)![1]).toContain('phone:hidden');
  });

  it('hides Practice\'s sub-nav on a phone, but not Learn\'s', () => {
    const strip = (p: string) =>
      /<nav aria-label="Section" class="([^"]*)"/.exec(
        renderToStaticMarkup(<MemoryRouter initialEntries={[p]}><Layout><p /></Layout></MemoryRouter>),
      )![1];
    expect(strip('/grind')).toContain('phone:hidden');
    expect(strip('/patterns')).not.toContain('phone:hidden');
  });
});

describe('keyboardUp', () => {
  it('is up when the visual viewport is well under the tallest it has been', () => {
    expect(keyboardUp(500, 844)).toBe(true);
    expect(keyboardUp(800, 844)).toBe(false);
    expect(keyboardUp(null, 844)).toBe(false);
    expect(keyboardUp(844, null)).toBe(false);
  });
});
