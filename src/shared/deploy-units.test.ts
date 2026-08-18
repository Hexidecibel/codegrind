// =============================================================================
// deploy/ is a set of TEMPLATES, and bin/install-units is what makes them real
// =============================================================================
// This lives in src/ for the same reason src/shared/languages.test.ts does: it
// asserts a fact that spans the repo rather than a module, and putting it where
// `tsc -b` and `vitest` already look is what stops it from quietly not running.
//
// The bug it exists for shipped: deploy/codegrind.service carried one machine's
// absolute paths — /home/hexi/local/src/codegrind, User=hexi and a pinned
// /home/hexi/.nvm/versions/node/v22.22.0/bin — and bin/install-units copied all
// three units into /etc verbatim with `sudo install`. Anybody else who cloned
// the repo and followed docs/operations.md got three units pointing at a
// directory that does not exist on their box and a timer that fails on every
// activation. Nothing typechecked, tested or linted could see it.
//
// So the two properties worth pinning are:
//
//   1. NO TEMPLATE CONTAINS A MACHINE-SPECIFIC PATH. That is the regression.
//   2. THE RENDERER FILLS IN EVERY PLACEHOLDER, from the same sources the rest
//      of bin/ uses — the script's own location, the invoking user, and
//      bin/lib/node.sh's Node. A unit installed with an `@…@` left in it is a
//      unit systemd refuses to load.
//
// Everything here is `bin/install-units --print`, which renders to stdout and
// touches nothing: no sudo, no /etc, no systemctl.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_UNITS = path.join(REPO_ROOT, 'bin/install-units');
const DEPLOY_DIR = path.join(REPO_ROOT, 'deploy');

/** Every file in deploy/ — the templates the installer is responsible for. */
const TEMPLATES = fs.readdirSync(DEPLOY_DIR).sort();

/** `bin/install-units --print <unit>`: the exact bytes that would reach /etc. */
function render(unit: string): string {
  return execFileSync('bash', [INSTALL_UNITS, '--print', unit], { encoding: 'utf8' });
}

/** The value of `Key=` in a rendered unit, or undefined. */
function directive(unit: string, key: string): string | undefined {
  const line = unit.split('\n').find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}

// =============================================================================
describe('the templates are machine-independent', () => {
  it('lists every deploy/ file in the installer, so none is silently skipped', () => {
    const script = fs.readFileSync(INSTALL_UNITS, 'utf8');
    const units = /^UNITS=\(([^)]*)\)/m.exec(script);
    expect(units, 'no UNITS=(…) array in bin/install-units').not.toBeNull();
    expect(units![1].trim().split(/\s+/).sort()).toEqual(TEMPLATES);
  });

  // The regression itself. `/home/` is the shape every one of the old hardcoded
  // values had, and it is what `grep -rn '/home/hexi' bin/` was already checked
  // for in docs/operations.md — deploy/ was the hole in that check.
  it.each(TEMPLATES)('%s hardcodes no home directory', (unit) => {
    const template = fs.readFileSync(path.join(DEPLOY_DIR, unit), 'utf8');
    // `##` lines are template commentary stripped at render time, and they are
    // allowed to *name* the old paths — that is where the incident is recorded.
    const directives = template
      .split('\n')
      .filter((l) => !l.startsWith('##'))
      .join('\n');
    expect(directives).not.toMatch(/\/home\//);
    expect(directives).not.toMatch(/\.nvm\//);
  });
});

// =============================================================================
describe('rendering a unit for this machine', () => {
  it.each(TEMPLATES)('%s comes out with every placeholder filled in', (unit) => {
    const out = render(unit);
    expect(out).not.toMatch(/@[A-Z_]+@/);
    // Template-only commentary must not reach /etc; real `#` comments must.
    expect(out.split('\n').some((l) => l.startsWith('##'))).toBe(false);
    expect(out).toMatch(/^\[(Unit|Install|Service|Timer)]$/m);
  });

  it('is deterministic — two renders are byte-identical', () => {
    for (const unit of TEMPLATES) expect(render(unit)).toBe(render(unit));
  });

  it('points the service at THIS checkout, derived rather than written down', () => {
    const out = render('codegrind.service');
    expect(directive(out, 'WorkingDirectory')).toBe(REPO_ROOT);
    expect(directive(out, 'EnvironmentFile')).toBe(path.join(REPO_ROOT, '.env'));
  });

  it('runs as a real user, never root — the app needs docker group, not privilege', () => {
    const user = directive(render('codegrind.service'), 'User');
    expect(user).toBeTruthy();
    expect(user).not.toBe('root');
    expect(user).not.toMatch(/\s/);
    // Both units must agree, or the reaper cannot clean up after the service.
    expect(directive(render('codegrind-reap.service'), 'User')).toBe(user);
  });

  it('pins a Node that exists, on the PATH and in ExecStart, from bin/lib/node.sh', () => {
    const out = render('codegrind.service');
    const exec = directive(out, 'ExecStart')!;
    const nodeBin = path.dirname(exec.split(' ')[0]);
    expect(fs.existsSync(path.join(nodeBin, 'node'))).toBe(true);
    // The service PATH must lead with the SAME directory: a unit whose npx and
    // whose PATH disagree loads better-sqlite3 under two different ABIs.
    const envPath = out
      .split('\n')
      .find((l) => l.startsWith('Environment=PATH='))!
      .slice('Environment=PATH='.length);
    expect(envPath.split(':')[0]).toBe(nodeBin);
  });

  it('sends the reaper at this checkout’s own script', () => {
    const out = render('codegrind-reap.service');
    expect(directive(out, 'ExecStart')).toBe(path.join(REPO_ROOT, 'bin/reap-runners'));
    expect(fs.existsSync(path.join(REPO_ROOT, 'bin/reap-runners'))).toBe(true);
  });
});

// =============================================================================
describe('what the render must NOT throw away', () => {
  // These comments are the only record of why the timer exists and why five
  // minutes is the right interval. A renderer that stripped every `#` line
  // would delete an incident report and nothing would notice.
  it('keeps the reap timer’s incident notes', () => {
    const out = render('codegrind-reap.timer');
    expect(out).toContain('Two of those ran for 10 days once.');
    expect(out).toContain('MAX_AGE is 300s');
    expect(directive(out, 'OnUnitActiveSec')).toBe('5min');
    expect(directive(out, 'Unit')).toBe('codegrind-reap.service');
  });

  it('keeps the reaper’s reason for not running as root', () => {
    expect(render('codegrind-reap.service')).toContain('docker group');
  });
});

// =============================================================================
describe('host-local config keeps its own home', () => {
  // The author's box carries CODEGRIND_MODEL_DENY in
  // /etc/systemd/system/codegrind.service.d/model-deny.conf: model ids that
  // exist only on that machine's LLM router, one of which starved a Plex
  // transcode. Drop-ins are separate files systemd merges over the unit, so the
  // installer can rewrite the unit without ever seeing them — and the generated
  // banner is what tells the next person where to put theirs.
  it('every rendered unit names its drop-in directory', () => {
    for (const unit of TEMPLATES) {
      expect(render(unit)).toContain(`/etc/systemd/system/${unit}.d/*.conf`);
    }
  });

  it('the installer never writes, reads or removes a drop-in', () => {
    const script = fs.readFileSync(INSTALL_UNITS, 'utf8');
    // The only `.d/` in an executed line is the --status listing, which reports
    // drop-ins and leaves them alone. Nothing may install or delete one.
    expect(script).not.toMatch(/^\s*sudo (install|rm|cp|tee).*\.d\//m);
  });
});
