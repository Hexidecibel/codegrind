// =============================================================================
// Language prompt profiles
// =============================================================================
// These tests exist because a prompt bug is invisible. A wrong Docker flag
// fails loudly on the next submission; a system prompt that tells the model to
// "write a pure, deterministic JavaScript function" while the Python harness
// waits for it produces a perfectly well-formed, perfectly wrong problem, at
// full generation cost, and the only symptom is that the bank fills with
// problems nobody can solve.
//
// So: no network, no API key, no mocking. Importing llm.service is safe by
// construction — the Anthropic client is built lazily on first CALL, which the
// module header calls out explicitly — and everything asserted below is a
// module-load constant.

import { describe, it, expect } from 'vitest';
import { LANGUAGES, type Language } from '../../shared/languages.js';
import {
  LANGUAGE_PROFILES,
  CORPUS_LANGUAGE,
  perLanguage,
  profileFor,
} from './llm.language.js';
import {
  GENERATE_SYSTEM_BY_LANGUAGE,
  COACH_SYSTEM_BY_LANGUAGE,
  DIFFICULTY_BRIEF_BY_LANGUAGE,
  EMIT_PROBLEM_TOOL_BY_LANGUAGE,
  PRIMER_SYSTEM,
  LESSON_SYSTEM,
} from './llm.service.js';

/** Tokens that must never appear in another language's prompt. */
const FOREIGN_TOKENS: Record<Language, RegExp[]> = {
  javascript: [/\bPython\b/, /\bJava\b/],
  python: [/\bJavaScript\b/, /\bTypeScript\b/, /\bJava\b/, /\bJS\b/],
  java: [/\bJavaScript\b/, /\bTypeScript\b/, /\bPython\b/],
};

describe('the profile registry', () => {
  it('covers every language exactly once', () => {
    expect(Object.keys(LANGUAGE_PROFILES).sort()).toEqual([...LANGUAGES].sort());
  });

  it('gives each profile the key it is filed under', () => {
    for (const language of LANGUAGES) {
      expect(profileFor(language).language).toBe(language);
    }
  });

  it('perLanguage builds one entry per language', () => {
    const built = perLanguage((p) => p.displayName);
    expect(Object.keys(built).sort()).toEqual([...LANGUAGES].sort());
    expect(built.python).toBe('Python');
  });
});

describe('the generation system prompt', () => {
  it('is precomputed, not rebuilt per read', () => {
    // Referential identity is the property that keeps `cache_control:
    // ephemeral` meaningful: a prompt reassembled per call is a fresh string,
    // and a fresh string that happens to be equal still costs nothing — but a
    // reassembly is also where an interpolated topic or timestamp would sneak
    // in and silently kill the cache. Freezing it at module load removes the
    // scope such a value could come from.
    expect(GENERATE_SYSTEM_BY_LANGUAGE.python).toBe(GENERATE_SYSTEM_BY_LANGUAGE.python);
    expect(COACH_SYSTEM_BY_LANGUAGE.python).toBe(COACH_SYSTEM_BY_LANGUAGE.python);
  });

  it('names its own language and no other', () => {
    for (const language of LANGUAGES) {
      const text = GENERATE_SYSTEM_BY_LANGUAGE[language];
      expect(text).toContain(LANGUAGE_PROFILES[language].displayName);
      for (const foreign of FOREIGN_TOKENS[language]) {
        expect(text, `${language} prompt mentions ${foreign}`).not.toMatch(foreign);
      }
    }
  });

  it('never leaks an undefined interpolation', () => {
    // The one failure mode a template literal has: a missing profile field
    // renders the word "undefined" into the prompt and the model dutifully
    // works around it.
    for (const language of LANGUAGES) {
      expect(GENERATE_SYSTEM_BY_LANGUAGE[language]).not.toContain('undefined');
      expect(COACH_SYSTEM_BY_LANGUAGE[language]).not.toContain('undefined');
      expect(DIFFICULTY_BRIEF_BY_LANGUAGE[language].expert).not.toContain('undefined');
    }
  });

  it('carries no per-call value — it is a pure function of the language', () => {
    // Anything topic- or difficulty-shaped in a CACHED prompt is a cache miss
    // on every request. The per-difficulty rubric deliberately lives in the
    // USER message instead; this asserts it stayed there.
    // NB "two-pointer" DOES appear here, as one of the static examples of a
    // pattern tag. That is a fixed part of the instructions, not the requested
    // topic — what must stay out is anything assembled per request.
    for (const language of LANGUAGES) {
      const text = GENERATE_SYSTEM_BY_LANGUAGE[language];
      expect(text).not.toContain('Create one '); // buildGenerateUserMessage's opener
      expect(text).not.toContain('Do NOT reuse any of these existing titles');
      expect(text).not.toMatch(/This is an EXPERT problem/); // the difficulty rubric
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe('the Python authoring rules', () => {
  const python = LANGUAGE_PROFILES.python;
  const prompt = GENERATE_SYSTEM_BY_LANGUAGE.python;

  it('bans the __main__ block the harness deliberately defeats', () => {
    // runner.py loads the solution under __name__ = "__cg_solution__", so a
    // trailing `if __name__ == "__main__":` block is dead code. Telling the
    // model up front is cheaper than a problem whose real logic never runs.
    expect(prompt).toContain('__main__');
  });

  it('demands spaces, because a tab is a real and invisible failure', () => {
    expect(prompt).toMatch(/4 spaces/);
    expect(prompt).toMatch(/never a tab/i);
  });

  it('describes what the harness can and cannot serialize', () => {
    // The three Python return types whose treatment is not obvious: a tuple
    // compares equal to a JSON array, a set compares order-insensitively, and
    // a generator has no JSON form at all.
    expect(prompt).toMatch(/tuple/i);
    expect(prompt).toMatch(/set compares/i);
    expect(prompt).toMatch(/generator/i);
  });

  it('emits a starter stub that is valid Python indentation', () => {
    const stub = python.starterStub('twoSum');
    expect(stub).toContain('def twoSum(');
    expect(stub).not.toContain('\t');
    expect(stub.split('\n')[1]).toMatch(/^ {4}\S/);
  });
});

describe('the safe-integer rubric', () => {
  it('binds every language to the transport bound', () => {
    // The bound is imposed by the harness, not by the language: every
    // `expected` is stored and compared after a round-trip through Node's
    // JSON.parse. It therefore applies even where the language could represent
    // more, which is exactly the sentence this asserts is present everywhere.
    for (const language of LANGUAGES) {
      const rubric = LANGUAGE_PROFILES[language].integerRubric;
      expect(rubric, language).toContain('2^53-1');
      expect(rubric, language).toContain('JSON.parse');
    }
  });

  it('gives each language its own hazard rather than a substituted noun', () => {
    // This is the site the plan singled out as un-substitutable. If these three
    // ever collapse into one templated sentence, the reason each language
    // breaches the bound is lost.
    expect(LANGUAGE_PROFILES.javascript.integerRubric).toMatch(/loses precision|silent/i);
    expect(LANGUAGE_PROFILES.python.integerRubric).toMatch(/arbitrary precision/i);
    expect(LANGUAGE_PROFILES.java.integerRubric).toMatch(/wraps|overflow/i);

    const rubrics = LANGUAGES.map((l) => LANGUAGE_PROFILES[l].integerRubric);
    expect(new Set(rubrics).size).toBe(LANGUAGES.length);
  });

  it('reaches the expert brief for every language', () => {
    for (const language of LANGUAGES) {
      expect(DIFFICULTY_BRIEF_BY_LANGUAGE[language].expert).toContain(
        LANGUAGE_PROFILES[language].integerRubric
      );
    }
  });

  it('leaves the hard brief language-neutral and identical everywhere', () => {
    // `hard` never mentioned an integer range, so it has nothing to fork over.
    const hard = LANGUAGES.map((l) => DIFFICULTY_BRIEF_BY_LANGUAGE[l].hard);
    expect(new Set(hard).size).toBe(1);
  });
});

describe('the emit_problem tool', () => {
  it('keeps one name across languages but forks the field descriptions', () => {
    // `tools` sits in front of `system` in the request, so it is inside the
    // cached prefix — which is why it is precomputed rather than rebuilt.
    for (const language of LANGUAGES) {
      expect(EMIT_PROBLEM_TOOL_BY_LANGUAGE[language].name).toBe('emit_problem');
    }
    const starters = LANGUAGES.map(
      (l) =>
        (EMIT_PROBLEM_TOOL_BY_LANGUAGE[l].input_schema.properties as Record<string, { description: string }>)
          .starterCode.description
    );
    expect(new Set(starters).size).toBe(LANGUAGES.length);
  });
});

describe('the shared study corpus', () => {
  it('is authored in one language on purpose', () => {
    // Lesson and primer PROSE is language-free (LESSON_SYSTEM forbids a fenced
    // block in a body), so only the snippet is language-bound. Forking these
    // prompts would fork the corpus — 90-180 generation calls per language
    // against 18 batched translations for the whole thing. Phase 4 overlays the
    // translated snippet at read time.
    expect(CORPUS_LANGUAGE).toBe('javascript');
    expect(PRIMER_SYSTEM).toContain('JavaScript');
    expect(LESSON_SYSTEM).toContain('JavaScript');
  });

  it('gives every language a snippet style for the translator to state', () => {
    // The translation prompt is the only consumer, and it is authored per PAIR
    // rather than per language — so a language added without this field would
    // produce a prompt that silently omits the house style instead of failing.
    for (const language of LANGUAGES) {
      const style = LANGUAGE_PROFILES[language].snippetStyle;
      expect(style, language).toBeTruthy();
      expect(style, language).not.toContain('undefined');
      // Authoring language, not translation language: "OPTIONAL" and "omit it
      // entirely" belong in snippetRule, and would tell a translator it may
      // decline to translate.
      expect(style, language).not.toMatch(/OPTIONAL|[Oo]mit it entirely/);
      for (const foreign of FOREIGN_TOKENS[language]) {
        expect(style, `${language} snippet style mentions ${foreign}`).not.toMatch(foreign);
      }
    }
  });

  it('still forbids fenced code in a lesson body', () => {
    // The single load-bearing property behind "lessons are shared": if a body
    // could contain a fence, the prose would be language-bound and the whole
    // translation strategy collapses.
    expect(LESSON_SYSTEM).toMatch(/NEVER put a fenced code block in the body/);
  });
});
