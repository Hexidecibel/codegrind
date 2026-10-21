// =============================================================================
// story-bank — the render rule, the competency map, the planner, the down path
// =============================================================================
// The rule that matters most: a story's `unconfirmed[]` is rendered ONLY under
// the OPEN QUESTIONS heading that says it is not fact — never in the confirmed
// block the grader may use. Ported from resume-builder's renderStoryForPrompt.

import { describe, it, expect } from 'vitest';
import {
  ALWAYS_ELIGIBLE,
  bankStatus,
  competenciesFor,
  competencyCoverage,
  competencyWeights,
  fetchStoryBank,
  gapCompetencies,
  normalizeBank,
  pickCompetencies,
  planBehavioral,
  renderGraderContext,
  renderStoryForGrader,
  storyBankUrl,
  storyCompetencies,
  type StoryBank,
} from './story-bank.js';
import { BQ_COMPETENCIES, BQ_QUESTIONS, pickQuestion, questionsFor } from '../../shared/behavioral-questions.js';

/** A seeded generator, so picks are reproducible. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Shaped like the live stories.json, trimmed. */
const RAW = {
  version: 1,
  stories: [
    {
      id: 'story-saas-rebuild',
      title: 'Rebuilding a single-tenant product as multi-tenant SaaS',
      employer: 'Sitehound',
      status: 'confirmed',
      situation: 'Each customer ran on its own environment.',
      task: 'Handed the job of building the replacement. (Assigned, not self-initiated.)',
      action: 'Led the architecture of a multi-tenant product.',
      result: 'Serves 50+ tenants.',
      numbers: ['~$3,000/month per environment before', '~$300/month after'],
      caveats: ['Cost figures are approximate; say roughly.', 'It was a NEW product, not a live migration.'],
      unconfirmed: ['Exact customers per environment', 'Whether the team was 5 or 10 at peak'],
      fits: ['hard technical challenge', 'long-horizon architecture', 'something you underestimated'],
      doesNotFit: ['initiative you drove (it was assigned)'],
    },
    {
      id: 'story-coaching-the-case',
      title: 'Coaching a colleague to make her case',
      status: 'confirmed',
      situation: 's',
      task: 't',
      action: 'a',
      result: 'r',
      numbers: [],
      caveats: ['It was her disagreement, not his.'],
      unconfirmed: [],
      fits: ['mentoring or coaching someone', 'influence without authority', 'helping someone disagree effectively with a senior leader'],
      doesNotFit: ['a disagreement you personally had'],
    },
    {
      id: 'story-reverse-code-review',
      title: 'Reverse code review',
      status: 'draft',
      situation: 's',
      task: '',
      action: 'a',
      result: '',
      numbers: [],
      caveats: [],
      unconfirmed: ['Who the junior was'],
      fits: ['mentoring someone junior'],
      doesNotFit: [],
    },
    { title: 'no id — dropped' },
  ],
  candidates: [{ title: 'ignored' }],
  gaps: [
    { type: 'disagreement or conflict', status: 'open', note: 'lone wolf' },
    { type: 'presenting to executives or the board', status: 'open' },
    { type: 'mentoring a specific person', status: 'partly covered' },
    { type: 'convincing others / persuasion', status: 'partly covered' },
    { type: 'a production incident', status: 'closed' },
    { type: 'failure', status: 'open', resolvedBy: 'story-x' },
  ],
};

const BANK: StoryBank = normalizeBank(RAW);

describe('normalizeBank', () => {
  it('drops a story with no id, defaults missing lists, and keeps gaps', () => {
    expect(BANK.stories.map((s) => s.id)).toEqual(['story-saas-rebuild', 'story-coaching-the-case', 'story-reverse-code-review']);
    expect(normalizeBank({ stories: [{ id: 'x' }] }).stories[0]).toMatchObject({ status: 'draft', numbers: [], unconfirmed: [] });
    expect(BANK.gaps).toHaveLength(6);
  });

  it('refuses a file with no stories array', () => {
    expect(() => normalizeBank({})).toThrow(/no stories/);
  });
});

describe('renderStoryForGrader — unconfirmed is never fact', () => {
  const saas = renderStoryForGrader(BANK.stories[0]);

  it('renders open questions ONLY under the OPEN QUESTIONS heading, after every confirmed field', () => {
    const at = saas.indexOf('OPEN QUESTIONS (NOT facts');
    expect(at).toBeGreaterThan(0);
    const confirmed = saas.slice(0, at);
    const open = saas.slice(at);
    for (const u of BANK.stories[0].unconfirmed) {
      expect(confirmed).not.toContain(u);
      expect(open).toContain(`  - ${u}`);
    }
    expect(open).toMatch(/never put one in a drill card/);
    // Nothing confirmed comes after the open questions.
    expect(open).not.toMatch(/^(situation|result|numbers):/m);
  });

  it('carries the caveats as how the story must be told', () => {
    expect(saas).toMatch(/how it must be told \(caveats/);
    for (const c of BANK.stories[0].caveats) expect(saas).toContain(`  - ${c}`);
  });

  it('marks a draft as unfinished, and omits the heading when nothing is unconfirmed', () => {
    expect(renderStoryForGrader(BANK.stories[2])).toMatch(/^DRAFT, CONFIRMED SO FAR/m);
    expect(renderStoryForGrader(BANK.stories[1])).not.toContain('OPEN QUESTIONS');
  });

  it('wraps the bank with the rules, gaps and coverage', () => {
    const ctx = renderGraderContext({ ok: true, bank: BANK });
    expect(ctx).toMatch(/^STORY BANK \(from resume-builder.*3 stories, 2 confirmed\)/);
    expect(ctx).toMatch(/OPEN QUESTIONS are not facts/);
    expect(ctx).toContain('<story id="story-saas-rebuild">');
    expect(ctx).toContain('- disagreement or conflict [open] — lone wolf');
    expect(ctx).not.toContain('a production incident [closed]');
    expect(ctx).toMatch(/^- conflict: NO STORY$/m);
    expect(renderGraderContext({ ok: true, bank: BANK })).toBe(ctx); // byte-stable
  });
});

describe('the story bank is down', () => {
  it('fetch never throws: unreachable, a 500, or garbage are all {ok:false}', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchStoryBank(boom)).toEqual({ ok: false, error: expect.stringMatching(/unreachable.*fetch failed/) });
    const five = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchStoryBank(five)).toEqual({ ok: false, error: 'resume-builder answered 500' });
    const junk = (async () => new Response('{"nope":1}', { status: 200 })) as unknown as typeof fetch;
    expect((await fetchStoryBank(junk)).ok).toBe(false);
  });

  it('reads the bank when it answers, from the configured URL', async () => {
    let url = '';
    const ok = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchStoryBank(ok);
    expect(r.ok && r.bank.stories).toHaveLength(3);
    expect(url).toBe('http://127.0.0.1:9410/api/data/read?file=stories.json');
    process.env.CODEGRIND_STORY_BANK_URL = 'http://elsewhere:1/';
    expect(storyBankUrl()).toBe('http://elsewhere:1/api/data/read?file=stories.json');
    delete process.env.CODEGRIND_STORY_BANK_URL;
  });

  it('tells the grader it has no bank, and reports status for the start card and the report', () => {
    const down = { ok: false as const, error: 'resume-builder unreachable (ECONNREFUSED)' };
    const ctx = renderGraderContext(down);
    expect(ctx).toMatch(/^STORY BANK: UNAVAILABLE/);
    expect(ctx).toMatch(/leave storyGaps empty/);
    expect(ctx).not.toContain('<story');
    expect(bankStatus(down)).toEqual({ loaded: false, stories: 0, confirmed: 0, openGaps: [], error: down.error });
    expect(bankStatus({ ok: true, bank: BANK })).toMatchObject({ loaded: true, stories: 3, confirmed: 2 });
  });

  it('still plans four questions without a bank', () => {
    const plan = planBehavioral({ bank: null, history: [], rand: seeded(1) });
    expect(plan.items.map((i) => i.stage)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });
});

describe('the competency map (keywords, no model)', () => {
  it('maps the live bank’s phrases', () => {
    expect(competenciesFor('stepping in outside your responsibility (ownership)')).toContain('ownership');
    expect(competenciesFor('influence without authority')).toEqual(['influence-without-authority']);
    expect(competenciesFor('changing a long-standing practice')).toContain('influence-without-authority');
    expect(competenciesFor('disagreement or conflict')).toEqual(['conflict']);
    expect(competenciesFor('a mistake and what you learned')).toContain('failure-learning');
    expect(competenciesFor('mentoring or coaching someone')).toEqual(['growing-others']);
    expect(competenciesFor('long-horizon architecture')).toContain('technical-strategy');
    expect(competenciesFor('working across team boundaries')).toContain('cross-team');
    expect(competenciesFor('presenting to executives or the board')).toEqual(['exec-communication']);
    expect(competenciesFor('debugging under pressure')).toContain('delivery-under-pressure');
    expect(competenciesFor('customer escalation')).toContain('customer-impact');
    expect(competenciesFor('forming a hypothesis when the obvious causes are ruled out')).toContain('ambiguity');
    expect(competenciesFor('convincing others / persuasion')).toEqual(['influence-without-authority']);
  });

  it('uses word boundaries, not substrings', () => {
    expect(competenciesFor('represent the data')).not.toContain('exec-communication');
  });

  it('subtracts what doesNotFit names', () => {
    // "helping someone disagree…" names conflict; "a disagreement you personally had" takes it away.
    expect(storyCompetencies(BANK.stories[1])).toEqual(['influence-without-authority', 'growing-others']);
    expect(storyCompetencies(BANK.stories[0])).not.toContain('ownership');
  });

  it('maps open gaps (open beats partial; closed and resolved are ignored)', () => {
    const g = gapCompetencies(BANK);
    expect(g.get('conflict')).toBe('open');
    expect(g.get('exec-communication')).toBe('open');
    expect(g.get('growing-others')).toBe('partial');
    expect(g.get('influence-without-authority')).toBe('partial');
    expect(g.has('delivery-under-pressure')).toBe(false);
    expect(g.has('failure-learning')).toBe(false);
  });

  it('covers confirmed stories first', () => {
    expect(competencyCoverage(BANK)['growing-others']).toEqual(['story-coaching-the-case', 'story-reverse-code-review']);
    expect(competencyCoverage(BANK).conflict).toEqual([]);
  });
});

describe('planning', () => {
  it('weights open gaps, weak past grades and influence without authority', () => {
    const { weights, reasons } = competencyWeights({
      bank: BANK,
      history: [
        { concept: 'prioritization', signal: 'weak' },
        { concept: 'prioritization', signal: 'missing' },
        { concept: 'ownership', signal: 'nailed' },
      ],
    });
    expect(weights.conflict).toBeGreaterThan(weights['customer-impact']);
    expect(reasons.conflict).toContain('open story-bank gap');
    expect(reasons.prioritization).toContain('weak in past grades');
    expect(weights.prioritization).toBeGreaterThan(weights.ambiguity);
    expect(reasons[ALWAYS_ELIGIBLE]).toContain('your known weak spot');
    // Nailed lowers, never to zero.
    expect(weights.ownership).toBeGreaterThan(0);
    for (const c of BQ_COMPETENCIES) expect(weights[c]).toBeGreaterThanOrEqual(0.25);
  });

  it('picks four distinct competencies, favouring the heavy ones over many draws', () => {
    const { weights } = competencyWeights({ bank: BANK, history: [] });
    const rand = seeded(7);
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const picked = pickCompetencies(weights, 4, rand);
      expect(new Set(picked).size).toBe(4);
      for (const c of picked) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.get('influence-without-authority')!).toBeGreaterThan(counts.get('customer-impact') ?? 0);
    expect(counts.get('conflict')!).toBeGreaterThan(counts.get('customer-impact') ?? 0);
  });

  it('honours a requested plan of four distinct known competencies, and ignores anything else', () => {
    const req = { concepts: ['conflict', 'ownership', 'ambiguity', 'cross-team'] };
    expect(planBehavioral({ bank: BANK, history: [], requested: req, rand: seeded(2) }).items.map((i) => i.concept)).toEqual(
      req.concepts
    );
    for (const bad of [{ concepts: ['conflict', 'conflict', 'ownership', 'ambiguity'] }, { concepts: ['nope', 'a', 'b', 'c'] }, { concepts: ['conflict'] }, 'x']) {
      const items = planBehavioral({ bank: BANK, history: [], requested: bad, rand: seeded(2) }).items;
      expect(new Set(items.map((i) => i.concept)).size).toBe(4);
    }
  });

  it('asks a question from each planned competency, preferring one not asked recently', () => {
    const plan = planBehavioral({ bank: BANK, history: [], rand: seeded(3) });
    for (const i of plan.items) {
      expect(questionsFor(i.concept as never).map((q) => q.id)).toContain(i.questionId);
    }
    const all = questionsFor('conflict').map((q) => q.id);
    const recent = all.slice(0, -1);
    for (let s = 0; s < 10; s++) expect(pickQuestion('conflict', recent, seeded(s)).id).toBe(all[all.length - 1]);
  });
});

describe('the question catalog', () => {
  it('has ~40 Staff questions, unique ids, at least three per competency', () => {
    expect(BQ_QUESTIONS.length).toBeGreaterThanOrEqual(36);
    expect(new Set(BQ_QUESTIONS.map((q) => q.id)).size).toBe(BQ_QUESTIONS.length);
    for (const c of BQ_COMPETENCIES) expect(questionsFor(c).length).toBeGreaterThanOrEqual(3);
  });
});
