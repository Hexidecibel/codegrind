import { useEffect, useRef } from 'react';
import {
  useIsDesktop,
  useIsShort,
  useVisualViewportHeight,
} from '@/client/hooks/useMediaQuery';

export { useVisualViewportHeight };

/**
 * Publishes the *visual* viewport height as `--app-height` on <html> so the app
 * shell can size itself to what the user can actually see.
 *
 * `100dvh` is not enough on a phone: when the soft keyboard opens, Android
 * (with `interactive-widget=resizes-content`) shrinks the layout viewport, but
 * iOS Safari does not — it only shrinks the visual viewport, leaving the bottom
 * of a `dvh`-sized app underneath the keyboard. visualViewport reports the truth
 * on both.
 *
 * Active on anything with a soft keyboard — which includes a landscape iPad, as
 * wide as a laptop — and below `lg`; a mouse-driven desktop keeps plain `dvh`.
 * Also publishes `data-short` for the `short:` CSS variant, which a media query
 * alone cannot drive on iOS (see useIsShort).
 */
export function useAppHeight(): void {
  const isDesktop = useIsDesktop();
  const height = useVisualViewportHeight();
  const isShort = useIsShort();

  useEffect(() => {
    const root = document.documentElement;
    if (isDesktop || height === null) {
      root.style.removeProperty('--app-height');
      return;
    }
    root.style.setProperty('--app-height', `${height}px`);
    return () => {
      root.style.removeProperty('--app-height');
    };
  }, [isDesktop, height]);

  // The shell just shrank around a field that was on screen a moment ago, and
  // nothing scrolls its pane to follow, so a field low on the page ends up behind
  // the keyboard. Editors are excluded: they reveal their own caret.
  const lastHeight = useRef(height);
  useEffect(() => {
    const shrank = height !== null && lastHeight.current !== null && height < lastHeight.current;
    lastHeight.current = height;
    if (isDesktop || !shrank) return;
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(id);
  }, [height, isDesktop]);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-short', isShort);
  }, [isShort]);
}
