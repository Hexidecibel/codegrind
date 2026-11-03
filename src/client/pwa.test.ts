// The home-screen install: the manifest is fetched with the login cookie, the
// app opens full screen and portrait, and Android gets a maskable icon whose
// glyph sits inside the safe zone.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('PWA', () => {
  it('index.html links the manifest with credentials and asks for full screen', () => {
    const html = read('index.html');
    expect(html).toMatch(/<link rel="manifest" href="\/site.webmanifest" crossorigin="use-credentials" \/>/);
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('viewport-fit=cover');
  });

  it('the manifest has an id, a scope, portrait, and a maskable icon that exists', () => {
    const m = JSON.parse(read('public/site.webmanifest'));
    expect(m).toMatchObject({ id: '/', scope: '/', start_url: '/', orientation: 'portrait', display: 'standalone' });
    const maskable = m.icons.filter((i: { purpose?: string }) => i.purpose?.includes('maskable'));
    expect(maskable).toHaveLength(1);
    expect(existsSync(new URL(`public${maskable[0].src}`, root))).toBe(true);
  });
});
