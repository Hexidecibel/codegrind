// =============================================================================
// clip — cut model text to a length WITHOUT cutting a word in half
// =============================================================================
// Notes were being cut mid-word ("…handle them all correctl") because every
// coercer did a bare `.slice(0, max)`. A cap is a safety bound on model text,
// not a target, so when it does bite the cut lands on the last sentence end
// inside the cap, else the last word boundary, and says so with an ellipsis.

/** `s` capped at `max` chars, cut at a sentence or word boundary. Pure. */
export function clipAtBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  // A sentence end in the last 40% of the window is a clean place to stop.
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max * 0.6) return head.slice(0, sentence + 1);
  const word = head.lastIndexOf(' ');
  const cut = word >= max * 0.5 ? head.slice(0, word) : head.slice(0, max - 1);
  return `${cut.replace(/[\s,;:—–-]+$/, '')}…`;
}
