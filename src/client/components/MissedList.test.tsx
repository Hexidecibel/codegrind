// =============================================================================
// The two things about MissedList that must never quietly change
// =============================================================================
// WHAT CAN AND CANNOT BE TESTED HERE, stated up front the way HelpHint.test.tsx
// does. This repo has no jsdom and no @testing-library — every test runs in
// plain node — so the component is rendered with `renderToStaticMarkup`, which
// gives real React output for the CLOSED state and no way to click anything.
// Unreachable from here, deliberately and without a fake DOM bolted on to make
// the suite look wider than it is:
//
//   - opening a popover, and everything inside it: the two-tap confirm, the
//     diff, the "you've edited since you submitted" note, the 404 copy. Radix
//     renders its content through a portal, which the server renderer does not
//     support at all.
//   - the band appearing in the editor, and — the reason it is worth restating
//     — the band SURVIVING a click into the editor. That behaviour is the
//     interaction of Radix's outside-click dismissal with a decoration in a
//     laid-out editor, and there is no honest way to assert it without a DOM.
//     What is asserted instead is its markup consequence (the marker follows
//     `selected`, not `open`) and, for the anchoring itself, the pure
//     `resolveMissedRange` tests, which pin the only decision that can be WRONG
//     rather than merely invisible.
//   - focus moving into the dialog, Escape closing it, focus returning to the
//     trigger. That is Radix's, exercised by Radix's own suite, and is the whole
//     reason this is a Popover rather than a bespoke div.
//
// What IS covered is the part that regresses silently, and it is the highest-
// value assertion in the client half of this feature: that an item with no
// anchor is plain text with no affordance at all, and that the corrected code
// is nowhere in the DOM until it has been paid for.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { MissedList, type MissedListProps } from './MissedList';
import { toMissedViews } from '@/client/lib/missed-fix';
import type { MissedItem } from '@/shared/types';

function render(items: MissedItem[], props: Partial<MissedListProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MissedList
        items={toMissedViews(items)}
        selected={null}
        open={null}
        onOpen={() => {}}
        onClose={() => {}}
        onDismiss={() => {}}
        fixes={{}}
        onFixRevealed={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

const ANCHORED: MissedItem = {
  note: 'you never reset left when the window shrinks',
  anchor: { startLine: 4, endLine: 5 },
  fixId: 'fix-abc',
};
const UNANCHORED: MissedItem = {
  note: 'there is no early-exit guard for an empty input',
};

describe('an item the coach could not tie to a line', () => {
  it('renders no button at all', () => {
    // THE assertion. A dead-looking affordance — something that looks tappable
    // and does nothing — is worse than plain text: it teaches the reader that
    // the feature is broken, on the very items where the coach was honest about
    // not having a line to point at.
    const html = render([UNANCHORED]);
    expect(html).not.toContain('<button');
  });

  it('renders exactly what shipped before this feature existed', () => {
    const html = render([UNANCHORED]);
    expect(html).toContain(`<span>${UNANCHORED.note}</span>`);
    // No hover cursor, no underline, nothing that reads as interactive.
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('underline');
    // Explicitly including the pointer: an inert bullet that makes the cursor
    // change is the same broken promise as a dead button, just quieter.
    expect(html).not.toContain('cursor-pointer');
  });
});

describe('an anchored item', () => {
  it('is a real button, explicitly type="button"', () => {
    // The difference between "reachable by Tab and Enter" and "reachable by
    // mouse only", and one careless refactor away at all times. `type="button"`
    // so it cannot submit a form it happens to be rendered inside.
    expect(render([ANCHORED])).toContain('<button type="button"');
  });

  it('announces the popover contract, currently closed', () => {
    const html = render([ANCHORED]);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
  });

  it('says what the click does, for a reader who cannot see the band', () => {
    const html = render([ANCHORED]);
    expect(html).toContain('Lines 4–5');
    expect(html).toContain('opens the lines in the editor');
    expect(html).toContain('offers the corrected version');
  });

  it('renders a focus-visible ring rather than removing the outline outright', () => {
    const html = render([ANCHORED]);
    expect(html).toContain('focus-visible:outline-none');
    expect(html).toContain('focus-visible:ring-1');
  });

  it('marks the bullet dot decorative — the button carries the text', () => {
    expect(render([ANCHORED])).toContain('aria-hidden="true"');
  });

  it('shows a pointer cursor, which a <button> does not get for free', () => {
    // The browser default for <button> is `cursor: default` and Tailwind's
    // preflight does not override it, so without this class the ONLY hover
    // affordance is the dotted underline changing shade — invisible to anyone
    // who has not already put the mouse on it.
    expect(render([ANCHORED])).toContain('cursor-pointer');
  });
});

describe('the band outlives the popover', () => {
  // The lifetime change itself (click a bullet, click into Monaco, band stays)
  // is NOT reachable from here: it needs a real DOM for Radix's outside-click,
  // and a laid-out editor for the decoration. What IS reachable, and what
  // regressed before, is the markup consequence — that the persistent marker
  // reads `selected` and not `open`, so it is still there once the popover has
  // closed and is the standing on-screen answer to "why is that line pink".
  it('keeps the selected bullet marked while its popover is shut', () => {
    const html = render([ANCHORED], { selected: 0, open: null });
    expect(html).toContain('border-l-2');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
  });

  it('marks nothing when no bullet owns the band', () => {
    expect(render([ANCHORED], { selected: null, open: null })).not.toContain(
      'border-l-2',
    );
  });
});

describe('assistance is not sitting in the DOM waiting to be read', () => {
  it('renders none of the fix affordance while closed', () => {
    // The corrected code is CONDITIONALLY RENDERED, never CSS-hidden: if it
    // were in the markup with `display:none` the reveal gate would be theatre,
    // readable in devtools by anyone who never clicked. Nothing about the fix —
    // not the diff, not the price, not even the button that offers it — exists
    // until the popover is open, and the text itself does not exist until the
    // server has been asked for it and has written the reveal.
    const html = render([ANCHORED]);
    expect(html).not.toContain('Show me the fix');
    expect(html).not.toContain('Counts as assisted');
    expect(html).not.toContain('of your submission');
    expect(html).not.toContain('Unverified model output');
  });

  it('carries no fix text and no diff glyphs anywhere in the closed markup', () => {
    // The brief never ships the corrected code in the first place — it carries
    // an opaque fixId — so the only way for fix text to be here would be a
    // cache populated before the fetch. There is none, by construction.
    const html = render([ANCHORED]);
    expect(html).not.toContain('fix-abc');
    expect(html).not.toContain('bg-emerald-500/10');
  });

  it('keeps an ALREADY-PAID-FOR fix out of the closed markup too', () => {
    // The cache now arrives as a prop (lifted to SolveSurface so that crossing
    // `lg` cannot make the user re-buy a fix), which moves the seam this
    // property has to hold at. A populated cache is a legitimate state — the
    // reveal is written, the user has seen the diff — but the text still only
    // belongs inside an OPEN popover, never in the list's own markup where a
    // second reader over the shoulder, or a devtools search, would find it.
    const html = render([ANCHORED], {
      selected: 0,
      open: null,
      fixes: { 'fix-abc': { before: 'while (n) {', after: 'while (n > 0) {' } },
    });
    expect(html).not.toContain('while (n > 0)');
    expect(html).not.toContain('Unverified model output');
  });
});

describe('the list as a whole', () => {
  it('mixes anchored and unanchored items without either changing shape', () => {
    const html = render([ANCHORED, UNANCHORED]);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(`<span>${UNANCHORED.note}</span>`);
  });

  it('drops the items the normalizer refused rather than rendering empty dots', () => {
    const html = render([{ note: '  ' }, UNANCHORED]);
    expect(html.match(/<li/g)).toHaveLength(1);
  });

  it('renders an empty list without a wrapper full of nothing', () => {
    expect(render([])).toBe('<ul class="space-y-1.5"></ul>');
  });
});
