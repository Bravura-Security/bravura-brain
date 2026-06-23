/**
 * Amazon Bedrock recipe smoke.
 *
 * Bedrock is the first KEYLESS native recipe: no auth_env.required, credentials
 * resolved through the AWS default provider chain (env / SSO / Pod Identity /
 * profile / IMDS) wired in the gateway's bedrock factory. This test pins:
 *  - Recipe registered with the expected shape (native, keyless)
 *  - Claude inference-profile chat/expansion models + Cohere embedding models
 *  - 1024-dim embedding default
 *  - dimsProviderOptions forwards the configured dim to Bedrock for Cohere
 *    embed-v4 (outputDimension) and Titan v2 (dimensions); no override for
 *    fixed-dim models (Cohere v3, Titan v1)
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

  test('embedding touchpoint: Cohere embed-v4 (on-demand profile) default, 1024 dims', () => {
    const r = getRecipe('bedrock')!;
    expect(r.touchpoints.embedding).toBeDefined();
    // On-demand-capable inference-profile id (bare cohere.embed-v4:0 is
    // profile-only and not on-demand-invocable in ca-central-1).
    expect(r.touchpoints.embedding!.models[0]).toBe('global.cohere.embed-v4:0');
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

  test('dimsProviderOptions forwards output_dimension to Cohere embed-v4', () => {
    // embed-v4 defaults to 1536 on Bedrock; without forwarding the configured
    // dim it would break the vector(1024) column. The bedrock provider keys
    // options under `bedrock` and maps `outputDimension` → wire
    // `output_dimension` for Cohere embed models.
    expect(dimsProviderOptions('native-bedrock', 'global.cohere.embed-v4:0', 1024)).toEqual({
      bedrock: { outputDimension: 1024 },
    });
    expect(dimsProviderOptions('native-bedrock', 'cohere.embed-v4:0', 512)).toEqual({
      bedrock: { outputDimension: 512 },
    });
  });

  test('dimsProviderOptions forwards dimensions to Titan embed v2', () => {
    // Titan v2 maps `dimensions` → wire `dimensions`.
    expect(dimsProviderOptions('native-bedrock', 'amazon.titan-embed-text-v2:0', 1024)).toEqual({
      bedrock: { dimensions: 1024 },
    });
  });

  test('dimsProviderOptions returns undefined for fixed-dim Bedrock embed models', () => {
    // Cohere v3 and Titan v1 are fixed-width and reject a dim override.
    expect(dimsProviderOptions('native-bedrock', 'cohere.embed-english-v3', 1024)).toBeUndefined();
    expect(dimsProviderOptions('native-bedrock', 'cohere.embed-multilingual-v3', 1024)).toBeUndefined();
    expect(dimsProviderOptions('native-bedrock', 'amazon.titan-embed-text-v1', 1536)).toBeUndefined();
  });
});
