// =============================================================================
// The four spending CLIs must ask the APP whether they need a key, not the env
// =============================================================================
// This lives in src/ for the same reason src/shared/deploy-units.test.ts does:
// it asserts a fact that spans the repo rather than a module, and putting it
// where `tsc -b` and `vitest` already look is what stops it from quietly not
// running.
//
// THE BUG IT EXISTS FOR SHIPPED, in bin/warm-lessons.ts and
// bin/translate-corpus.ts. Both opened with
//
//     if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) { ...exit 1 }
//
// and neither called hydrate() or hydrateProviderConfig(). Three consequences,
// all of them on somebody else's install rather than the author's:
//
//   1. A key pasted into the first-run wizard lives in the `settings` table, not
//      in the environment — so the two scripts refused to run on an install that
//      was correctly configured through the only path the app documents.
//   2. A FULLY LOCAL, KEYLESS install was refused outright, even though the app
//      is designed to run with no Anthropic key at all.
//   3. Past the check they would have resolved routing from the environment
//      alone and defaulted to Anthropic — so a local user got billed, or got a
//      401 for a key they were never asked to have.
//
// bin/seed-bank.ts and bin/dry-run-generate.ts already did it correctly. The
// property below is therefore stated over ALL FOUR: the check is
// `needsAnthropicKey() && !isConfigured()`, after both hydrations, and nowhere
// is process.env.ANTHROPIC_API_KEY consulted to make the decision.
//
// The second property is about WHO IS READING. The old message said "provision
// it via bin/inject" — the author's private cush-tools/Infisical plumbing, which
// means nothing in anyone else's clone and names a tool they cannot install.
// User-facing STRINGS in bin/ must not reference it. Comments may: the reason
// the key is not kept in .env is precisely that bin/inject truncates it, and
// that explanation is worth keeping.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN_DIR = path.join(REPO_ROOT, 'bin');

/** Every CLI that can spend money on a generation call. */
const SPENDING_CLIS = [
  'bin/seed-bank.ts',
  'bin/dry-run-generate.ts',
  'bin/warm-lessons.ts',
  'bin/translate-corpus.ts',
] as const;

function parse(rel: string): ts.SourceFile {
  const abs = path.join(REPO_ROOT, rel);
  return ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.ES2020, true);
}

/** Every node in the file, in source order. */
function nodes(sf: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    out.push(n);
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/** Position of the first `name(...)` call, or -1. Source order, not scope. */
function firstCallPos(sf: ts.SourceFile, name: string): number {
  for (const n of nodes(sf)) {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      return n.getStart(sf);
    }
  }
  return -1;
}

/**
 * The text of every STRING the file would print — literals and template heads
 * alike. Parsed rather than grepped, because the honest explanation of why the
 * key does not live in .env mentions `bin/inject` inside a comment and a naive
 * search cannot tell the two apart.
 */
function stringLiterals(sf: ts.SourceFile): string[] {
  return nodes(sf)
    .filter(
      (n) =>
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n) ||
        ts.isTemplateMiddle(n) ||
        ts.isTemplateTail(n)
    )
    .map((n) => (n as ts.LiteralLikeNode).text);
}

describe('the spending CLIs gate on resolved routing, not on the environment', () => {
  for (const rel of SPENDING_CLIS) {
    describe(rel, () => {
      const sf = parse(rel);

      it('never decides on process.env.ANTHROPIC_API_KEY', () => {
        const reads = nodes(sf)
          .filter(ts.isPropertyAccessExpression)
          .map((n) => n.getText(sf))
          .filter((t) => t.includes('process.env.ANTHROPIC_API_KEY'));
        expect(reads).toEqual([]);
      });

      it('hydrates the stored provider config and the stored key', () => {
        expect(firstCallPos(sf, 'hydrateProviderConfig')).toBeGreaterThan(-1);
        expect(firstCallPos(sf, 'hydrate')).toBeGreaterThan(-1);
      });

      it('asks needsAnthropicKey()/isConfigured(), and only AFTER hydrating', () => {
        const gate = firstCallPos(sf, 'needsAnthropicKey');
        expect(gate).toBeGreaterThan(-1);
        expect(firstCallPos(sf, 'isConfigured')).toBeGreaterThan(-1);
        // Hydration first, or the gate reads a config the app has not loaded and
        // a wizard-configured install looks unconfigured.
        expect(firstCallPos(sf, 'hydrateProviderConfig')).toBeLessThan(gate);
        expect(firstCallPos(sf, 'hydrate')).toBeLessThan(gate);
      });

      it('tells the refused user about the setup screen', () => {
        const printed = stringLiterals(sf).join('\n');
        expect(printed).toMatch(/setup screen/);
        expect(printed).toMatch(/ANTHROPIC_API_KEY/);
      });
    });
  }
});

describe('nothing in bin/ tells a stranger to use the author private tooling', () => {
  // Comments are fine and often necessary; printed strings are not.
  const PRIVATE_TOOLING = [/bin\/inject/i, /cush-tools/i, /infisical/i, /1password/i];
  const CLI_SOURCES = fs
    .readdirSync(BIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `bin/${f}`);

  it('covers every bin/*.ts, so a new one cannot skip the rule', () => {
    // A guard on the guard: if bin/ grows a CLI this list must grow with it.
    expect(CLI_SOURCES.length).toBeGreaterThanOrEqual(SPENDING_CLIS.length);
    for (const cli of SPENDING_CLIS) expect(CLI_SOURCES).toContain(cli);
  });

  for (const rel of CLI_SOURCES) {
    it(`${rel} prints no reference to it`, () => {
      const offending = stringLiterals(parse(rel)).filter((s) =>
        PRIVATE_TOOLING.some((re) => re.test(s))
      );
      expect(offending).toEqual([]);
    });
  }
});
