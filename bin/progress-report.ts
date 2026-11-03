// READ-ONLY practice report. Run via bin/progress-report (tsx, Node 22).
//
// Opens the database with { readonly: true } on its OWN connection. It must not
// import services/db.ts: that module runs the migration on import (a write).
// Pure compute (readiness, closeness) is reused.
//
// Grind vs free: attempts carry NO session id. A problem is "grind" here when it
// was first submitted inside a sitting: after a `sessions` row was created, and
// among the first `served` distinct problems that began after it (same-day,
// within 8h). Everything else is "free". That is a heuristic; the app itself
// treats both identically (see submit.ts: skill_state, review_queue).

import Database from 'better-sqlite3';
import path from 'node:path';
import { computeReadiness } from '../src/server/services/readiness.compute.js';
import { isNearMiss } from '../src/shared/closeness.js';
import { TOPICS } from '../src/shared/types.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const db = new Database(path.join(DATA_DIR, 'codegrind.db'), { readonly: true });
const TZ = process.env.CODEGRIND_TZ || 'America/Chicago';
const NOW = Date.now();
const DAY = 86_400_000;
const windows = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (windows.length === 0) windows.push(14, 30);

const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const pad = (s: unknown, n: number) => String(s).padEnd(n);
const lpad = (s: unknown, n: number) => String(s).padStart(n);
const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

interface Att { id: string; problemId: string; pattern: string; difficulty: string; solved: number; hintsUsed: number; testsPassed: number; testsTotal: number; createdAt: string; language: string }
const all = q<Att>(`SELECT id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, createdAt, language FROM attempts ORDER BY createdAt`);
const sessions = q<{ createdAt: string; served: number }>(`SELECT createdAt, served FROM sessions ORDER BY createdAt`);

// Classify each problem's first-in-window submission as grind or free.
const grindProblems = new Set<string>();
for (const s of sessions) {
  const start = Date.parse(s.createdAt);
  const seen: string[] = [];
  for (const a of all) {
    const t = Date.parse(a.createdAt);
    if (t < start || t > start + 8 * 3600_000) continue;
    if (!seen.includes(a.problemId)) seen.push(a.problemId);
  }
  seen.slice(0, s.served).forEach((p) => grindProblems.add(`${s.createdAt}|${p}`));
}
const grindAttempt = new Set<string>(); // attempt ids inside a sitting
for (const s of sessions) {
  const start = Date.parse(s.createdAt);
  const picked = [...grindProblems].filter((k) => k.startsWith(s.createdAt + '|')).map((k) => k.split('|')[1]);
  for (const a of all) {
    const t = Date.parse(a.createdAt);
    if (t >= start && t <= start + 8 * 3600_000 && picked.includes(a.problemId)) grindAttempt.add(a.id);
  }
}

console.log(`codegrind progress report  (tz ${TZ}, now ${new Date(NOW).toISOString()}, ${all.length} attempts total, ${sessions.length} sittings ever)`);

for (const W of windows) {
  const since = NOW - W * DAY;
  const mid = NOW - (W * DAY) / 2;
  const inW = all.filter((a) => Date.parse(a.createdAt) >= since);
  console.log(`\n==================== LAST ${W} DAYS ====================`);
  console.log(`1. VOLUME  submissions ${inW.length}, distinct problems ${new Set(inW.map((a) => a.problemId)).size}, active days ${new Set(inW.map((a) => day(a.createdAt))).size}/${W}`);
  const g = inW.filter((a) => grindAttempt.has(a.id));
  console.log(`   grind(sitting, heuristic) ${g.length} subs / ${new Set(g.map((a) => a.problemId)).size} problems;  free ${inW.length - g.length} subs / ${new Set(inW.filter((a) => !grindAttempt.has(a.id)).map((a) => a.problemId)).size} problems`);
  const byDay = new Map<string, { n: number; g: number; s: number }>();
  for (const a of inW) {
    const d = byDay.get(day(a.createdAt)) ?? { n: 0, g: 0, s: 0 };
    d.n++; if (grindAttempt.has(a.id)) d.g++; d.s += a.solved;
    byDay.set(day(a.createdAt), d);
  }
  console.log('   day         subs grind free solved');
  for (const [d, v] of [...byDay].sort()) console.log(`   ${d}  ${lpad(v.n, 4)} ${lpad(v.g, 5)} ${lpad(v.n - v.g, 4)} ${lpad(v.s, 6)}`);

  console.log(`2. PER TOPIC (first half -> second half solved rate)`);
  console.log(`   ${pad('topic', 20)}${lpad('att', 4)}${lpad('free', 5)}${lpad('solv', 6)}${lpad('near', 5)}${lpad('hint', 5)}${lpad('unaid', 6)}  trend`);
  const topics = [...new Set<string>([...TOPICS, ...all.map((a) => a.pattern)])];
  const untouched: string[] = [];
  const rows = topics.map((t) => {
    const r = inW.filter((a) => a.pattern === t);
    const solved = r.filter((a) => a.solved);
    const h1 = r.filter((a) => Date.parse(a.createdAt) < mid), h2 = r.filter((a) => Date.parse(a.createdAt) >= mid);
    const rate = (x: Att[]) => (x.length ? pct(x.filter((a) => a.solved).length, x.length) : '-');
    return { t, r, solved, h1, h2, rate };
  });
  for (const x of rows.sort((a, b) => b.r.length - a.r.length)) {
    if (x.r.length === 0) { untouched.push(x.t); continue; }
    const hinted = x.solved.filter((a) => a.hintsUsed > 0).length;
    console.log(`   ${pad(x.t, 20)}${lpad(x.r.length, 4)}${lpad(x.r.filter((a) => !grindAttempt.has(a.id)).length, 5)}${lpad(pct(x.solved.length, x.r.length), 6)}${lpad(x.r.filter(isNearMissRow).length, 5)}${lpad(hinted, 5)}${lpad(x.solved.length - hinted, 6)}  ${x.rate(x.h1)}(${x.h1.length}) -> ${x.rate(x.h2)}(${x.h2.length})`);
  }
  console.log(`3. UNTOUCHED in window: ${untouched.join(', ') || '(none)'}`);

  const rec = q<{ topic: string; patternCorrect: number; grade: string }>(`SELECT topic, patternCorrect, grade FROM recognize_attempts WHERE createdAt >= ?`, new Date(since).toISOString());
  console.log(`4. RECOGNIZE cards ${rec.length}` + (rec.length ? '' : '  (none in window)'));
  const rt = new Map<string, { n: number; ok: number; got: number }>();
  for (const r of rec) { const v = rt.get(r.topic) ?? { n: 0, ok: 0, got: 0 }; v.n++; v.ok += r.patternCorrect; v.got += r.grade === 'got' ? 1 : 0; rt.set(r.topic, v); }
  for (const [t, v] of [...rt].sort((a, b) => b[1].n - a[1].n)) console.log(`   ${pad(t, 20)} n=${lpad(v.n, 3)} pattern-correct ${pct(v.ok, v.n)}  graded-got ${pct(v.got, v.n)}`);

  const env = q<{ ok: number; mode: string }>(`SELECT ok, mode FROM envelope_attempts WHERE createdAt >= ?`, new Date(since).toISOString());
  const envDays = new Set(q<{ createdAt: string }>(`SELECT createdAt FROM envelope_attempts WHERE createdAt >= ?`, new Date(since).toISOString()).map((r) => day(r.createdAt))).size;
  console.log(`7. ENVELOPE attempts ${env.length} (ok ${pct(env.filter((e) => e.ok).length, env.length)}) on ${envDays} days`);
}

function isNearMissRow(a: Att) { return isNearMiss({ solved: !!a.solved, testsPassed: a.testsPassed, testsTotal: a.testsTotal }); }

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
