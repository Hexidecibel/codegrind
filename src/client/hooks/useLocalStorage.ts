import { useCallback, useState } from 'react';

/**
 * A useState-like hook that persists to localStorage under `key`.
 * SSR-safe-ish (guards `window`), swallows quota/parse errors.
 */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          /* ignore write failures */
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set] as const;
}
