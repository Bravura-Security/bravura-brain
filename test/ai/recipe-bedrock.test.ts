/**
 * Amazon Bedrock recipe smoke.
 *
 * Bedrock is the first KEYLESS native recipe: no auth_env.required, credentials
 * resolved through the AWS default provider chain (env / SSO / Pod Identity /
 * profile / IMDS) wired in the gateway's bedrock factory. This test pins:
 *  - Recipe registered with the expected shape (native, keyless)
 *  - Claude inference-profile chat/expansion models + Cohere embedding models
 *  - 1024-dim embedding default
 *  - dimsProviderOptions returns undefined for native-bedrock (no dim override)
 *  - the recipe holds NO static credential env in auth_env.required
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';

describe('recipe: bedrock', () => {
  test('registered with expected shape (native, keyless)', () => {
    const r = getRecipe('bedrock');
    expect(r).toBeDefined();
    expect(r!.id).toBe('bedrock');
    expect(r!.name).toBe('Amazon Bedrock');
    expect(r!.tier).toBe('native');
    expect(r!.implementation).toBe('native-bedrock');
    expect(r!.base_url_default).toBeUndefined();
  });

  test('keyless: auth_env.required is empty (no static keys)', () => {
    const r = getRecipe('bedrock')!;
    expect(r.auth_env?.required).toEqual([]);
    // Region + profile are optional, env-driven knobs only.
    expect(r.auth_env?.optional).toContain('AWS_REGION');
    expect(r.auth_env?.optional).toContain('BEDROCK_REGION');
    expect(r.auth_env?.optional).toContain('AWS_PROFILE');
  });

  test('embedding touchpoint: Cohere embed-v4 default, 1024 dims', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.embedding).toBeDefined();
    expect(r.touchpoints.embedding!.models[0]).toBe('cohere.embed-v4:0');
    expect(r.touchpoints.embedding!.models).toContain('cohere.embed-english-v3');
    expect(r.touchpoints.embedding!.default_dims).toBe(1024);
    // Declares a batch cap so the recursive-halving safety net engages.
    expect(r.touchpoints.embedding!.max_batch_tokens).toBeGreaterThan(0);
  });

  test('chat touchpoint: global Sonnet default + us Opus inference profiles', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.chat).toBeDefined();
    expect(r.touchpoints.chat!.models[0]).toBe('global.anthropic.claude-sonnet-4-6');
    expect(r.touchpoints.chat!.models).toContain('us.anthropic.claude-opus-4-8');
    expect(r.touchpoints.chat!.supports_tools).toBe(true);
    expect(r.touchpoints.chat!.supports_subagent_loop).toBe(true);
    expect(r.touchpoints.chat!.supports_prompt_cache).toBe(true);
  });

  test('expansion touchpoint declares Haiku inference profiles', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.expansion).toBeDefined();
    expect(r.touchpoints.expansion!.models.length).toBeGreaterThan(0);
    expect(r.touchpoints.expansion!.models[0]).toContain('anthropic.claude-haiku');
  });

  test('dimsProviderOptions returns undefined for native-bedrock (native 1024)', () => {
    // Cohere embed on Bedrock is fixed 1024; gbrain pins the schema default and
    // sends no dimension override (the bedrock provider keys options under
    // `bedrock`, not the openai/openaiCompatible shapes).
    expect(dimsProviderOptions('native-bedrock', 'cohere.embed-v4:0', 1024)).toBeUndefined();
    expect(dimsProviderOptions('native-bedrock', 'cohere.embed-english-v3', 1024)).toBeUndefined();
  });
});
