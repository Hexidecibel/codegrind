// =============================================================================
// Grind's soft read-first gate — what is dismissed, and the Learn links
// =============================================================================
// The server attaches `readFirst` to a served problem when its topic has never
// been attempted and the topic's skeleton lesson is unread (coach.brain
// grindGate). The gate is SOFT: "Skip" hides it for that topic for the rest of
// the browser session, "I've read it" also records the read. Dismissals live in
// sessionStorage, and every access is wrapped — a private window or blocked
// storage just means the gate can show again, never that grind breaks.

import type { CoachNudge, Topic } from '@/shared/types';

const KEY = 'codegrind.readFirstDismissed';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function store(s?: Store | null): Store | null {
  if (s !== undefined) return s;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readSet(s: Store | null): Set<string> {
  if (!s) return new Set();
  try {
    const parsed: unknown = JSON.parse(s.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []);
  } catch {
    return new Set();
  }
}

export function isGateDismissed(topic: Topic | string, s?: Store | null): boolean {
  return readSet(store(s)).has(topic);
}

export function dismissGate(topic: Topic | string, s?: Store | null): void {
  const st = store(s);
  if (!st) return;
  try {
    const set = readSet(st);
    set.add(topic);
    st.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* storage full or blocked — the gate may show again; harmless */
  }
}

/** The gate to show, if any: present and not dismissed for its topic. */
export function activeGate(readFirst: CoachNudge | undefined, s?: Store | null): CoachNudge | null {
  return readFirst && !isGateDismissed(readFirst.topic, s) ? readFirst : null;
}

/** `?topic=&tag=` from Learn's "Practice this →", validated against TOPICS. */
export function pinFromSearch(
  search: string,
  topics: readonly string[],
): { topic: Topic; tag?: string } | null {
  const qs = new URLSearchParams(search);
  const topic = qs.get('topic');
  if (!topic || !topics.includes(topic)) return null;
  const tag = qs.get('tag');
  return tag ? { topic: topic as Topic, tag } : { topic: topic as Topic };
}

/**
 * Where a coach nudge's lesson lives in Learn. The default Learn feed is coach
 * ordered (FIX first, most recent slip first), so a fix lands on top of it; a
 * pre-read is the topic's own track, which `?topic=` jumps to.
 */
export function learnHref(n: Pick<CoachNudge, 'intent' | 'topic'>): string {
  return n.intent === 'fix' ? '/study' : `/study?topic=${encodeURIComponent(n.topic)}`;
}
