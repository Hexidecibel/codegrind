// READ-ONLY practice report. Run via bin/progress-report (tsx, Node 22).
//
// Opens the database with { readonly: true } on its OWN connection. It must not
// import services/db.ts: that module runs the migration on import (a write).
// Pure compute is reused: readiness, and the window numbers in
// services/weekly.compute.ts (also behind Home's "This week"), whose SELECTs live
// in services/weekly.rows.ts and take this read-only handle as an argument.
//
// Grind vs free is a heuristic: see weekly.compute.classifyGrind.

import Database from 'better-sqlite3';
import path from 'node:path';
import { computeReadiness } from '../src/server/services/readiness.compute.js';
import { classifyGrind, summarizeWindow } from '../src/server/services/weekly.compute.js';
import type { WeeklyTrendHalf } from '../src/shared/weekly.js';
import { loadWeeklyRows } from '../src/server/services/weekly.rows.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const db = new Database(path.join(DATA_DIR, 'codegrind.db'), { readonly: true });
const TZ = process.env.CODEGRIND_TZ || 'America/Chicago';
const NOW = Date.now();
const DAY = 86_400_000;
const windows = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (windows.length === 0) windows.push(14, 30);

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);
const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

// Every row ever (the header counts them all); weekly.compute filters per window.
const rows = loadWeeklyRows(db, '');
const all = rows.attempts;
const sessions = rows.sessions;
const grindAttempt = classifyGrind(all, sessions);

console.log(`codegrind progress report  (tz ${TZ}, now ${new Date(NOW).toISOString()}, ${all.length} attempts total, ${sessions.length} sittings ever)`);

const rate = (h: WeeklyTrendHalf) => (h.n ? pct(h.solved, h.n) : '-');

for (const W of windows) {
  const s = summarizeWindow({
    attempts: all,
    grindIds: grindAttempt,
    recognize: rows.recognize,
    envelope: rows.envelope,
    mocks: rows.mocks,
    since: NOW - W * DAY,
    now: NOW,
    tz: TZ,
  });
  console.log(`\n==================== LAST ${W} DAYS ====================`);
  console.log(`1. VOLUME  submissions ${s.subs}, distinct problems ${s.problems}, active days ${s.activeDays}/${W}`);
  console.log(`   grind(sitting, heuristic) ${s.grind.subs} subs / ${s.grind.problems} problems;  free ${s.free.subs} subs / ${s.free.problems} problems`);
  console.log('   day         subs grind free solved');
  for (const v of s.daily.filter((d) => d.subs > 0)) console.log(`   ${v.date}  ${lpad(v.subs, 4)} ${lpad(v.grind, 5)} ${lpad(v.subs - v.grind, 4)} ${lpad(v.solved, 6)}`);

  console.log(`2. PER TOPIC (first half -> second half solved rate)`);
  console.log(`   ${pad('topic', 20)}${lpad('att', 4)}${lpad('free', 5)}${lpad('solv', 6)}${lpad('near', 5)}${lpad('hint', 5)}${lpad('unaid', 6)}  trend`);
  for (const x of s.topics) {
    const { before: h1, after: h2 } = x.trend;
    console.log(`   ${pad(x.topic, 20)}${lpad(x.attempts, 4)}${lpad(x.free, 5)}${lpad(pct(x.solved, x.attempts), 6)}${lpad(x.nearMisses, 5)}${lpad(x.hinted, 5)}${lpad(x.unaided, 6)}  ${rate(h1)}(${h1.n}) -> ${rate(h2)}(${h2.n})`);
  }
  console.log(`3. UNTOUCHED in window: ${s.untouched.join(', ') || '(none)'}`);

  console.log(`4. RECOGNIZE cards ${s.recognizeTotal}` + (s.recognizeTotal ? '' : '  (none in window)'));
  for (const v of s.recognize) console.log(`   ${pad(v.topic, 20)} n=${lpad(v.n, 3)} pattern-correct ${pct(v.patternCorrect, v.n)}  graded-got ${pct(v.got, v.n)}`);

  console.log(`7. ENVELOPE attempts ${s.envelope.n} (ok ${pct(s.envelope.ok, s.envelope.n)}) on ${s.envelope.days} days`);
}

// ---- 5. SRS / review queue state (now) ----------------------------------
console.log(`\n==================== STATE NOW ====================`);
const nowIso = new Date(NOW).toISOString();
const LANG = (q<{ value: string }>(`SELECT value FROM settings WHERE key = 'language'`)[0]?.value ?? 'javascript').replace(/^"|"$/g, '');
const rq = q<{ topic: string; reason: string; rung: number; dueAt: string }>(
  `SELECT p.topic, r.reason, r.rung, r.dueAt FROM review_queue r JOIN problems p ON p.id = r.problemId WHERE r.clearedAt IS NULL`);
const due = rq.filter((r) => r.dueAt <= nowIso);
const overdue = rq.filter((r) => Date.parse(r.dueAt) < NOW - DAY);
console.log(`5. REVIEW QUEUE open ${rq.length}, due now ${due.length}, overdue >1d ${overdue.length}`);
const byT = new Map<string, { open: number; due: number; od: number }>();
for (const r of rq) { const v = byT.get(r.topic) ?? { open: 0, due: 0, od: 0 }; v.open++; if (r.dueAt <= nowIso) v.due++; if (Date.parse(r.dueAt) < NOW - DAY) v.od++; byT.set(r.topic, v); }
for (const [t, v] of [...byT].sort((a, b) => b[1].due - a[1].due)) console.log(`   ${pad(t, 20)} open ${v.open} due ${v.due} overdue ${v.od}`);
console.log(`   skill_state (topic/lang/diff box streak att solved dueAt):`);
for (const s of q<any>(`SELECT topic, language, currentDifficulty d, box, streak, attempts, solved, dueAt FROM skill_state WHERE language = ? ORDER BY dueAt`, LANG))
  console.log(`   ${pad(s.topic, 16)} ${pad(s.d, 7)} box ${s.box} streak ${s.streak} ${s.solved}/${s.attempts}  due ${s.dueAt?.slice(0, 16)}${s.dueAt && s.dueAt <= nowIso ? '  DUE' : ''}`);
const rc = q<{ topic: string; dueAt: string }>(`SELECT topic, dueAt FROM recognize_cards WHERE retiredAt IS NULL`);
console.log(`   recognize cards active ${rc.length}, due ${rc.filter((c) => c.dueAt <= nowIso).length}` + (rc.length ? ` (${rc.map((c) => c.topic).join(',')})` : ''));

// ---- 6. Readiness --------------------------------------------------------
const lang = LANG;
const sinceR = new Date(NOW - 120 * DAY).toISOString();
const ratt = q<any>(`SELECT a.problemId, a.difficulty, a.solved, a.hintsUsed, a.createdAt, a.prediction, n.time AS refTime FROM attempts a LEFT JOIN recognize_notes n ON n.problemId = a.problemId WHERE a.language = ? AND a.createdAt >= ? ORDER BY a.createdAt`, lang, sinceR).map((r) => {
  let p: any = null; try { p = r.prediction ? JSON.parse(r.prediction) : null; } catch { /* ignore */ }
  return { problemId: r.problemId, difficulty: r.difficulty, solved: r.solved === 1, hintsUsed: r.hintsUsed, createdAt: r.createdAt, confidence: typeof p?.confidence === 'number' ? p.confidence : null, predTime: typeof p?.predTime === 'string' ? p.predTime : null, refTime: r.refTime };
});
const readiness = computeReadiness({
  now: NOW,
  attempts: ratt,
  grades: q<any>(`SELECT m.kind AS kind, g.verdict AS verdict, g.createdAt AS createdAt FROM mock_grades g JOIN mocks m ON m.id = g.mockId ORDER BY g.createdAt DESC LIMIT 60`),
  cardReviews: q<any>(`SELECT COALESCE(m.kind, '') AS kind, r.grade, r.intervalDays FROM card_reviews r LEFT JOIN mock_gaps g ON g.id = r.cardId LEFT JOIN mocks m ON m.id = g.mockId WHERE r.at >= ?`, sinceR),
  nextLoop: null,
});
console.log(`6. READINESS (language ${lang}; no loop, no concept reps fed)`);
for (const a of readiness) {
  console.log(`   ${pad(a.label, 22)} ${pad(a.verdict, 12)} ${a.evidence}`);
  console.log(`      hint: ${a.hint}`);
}
