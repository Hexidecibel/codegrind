// =============================================================================
// candidate-profile — personal background comes from a local file, never the code
// =============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CANDIDATE_PROFILE,
  EMPTY_PROFILE,
  candidateProfilePath,
  loadCandidateProfile,
  parseCandidateProfile,
} from './candidate-profile.js';
import { CANDIDATE_CARD, SD_FRAMEWORK, renderCandidateCard } from './sd-candidate.js';
import { renderKnownFacts } from './story-bank.js';
import { CANDIDATE_EXPERIENCE, renderOwnWork } from './llm.concept.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-profile-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const PROFILE = {
  systemDesignNotes: 'Their own experience: queues.\n\nHonest gaps: GraphQL.',
  knownFacts: ['Acme was a new product.'],
  ownWork: ['widgetly: a document tool with no customers.'],
  familiarSystems: ['wedding-jukebox'],
};

describe('where the profile is read from', () => {
  it('the env var wins, then DATA_DIR; a test run never reads the default file', () => {
    expect(candidateProfilePath({ CODEGRIND_CANDIDATE_PROFILE: '/x/p.json', VITEST: 'true' })).toBe('/x/p.json');
    expect(candidateProfilePath({ DATA_DIR: '/srv/cg' })).toBe('/srv/cg/candidate-profile.json');
    expect(candidateProfilePath({ VITEST: 'true', DATA_DIR: '/srv/cg' })).toBeNull();
    expect(CANDIDATE_PROFILE).toEqual(EMPTY_PROFILE);
  });
});

describe('loadCandidateProfile', () => {
  it('reads the file', () => {
    const f = path.join(dir, 'ok.json');
    fs.writeFileSync(f, JSON.stringify(PROFILE));
    expect(loadCandidateProfile({ CODEGRIND_CANDIDATE_PROFILE: f })).toEqual(PROFILE);
  });

  it('a missing or broken file is the neutral profile, never a throw', () => {
    expect(loadCandidateProfile({ CODEGRIND_CANDIDATE_PROFILE: path.join(dir, 'nope.json') })).toEqual(EMPTY_PROFILE);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    expect(loadCandidateProfile({ CODEGRIND_CANDIDATE_PROFILE: bad })).toEqual(EMPTY_PROFILE);
  });

  it('parse keeps only well-typed fields', () => {
    expect(parseCandidateProfile(null)).toEqual(EMPTY_PROFILE);
    expect(parseCandidateProfile([1])).toEqual(EMPTY_PROFILE);
    expect(parseCandidateProfile({ systemDesignNotes: 3, knownFacts: ['a', 2, ' ', ' b '], ownWork: 'x' })).toEqual({
      systemDesignNotes: '',
      knownFacts: ['a', 'b'],
      ownWork: [],
      familiarSystems: [],
    });
  });
});

describe('the prompts with and without a profile', () => {
  it('neutral: the framework, and nothing about the person', () => {
    expect(CANDIDATE_CARD).toContain(SD_FRAMEWORK);
    expect(CANDIDATE_CARD).toMatch(/Nothing else is known about their background/);
    expect(CANDIDATE_CARD).not.toMatch(/prep notes/);
    expect(CANDIDATE_EXPERIENCE).toBe("THE CANDIDATE'S OWN WORK: none recorded. Leave drawOn empty.");
  });

  it('with a profile: the notes follow the framework, facts and work are listed', () => {
    const card = renderCandidateCard(PROFILE);
    expect(card.startsWith('WHAT YOU KNOW ABOUT THIS CANDIDATE (from their own prep notes')).toBe(true);
    expect(card.endsWith(`${SD_FRAMEWORK}\n\n${PROFILE.systemDesignNotes}`)).toBe(true);
    expect(renderKnownFacts(PROFILE)).toMatch(/^CONFIRMED FACTS[^\n]*\n- Acme was a new product\.\n- Only facts/);
    expect(renderOwnWork(PROFILE)).toBe(
      "THE CANDIDATE'S OWN WORK (the only facts you may use about them):\n- widgetly: a document tool with no customers."
    );
  });
});
