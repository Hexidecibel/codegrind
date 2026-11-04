// =============================================================================
// candidate-profile — what the prompts may know about THIS install's candidate
// =============================================================================
// Personal background (experience, honest gaps, confirmed facts about past
// projects) is the user's own data, so it never lives in the code. It is read
// once, at module load, from a local JSON file:
//
//   $CODEGRIND_CANDIDATE_PROFILE, else $DATA_DIR/candidate-profile.json
//
// DATA_DIR is gitignored. No file → the neutral profile: every prompt that
// would carry a candidate section says nothing is known and asks the model not
// to assume anything. Read synchronously because the system prompts that use it
// are module-level constants (byte-stable, so the cached prefix is shared).
//
// Shape (every field optional):
//   {
//     "systemDesignNotes": "free text after the framework in the SD interviewer's card",
//     "knownFacts": ["one confirmed fact per line, for the story forge and deep-dive grader"],
//     "ownWork": ["one project per line, for the AI-systems lessons' drawOn"],
//     "familiarSystems": ["system-design prompt ids the candidate has built (the warm-up pool)"]
//   }
//
// A test run never reads the default file (process.env.VITEST): the suite and
// the golden fixtures must see the neutral profile on every machine.

import fs from 'node:fs';
import path from 'node:path';

export interface CandidateProfile {
  systemDesignNotes: string;
  knownFacts: string[];
  ownWork: string[];
  familiarSystems: string[];
}

export const EMPTY_PROFILE: CandidateProfile = Object.freeze({ systemDesignNotes: '', knownFacts: [], ownWork: [], familiarSystems: [] });

/** Where the profile is read from; null when nothing should be read. */
export function candidateProfilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CODEGRIND_CANDIDATE_PROFILE?.trim();
  if (explicit) return path.resolve(explicit);
  if (env.VITEST) return null;
  return path.resolve(env.DATA_DIR || './data', 'candidate-profile.json');
}

const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];

/** Whatever the file held → a CandidateProfile. Pure, never throws. */
export function parseCandidateProfile(raw: unknown): CandidateProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_PROFILE;
  const r = raw as Record<string, unknown>;
  return {
    systemDesignNotes: typeof r.systemDesignNotes === 'string' ? r.systemDesignNotes.trim() : '',
    knownFacts: lines(r.knownFacts),
    ownWork: lines(r.ownWork),
    familiarSystems: lines(r.familiarSystems),
  };
}

/** Read the profile. A missing file is the normal case; a broken one warns and falls back. Never throws. */
export function loadCandidateProfile(env: NodeJS.ProcessEnv = process.env): CandidateProfile {
  const file = candidateProfilePath(env);
  if (!file) return EMPTY_PROFILE;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return EMPTY_PROFILE;
  }
  try {
    return parseCandidateProfile(JSON.parse(text));
  } catch (err) {
    console.warn(`[candidate-profile] ignoring ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_PROFILE;
  }
}

/** This process's profile, read once. */
export const CANDIDATE_PROFILE: CandidateProfile = loadCandidateProfile();
