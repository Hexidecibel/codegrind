// =============================================================================
// llm.examples.test — post-processing of the brute force (no model calls)
// =============================================================================

import { describe, it, expect } from 'vitest';
import { stripJsExports } from './llm.examples.js';

describe('stripJsExports', () => {
  it('removes the export lines a model adds, which the plain-script runner cannot load', () => {
    const src = 'function f(a) {\n  return a;\n}\n\nmodule.exports = f;\n';
    expect(stripJsExports(src)).toBe('function f(a) {\n  return a;\n}\n\n');
    expect(stripJsExports('function f() {}\nmodule.exports.f = f;')).toBe('function f() {}\n');
    expect(stripJsExports('export function f() {}\nexport default f;\n')).toBe('function f() {}\n');
    expect(stripJsExports('export const g = 1;')).toBe('const g = 1;');
  });

  it('leaves code that only mentions exports alone', () => {
    const src = 'function f() {\n  const exportsCount = 1; // module.exports is not used here\n  return exportsCount;\n}';
    expect(stripJsExports(src)).toBe(src);
  });
});
