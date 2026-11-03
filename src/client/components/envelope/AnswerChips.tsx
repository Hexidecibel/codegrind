// =============================================================================
// Answer inputs on a phone: the right keyboard, and the hard keys as chips
// =============================================================================
// A phone keyboard hides "×", "^" and the minus sign two layers down, and
// autocorrect turns "5e8" into "See". Every answer box spreads ANSWER_INPUT
// (no capitals, no autocorrect, a Go key), and the envelope ones add a row of
// tap-to-insert chips that only shows on a phone (`hidden phone:flex`), so
// the iPad and desktop look exactly as before.

import type { RefObject } from 'react';
import type { StepType } from '@/shared/envelope-learn';

/** Spread on every free-text answer input. */
export const ANSWER_INPUT = {
  autoComplete: 'off',
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  enterKeyHint: 'go',
} as const;

/** Prose answers: the same, minus the Go key (Enter is a newline there). */
export const ANSWER_TEXTAREA = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export interface Chip {
  label: string;
  insert: string;
}

const POW: Chip = { label: '× 10^', insert: ' × 10^' };
const SCALE: Chip[] = ['K', 'M', 'B', 'T'].map((s) => ({ label: s, insert: s }));
// The checkers read an ASCII hyphen; the chip shows a real minus sign.
const MINUS: Chip = { label: '−', insert: '-' };

/** The chip row for a guided step (or plain mode, `null`), with the item's unit. */
export function chipsFor(type: StepType | null, unit: string | null | undefined): Chip[] {
  const u: Chip[] = unit ? [{ label: unit, insert: ` ${unit}` }] : [];
  switch (type) {
    case 'split':
      return [POW];
    case 'back':
      return [...SCALE, ...u];
    case 'exponent':
      return [MINUS];
    case 'unit':
    case null:
      return [POW, ...SCALE, ...u];
    default:
      return [];
  }
}

/**
 * The keyboard each step wants. Exponents can be negative (÷ a bigger power),
 * and an iOS number pad has no minus: the "−" chip supplies it, so the pad
 * stays the fast one.
 */
export function inputModeFor(type: StepType | null): 'decimal' | 'numeric' | 'text' {
  if (type === 'small') return 'decimal';
  if (type === 'exponent') return 'numeric';
  return 'text';
}

/** `text` inserted at the caret (or the end), and where the caret goes after. */
export function insertAt(value: string, start: number | null, end: number | null, text: string): { value: string; caret: number } {
  const a = start ?? value.length;
  const b = end ?? a;
  // Don't double a space the chip starts with.
  const t = a > 0 && value[a - 1] === ' ' ? text.replace(/^ /, '') : text.replace(/^ /, a === 0 ? '' : ' ');
  return { value: value.slice(0, a) + t + value.slice(b), caret: a + t.length };
}

export function AnswerChips({
  chips,
  inputRef,
  value,
  onChange,
  disabled,
}: {
  chips: Chip[];
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  if (!chips.length) return null;
  return (
    <div className="hidden flex-wrap gap-2 phone:flex" aria-label="Insert">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          disabled={disabled}
          // Keep the keyboard up: a tap here must not blur the input.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = inputRef.current;
            const r = insertAt(value, el?.selectionStart ?? null, el?.selectionEnd ?? null, c.insert);
            onChange(r.value);
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(r.caret, r.caret);
            });
          }}
          className="h-11 min-w-11 rounded-lg border border-border bg-secondary px-3 font-mono text-base active:bg-accent disabled:opacity-50"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
