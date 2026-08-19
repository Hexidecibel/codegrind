// =============================================================================
// The mobile editor's "what you missed" band, without a browser
// =============================================================================
// This is the exception to "the editors cannot be tested here". CM6 splits
// cleanly in two: `EditorView` needs a real layout box and is out of reach in a
// jsdom-less repo, but `EditorState` — the document, the state fields, the
// facets, and therefore the entire decoration COMPUTATION — is pure data and
// runs in plain node. So the band's real extension is imported from the
// component and driven directly.
//
// Two of the assertions below exist because the design rests on a claim about
// CM6 that is easy to state and easy to get wrong, and getting it wrong fails
// silently in production rather than loudly here:
//
//   @uiw/react-codemirror does NOT recreate the view when the `extensions` prop
//   changes — it dispatches `StateEffect.reconfigure`. CM6 preserves a state
//   field's value across that IF AND ONLY IF the same field INSTANCE is present
//   in both the old and the new configuration.
//
// That is the whole reason the field is defined at module scope (so its
// identity survives a re-render) and pushed unconditionally into
// `extensionsFor` (so it is present in every configuration, at every rung of
// the assistance ladder). The third test pins the failure mode that would
// follow from breaking either half.

import { describe, it, expect } from 'vitest';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  BAND_EXTENSION,
  setBandEffect,
} from '@/client/components/CodeMirrorEditor';

const DOC = 'aaa\nbbb\nccc\nddd\neee';

const fresh = () => EditorState.create({ doc: DOC, extensions: [BAND_EXTENSION] });

/** The 1-based line numbers the band is currently painting. */
function paintedLines(state: EditorState): number[] {
  const out: number[] = [];
  for (const set of state.facet(EditorView.decorations)) {
    // View-dependent providers (there are none here) come through as functions.
    if (typeof set === 'function') continue;
    const iter = set.iter();
    while (iter.value) {
      out.push(state.doc.lineAt(iter.from).number);
      iter.next();
    }
  }
  return out;
}

/** Paint lines `a`..`b` the way the editor handle does. */
function band(state: EditorState, a: number, b: number): EditorState {
  return state.update({
    effects: setBandEffect.of({ from: state.doc.line(a).from, to: state.doc.line(b).to }),
  }).state;
}

describe('painting', () => {
  it('paints nothing until asked', () => {
    expect(paintedLines(fresh())).toEqual([]);
  });

  it('paints every line of the range, including the last', () => {
    // The off-by-one that drops the final line is the classic bug in a
    // whole-line highlight; a two-line anchor showing one line is subtly wrong
    // rather than obviously broken.
    expect(paintedLines(band(fresh(), 2, 4))).toEqual([2, 3, 4]);
  });

  it('paints a single line for a single-line anchor', () => {
    expect(paintedLines(band(fresh(), 3, 3))).toEqual([3]);
  });

  it('clears on a null effect', () => {
    const s = band(fresh(), 2, 3).update({ effects: setBandEffect.of(null) }).state;
    expect(paintedLines(s)).toEqual([]);
  });
});

describe('surviving a reconfigure (the premise the design rests on)', () => {
  it('keeps the band when the extensions prop changes', () => {
    // Byte for byte what @uiw/react-codemirror dispatches when `extensions`
    // changes identity — which it does every time the assistance overrides or
    // the problem language change, i.e. mid-session, with a band up.
    const s = band(fresh(), 2, 3).update({
      effects: StateEffect.reconfigure.of([BAND_EXTENSION, EditorState.tabSize.of(8)]),
    }).state;
    expect(paintedLines(s)).toEqual([2, 3]);
  });

  it('loses the band if the field is dropped from the new configuration', () => {
    // The failure this pins: gate BAND_EXTENSION behind an assistance toggle,
    // or build the field inside the component, and the band silently vanishes
    // the next time anything reconfigures. Documented as a test because the
    // symptom in production is "it just stopped working sometimes".
    const gone = band(fresh(), 2, 3).update({
      effects: StateEffect.reconfigure.of([]),
    }).state;
    expect(paintedLines(gone)).toEqual([]);
    const readded = gone.update({
      effects: StateEffect.reconfigure.of([BAND_EXTENSION]),
    }).state;
    expect(paintedLines(readded)).toEqual([]);
  });
});

describe('following the document', () => {
  it('moves down when a line is inserted above it', () => {
    const s = band(fresh(), 2, 3).update({ changes: { from: 0, insert: 'zzz\n' } }).state;
    expect(paintedLines(s)).toEqual([3, 4]);
  });

  it('does not grow when text is typed at either edge', () => {
    // CM's spelling of Monaco's NeverGrowsWhenTypingAtEdges. Without it the
    // band creeps onto brand-new code and reads as the coach commenting on
    // something it never saw.
    let s = fresh();
    const line = s.doc.line(2);
    s = s.update({ effects: setBandEffect.of({ from: line.from, to: line.to }) }).state;
    s = s.update({ changes: { from: s.doc.line(2).to, insert: 'X' } }).state;
    expect(paintedLines(s)).toEqual([2]);
    s = s.update({ changes: { from: s.doc.line(2).from, insert: 'Y' } }).state;
    expect(paintedLines(s)).toEqual([2]);
  });

  it('does not throw when the banded region is deleted out from under it', () => {
    // `lineAt` throws on an out-of-range position, and the user is free to
    // select-all-delete while a band is up.
    const s = band(fresh(), 2, 4).update({
      changes: { from: 0, to: DOC.length },
    }).state;
    expect(() => paintedLines(s)).not.toThrow();
  });
});
