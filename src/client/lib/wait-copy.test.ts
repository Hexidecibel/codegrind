// The rule under test is the one that made "Loading next…" a lie: a bank hit and
// a cold generation are the same spinner, and only elapsed time tells them
// apart. The scary copy must never appear for the fast path, must appear for the
// slow one, and must never quote a number nobody measured.

import { describe as suite, it, expect } from 'vitest';
import {
  describeWait,
  formatElapsed,
  formatEstimate,
  GENERATION_TELL_MS,
} from './wait-copy';

const base = {
  intent: 'bank-first' as const,
  estimateSeconds: 25,
  subject: 'next problem' as const,
};

suite('describeWait — a bank hit never looks like a generation', () => {
  it('says nothing alarming while the request is still plausibly instant', () => {
    const w = describeWait({ ...base, elapsedMs: 0 });
    expect(w.generating).toBe(false);
    expect(w.label).toBe('Loading next…');
    expect(w.note).toBeNull();
  });

  it('is still quiet one tick before the threshold', () => {
    const w = describeWait({ ...base, elapsedMs: GENERATION_TELL_MS - 1 });
    expect(w.generating).toBe(false);
    expect(w.note).toBeNull();
  });

  it('switches to "a model is writing you one" at the threshold', () => {
    const w = describeWait({ ...base, elapsedMs: GENERATION_TELL_MS });
    expect(w.generating).toBe(true);
    expect(w.label).toBe('Writing a problem…');
    expect(w.note).toContain('writing you a fresh one');
  });
});

suite('describeWait — a caller that already knows says so immediately', () => {
  it('does not wait for the clock when the intent is explicit', () => {
    const w = describeWait({ ...base, intent: 'generate', elapsedMs: 0 });
    expect(w.generating).toBe(true);
    expect(w.note).toContain('Writing you a fresh problem');
    // It never claims the bank was empty — Generate skips the bank on purpose.
    expect(w.note).not.toContain('Nothing banked');
  });
});

suite('describeWait — the estimate is measured or absent', () => {
  it('quotes the measurement when there is one', () => {
    const w = describeWait({ ...base, elapsedMs: 5000, estimateSeconds: 25 });
    expect(w.note).toContain('usually about 25 seconds');
  });

  it('invents no number when nothing was ever measured', () => {
    const w = describeWait({ ...base, elapsedMs: 5000, estimateSeconds: null });
    expect(w.note).toContain('couple of minutes');
    expect(w.note).not.toMatch(/usually about/);
  });

  it('counts up, so a long wait still looks alive', () => {
    const w = describeWait({ ...base, elapsedMs: 42_000 });
    expect(w.note).toContain('42s so far');
  });

  it('admits an overrun rather than repeating a stale estimate', () => {
    const w = describeWait({ ...base, elapsedMs: 90_000, estimateSeconds: 25 });
    expect(w.note).toContain('Taking longer than usual');
    expect(w.note).toContain('3 tries');
  });

  it('does not cry overrun while still inside the estimate', () => {
    const w = describeWait({ ...base, elapsedMs: 20_000, estimateSeconds: 25 });
    expect(w.note).not.toContain('Taking longer');
  });

  it('cannot overrun an estimate that does not exist', () => {
    const w = describeWait({ ...base, elapsedMs: 600_000, estimateSeconds: null });
    expect(w.note).not.toContain('Taking longer');
  });
});

suite('formatEstimate', () => {
  it('uses seconds below a minute and a half', () => {
    expect(formatEstimate(25)).toBe('about 25 seconds');
    expect(formatEstimate(89)).toBe('about 89 seconds');
  });

  it('switches to minutes for the local-model case', () => {
    expect(formatEstimate(95)).toBe('about 2 minutes');
    expect(formatEstimate(60 * 3)).toBe('about 3 minutes');
  });

  it('returns null for anything that is not a measurement', () => {
    expect(formatEstimate(null)).toBeNull();
    expect(formatEstimate(0)).toBeNull();
    expect(formatEstimate(Number.NaN)).toBeNull();
  });
});

suite('formatElapsed', () => {
  it('reads as seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(8400)).toBe('8s');
  });

  it('reads as m ss past a minute', () => {
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(125_000)).toBe('2m 05s');
  });
});
