import { useEffect, useState } from 'react';
import { useIsDesktop } from '@/client/hooks/useMediaQuery';

/** Visual viewport height, pinch-zoom normalised out, or null if unsupported. */
function readHeight(): number | null {
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
    typeof window === 'undefined' ? null : readHeight(),
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => setHeight(readHeight());
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
 * Publishes the *visual* viewport height as `--app-height` on <html> so the app
 * shell can size itself to what the user can actually see.
 *
 * `100dvh` is not enough on a phone: when the soft keyboard opens, Android
 * (with `interactive-widget=resizes-content`) shrinks the layout viewport, but
 * iOS Safari does not — it only shrinks the visual viewport, leaving the bottom
 * of a `dvh`-sized app underneath the keyboard. visualViewport reports the truth
 * on both.
 *
 * Only active below `lg`; desktop keeps its plain `h-dvh` sizing untouched.
 */
export function useAppHeight(): void {
  const isDesktop = useIsDesktop();
  const height = useVisualViewportHeight();

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
}
