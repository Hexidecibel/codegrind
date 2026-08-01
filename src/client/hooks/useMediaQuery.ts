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
 * The Tailwind `lg` breakpoint, expressed for JS. Layout decisions that can't be
 * made with a `lg:` variant alone (which editor to mount, tabs vs split) read
 * this so they track the exact same threshold as the CSS.
 */
export const LG_QUERY = '(min-width: 1024px)';

/** True at/above Tailwind's `lg` breakpoint. */
export function useIsDesktop(): boolean {
  return useMediaQuery(LG_QUERY);
}

/**
 * A phone in landscape with the soft keyboard up — short *and* wide, roughly
 * 180-500px of usable height. Every bar on screen is competing with the editor
 * there, so chrome collapses into a single row. The width clause matters: a
 * keyboard-shrunk portrait viewport is just as short but has no horizontal room
 * to consolidate into.
 */
export const SHORT_QUERY = '(max-height: 500px) and (min-width: 600px)';

/** True in a short (landscape-ish) viewport. */
export function useIsShort(): boolean {
  return useMediaQuery(SHORT_QUERY);
}

/**
 * The Button size to use for interactive chrome. Phones get 44px touch targets;
 * desktop keeps its existing `sm` density, and so does a short landscape
 * viewport where 44px bars would eat the editor (32px still clears WCAG 2.5.8).
 */
export function useControlSize(): 'sm' | 'touch' {
  const isDesktop = useIsDesktop();
  const isShort = useIsShort();
  return isDesktop || isShort ? 'sm' : 'touch';
}
