/**
 * hybridSearch meta-field accuracy (v0.25.0, callback-based API).
 *
 * v0.25.0 keeps hybridSearch's return as `Promise<SearchResult[]>` (so
 * Cathedral II callers stay unchanged) and surfaces meta via an optional
 * `onMeta` callback in HybridSearchOpts. Asserts the callback fires with
 * accurate values:
 *   - vector_enabled=false when OPENAI_API_KEY missing (keyword-only path)
 *   - detail_resolved reflects auto-detect + caller override
 *   - expansion_applied only true when expandFn returned variants
 *
 * Uses PGLite in-memory + no embedding calls (vector path doesn't need
 * real embeddings to test the meta flag since we control the env).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch, runPostFusionStages, type PostFusionOpts } from '../src/core/search/hybrid.ts';
import type { PageInput, HybridSearchMeta, SearchResult } from '../src/core/types.ts';

let engine: PGLiteEngine;
const savedKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page: PageInput = {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice Example is a test person for hybrid-meta tests.',
  };
  await engine.putPage('people/alice-example', page);
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await engine.disconnect();
});

async function runWithMeta(query: string, opts: Parameters<typeof hybridSearch>[2] = {}): Promise<HybridSearchMeta | null> {
  let captured: HybridSearchMeta | null = null;
  await hybridSearch(engine, query, { ...opts, onMeta: (m) => { captured = m; } });
  return captured;
}

describe('hybridSearch return shape (v0.25.0 keeps SearchResult[])', () => {
  test('returns SearchResult[] (unchanged from Cathedral II contract)', async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await hybridSearch(engine, 'alice');
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('hybridSearch onMeta callback — vector_enabled', () => {
  test('false when OPENAI_API_KEY is missing (keyword-only path)', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice');
    expect(meta).not.toBeNull();
    expect(meta!.vector_enabled).toBe(false);
  });
});

describe('hybridSearch onMeta callback — detail_resolved', () => {
  test('passes through explicit detail override (caller specified "high")', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', { detail: 'high' });
    expect(meta!.detail_resolved).toBe('high');
  });

  test('detail_resolved reflects autoDetect output when caller omits detail', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice');
    expect([null, 'low', 'medium', 'high']).toContain(meta!.detail_resolved);
  });
});

describe('hybridSearch onMeta callback — expansion_applied', () => {
  test('false when expansion flag is off', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', { expansion: false });
    expect(meta!.expansion_applied).toBe(false);
  });

  test('false when OPENAI_API_KEY missing (early-return short-circuits expansion)', async () => {
    delete process.env.OPENAI_API_KEY;
    const meta = await runWithMeta('alice', {
      expansion: true,
      expandFn: async () => ['alice', 'alice example', 'the person alice'],
    });
    expect(meta!.expansion_applied).toBe(false);
  });
});

describe('onMeta callback omitted', () => {
  test('hybridSearch works without onMeta (existing Cathedral II callers unaffected)', async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await hybridSearch(engine, 'alice');
    expect(Array.isArray(out)).toBe(true);
  });
});

// Per-type retrieval weights (inbox downweight). Feeds synthetic SearchResult
// rows through runPostFusionStages so the ranking stage is exercised without a
// live embedding provider (keyword-only PGLite returns no rows to reorder) —
// the same pattern search-alias-resolved-boost.serial uses. The
// weights-from-DB-config path is covered separately below via loadTypeWeights.
describe('per-type retrieval weights (inbox downweight)', () => {
  let twEngine: PGLiteEngine;

  beforeAll(async () => {
    twEngine = new PGLiteEngine();
    await twEngine.connect({});
    await twEngine.initSchema();
  });

  afterAll(async () => {
    await twEngine.disconnect();
  });

  const mkRow = (slug: string, type: string, score: number): SearchResult =>
    ({
      slug, source_id: 'default', score,
      chunk_id: 1, page_id: 1, chunk_text: '', chunk_index: 0,
      title: slug, type,
    } as unknown as SearchResult);

  const noopBase: PostFusionOpts = {
    applyBacklinks: false,
    salience: 'off',
    recency: 'off',
    graphSignalsEnabled: false,
  };

  test('inbox-typed result is downweighted vs a same-score non-inbox result', async () => {
    const results: SearchResult[] = [mkRow('inbox/a', 'inbox', 1.0), mkRow('docs/b', 'documentation', 1.0)];
    await runPostFusionStages(twEngine, results, {
      ...noopBase,
      // Effective map as loadTypeWeights would resolve it (code default inbox=0.4).
      typeWeights: { inbox: 0.4 },
    });
    const inbox = results.find((r) => r.type === 'inbox')!;
    const doc = results.find((r) => r.type === 'documentation')!;
    // inbox demoted to 0.4 and stamped; documentation untouched (no stamp).
    expect(inbox.score).toBeCloseTo(0.4, 6);
    expect(inbox.type_weight).toBe(0.4);
    expect(doc.score).toBeCloseTo(1.0, 6);
    expect(doc.type_weight).toBeUndefined();
    expect(inbox.score).toBeLessThan(doc.score);
  });

  test('config override neutralizes the inbox downweight (effective weight 1.0 is a no-op)', async () => {
    const results: SearchResult[] = [mkRow('inbox/a', 'inbox', 1.0)];
    await runPostFusionStages(twEngine, results, {
      ...noopBase,
      // What loadTypeWeights returns when search.type_weights.inbox=1.0 overrides the default.
      typeWeights: { inbox: 1.0 },
    });
    expect(results[0].score).toBeCloseTo(1.0, 6);
    expect(results[0].type_weight).toBeUndefined();
  });

  test('no typeWeights opt → stage is a no-op (default undefined preserves behavior)', async () => {
    const results: SearchResult[] = [mkRow('inbox/a', 'inbox', 1.0)];
    await runPostFusionStages(twEngine, results, noopBase);
    expect(results[0].score).toBeCloseTo(1.0, 6);
    expect(results[0].type_weight).toBeUndefined();
  });

  test('weights resolved from DB config drive the stage end-to-end', async () => {
    // Prove the config → loadTypeWeights → runPostFusionStages wiring: set an
    // override, load the effective map the way hybridSearch does, and confirm
    // the stage applies it.
    const { loadTypeWeights } = await import('../src/core/search/type-weights.ts');
    await twEngine.setConfig('search.type_weights.inbox', '0.25');
    const weights = await loadTypeWeights(twEngine);
    const results: SearchResult[] = [mkRow('inbox/a', 'inbox', 1.0)];
    await runPostFusionStages(twEngine, results, { ...noopBase, typeWeights: weights });
    expect(results[0].score).toBeCloseTo(0.25, 6);
    expect(results[0].type_weight).toBe(0.25);
    await twEngine.unsetConfig('search.type_weights.inbox');
  });
});

// Unit-level coverage for the loader / fingerprint / apply helpers, and the
// cache-key fold-in — kept alongside the behavioral tests since they exercise
// the same feature (hybrid-meta.serial conventions).
describe('type-weights helpers (loader / fingerprint / apply / cache key)', () => {
  let helperEngine: PGLiteEngine;

  beforeAll(async () => {
    helperEngine = new PGLiteEngine();
    await helperEngine.connect({});
    await helperEngine.initSchema();
  });

  afterAll(async () => {
    await helperEngine.disconnect();
  });

  test('loadTypeWeights returns code defaults (inbox=0.4) with no config set', async () => {
    const { loadTypeWeights } = await import('../src/core/search/type-weights.ts');
    const w = await loadTypeWeights(helperEngine);
    expect(w.inbox).toBe(0.4);
  });

  test('loadTypeWeights merges config overrides over code defaults', async () => {
    const { loadTypeWeights } = await import('../src/core/search/type-weights.ts');
    await helperEngine.setConfig('search.type_weights.inbox', '0.2');
    await helperEngine.setConfig('search.type_weights.chat', '0.7');
    const w = await loadTypeWeights(helperEngine);
    expect(w.inbox).toBe(0.2); // config override wins over default
    expect(w.chat).toBe(0.7);
    await helperEngine.unsetConfig('search.type_weights.inbox');
    await helperEngine.unsetConfig('search.type_weights.chat');
  });

  test('loadTypeWeights ignores out-of-range / malformed values (falls through to default)', async () => {
    const { loadTypeWeights } = await import('../src/core/search/type-weights.ts');
    await helperEngine.setConfig('search.type_weights.inbox', '99'); // > 5 cap → ignored
    await helperEngine.setConfig('search.type_weights.junk', 'notanumber'); // ignored
    const w = await loadTypeWeights(helperEngine);
    expect(w.inbox).toBe(0.4); // fell back to code default
    expect(w.junk).toBeUndefined();
    await helperEngine.unsetConfig('search.type_weights.inbox');
    await helperEngine.unsetConfig('search.type_weights.junk');
  });

  test('typeWeightsFingerprint: non-1.0 entries only, sorted, stable; all-1.0 → none', async () => {
    const { typeWeightsFingerprint } = await import('../src/core/search/type-weights.ts');
    expect(typeWeightsFingerprint({ inbox: 0.4 })).toBe('inbox=0.4000');
    // Order-independent; 1.0 entries excluded.
    expect(typeWeightsFingerprint({ chat: 0.7, inbox: 0.4, person: 1.0 })).toBe(
      'chat=0.7000,inbox=0.4000',
    );
    // A weight neutralized to 1.0 fingerprints identically to no weights.
    expect(typeWeightsFingerprint({ inbox: 1.0 })).toBe('none');
    expect(typeWeightsFingerprint({})).toBe('none');
  });

  test('applyTypeWeight multiplies score + stamps only non-1.0 types', async () => {
    const { applyTypeWeight } = await import('../src/core/search/type-weights.ts');
    const rows = [
      { type: 'inbox', score: 1.0 },
      { type: 'documentation', score: 1.0 },
    ] as unknown as Parameters<typeof applyTypeWeight>[0];
    applyTypeWeight(rows, { inbox: 0.4 });
    expect(rows[0].score).toBeCloseTo(0.4, 6);
    expect(rows[0].type_weight).toBe(0.4);
    expect(rows[1].score).toBe(1.0); // no weight → untouched
    expect(rows[1].type_weight).toBeUndefined();
  });

  test('cache knobsHash bifurcates when the type-weights fingerprint changes', async () => {
    const { knobsHash, resolveSearchMode } = await import('../src/core/search/mode.ts');
    const { typeWeightsFingerprint } = await import('../src/core/search/type-weights.ts');
    const base = resolveSearchMode({ mode: 'balanced' });
    const hDefault = knobsHash(base, {
      typeWeightsFingerprint: typeWeightsFingerprint({ inbox: 0.4 }),
    });
    const hChanged = knobsHash(base, {
      typeWeightsFingerprint: typeWeightsFingerprint({ inbox: 0.2 }),
    });
    const hNone = knobsHash(base, {
      typeWeightsFingerprint: typeWeightsFingerprint({}),
    });
    expect(hDefault).not.toBe(hChanged);
    expect(hDefault).not.toBe(hNone);
  });
});
