import { describe, it, expect } from 'vitest';
import type { LlmFieldSource, LlmRoleStatus } from '@/shared/types';
import { sourceLabel, isEnvPinned, roleIsEnvPinned } from './provider-source';

const ALL: LlmFieldSource[] = ['env', 'settings', 'default'];

function role(source: Partial<LlmRoleStatus['source']> = {}): LlmRoleStatus {
  return {
    provider: 'openai-compatible',
    model: 'a-model',
    // A local endpoint deliberately has no default model, so this is '' here.
    defaultModel: '',
    endpoint: 'http://127.0.0.1:9600/v1',
    source: {
      provider: 'settings',
      model: 'settings',
      endpoint: 'settings',
      endpointKey: 'default',
      ...source,
    },
    credential: { configured: false, source: null, suffix: null },
  };
}

describe('sourceLabel', () => {
  it('has words for every source the API can report', () => {
    for (const s of ALL) {
      expect(sourceLabel(s)).toBeTruthy();
    }
  });

  it('names the deploy for an env-supplied value', () => {
    // The exact phrase the wizard has always used for an env-pinned field. If
    // this drifts, the two surfaces stop agreeing about who owns the value.
    expect(sourceLabel('env')).toBe('your deploy set this');
  });

  it('never labels two different origins the same way', () => {
    expect(new Set(ALL.map(sourceLabel)).size).toBe(ALL.length);
  });
});

describe('isEnvPinned', () => {
  it('is true only for env', () => {
    expect(isEnvPinned('env')).toBe(true);
    expect(isEnvPinned('settings')).toBe(false);
    expect(isEnvPinned('default')).toBe(false);
  });
});

describe('roleIsEnvPinned', () => {
  it('is false when every field came from the database or a default', () => {
    expect(roleIsEnvPinned(role())).toBe(false);
  });

  it('is true when ANY single field is env-supplied', () => {
    // One env-pinned field is enough: the deploy owns part of this role, so the
    // browser cannot present the whole thing as editable.
    expect(roleIsEnvPinned(role({ provider: 'env' }))).toBe(true);
    expect(roleIsEnvPinned(role({ model: 'env' }))).toBe(true);
    expect(roleIsEnvPinned(role({ endpoint: 'env' }))).toBe(true);
    expect(roleIsEnvPinned(role({ endpointKey: 'env' }))).toBe(true);
  });
});
