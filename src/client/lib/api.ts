// Typed fetch wrappers for the codegrind API. Every function returns the
// contract type from @/shared/types. Errors surface as thrown Error objects
// (the server responds `{ error: string }` on failure).

import type {
  Problem,
  RunResult,
  SubmitResponse,
  Hint,
  HintLevel,
  ProgressStats,
  HistoryResponse,
  Topic,
  Difficulty,
  SessionStartResponse,
  GrindProblem,
  SessionPlan,
  ChatTurn,
  AskResponse,
  Prediction,
  MistakeStat,
  Primer,
} from '@/shared/types';

/** Shape returned by GET /api/session/:id (resume). */
export interface SessionState {
  sessionId: string;
  createdAt: string;
  plan: SessionPlan;
  served: number;
  lastTopic: Topic | null;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      (body && (body.error || body.message)) || res.statusText || 'Request failed';
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** GET /api/problems/next — pull an unused problem from the bank (fast, no LLM). */
export function nextProblem(topic: Topic, difficulty: Difficulty): Promise<Problem> {
  const qs = new URLSearchParams({ topic, difficulty }).toString();
  return request<Problem>(`/api/problems/next?${qs}`);
}

/** POST /api/problems/generate — force a fresh Claude-generated problem (slow). */
export function generateProblem(
  topic: Topic,
  difficulty: Difficulty,
): Promise<Problem> {
  return request<Problem>('/api/problems/generate', {
    method: 'POST',
    body: JSON.stringify({ topic, difficulty }),
  });
}

/** GET /api/problems/:id */
export function getProblem(id: string): Promise<Problem> {
  return request<Problem>(`/api/problems/${encodeURIComponent(id)}`);
}

/** POST /api/run — run visible sample tests only (sandbox, no AI). */
export function runCode(problemId: string, code: string): Promise<RunResult> {
  return request<RunResult>('/api/run', {
    method: 'POST',
    body: JSON.stringify({ problemId, code }),
  });
}

/** POST /api/submit — run all hidden tests + get the coaching brief. */
export function submitCode(
  problemId: string,
  code: string,
  hintsUsed = 0,
  prediction?: Prediction,
): Promise<SubmitResponse> {
  return request<SubmitResponse>('/api/submit', {
    method: 'POST',
    body: JSON.stringify({ problemId, code, hintsUsed, prediction }),
  });
}

/** POST /api/hint — progressive, level-scoped nudge (1|2|3). */
export function getHint(
  problemId: string,
  code: string,
  level: HintLevel,
): Promise<Hint> {
  return request<Hint>('/api/hint', {
    method: 'POST',
    body: JSON.stringify({ problemId, code, level }),
  });
}

// ---------------------------------------------------------------------------
// Adaptive Grind Mode
// ---------------------------------------------------------------------------
/** POST /api/session/start — plan a sitting + serve the first adaptive problem. */
export function startSession(): Promise<SessionStartResponse> {
  return request<SessionStartResponse>('/api/session/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** POST /api/session/:id/next — pick + serve the next adaptive problem. */
export function nextInSession(sessionId: string): Promise<GrindProblem> {
  return request<GrindProblem>(
    `/api/session/${encodeURIComponent(sessionId)}/next`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** GET /api/session/:id — resume a persisted session (plan + counters). */
export function getSession(sessionId: string): Promise<SessionState> {
  return request<SessionState>(`/api/session/${encodeURIComponent(sessionId)}`);
}

/** POST /api/ask — conversational follow-up Q&A anchored to the current problem + code. */
export function askCoach(
  problemId: string,
  code: string,
  question: string,
  history: ChatTurn[] = [],
): Promise<AskResponse> {
  return request<AskResponse>('/api/ask', {
    method: 'POST',
    body: JSON.stringify({ problemId, code, question, history }),
  });
}

/** GET /api/progress — per-pattern mastery. */
export function getProgress(): Promise<ProgressStats> {
  return request<ProgressStats>('/api/progress');
}

/** GET /api/history — recent attempts. */
export function getHistory(): Promise<HistoryResponse> {
  return request<HistoryResponse>('/api/history');
}

// ---------------------------------------------------------------------------
// Phase C — retrieval loop, primers, mistake ledger
// ---------------------------------------------------------------------------
/** GET /api/mistakes — aggregated recurring-mistake tags, most frequent first. */
export function getMistakes(): Promise<MistakeStat[]> {
  return request<MistakeStat[]>('/api/mistakes');
}

/** GET /api/primer/:topic — per-pattern cheat-sheet card (generates + caches on miss). */
export function getPrimer(topic: string): Promise<Primer> {
  return request<Primer>(`/api/primer/${encodeURIComponent(topic)}`);
}

/** GET /api/primers — topic ids that already have a cached primer. */
export function getPrimers(): Promise<string[]> {
  return request<string[]>('/api/primers');
}
