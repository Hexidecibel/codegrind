// =============================================================================
// The one hint affordance behaves the same way at all nine call sites
// =============================================================================
// The reason to have ONE hint component is that its accessibility is then a
// property of one file rather than of nine. These tests hold that file to it.
//
// WHAT CAN AND CANNOT BE TESTED HERE. This repo has no jsdom and no
// @testing-library — every existing test runs in plain node — so the component
// is rendered with `renderToStaticMarkup`, which gives real React output for the
// CLOSED state and no way to click anything. That is a narrower test than
// "open it and read the panel", and it is deliberately not padded out with a
// fake DOM to look wider. What it does cover is exactly the part that regresses
// silently:
//
//   - the trigger is a real <button>, not a div with an onClick. This is the
//     difference between "reachable by Tab and by Enter" and "reachable by
//     mouse only", and it is one careless refactor away at all times.
//   - it has an accessible name, and that name matches the popover's heading.
//   - the ARIA the popover contract depends on (haspopup/expanded/state) is
//     actually emitted rather than assumed.
//   - the body does NOT render while closed, i.e. the hint is genuinely quiet
//     and is not nine paragraphs of help text hidden with CSS.
//
// The open state — focus moving into a role="dialog", Escape closing it, focus
// returning to the trigger — is Radix's, exercised by Radix's own suite, and is
// the whole reason this is a Popover and not a bespoke div.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { HelpHint } from './HelpHint';
import {
  HELP_HINTS,
  HELP_HINT_IDS,
  helpHref,
  type HelpHintId,
} from '@/client/lib/help-content';

function render(id: HelpHintId, props: { align?: 'start' | 'center' | 'end' } = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HelpHint id={id} {...props} />
    </MemoryRouter>,
  );
}

describe('every hint renders a keyboard-reachable trigger', () => {
  it.each(HELP_HINT_IDS)('%s', (id) => {
    const html = render(id);
    // A <button>, explicitly type="button" so it cannot submit a form it happens
    // to be rendered inside.
    expect(html).toMatch(/^<button type="button"/);
    // Named for a screen reader, and named after the thing it explains.
    expect(html).toContain(`aria-label="Help: ${HELP_HINTS[id].title}"`);
  });
});

describe('the popover contract', () => {
  it('announces itself as opening a dialog, currently closed', () => {
    const html = render('mastery');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
  });

  it('renders a focus-visible ring rather than removing the outline outright', () => {
    // `focus-visible:outline-none` on its own is the classic way to make a
    // control invisible to a keyboard user. The ring is what makes it legal.
    const html = render('mastery');
    expect(html).toContain('focus-visible:outline-none');
    expect(html).toContain('focus-visible:ring-1');
  });

  it('marks the glyph decorative — the button already has the name', () => {
    expect(render('mastery')).toContain('aria-hidden="true"');
  });
});

describe('quiet by default', () => {
  it.each(HELP_HINT_IDS)('%s renders none of its body while closed', (id) => {
    const html = render(id);
    for (const paragraph of HELP_HINTS[id].body) {
      // A distinctive slice — the whole paragraph would also pass if the panel
      // were merely display:none, which is the thing being ruled out.
      expect(html).not.toContain(paragraph.slice(0, 40));
    }
    expect(html).not.toContain(helpHref(HELP_HINTS[id].section));
  });

  it('takes no layout space of its own beyond the hit area', () => {
    // -m-2 p-2 cancel out: a ~30px target that occupies the footprint of the
    // 14px glyph. Losing the negative margin is what makes a hint start pushing
    // the label it sits next to around.
    const html = render('mastery');
    expect(html).toContain('-m-2 p-2');
    expect(html).toContain('h-3.5 w-3.5');
  });
});

describe('the caller-facing API', () => {
  it('takes only an id, an alignment and spacing classes', () => {
    const html = render('review-due', { align: 'end' });
    expect(html).toMatch(/^<button /);
    // `align` reaches Radix rather than the trigger, so the closed markup is
    // unchanged by it — asserted so a future prop cannot start leaking into the
    // trigger's class list unnoticed.
    expect(html).toBe(render('review-due'));
  });

  it('appends the caller class without dropping its own', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HelpHint id="mastery" className="ml-auto" />
      </MemoryRouter>,
    );
    expect(html).toContain('ml-auto');
    expect(html).toContain('text-muted-foreground/60');
  });
});
