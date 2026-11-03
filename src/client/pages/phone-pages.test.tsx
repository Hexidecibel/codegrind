// The phone's versions of the coding and reference pages, rendered as a phone
// sees them: `window.matchMedia` answers the PHONE_QUERY, so every
// useIsPhone() starts true. Markup only (no DOM in this runner).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PHONE_QUERY } from '@/client/hooks/useMediaQuery';
import { GrindPage } from './GrindPage';
import { WorkspacePage } from './WorkspacePage';
import { MockPage } from './MockPage';
import { Section } from '@/client/components/reflect/primitives';

function asDevice(phone: boolean, opened: Record<string, string> = {}) {
  const store = { ...opened };
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({
      matches: phone && q === PHONE_QUERY,
      addEventListener() {},
      removeEventListener() {},
    }),
    localStorage: { getItem: () => null, setItem() {} },
    innerWidth: phone ? 390 : 1280,
  });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => (store[k] = v),
  });
}

const at = (path: string, el: React.ReactElement, pattern = path.split('?')[0]) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={el} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('coding places on a phone', () => {
  beforeEach(() => asDevice(true));

  it('/grind offers Recognize ×5 instead', () => {
    const html = at('/grind', <GrindPage />);
    expect(html).toContain('Code this on iPad.');
    expect(html).toMatch(/href="\/recognize\?n=5"[^>]*>Do Recognize ×5 instead/);
  });

  it('/manual offers to read the problem', () => {
    const html = at('/manual', <WorkspacePage />);
    expect(html).toContain('Code this on iPad.');
    expect(html).toMatch(/<button[^>]*>Read it<\/button>/);
  });

  it('/manual?problem= offers to plan that problem in Recognize', () => {
    const html = at('/manual?problem=p-1', <WorkspacePage />);
    expect(html).toContain('href="/recognize?problem=p-1"');
    expect(html).toContain('Plan the approach');
    expect(html).not.toContain('Read it');
  });

  it('Open anyway is remembered for the session', () => {
    asDevice(true, { 'codegrind.openAnyway.grind': '1' });
    expect(at('/grind', <GrindPage />)).not.toContain('Code this on iPad.');
  });

  it('the mock start greys out Coding with an iPad badge and keeps the intro to one line', () => {
    const html = at('/mock', <MockPage />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Coding<span[^>]*>iPad<\/span><\/button>/);
    expect(html).toContain('A system-design interview over chat.');
    expect(html).not.toContain('pushes and moves you through the stages');
    expect(html).toContain('Tap the keyboard mic to talk.');
  });
});

describe('the same pages off a phone', () => {
  beforeEach(() => asDevice(false));

  it('/grind and /manual never show the card', () => {
    expect(at('/grind', <GrindPage />)).not.toContain('Code this on iPad.');
    expect(at('/manual', <WorkspacePage />)).not.toContain('Code this on iPad.');
  });

  it('the mock start keeps Coding and the full intro', () => {
    const html = at('/mock', <MockPage />);
    expect(html).not.toContain('>iPad<');
    expect(html).toContain('pushes and moves you through the stages');
  });
});

describe('Progress sections', () => {
  const section = () =>
    renderToStaticMarkup(
      <Section title="Trend" description="One point per problem." table={<table />} foldOnPhone>
        <p>chart</p>
      </Section>,
    );

  it('fold to their heading on a phone', () => {
    asDevice(true);
    const html = section();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Trend/);
    expect(html).not.toContain('chart');
    expect(html).not.toContain('Show data');
  });

  it('stay open elsewhere, with the caption beside the heading', () => {
    asDevice(false);
    const html = section();
    expect(html).toContain('<h2 class="text-lg font-bold">Trend</h2>');
    expect(html).toContain('chart');
    expect(html).toContain('phone:basis-full');
  });
});
