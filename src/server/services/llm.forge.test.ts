// =============================================================================
// llm.forge — the coach's prompt carries the never-invent rule; the coercer enforces it
// =============================================================================
import { describe, it, expect } from 'vitest';
import { EMIT_FORGE_TURN_TOOL, FORGE_SYSTEM, coerceForgeTurn, renderForgeInput } from './llm.forge.js';
import { CANDIDATE_KNOWN_FACTS } from './story-bank.js';

describe('the forge prompt', () => {
  it('states the never-invent rule and the pushback kinds', () => {
    expect(FORGE_SYSTEM).toMatch(/THE NEVER-INVENT RULE/);
    expect(FORGE_SYSTEM).toMatch(/Never invent, estimate, round up or "fill in"/);
    expect(FORGE_SYSTEM).toMatch(/ASK for it/);
    expect(FORGE_SYSTEM).toMatch(/unconfirmed\[\] items are open questions, never facts/);
    for (const k of ['i-vs-we', 'vague-scope', 'no-number', 'staff-framing']) expect(FORGE_SYSTEM).toContain(`- ${k}:`);
    expect(FORGE_SYSTEM).toMatch(/influence without authority/);
  });

  it('renders the known facts, the seed under its NOT-facts heading, the transcript, and the reminder last', () => {
    const text = renderForgeInput({
      competency: 'conflict',
      seed: 'OPEN QUESTIONS (NOT facts …):\n  - who disagreed',
      seedConfirmed: '',
      knownFacts: CANDIDATE_KNOWN_FACTS,
      turns: [
        { role: 'coach', content: 'What was the situation?' },
        { role: 'you', content: 'we disagreed about tenancy' },
      ],
      answers: 1,
      maxTurns: 12,
    });
    expect(text).toContain('Competency the story is for: conflict (Conflict & disagreement)');
    expect(text).toMatch(/Sitehound was a NEW multi-tenant SaaS product/);
    expect(text).toMatch(/dox \/ supdox has NO live customers/);
    expect(text).toMatch(/gwag and corrallm are NOT the candidate's projects/);
    expect(text).toMatch(/OPEN QUESTIONS are not facts/);
    expect(text).toContain('COACH: What was the situation?\nCANDIDATE: we disagreed about tenancy');
    expect(text.trim().split('\n').pop()).toMatch(/^Remember: nothing goes into the draft that the candidate did not say/);
    expect(renderForgeInput({ competency: 'conflict', seed: '', seedConfirmed: '', knownFacts: '', turns: [], answers: 11, maxTurns: 12 })).toMatch(/nearly spent/);
  });

  it('is a strict tool with `say` last as the leak sink', () => {
    const keys = Object.keys(EMIT_FORGE_TURN_TOOL.schema.properties as object);
    expect(keys[keys.length - 1]).toBe('say');
    expect(EMIT_FORGE_TURN_TOOL.leakSink).toBe('say');
    expect(EMIT_FORGE_TURN_TOOL.exactSchema).toBe(true);
  });
});

describe('coerceForgeTurn', () => {
  it('drops unknown beats/pushback, fills the next beat, and moves numbers the candidate never said', () => {
    const r = coerceForgeTurn(
      {
        covered: ['situation', 'bogus', 'situation'],
        nextBeat: 'nope',
        pushback: [{ kind: 'no-number', note: 'How much faster?' }, { kind: 'bogus', note: 'x' }],
        draft: { title: 'T', situation: 'S', action: 'A', result: 'Cut deploy time 40%.', numbers: ['40% faster deploys', '3 teams'] },
        done: 'yes',
        say: 'How much faster, roughly?',
      },
      ['three teams were involved', 'we had 3 teams']
    );
    expect(r.covered).toEqual(['situation']);
    expect(r.nextBeat).toBe('role');
    expect(r.pushback).toEqual([{ kind: 'no-number', note: 'How much faster?' }]);
    expect(r.done).toBe(false);
    expect(r.draft.numbers).toEqual(['3 teams']);
    expect(r.draft.unconfirmed.some((u) => u.includes('40% faster deploys'))).toBe(true);
    expect(r.moved).toContain('40');
  });

  it('never throws on garbage', () => {
    const r = coerceForgeTurn(null, []);
    expect(r.draft.title).toBe('');
    expect(r.say).toBe('');
  });
});
