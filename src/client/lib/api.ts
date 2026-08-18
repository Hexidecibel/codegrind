// Typed fetch wrappers for the codegrind API. Every function returns the
// contract type from @/shared/types. Errors surface as thrown Error objects
// (the server responds `{ error: string }` on failure).

import type {
  Problem,
  RunResult,
  SubmitEvent,
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
  RevealResponse,
  TestResult,
  Prediction,
  Primer,
  StudyFeedResponse,
  StudyIndexResponse,
  StudyReadResponse,
  ReflectResponse,
  SettingsResponse,
  SetupState,
  SeedEvent,
  BankStatus,
  LlmStatus,
  LlmModelsResponse,
  LlmConfigRequest,
  LlmConfigResponse,
} from '@/shared/types';
import type { Language } from '@/shared/languages';

/** Shape returned by GET /api/session/:id (resume). */
export interface SessionState {
  sessionId: string;
  createdAt: string;
  plan: SessionPlan;
  served: number;
  lastTopic: Topic | null;
}

/**
 * A failed request, carrying the server's optional technical detail.
 *
 * The routes explain themselves now (see server/services/explain.service.ts):
 * `error` is one plain sentence naming the next action, and `detail` is the raw
 * internal message it was derived from. Keeping both is the point — the UI shows
 * the sentence and tucks the detail behind a disclosure, so nobody has to read
 * raw docker output to learn that the fix is `bin/build-runner-image`, and
 * nobody debugging their own homelab loses the output either.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turn a non-2xx response into an ApiError, reading `{ error, detail }`. */
async function toApiError(res: Response, fallback: string): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  const message =
    (body && (body.error || body.message)) || res.statusText || fallback;
  const detail =
    body && typeof body.detail === 'string' ? body.detail : undefined;
  return new ApiError(message, detail);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) throw await toApiError(res, 'Request failed');
  return res.json() as Promise<T>;
}

/**
 * Read an NDJSON body, handing each parsed line to `onEvent`.
 *
 * Shared by the app's two streaming POSTs (/api/setup/seed and /api/submit) so
 * the chunk-boundary handling below exists once. Both are POSTs that spend money
 * or time, which is why neither can be an EventSource.
 */
async function readNdjson<T>(
  res: Response,
  onEvent: (event: T) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Chunk boundaries fall wherever TCP wants them, so a line can arrive in two
  // pieces. Everything before the last newline is complete; the remainder is
  // carried forward.
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line) as T);
        } catch {
          /* a truncated line is not worth failing the whole run over */
        }
      }
      nl = buffer.indexOf('\n');
    }
    if (done) break;
  }
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

/**
 * GET /api/bank — which slots can be served right now, and what a miss costs.
 *
 * Free (three indexed counts, no LLM). Two callers: /manual opens on `suggested`
 * so a fresh install's first click is a database read rather than a 15-95 second
 * cold generation, and the "please wait" copy quotes `generationSeconds` — a
 * measured number or nothing at all, never a guess.
 */
export function getBankStatus(): Promise<BankStatus> {
  return request<BankStatus>('/api/bank');
}

/** POST /api/run — run visible sample tests only (sandbox, no AI). */
export function runCode(problemId: string, code: string): Promise<RunResult> {
  return request<RunResult>('/api/run', {
    method: 'POST',
    body: JSON.stringify({ problemId, code }),
  });
}

/**
 * POST /api/submit — hidden tests first, coaching after.
 *
 * NDJSON, one `SubmitEvent` per line, and the reason is the whole feature: the
 * verdict is computed in a couple of seconds and the coaching call after it can
 * take minutes (workhorse role, 8000 tokens, adaptive thinking, a 180-300s
 * budget). Awaiting the whole body held the test results hostage behind the
 * essay. `onEvent` fires with `result` as soon as the sandbox is done, then with
 * `coaching`; the returned promise resolves when the stream ends.
 *
 * Failures BEFORE the stream starts (problem not found, sandbox unavailable)
 * still arrive as an ordinary HTTP error and are thrown as ApiError, so callers
 * keep exactly one error path.
 */
export async function submitCode(
  problemId: string,
  code: string,
  hintsUsed = 0,
  prediction: Prediction | undefined,
  onEvent: (event: SubmitEvent) => void,
): Promise<void> {
  const res = await fetch('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problemId, code, hintsUsed, prediction }),
  });
  if (!res.ok) throw await toApiError(res, 'Submit failed');
  await readNdjson<SubmitEvent>(res, onEvent);
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

/**
 * POST /api/ask — conversational follow-up Q&A anchored to the current problem
 * + code. `results` are the last submit's per-test outcomes; pass them so the
 * tutor can answer "why did mine fail?" from the actual failures rather than
 * by re-deriving them from the code.
 */
export function askCoach(
  problemId: string,
  code: string,
  question: string,
  history: ChatTurn[] = [],
  results: TestResult[] = [],
): Promise<AskResponse> {
  return request<AskResponse>('/api/ask', {
    method: 'POST',
    body: JSON.stringify({ problemId, code, question, history, results }),
  });
}

/**
 * POST /api/reveal — show the reference solution. Always available; the server
 * records the reveal and the next submit is counted as assisted (same treatment
 * as a hint), so it can never earn tier credit.
 */
export function revealSolution(problemId: string): Promise<RevealResponse> {
  return request<RevealResponse>('/api/reveal', {
    method: 'POST',
    body: JSON.stringify({ problemId }),
  });
}

// ---------------------------------------------------------------------------
// Settings — server-side, because the language decides what gets GENERATED
// ---------------------------------------------------------------------------
/**
 * The active language is not a display preference and so cannot live in
 * localStorage: generation happens on the server, hours before any client asks
 * for a problem (bin/seed-bank, the warm-ahead jobs). A preference the server
 * cannot read is not a preference, it is a filter.
 */
export function getSettings(): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings');
}

/**
 * PUT /api/settings — partial update; returns the whole resulting state.
 *
 * `apiKey` is write-only. The server validates it against Anthropic before
 * storing (so a 400 here means "that key does not work", not "malformed") and
 * the response carries only a status: configured, source, last four characters.
 */
export function updateSettings(patch: {
  language?: Language;
  apiKey?: string;
}): Promise<SettingsResponse> {
  return request<SettingsResponse>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------------------------
// Which model answers
// ---------------------------------------------------------------------------
/** GET /api/providers — the live routing. Never carries a credential. */
export function getProviders(): Promise<LlmStatus> {
  return request<LlmStatus>('/api/providers');
}

/**
 * POST /api/providers/models — what the endpoint says it serves.
 *
 * A POST rather than a GET because it may carry a bearer token, and a query
 * string is the one place a secret is certain to be logged. Denied ids are
 * already filtered out server-side: the picker must not be able to offer one.
 */
export function listProviderModels(
  endpoint: string,
  endpointKey?: string,
): Promise<LlmModelsResponse> {
  return request<LlmModelsResponse>('/api/providers/models', {
    method: 'POST',
    body: JSON.stringify({ endpoint, endpointKey }),
  });
}

/**
 * PUT /api/providers — validate a configuration, then store it.
 *
 * A 400 here means the endpoint failed the gate (unreachable, does not serve
 * that model, or cannot make a forced tool call) and NOTHING was stored. The
 * message says which, and what to do.
 */
export function updateProvider(body: LlmConfigRequest): Promise<LlmConfigResponse> {
  return request<LlmConfigResponse>('/api/providers', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------
/** GET /api/setup/state — what is missing, derived fresh (never a stored flag). */
export function getSetupState(): Promise<SetupState> {
  return request<SetupState>('/api/setup/state');
}

/** POST /api/setup/dismiss — proceed with an empty bank. */
export function dismissSetup(): Promise<SetupState> {
  return request<SetupState>('/api/setup/dismiss', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * POST /api/setup/seed — stock a bank, reporting real progress.
 *
 * The response is NDJSON: one `SeedEvent` per line, written as each step
 * actually completes. This reads the socket rather than the whole body, which
 * is the entire point — a bank of 8 problems takes two to four minutes, and a
 * bar that only moves at the end is worse than no bar.
 *
 * `signal` aborts the read. It does NOT stop the server mid-generation (the
 * current problem finishes and is banked, which is the right outcome — it was
 * already paid for), it stops the client watching.
 */
export async function seedBank(
  body: { language?: Language; perSlot?: number },
  onEvent: (event: SeedEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/setup/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw await toApiError(res, 'Seeding failed to start');
  }
  await readNdjson<SeedEvent>(res, onEvent);
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
// Phase C — retrieval loop, primers
// ---------------------------------------------------------------------------
/** GET /api/primer/:topic — per-pattern cheat-sheet card (generates + caches on miss). */
export function getPrimer(topic: string): Promise<Primer> {
  return request<Primer>(`/api/primer/${encodeURIComponent(topic)}`);
}

// ---------------------------------------------------------------------------
// Study — the guided reading feed
// ---------------------------------------------------------------------------
/**
 * GET /api/study/feed — the next already-cached lessons in curriculum order.
 * Never blocks on generation: omit `after` to resume at the first unread lesson,
 * and watch `warming` to decide whether to render a skeleton for the next card.
 */
export function getStudyFeed(
  opts: { after?: string; limit?: number } = {},
): Promise<StudyFeedResponse> {
  const qs = new URLSearchParams({ limit: String(opts.limit ?? 3) });
  if (opts.after) qs.set('after', opts.after);
  return request<StudyFeedResponse>(`/api/study/feed?${qs.toString()}`);
}

/** GET /api/study/jump/:topic — reposition the feed to a topic. */
export function jumpToTopic(topic: string): Promise<StudyFeedResponse> {
  return request<StudyFeedResponse>(`/api/study/jump/${encodeURIComponent(topic)}`);
}

/** POST /api/study/read — mark a lesson read; `fuzzy` resurfaces it for a re-read. */
export function markLessonRead(lessonId: string, fuzzy = false): Promise<StudyReadResponse> {
  return request<StudyReadResponse>('/api/study/read', {
    method: 'POST',
    body: JSON.stringify({ lessonId, fuzzy }),
  });
}

/** GET /api/study/index — per-topic totals, read counts and mastery for the jump grid. */
export function getStudyIndex(): Promise<StudyIndexResponse> {
  return request<StudyIndexResponse>('/api/study/index');
}

// ---------------------------------------------------------------------------
// Reflect — the progress dashboard
// ---------------------------------------------------------------------------
/**
 * GET /api/reflect — the whole dashboard in one call: skill tree, next unlock,
 * stat tiles, 84-day activity, per-problem trend and the split mistake ledger.
 * Everything is precomputed server-side; nothing here needs re-deriving.
 */
export function getReflect(): Promise<ReflectResponse> {
  return request<ReflectResponse>('/api/reflect');
}
