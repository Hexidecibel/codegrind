// =============================================================================
// readiness.compute — per-area interview readiness (Phase H2), deterministic
// =============================================================================
// Replaces the old one-number "%" (which flipped 0 ↔ 100 on a single mock).
// Each area gets a VERDICT against the next interview loop — ready / close /
// not yet / not enough evidence — the signals behind it, and one line saying
// what would move it. No model call, no database, no clock it is not handed.
//
// THE SIGNALS
//   pass         Algorithms: recency-weighted first-try pass rate on UNSEEN
//                mediums (and hards): a problem's first local day, passed =
//                solved on a submit with no hints. Weight 0.5^(age/21d). There
//                are no solve timers yet, so it is untimed; a timer would gate
//                "passed" here and nowhere else.
//   level        Mock areas: mean verdict of the last 3 graded mocks
//                (below 0 · at 1 · above 2), shown as "at" etc.
//   trend        Mock areas: newest minus oldest of the last 3 (−2..+2).
//   retention    Recall after 5+ days. Algorithms: a review re-solve 5+ days
//                after the previous attempt on that problem, passed = solved
//                with no hints. Mock areas: drill-card self-grades whose card
//                had waited 5+ days (got 1 · shaky ½ · missed 0).
//   calibration  Algorithms only (mocks record no prediction): 1 − mean
//                |confidence − first-try pass| over predictions with a
//                confidence, averaged with the predicted-time-complexity match
//                rate where a reference complexity is known.
//
// THE VERDICT (thresholds are constants below, tested on fixtures)
//   not-enough  algorithms < ALGO_MIN_EVIDENCE unseen mediums in 90 days;
//               a mock area < MOCK_MIN_EVIDENCE graded mocks
//   ready       algorithms: pass ≥ 70%, and retention / calibration (when they
//               have ≥ 3 points) ≥ 70% / 60%. Mocks: level ≥ at, latest not
//               below, trend ≥ 0, card retention (≥ 3 points) ≥ 70%
//   close       algorithms: pass ≥ 50%. Mocks: level ≥ ⅔ or (latest not below
//               and trend > 0)
//   not-yet     otherwise

import type { MockVerdict } from '../../shared/mock.js';
import type { RoundType } from '../../shared/loops.js';
import type { ReadinessArea, ReadinessSignal, ReadinessVerdict } from '../../shared/today.js';

export const ALGO_MIN_EVIDENCE = 5;
export const MOCK_MIN_EVIDENCE = 3;
/** Recency half-life of the algorithms pass rate. */
export const PASS_HALF_LIFE_DAYS = 21;
/** Only this recent evidence counts toward the algorithms area. */
export const EVIDENCE_WINDOW_DAYS = 90;
/** Recall over at least this many days counts as retention. */
export const RETENTION_MIN_DAYS = 5;
/** A signal needs this many points before it can hold a verdict back. */
export const SIGNAL_MIN_N = 3;

const DAY_MS = 86_400_000;
const VERDICT_SCORE: Record<MockVerdict, number> = { below: 0, at: 1, above: 2 };

export interface ReadinessAttempt {
  problemId: string;
  difficulty: string;
  solved: boolean;
  hintsUsed: number;
  createdAt: string;
  /** 1..5 from the predict-before-solve panel, or null. */
  confidence: number | null;
  predTime: string | null;
  /** The problem's reference time complexity, when an AI check cached one. */
  refTime: string | null;
}

export interface ReadinessInput {
  now: number;
  /** Grind attempts in the active language, any order. */
  attempts: readonly ReadinessAttempt[];
  /** Graded mocks, newest first. */
  grades: readonly { kind: string; verdict: MockVerdict; createdAt?: string }[];
  /** Drill-card self-grades with the mock kind the card came from. */
  cardReviews: readonly { kind: string; grade: string; intervalDays: number }[];
  /** The next loop, or null. */
  nextLoop: { company: string; daysLeft: number; rounds: readonly RoundType[] } | null;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signed = (x: number) => (x > 0 ? `+${x}` : `${x}`);

/** "O(n log n)" / "o(nlogn)" → "nlogn"; '' when unreadable. */
export function normComplexity(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^o\((.*)\)$/, '$1')
    .replace(/[·*]/g, '')
    .replace(/\^/g, '');
}

interface ProblemDay {
  first: number;
  difficulty: string;
  /** Solved with no hints on its first local day (≈ within 12h of the first submit). */
  pass: boolean;
  confidence: number | null;
  predTime: string | null;
  refTime: string | null;
}

/** Per problem: the first-session outcome, and later "sessions" (≥ RETENTION_MIN_DAYS gaps). */
function byProblem(attempts: readonly ReadinessAttempt[]) {
  const groups = new Map<string, ReadinessAttempt[]>();
  for (const a of attempts) {
    const t = Date.parse(a.createdAt);
    if (!Number.isFinite(t)) continue;
    (groups.get(a.problemId) ?? groups.set(a.problemId, []).get(a.problemId)!).push(a);
  }
  const firsts: ProblemDay[] = [];
  const recalls: { at: number; pass: boolean }[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Sessions: runs of attempts with < 12h between neighbours.
    const sessions: ReadinessAttempt[][] = [];
    let last = -Infinity;
    for (const a of list) {
      const t = Date.parse(a.createdAt);
      if (t - last >= 12 * 3600_000) sessions.push([]);
      sessions[sessions.length - 1].push(a);
      last = t;
    }
    const first = sessions[0];
    const pred = first.find((a) => a.confidence !== null || a.predTime);
    firsts.push({
      first: Date.parse(first[0].createdAt),
      difficulty: first[0].difficulty,
      // hintsUsed is the running count on the problem, so a solve after a hint
      // carries it: "solved on a no-hint submit" is "passed unaided".
      pass: first.some((a) => a.solved && a.hintsUsed === 0),
      confidence: pred?.confidence ?? null,
      predTime: pred?.predTime ?? null,
      refTime: first[0].refTime,
    });
    for (let i = 1; i < sessions.length; i++) {
      const prevEnd = Date.parse(sessions[i - 1][sessions[i - 1].length - 1].createdAt);
      const start = Date.parse(sessions[i][0].createdAt);
      if ((start - prevEnd) / DAY_MS >= RETENTION_MIN_DAYS) {
        recalls.push({ at: start, pass: sessions[i].some((a) => a.solved && a.hintsUsed === 0) });
      }
    }
  }
  return { firsts, recalls };
}

function loopNote(input: ReadinessInput, verdict: ReadinessVerdict, inLoop: boolean | null): string {
  if (!input.nextLoop || !inLoop || verdict === 'ready') return '';
  const d = input.nextLoop.daysLeft;
  return ` — ${d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`} to ${input.nextLoop.company}`;
}

function inLoopOf(input: ReadinessInput, round: RoundType): boolean | null {
  return input.nextLoop ? input.nextLoop.rounds.includes(round) : null;
}

/** The algorithms area. Exported for tests. */
export function algorithmsArea(input: ReadinessInput): ReadinessArea {
  const cutoff = input.now - EVIDENCE_WINDOW_DAYS * DAY_MS;
  const { firsts, recalls } = byProblem(input.attempts);
  const unseen = firsts.filter((f) => f.first >= cutoff && (f.difficulty === 'medium' || f.difficulty === 'hard'));
  let wSum = 0;
  let wPass = 0;
  for (const f of unseen) {
    const w = Math.pow(0.5, (input.now - f.first) / DAY_MS / PASS_HALF_LIFE_DAYS);
    wSum += w;
    if (f.pass) wPass += w;
  }
  const pass = wSum > 0 ? wPass / wSum : null;

  const rec = recalls.filter((r) => r.at >= cutoff);
  const retention = rec.length ? rec.filter((r) => r.pass).length / rec.length : null;

  // Calibration over every first attempt with a prediction (any difficulty).
  const conf = firsts.filter((f) => f.first >= cutoff && f.confidence !== null);
  const confScore = conf.length
    ? 1 - conf.reduce((s, f) => s + Math.abs((Math.min(5, Math.max(1, f.confidence!)) - 1) / 4 - (f.pass ? 1 : 0)), 0) / conf.length
    : null;
  const cx = firsts.filter((f) => f.first >= cutoff && normComplexity(f.predTime) && normComplexity(f.refTime));
  const cxScore = cx.length ? cx.filter((f) => normComplexity(f.predTime) === normComplexity(f.refTime)).length / cx.length : null;
  const calibParts = [confScore, cxScore].filter((x): x is number => x !== null);
  const calibration = calibParts.length ? calibParts.reduce((a, b) => a + b, 0) / calibParts.length : null;
  const calibN = conf.length + cx.length;

  const signals: ReadinessSignal[] = [
    { id: 'pass', label: 'First-try pass, unseen mediums', value: pass === null ? 'n/a' : pct(pass), n: unseen.length },
    { id: 'retention', label: `Cold re-solve after ${RETENTION_MIN_DAYS}+ days`, value: retention === null ? 'n/a' : pct(retention), n: rec.length },
    { id: 'calibration', label: 'Calibration (confidence, complexity)', value: calibration === null ? 'n/a' : pct(calibration), n: calibN },
  ];
  const inLoop = inLoopOf(input, 'coding');
  const n = unseen.length;
  let verdict: ReadinessVerdict;
  let hint: string;
  const retOk = retention === null || rec.length < SIGNAL_MIN_N || retention >= 0.7;
  const calOk = calibration === null || calibN < SIGNAL_MIN_N || calibration >= 0.6;
  if (n < ALGO_MIN_EVIDENCE) {
    verdict = 'not-enough';
    const k = ALGO_MIN_EVIDENCE - n;
    hint = `Solve ${k} more unseen medium${k === 1 ? '' : 's'} with no hints to get a read.`;
  } else if (pass! >= 0.7 && retOk && calOk) {
    verdict = 'ready';
    hint = 'Hold it: one unseen medium every other day keeps this honest.';
  } else {
    verdict = pass! >= 0.5 ? 'close' : 'not-yet';
    if (pass! < 0.7) hint = `First-try pass on unseen mediums is ${pct(pass!)} (bar 70%): one unseen medium a day, no hints, predict first.`;
    else if (!retOk) hint = `Cold re-solves after ${RETENTION_MIN_DAYS}+ days pass ${pct(retention!)}: clear review problems the day they come due.`;
    else hint = `Your confidence runs ahead of results (calibration ${pct(calibration!)}): predict complexity before coding and check it after.`;
  }
  return {
    id: 'algos',
    label: 'Algorithms',
    verdict,
    evidence: `${n} unseen medium${n === 1 ? '' : 's'}`,
    signals,
    hint: hint + loopNote(input, verdict, inLoop),
    inLoop,
  };
}

const MOCK_AREAS = [
  { id: 'system-design', label: 'System design', round: 'system-design' },
  { id: 'behavioral', label: 'Behavioral', round: 'behavioral' },
  { id: 'coding', label: 'Coding mock', round: 'coding' },
] as const;

const VERDICT_WORD = (m: number) => (m >= 1.5 ? 'above' : m >= 1 ? 'at' : m >= 0.5 ? 'near' : 'below');

/** One mock area. Exported for tests. */
export function mockArea(input: ReadinessInput, id: (typeof MOCK_AREAS)[number]['id']): ReadinessArea {
  const spec = MOCK_AREAS.find((a) => a.id === id)!;
  const mine = input.grades.filter((g) => g.kind === id);
  const last3 = mine.slice(0, 3);
  const level = last3.length ? last3.reduce((s, g) => s + VERDICT_SCORE[g.verdict], 0) / last3.length : null;
  const trend = last3.length >= 2 ? VERDICT_SCORE[last3[0].verdict] - VERDICT_SCORE[last3[last3.length - 1].verdict] : null;
  const cards = input.cardReviews.filter((c) => c.kind === id && c.intervalDays >= RETENTION_MIN_DAYS);
  const retention = cards.length
    ? cards.reduce((s, c) => s + (c.grade === 'got' ? 1 : c.grade === 'shaky' ? 0.5 : 0), 0) / cards.length
    : null;

  const signals: ReadinessSignal[] = [
    { id: 'level', label: 'Level, last 3 mocks', value: level === null ? 'n/a' : VERDICT_WORD(level), n: last3.length },
    { id: 'trend', label: 'Trend, last 3', value: trend === null ? 'n/a' : signed(trend), n: last3.length },
    { id: 'retention', label: `Drill cards recalled after ${RETENTION_MIN_DAYS}+ days`, value: retention === null ? 'n/a' : pct(retention), n: cards.length },
  ];
  const inLoop = inLoopOf(input, spec.round);
  const latestBelow = mine[0]?.verdict === 'below';
  const retOk = retention === null || cards.length < SIGNAL_MIN_N || retention >= 0.7;
  let verdict: ReadinessVerdict;
  let hint: string;
  if (mine.length < MOCK_MIN_EVIDENCE) {
    verdict = 'not-enough';
    const k = MOCK_MIN_EVIDENCE - mine.length;
    hint = `Do ${k} more ${spec.label.toLowerCase()}${spec.id === 'coding' ? '' : ' mock'}${k === 1 ? '' : 's'} to get a read${
      mine.length ? ` (last: ${mine[0].verdict} level)` : ''
    }.`;
  } else if (level! >= 1 && !latestBelow && trend! >= 0 && retOk) {
    verdict = 'ready';
    hint = 'Hold it: one of these a week, and clear its drill cards when due.';
  } else {
    verdict = level! >= 2 / 3 || (!latestBelow && trend! > 0) ? 'close' : 'not-yet';
    if (latestBelow) hint = 'The last one graded below level: drill its cards, then run one more of this kind.';
    else if (trend! < 0) hint = `Trending down over the last 3 (${signed(trend!)}): re-read the last grade's gaps before the next one.`;
    else if (level! < 1) hint = 'Averaging below the bar: one more of this kind this week, aimed at the last grade\'s top gap.';
    else hint = `Drill cards fade after ${RETENTION_MIN_DAYS}+ days (${pct(retention!)}): clear them the day they come due.`;
  }
  return {
    id,
    label: spec.label,
    verdict,
    evidence: mine.length < MOCK_MIN_EVIDENCE ? `${mine.length} of ${MOCK_MIN_EVIDENCE} mocks` : `${mine.length} mocks`,
    signals,
    hint: hint + loopNote(input, verdict, inLoop),
    inLoop,
  };
}

export function computeReadiness(input: ReadinessInput): ReadinessArea[] {
  return [algorithmsArea(input), ...MOCK_AREAS.map((a) => mockArea(input, a.id))];
}
