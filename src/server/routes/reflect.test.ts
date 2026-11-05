// =============================================================================
// routes/reflect — lesson reads against a real (temporary) database
// =============================================================================
// Pinned (coach plan, Phase 5):
//   * a topic's lessonsRead counts TRACK lessons only — personalized fix:,
//     mistake: and walkthrough: lessons sit outside trackSlotCount, so counting
//     them let "Lessons" read e.g. 5 / 3.
//   * reading never moves tier, mastery or clean solves: progress is earned by
//     solving, and lesson_reads feeds nothing but the read counts.
//   * the "Next read" pick is free: no model call, no lesson written.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReflectResponse, ReflectTreeNode } from '../../shared/types.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-reflect-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { reflectRoutes } = await import('./reflect.js');
const { db, getLessonReadCounts, getReadsSince, getCleanSolvesByTopic, getSkillState } = await import(
  '../services/db.js'
);

const app = new Hono();
app.route('/api', reflectRoutes);

afterAll(() => {
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const LESSONS: Array<[id: string, kind: string, seq: number]> = [
  ['arrays:0', 'concept', 0],
  ['arrays:1', 'concept', 1],
  ['mistake:off-by-one:1', 'mistake', 1001],
  ['fix:off-by-one:arrays', 'mistake', 1000],
  ['walkthrough:p1', 'walkthrough', 1100],
];

function insertLesson(id: string, kind: string, seq: number) {
  const lesson = { id, topic: 'arrays', kind, seq, title: `Lesson ${id}`, body: 'b', takeaway: 't' };
  db.prepare(
    `INSERT INTO lessons (id, topic, kind, seq, title, data, createdAt) VALUES (?, 'arrays', ?, ?, ?, ?, ?)`,
  ).run(id, kind, seq, lesson.title, JSON.stringify(lesson), '2026-10-01T00:00:00.000Z');
}

function markRead(lessonId: string, at: string) {
  db.prepare(
    `INSERT INTO lesson_reads (lessonId, readAt, fuzzy) VALUES (?, ?, 0)
     ON CONFLICT(lessonId) DO UPDATE SET readAt = excluded.readAt`,
  ).run(lessonId, at);
}

function insertSolve(n: number) {
  db.prepare(
    `INSERT INTO problems (id, title, prompt, examples, constraints, difficulty, topic, pattern, starterCode,
       functionName, sampleTests, hiddenTests, referenceSolution, used, createdAt, language)
     VALUES (?, ?, 'p', '[]', '[]', 'easy', 'arrays', 'arrays', '', 'f', '[]', '[]', '', 1, ?, 'javascript')`,
  ).run(`p${n}`, `Problem ${n}`, '2026-10-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO attempts (id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, code, createdAt, language)
     VALUES (?, ?, 'arrays', 'easy', 1, 0, 3, 3, '', ?, 'javascript')`,
  ).run(`a${n}`, `p${n}`, `2026-10-0${n}T12:00:00.000Z`);
}

async function getReflect(): Promise<ReflectResponse> {
  const res = await app.request('/api/reflect');
  expect(res.status).toBe(200);
  return (await res.json()) as ReflectResponse;
}

const arrays = (r: ReflectResponse) => r.tree.find((n) => n.topic === 'arrays') as ReflectTreeNode;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  for (const t of ['lesson_reads', 'lessons', 'attempts', 'problems', 'ai_usage']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  for (const [id, kind, seq] of LESSONS) insertLesson(id, kind, seq);
  insertSolve(1);
  insertSolve(2);
});

describe('lesson reads (Phase 5)', () => {
  it('counts track lessons only, everywhere Reflect shows reads', async () => {
    for (const [id] of LESSONS) markRead(id, '2026-10-05T12:00:00.000Z');

    expect(getLessonReadCounts().get('arrays')).toBe(2);
    const r = await getReflect();
    expect(arrays(r).lessonsRead).toBe(2);
    expect(r.tiles.lessonsRead).toBe(2);
    // Today's step still sees every read, personalized ones included.
    expect(getReadsSince('2026-10-05T00:00:00.000Z')).toHaveLength(LESSONS.length);
    expect(getReadsSince('2026-10-06T00:00:00.000Z')).toHaveLength(0);
  });

  it('reading moves no tier, mastery or clean solve', async () => {
    const before = await getReflect();
    const cleanBefore = getCleanSolvesByTopic('javascript');
    const skillBefore = getSkillState('javascript');

    for (const [id] of LESSONS) markRead(id, '2026-10-05T12:00:00.000Z');
    const after = await getReflect();

    const strip = ({ lessonsRead: _r, ...rest }: ReflectTreeNode) => rest;
    expect(after.tree.map(strip)).toEqual(before.tree.map(strip));
    expect(after.nextUnlock).toEqual(before.nextUnlock);
    expect(after.tiles.tiersCleared).toBe(before.tiles.tiersCleared);
    expect(after.tiles.topicsReached).toBe(before.tiles.topicsReached);
    expect(getCleanSolvesByTopic('javascript')).toEqual(cleanBefore);
    expect(getSkillState('javascript')).toEqual(skillBefore);
  });

  it('the next-read pick costs nothing', async () => {
    const lessons = count('lessons');
    const r = await getReflect();
    if (r.nextRead) {
      expect(r.nextRead.lessonId).toBeTruthy();
      expect(r.nextRead.reason).toBeTruthy();
    }
    expect(count('ai_usage')).toBe(0);
    // materializeDerivedLessons may copy cached primers; nothing is generated.
    expect(count('lessons')).toBeGreaterThanOrEqual(lessons);
  });
});
