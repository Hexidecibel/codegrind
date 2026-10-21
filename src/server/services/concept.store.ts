// =============================================================================
// concept.store — concept_reps, concept_learning, concept_lessons (Phase H3)
// =============================================================================
// Same connection as db.ts; statements prepared lazily.

import { db } from './db.js';
import type { GapCardGrade } from '../../shared/gap-cards.js';
import type { ConceptLesson, RepFact } from '../../shared/concepts.js';

export interface ConceptRepRow {
  id: number;
  day: string;
  concept: string;
  promptIdx: number;
  question: string;
  answer: string;
  primed: boolean;
  grade: GapCardGrade;
  result: { hit: string[]; missed: string[]; why: string; modelAnswer: string; followUp: string };
  cardId: number | null;
  model: string;
  costUsd: number | null;
  createdAt: string;
}

interface RawRep extends Omit<ConceptRepRow, 'primed' | 'result'> {
  primed: number;
  result: string;
}

function parseRep(r: RawRep): ConceptRepRow {
  let result: ConceptRepRow['result'] = { hit: [], missed: [], why: '', modelAnswer: '', followUp: '' };
  try {
    result = { ...result, ...(JSON.parse(r.result) as Partial<ConceptRepRow['result']>) };
  } catch {
    /* a corrupt row reads as an empty result */
  }
  return { ...r, primed: r.primed === 1, result };
}

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    insertRep: db.prepare(`
      INSERT INTO concept_reps (day, concept, promptIdx, question, answer, primed, grade, result, cardId, model, costUsd, createdAt)
      VALUES (@day, @concept, @promptIdx, @question, @answer, @primed, @grade, @result, @cardId, @model, @costUsd, @createdAt)
    `),
    setCard: db.prepare(`UPDATE concept_reps SET cardId = ? WHERE id = ?`),
    repsSince: db.prepare(`SELECT * FROM concept_reps WHERE createdAt >= ? ORDER BY createdAt ASC, id ASC`),
    repsOfDay: db.prepare(`SELECT * FROM concept_reps WHERE day = ? ORDER BY createdAt ASC, id ASC`),
    facts: db.prepare(`SELECT concept, grade, primed, createdAt FROM concept_reps ORDER BY createdAt DESC LIMIT 2000`),
    learned: db.prepare(`SELECT concept, learnedAt FROM concept_learning`),
    setLearned: db.prepare(`INSERT OR IGNORE INTO concept_learning (concept, learnedAt, via) VALUES (?, ?, ?)`),
    getLesson: db.prepare(`SELECT lesson FROM concept_lessons WHERE concept = ?`),
    putLesson: db.prepare(`INSERT OR REPLACE INTO concept_lessons (concept, lesson, createdAt) VALUES (?, ?, ?)`),
    lessonConcepts: db.prepare(`SELECT concept FROM concept_lessons`),
    getPick: db.prepare(`SELECT conceptPick FROM daily_sessions WHERE date = ?`),
    setPick: db.prepare(`
      INSERT INTO daily_sessions (date, conceptPick, createdAt, updatedAt) VALUES (@date, @pick, @now, @now)
      ON CONFLICT(date) DO UPDATE SET conceptPick = excluded.conceptPick, updatedAt = excluded.updatedAt
    `),
  };
}
const S = () => (stmts ??= prepare());

export function insertRep(r: Omit<ConceptRepRow, 'id'>): number {
  return Number(
    S().insertRep.run({ ...r, primed: r.primed ? 1 : 0, result: JSON.stringify(r.result) }).lastInsertRowid
  );
}

export function setRepCard(repId: number, cardId: number): void {
  S().setCard.run(cardId, repId);
}

export function repsSince(iso: string): ConceptRepRow[] {
  return (S().repsSince.all(iso) as RawRep[]).map(parseRep);
}

export function repsOfDay(day: string): ConceptRepRow[] {
  return (S().repsOfDay.all(day) as RawRep[]).map(parseRep);
}

/** Every rep's facts for the pure rules (learning state, the pick). */
export function repFacts(): RepFact[] {
  return (S().facts.all() as { concept: string; grade: GapCardGrade; primed: number; createdAt: string }[]).map((r) => ({
    concept: r.concept,
    grade: r.grade,
    primed: r.primed === 1,
    createdAt: r.createdAt,
  }));
}

export function learnedMap(): Record<string, string> {
  return Object.fromEntries((S().learned.all() as { concept: string; learnedAt: string }[]).map((r) => [r.concept, r.learnedAt]));
}

/** First learning wins (INSERT OR IGNORE): re-reading never moves the clock. */
export function markLearned(concept: string, via: 'primer' | 'lesson', now: Date): void {
  S().setLearned.run(concept, now.toISOString(), via);
}

export function getLesson(concept: string): ConceptLesson | null {
  const r = S().getLesson.get(concept) as { lesson: string } | undefined;
  if (!r) return null;
  try {
    return JSON.parse(r.lesson) as ConceptLesson;
  } catch {
    return null;
  }
}

export function putLesson(l: ConceptLesson): void {
  S().putLesson.run(l.concept, JSON.stringify(l), l.createdAt);
}

export function lessonConcepts(): Set<string> {
  return new Set((S().lessonConcepts.all() as { concept: string }[]).map((r) => r.concept));
}

export interface StoredPick {
  concept: string;
  promptIdx: number;
  /** Primer state frozen at pick time. */
  primed: boolean;
  why: string;
}

export function getPick(date: string): StoredPick | null {
  const r = S().getPick.get(date) as { conceptPick: string | null } | undefined;
  if (!r?.conceptPick) return null;
  try {
    return JSON.parse(r.conceptPick) as StoredPick;
  } catch {
    return null;
  }
}

export function setPick(date: string, pick: StoredPick, now: Date): void {
  S().setPick.run({ date, pick: JSON.stringify(pick), now: now.toISOString() });
}
