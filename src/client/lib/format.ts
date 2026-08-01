/** Turn a slug like "two-pointer" into "Two-Pointer" for display. */
export function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join('-');
}

/** Nicer display labels for the closed mistake-tag vocabulary. */
const MISTAKE_LABELS: Record<string, string> = {
  'off-by-one': 'Off-by-one',
  'empty-input': 'Empty input',
  'single-element': 'Single element',
  duplicates: 'Duplicates',
  'negative-or-overflow': 'Negative / overflow',
  'wrong-data-structure': 'Wrong data structure',
  'brute-force-only': 'Brute force only',
  'complexity-misjudged': 'Complexity misjudged',
  'runtime-error': 'Runtime error',
  'syntax-error': 'Syntax error',
  'edge-case-missed': 'Edge case missed',
};

/** Humanize a mistake tag with a curated label, falling back to slug titling. */
export function mistakeLabel(tag: string): string {
  return MISTAKE_LABELS[tag] ?? humanize(tag);
}

/** Human-friendly relative-ish date from an ISO string. */
export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
