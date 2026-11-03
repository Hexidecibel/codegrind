import { describe, it, expect } from 'vitest';
import { clampSplit, readSplit, writeSplit, splitFromPointer, splitFromKey } from './useSplitPane';

const B = { min: 15, max: 75 };

function memStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('clampSplit', () => {
  it('keeps values inside the bounds', () => {
    expect(clampSplit(40, B)).toBe(40);
    expect(clampSplit(2, B)).toBe(15);
    expect(clampSplit(99, B)).toBe(75);
  });
  it('falls back on non-numbers', () => {
    expect(clampSplit(NaN, B, 38)).toBe(38);
    expect(clampSplit(Infinity, B, 38)).toBe(38);
  });
});

describe('readSplit / writeSplit', () => {
  it('round-trips through storage, per key', () => {
    const s = memStorage();
    writeSplit('codegrind.split.stacked', 52.345, s);
    writeSplit('codegrind.split.side', 30, s);
    expect(readSplit('codegrind.split.stacked', 38, B, s)).toBe(52.3);
    expect(readSplit('codegrind.split.side', 42, B, s)).toBe(30);
  });
  it('uses the fallback when absent or garbage, and clamps stored values', () => {
    expect(readSplit('k', 38, B, memStorage())).toBe(38);
    expect(readSplit('k', 38, B, memStorage({ k: 'wide' }))).toBe(38);
    expect(readSplit('k', 38, B, memStorage({ k: '5' }))).toBe(15);
    expect(readSplit('k', 38, B, memStorage({ k: '90' }))).toBe(75);
  });
  it('survives storage that throws (private mode, quota)', () => {
    expect(readSplit('k', 38, B, throwing)).toBe(38);
    expect(() => writeSplit('k', 40, throwing)).not.toThrow();
    expect(readSplit('k', 38, B, null)).toBe(38);
  });
});

describe('splitFromPointer', () => {
  it('maps a pointer position onto the container as a percentage', () => {
    expect(splitFromPointer(300, 100, 800)).toBe(25);
    expect(splitFromPointer(100, 100, 800)).toBe(0);
    expect(Number.isNaN(splitFromPointer(100, 100, 0))).toBe(true);
  });
});

describe('splitFromKey', () => {
  it('steps with the arrows, jumps with Home/End, clamps, ignores others', () => {
    expect(splitFromKey('ArrowDown', 40, B)).toBe(45);
    expect(splitFromKey('ArrowRight', 40, B)).toBe(45);
    expect(splitFromKey('ArrowUp', 40, B)).toBe(35);
    expect(splitFromKey('ArrowLeft', 17, B)).toBe(15);
    expect(splitFromKey('Home', 40, B)).toBe(15);
    expect(splitFromKey('End', 40, B)).toBe(75);
    expect(splitFromKey('a', 40, B)).toBeNull();
  });
});
