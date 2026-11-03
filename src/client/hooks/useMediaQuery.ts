import { useEffect, useState } from 'react';

/**
 * Subscribes to a CSS media query and re-renders on change (rotation, resize,
 * desktop window drags). SSR-safe-ish (guards `window`).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches); // re-sync in case the query changed
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * WIDTH IS NOT A DEVICE. An iPad in landscape is as wide as a laptop and has a
 * finger and a soft keyboard; an iPad Pro 12.9 is 1024px wide even in portrait.
 * So two different questions get two different queries:
 *
 *   useIsWide    — is there ROOM for side-by-side panes? (`lg`, the same
 *                  threshold as the CSS `lg:` variant)
 *   useIsDesktop — is this a big screen driven by a MOUSE? Monaco, 32px controls
 *                  and "the keyboard never covers anything" all depend on that,
 *                  and none of them hold on a tablet.
 *
 * Both are matchMedia rather than user-agent: iPadOS Safari announces itself as
 * a Mac, and rotation has to re-evaluate.
 */
export const LG_QUERY = '(min-width: 1024px)';
export const DESKTOP_QUERY = '(min-width: 1024px) and (pointer: fine)';

/** True at/above Tailwind's `lg` breakpoint, whatever is driving the screen. */
export function useIsWide(): boolean {
  return useMediaQuery(LG_QUERY);
}

/** True on a big screen with a mouse or trackpad as the primary pointer. */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

/**
 * A tablet held upright: too narrow for side-by-side panes, but tall enough that
 * the statement and the editor can both be on screen, stacked — even with the
 * keyboard up. Flipping between tabs to re-read a constraint is a phone's
 * compromise. `orientation` follows the layout viewport, which on iOS the
 * keyboard does not resize, so this does not flip when the keyboard opens.
 */
export const TABLET_PORTRAIT_QUERY =
  '(min-width: 700px) and (max-width: 1023.98px) and (orientation: portrait) and (pointer: coarse)';

/** True on a tablet in portrait: the stacked problem-over-editor layout. */
export function useIsTabletPortrait(): boolean {
  return useMediaQuery(TABLET_PORTRAIT_QUERY);
}

/** Visual viewport height, pinch-zoom normalised out, or null if unsupported. */
function readViewportHeight(): number | null {
  const vv = window.visualViewport;
  if (!vv) return null;
  // `scale` normalises pinch-zoom, where the visual viewport shrinks even
  // though the layout viewport hasn't moved.
  const height = Math.round(vv.height * vv.scale);
  // Mid-transition browsers occasionally report a nonsense height.
  return height > 100 ? height : null;
}

/**
 * Subscribes to visual-viewport changes and returns the current height.
 * Re-renders on every soft-keyboard open/close, which is the signal callers use
 * to re-reveal the caret — the keyboard can otherwise cover it, and neither
 * editor scrolls on its own when it is merely resized.
 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() =>
    typeof window === 'undefined' ? null : readViewportHeight(),
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => setHeight(readViewportHeight());
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);

  return height;
}

/**
 * Short *and* wide, roughly 180-500px of usable height: a phone in landscape, or
 * a tablet in landscape with the soft keyboard up. Every bar on screen is
 * competing with the editor there, so chrome collapses into a single row. The
 * width clause matters: a keyboard-shrunk portrait viewport is just as short but
 * has no horizontal room to consolidate into.
 */
export const SHORT_QUERY = '(max-height: 500px) and (min-width: 600px)';
const SHORT_HEIGHT = 500;
const SHORT_MIN_WIDTH = 600;

/**
 * True in a short (landscape-ish) viewport.
 *
 * The media query alone cannot see the iOS keyboard: Safari leaves the layout
 * viewport alone and shrinks only the visual one, so a 1180x820 iPad with about
 * 430px left still matches nothing. Hence the second clause. useAppHeight
 * mirrors this onto <html data-short> for the `short:` CSS variant.
 */
export function useIsShort(): boolean {
  const byMedia = useMediaQuery(SHORT_QUERY);
  const height = useVisualViewportHeight();
  const wideEnough = typeof window !== 'undefined' && window.innerWidth >= SHORT_MIN_WIDTH;
  return byMedia || (height !== null && height <= SHORT_HEIGHT && wideEnough);
}

/**
 * A phone: a finger on a small screen. Portrait phones are under `sm` (640px)
 * wide; landscape phones are wider than that but short (an iPhone is ~390-430px
 * tall on its side; an iPad's shortest side is 744px+). Mirrors the `phone:` CSS
 * variant in src/index.css; keep the two in sync. No user-agent sniffing: a
 * narrow desktop window has a fine pointer and stays desktop.
 *
 * Chrome (header, tab bar) switches by the CSS variant; content that swaps out
 * entirely reads this hook, and pure components take an `isPhone` prop.
 */
export const PHONE_QUERY =
  '(pointer: coarse) and (max-width: 639px), (pointer: coarse) and (max-height: 459px)';

/** True on a phone, portrait or landscape. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/**
 * The Button size to use for interactive chrome. Touch screens get 44px targets;
 * desktop keeps its existing `sm` density, and so does a short landscape
 * viewport where 44px bars would eat the editor (32px still clears WCAG 2.5.8).
 */
export function useControlSize(): 'sm' | 'touch' {
  const isDesktop = useIsDesktop();
  const isShort = useIsShort();
  return isDesktop || isShort ? 'sm' : 'touch';
}
