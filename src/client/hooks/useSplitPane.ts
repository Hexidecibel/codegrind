// =============================================================================
// useSplitPane — a draggable problem/code divider's state, for tablets
// =============================================================================
// The share of the split the PROBLEM gets, as a percentage of the container,
// clamped to [min, max] and remembered per arrangement (stacked portrait and
// side-by-side landscape want very different numbers) in localStorage.
//
// Storage is wrapped in try/catch everywhere: Safari private mode, disabled
// site data and quota errors all throw, and a divider that cannot remember is
// still a divider. The pure helpers are exported for tests.

import { useCallback, useEffect, useState } from 'react';

export interface SplitBounds {
  min: number;
  max: number;
}

/** Keeps a split percentage inside its bounds; NaN falls back to `fallback`. */
export function clampSplit(value: number, { min, max }: SplitBounds, fallback = min): number {
  if (!Number.isFinite(value)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, value));
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored split for `key`, clamped, or `fallback` when absent/unreadable. */
export function readSplit(
  key: string,
  fallback: number,
  bounds: SplitBounds,
  storage: StorageLike | null = defaultStorage(),
): number {
  try {
    const raw = storage?.getItem(key);
    if (raw == null || raw === '') return clampSplit(fallback, bounds);
    return clampSplit(parseFloat(raw), bounds, fallback);
  } catch {
    return clampSplit(fallback, bounds);
  }
}

/** Persists a split; silently does nothing when storage is unavailable. */
export function writeSplit(key: string, value: number, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(key, String(Math.round(value * 10) / 10));
  } catch {
    /* private mode / quota: the divider still works, it just forgets */
  }
}

/** Pointer position along the split axis -> percentage of the container. */
export function splitFromPointer(pos: number, start: number, size: number): number {
  if (size <= 0) return NaN;
  return ((pos - start) / size) * 100;
}

/** Keyboard step for a separator; null when the key is not one of ours. */
export function splitFromKey(key: string, current: number, bounds: SplitBounds, step = 5): number | null {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowLeft':
      return clampSplit(current - step, bounds);
    case 'ArrowDown':
    case 'ArrowRight':
      return clampSplit(current + step, bounds);
    case 'Home':
      return bounds.min;
    case 'End':
      return bounds.max;
    default:
      return null;
  }
}

/**
 * [value, set(value, persist)]: call `set(v)` while dragging for a live update
 * and `set(v, true)` on release to remember it. Re-reads storage when the key
 * changes (rotating the iPad swaps stacked for side-by-side).
 */
export function useSplitPane(
  key: string,
  fallback: number,
  bounds: SplitBounds,
): [number, (value: number, persist?: boolean) => void] {
  const { min, max } = bounds;
  const [value, setValue] = useState(() => readSplit(key, fallback, { min, max }));

  useEffect(() => {
    setValue(readSplit(key, fallback, { min, max }));
  }, [key, fallback, min, max]);

  const set = useCallback(
    (next: number, persist = false) => {
      const v = clampSplit(next, { min, max }, fallback);
      setValue(v);
      if (persist) writeSplit(key, v);
    },
    [key, fallback, min, max],
  );

  return [value, set];
}
