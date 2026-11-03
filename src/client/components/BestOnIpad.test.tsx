// The coding places met on a phone: one line, one primary action, a quiet way
// through. Markup only (no DOM in this runner).
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BestOnIpad } from './BestOnIpad';
import { oneLine, phoneBlocksKind } from '@/client/pages/MockPage';
import { MOCK_KINDS, mockKindInfo } from '@/shared/mock-kinds';

const noop = () => {};

function render(action: Parameters<typeof BestOnIpad>[0]['action']) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BestOnIpad action={action} onOpenAnyway={noop} />
    </MemoryRouter>,
  );
}

describe('BestOnIpad', () => {
  it('says one line and links the phone-shaped alternative', () => {
    const html = render({ label: 'Do Recognize ×5 instead', to: '/recognize?n=5' });
    expect(html).toContain('Code this on iPad.');
    expect(html).toMatch(/<a[^>]*href="\/recognize\?n=5"[^>]*>Do Recognize ×5 instead<\/a>/);
    expect(html).toContain('Open anyway');
  });

  it('has exactly one primary action; Open anyway is a quiet link-styled button', () => {
    const html = render({ label: 'Read it', onClick: noop });
    expect(html.match(/bg-primary(?=[\s"])/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*class="[^"]*text-muted-foreground[^"]*"[^>]*>Open anyway<\/button>/);
    expect(html).toMatch(/<button[^>]*>Read it<\/button>/);
  });

  it('keeps both targets at least 44px', () => {
    const html = render({ label: 'Read it', onClick: noop });
    expect(html).toContain('h-12');
    expect(html).toContain('min-h-11');
  });
});

describe('mock on a phone', () => {
  it('only the coding kind is the iPad’s', () => {
    expect(MOCK_KINDS.filter((k) => phoneBlocksKind(k, true))).toEqual(['coding']);
    expect(MOCK_KINDS.filter((k) => phoneBlocksKind(k, false))).toEqual([]);
  });

  it('shortens each allowed kind’s intro to one sentence', () => {
    for (const k of MOCK_KINDS.filter((x) => x !== 'coding')) {
      const line = oneLine(mockKindInfo(k).start.blurb);
      expect(line).toMatch(/^A .*over chat\.$/);
      expect(line.length).toBeLessThan(60);
    }
  });
});
