// =============================================================================
// The language registry, and the three other files that must agree with it
// =============================================================================
// A language is described in four places, each owning a different kind of fact:
//
//   src/shared/languages.ts       presentation + authoring (this file's subject)
//   bin/lib/languages.sh          the docker facts
//   test-harness/<lang>/          the harness that actually runs the code
//   package.json                  the CodeMirror grammar for the mobile editor
//
// Splitting them is right — the browser has no business knowing an image tag —
// but a four-way split has a four-way failure mode: a language half-added,
// which does not throw anywhere. It serves an unhighlighted buffer, or expands
// to an empty image name, or falls back to another language's grammar. These
// tests are the seam that makes a half-added language loud.
//
// Everything here is filesystem and constant reading. No database, no network,
// no docker.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, LANGUAGE_META, DEFAULT_LANGUAGE, isLanguage, type Language } from './languages.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGUAGES_SH = fs.readFileSync(path.join(REPO_ROOT, 'bin/lib/languages.sh'), 'utf8');

/** The keys of a `declare -A NAME=( [k]=v … )` block in languages.sh. */
function bashTableKeys(name: string): string[] {
  const block = new RegExp(`declare -A ${name}=\\(([^)]*)\\)`, 'm').exec(LANGUAGES_SH);
  if (!block) throw new Error(`no ${name} table in bin/lib/languages.sh`);
  return [...block[1].matchAll(/\[([a-z]+)\]=/g)].map((m) => m[1]);
}

/** True when `test-harness/<language>/Dockerfile` exists — i.e. it can be built. */
function hasHarness(language: Language): boolean {
  return fs.existsSync(path.join(REPO_ROOT, 'test-harness', language, 'Dockerfile'));
}

/**
 * The languages this build deliberately cannot run yet.
 *
 * ASSERTED, not skipped. This list used to be a `continue` in the middle of one
 * test, which made "Java has no harness" a thing the suite quietly tolerated
 * rather than a thing it knew — and that is precisely why nothing caught the
 * language picker offering Java anyway, at a cost of three generation calls and
 * an error blaming the model. Naming it here turns the same fact into a claim,
 * so the day `test-harness/java/` lands this file fails and points at every
 * other surface that has to be told.
 *
 * When a language is finished: delete it from this array and the rest follows.
 */
const PENDING: readonly Language[] = ['java'];

/** Read a source file from the repo, for the "is the gate wired up" checks. */
function source(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

describe('the language registry', () => {
  it('gives every language a meta entry keyed by itself', () => {
    expect(Object.keys(LANGUAGE_META).sort()).toEqual([...LANGUAGES].sort());
  });

  it('keeps the default language in the set', () => {
    expect(LANGUAGES).toContain(DEFAULT_LANGUAGE);
  });

  it('narrows only exact members', () => {
    for (const l of LANGUAGES) expect(isLanguage(l)).toBe(true);
    expect(isLanguage('Go')).toBe(false);
    expect(isLanguage('golang')).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });

  it('gives every language a distinct display name, fence and extension', () => {
    for (const key of ['displayName', 'codeFence', 'fileExtension'] as const) {
      const values = LANGUAGES.map((l) => LANGUAGE_META[l][key]);
      expect(new Set(values).size, key).toBe(LANGUAGES.length);
    }
  });

  it('never pairs tabs with an indent width of one', () => {
    // When insertSpaces is false, indentSize stops being a count of spaces and
    // becomes the DISPLAY width of a tab. Reading the plan's "indentSize: 1,
    // with tabs" literally would render Go at one column per level, which is
    // unreadable and tells you nothing about gofmt.
    for (const l of LANGUAGES) {
      const meta = LANGUAGE_META[l];
      if (!meta.insertSpaces) expect(meta.indentSize, l).toBeGreaterThan(1);
    }
  });
});

describe('agreement with bin/lib/languages.sh', () => {
  it('describes exactly the same set of languages, in the same order', () => {
    // Order matters as well as membership: bash iterates CG_LANGUAGES to decide
    // what to build, and the two lists reading differently is the first symptom
    // of a language that exists to the app but not to the build.
    const declared = /^CG_LANGUAGES=\(([^)]*)\)/m.exec(LANGUAGES_SH);
    expect(declared, 'no CG_LANGUAGES in bin/lib/languages.sh').toBeTruthy();
    expect(declared![1].trim().split(/\s+/)).toEqual([...LANGUAGES]);
  });

  it('gives every language a row in every docker table', () => {
    // A missing row does not fail loudly in bash: `${CG_IMAGE[go]}` expands to
    // the empty string under `set -u` only because it is an associative array
    // miss, and docker is then handed a nonsense command line.
    for (const table of ['CG_IMAGE', 'CG_SRCNAME', 'CG_CMD', 'CG_MEMORY', 'CG_PIDS', 'CG_TIMEOUT', 'CG_TMPFS']) {
      expect(bashTableKeys(table).sort(), table).toEqual([...LANGUAGES].sort());
    }
  });

  it('gives a compiled language an executable /tmp and denies it to the rest', () => {
    // `exec` is a real relaxation of the sandbox, granted only where a compiler
    // writes a binary and then runs it. Go needs it; an interpreted language
    // that acquired it would be a silent widening of the blast radius.
    const rows = /declare -A CG_TMPFS=\(([^)]*)\)/m.exec(LANGUAGES_SH)![1];
    expect(rows).toMatch(/\[go\]=\/tmp:exec/);
    expect(rows).toMatch(/\[javascript\]=\/tmp\s/);
    expect(rows).toMatch(/\[python\]=\/tmp\s/);
  });

  it('keeps the outer timeout strictly above the harness budgets it wraps', () => {
    // The outer `timeout` around docker run must never fire first, or the
    // structured partial results are lost and the caller sees an opaque kill.
    // Go's harness spends up to a 10s compile plus a 10s run plus 3s of grace.
    const rows = /declare -A CG_TIMEOUT=\(([^)]*)\)/m.exec(LANGUAGES_SH)![1];
    const go = /\[go\]=(\d+)/.exec(rows);
    expect(go).toBeTruthy();
    expect(Number(go![1])).toBeGreaterThan(23);
  });
});

describe('agreement with the harnesses and the editors', () => {
  it('has a harness on disk for exactly the languages that are not still pending', () => {
    // Both directions. A supported language that lost its harness means the app
    // can serve a language nothing can run; a PENDING language that GAINED one
    // means the rest of this file's claims are now stale and every gate built on
    // "supported" is silently understating what the build can do.
    for (const l of LANGUAGES) {
      expect(hasHarness(l), `test-harness/${l}/Dockerfile`).toBe(!PENDING.includes(l));
    }
  });

  it('keeps the default language out of the pending set', () => {
    // A pending default would mean a fresh install cannot run anything at all.
    expect(PENDING).not.toContain(DEFAULT_LANGUAGE);
  });

  it('has a CodeMirror grammar dependency for every buildable language', () => {
    // The mobile editor DEGRADES GRACEFULLY on a missing grammar — no crash,
    // just an unhighlighted buffer — which makes a forgotten `npm install` the
    // kind of bug that ships. GRAMMARS in CodeMirrorEditor.tsx cannot be
    // imported here without dragging in the whole CM6 stack, so the dependency
    // itself is what gets asserted.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const l of LANGUAGES) {
      if (!hasHarness(l)) continue;
      expect(deps[`@codemirror/lang-${l}`], `@codemirror/lang-${l}`).toBeTruthy();
    }
  });

  it('names a Monaco grammar that monaco-editor actually registers', () => {
    // Monaco's default ESM entry registers every grammar it ships, which is why
    // the desktop editor costs nothing per language — but only for the ids it
    // really has. `golang` instead of `go` would silently give a plain buffer.
    const entry = fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules/monaco-editor/esm/vs/index.js'),
      'utf8',
    );
    for (const l of LANGUAGES) {
      expect(entry, l).toContain(`languages/definitions/${LANGUAGE_META[l].monacoId}/register.js`);
    }
  });
});

// =============================================================================
describe('an unsupported language is not reachable', () => {
  // The registry is a vocabulary, not a menu. Every surface that lets a
  // language be CHOSEN — the wizard, the picker, the settings write — has to
  // narrow it to what this build can run, and each of these is a place that
  // previously did not, or still might stop.

  it('answers "can this build run it" from the filesystem, for real', async () => {
    const { harnessExists, isSupportedLanguage, supportedLanguages, unsupportedLanguageMessage } =
      await import('../server/services/harness.service.js');

    for (const l of LANGUAGES) expect(harnessExists(l), l).toBe(hasHarness(l));
    expect(supportedLanguages()).toEqual(LANGUAGES.filter(hasHarness));

    for (const l of PENDING) {
      // `isLanguage` says yes — it is a real member of the registry. That is the
      // whole trap, and why write paths need the stricter guard.
      expect(isLanguage(l), l).toBe(true);
      expect(isSupportedLanguage(l), l).toBe(false);
      // And the sentence names the language and the real reason.
      expect(unsupportedLanguageMessage(l)).toContain(LANGUAGE_META[l].displayName);
      expect(unsupportedLanguageMessage(l)).toContain('no sandbox harness');
    }
    expect(isSupportedLanguage('kotlin')).toBe(false);
  });

  it('makes the settings write gate consult the harness, not just the registry', () => {
    // PUT /api/settings is the only route that stores a language, and it used to
    // stop at `isLanguage`. See settings.test.ts for the behavioural half; this
    // is the seam that notices the import being dropped.
    const route = source('src/server/routes/settings.ts');
    expect(route).toContain('harness.service.js');
    expect(route).toMatch(/harnessExists\(/);
  });

  it('makes the language picker offer the supported set rather than the registry', () => {
    // LanguagePicker.tsx mapped `LANGUAGES` directly, which is how Java got into
    // the Manual and Settings pickers while the wizard correctly hid it.
    const picker = source('src/client/components/LanguagePicker.tsx');
    expect(picker).toContain('supportedLanguageOptions');
    expect(picker).not.toMatch(/LANGUAGES\.map\(/);
  });

  it('keeps the first-run wizard filtering on the same field', () => {
    const wizard = source('src/client/components/setup/SetupWizard.tsx');
    expect(wizard).toMatch(/state\.languages\.filter\(\(l\) => l\.supported\)/);
  });
});

describe("the Go image's build cache", () => {
  // The only language here with a cache to keep warm is the only one that can
  // lose a day to it. `go build` rewrites $GOCACHE/trim.txt once every 24h and
  // calls Fatalf if it cannot, so a Go image whose stamp was baked in
  // root-owned compiled fine for one day and then failed every submission that
  // COMPILES — with compile ERRORS still passing, because go prints its
  // diagnostics before it dies.
  //
  // WHAT THIS TEST IS, AND WHAT IT IS NOT. Nothing in this suite starts docker,
  // which is precisely why 448 passing tests said nothing while production was
  // broken. So this asserts the LINE that keeps the trim stamp writable and
  // claims nothing about behaviour. The behavioural proof forces the aged
  // condition rather than trusting a fresh image, and lives in the two places
  // that can actually run a container: the image's own --selftest probe
  // (cgSelftestCacheTrim in test-harness/go/runner.go, which bin/build-runner-image
  // runs under the production sandbox flags) and proof 6 of bin/smoke-go. This
  // is the cheap seam that notices the Dockerfile line vanishing in an edit,
  // one `npx vitest run` later instead of 24 hours later.
  const DOCKERFILE = source('test-harness/go/Dockerfile');

  it('points the cache trim stamp at a writable tmpfs path', () => {
    // /tmp is the only writable surface a --read-only runner has, and it is
    // fresh per container — so the trim succeeds no matter how old the image
    // is, which is the whole requirement. Nothing self-heals otherwise:
    // bin/deploy and bin/setup only BUILD an image that is missing.
    expect(DOCKERFILE).toMatch(/ln -s\s+\/tmp\/\S+\s+\/gocache\/trim\.txt/);
  });

  it('leaves the baked cache itself read-only and in the image', () => {
    // The fix has to stay a symlink for ONE file. Moving the whole GOCACHE onto
    // a tmpfs, or copying 42MB into one per submission, would give up the warm
    // cache — and a cold build measured inside this sandbox is 10.05s against a
    // 10s compile budget, so that is not a slowdown, it is every submission
    // failing.
    expect(DOCKERFILE).toMatch(/GOCACHE=\/gocache/);
    expect(DOCKERFILE).not.toMatch(/--tmpfs\s+\/gocache/);
  });
});
