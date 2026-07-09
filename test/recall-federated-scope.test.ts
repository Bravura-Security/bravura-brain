/**
 * recall op — federated read-grant scoping.
 *
 * The regression: recall read ONLY the scalar `ctx.sourceId ?? 'default'`.
 * For a remote MCP caller (CF Access / OAuth) the scalar is their WRITE
 * source (e.g. the personal source), so facts living in a granted READ
 * source came back as {facts: [], total: 0} while query/search — which
 * route through sourceScopeOpts — worked fine.
 *
 * Pins:
 *   - federated ctx.auth.allowedSources spans every granted source
 *   - a granted-but-missing source is skipped (warn), never fails/empties
 *   - scalar ctx.sourceId behavior is unchanged (local CLI path)
 *   - remote world-only visibility still applies on the federated path
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

interface RecallResult {
  facts: { fact: string; source_id: string; visibility: string }[];
  total: number;
}

function ctxFor(overrides: Record<string, unknown>) {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    ...overrides,
  };
}

async function runRecall(ctx: unknown, params: Record<string, unknown> = {}): Promise<RecallResult> {
  const { operations } = await import('../src/core/operations.ts');
  const op = operations.find(o => o.name === 'recall');
  expect(op).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await op!.handler(ctx as any, params)) as RecallResult;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('company', 'Company', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('personal-src', 'Personal', '{}'::jsonb) ON CONFLICT DO NOTHING`,
  );
  // World-visible facts in the shared read source.
  await engine.insertFact(
    // NOTE: recall's entity branch canonicalizes via resolveEntitySlug, which
    // slugifies to the dash form — store the canonical form so the entity
    // filter test exercises scope (not slug-resolution quirks).
    { fact: 'company fact one', kind: 'fact', entity_slug: 'companies-acme-example', visibility: 'world', source: 'test' },
    { source_id: 'company' },
  );
  await engine.insertFact(
    { fact: 'company fact two', kind: 'fact', visibility: 'world', source: 'test' },
    { source_id: 'company' },
  );
  // Private fact in the shared source: must stay invisible to remote callers.
  await engine.insertFact(
    { fact: 'company private fact', kind: 'fact', visibility: 'private', source: 'test' },
    { source_id: 'company' },
  );
  // World fact in the personal write source.
  await engine.insertFact(
    { fact: 'personal fact', kind: 'fact', visibility: 'world', source: 'test' },
    { source_id: 'personal-src' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('recall — federated read grant', () => {
  test('remote caller with allowedSources sees facts across the grant, not just the write source', async () => {
    const ctx = ctxFor({
      remote: true,
      sourceId: 'personal-src', // write source — the pre-fix scalar scope
      auth: {
        token: 't', clientId: 'c', scopes: ['read', 'write'],
        sourceId: 'personal-src',
        allowedSources: ['personal-src', 'company'],
      },
    });
    const res = await runRecall(ctx, {});
    const facts = res.facts.map(f => f.fact).sort();
    expect(facts).toContain('company fact one');
    expect(facts).toContain('company fact two');
    expect(facts).toContain('personal fact');
    // Remote world-only visibility still applies on the federated path.
    expect(facts).not.toContain('company private fact');
    expect(res.facts.every(f => ['personal-src', 'company'].includes(f.source_id))).toBe(true);
  });

  test('granted-but-missing source is skipped, never fails or empties the result', async () => {
    const ctx = ctxFor({
      remote: true,
      sourceId: 'personal-src',
      auth: {
        token: 't', clientId: 'c', scopes: ['read'],
        sourceId: 'personal-src',
        // 'customer' does not exist (stale grant after a source hard-delete).
        allowedSources: ['personal-src', 'company', 'customer'],
      },
    });
    const res = await runRecall(ctx, {});
    expect(res.total).toBeGreaterThan(0);
    expect(res.facts.map(f => f.fact)).toContain('company fact one');
  });

  test('entity filter spans the grant', async () => {
    const ctx = ctxFor({
      remote: true,
      sourceId: 'personal-src',
      auth: {
        token: 't', clientId: 'c', scopes: ['read'],
        sourceId: 'personal-src',
        allowedSources: ['personal-src', 'company'],
      },
    });
    const res = await runRecall(ctx, { entity: 'companies-acme-example' });
    expect(res.facts.map(f => f.fact)).toContain('company fact one');
  });

  test('scalar ctx.sourceId (no federated grant) keeps the pre-fix single-source behavior', async () => {
    const ctx = ctxFor({ remote: false, sourceId: 'company' });
    const res = await runRecall(ctx, {});
    expect(res.facts.every(f => f.source_id === 'company')).toBe(true);
    // Local callers see private too (visibility undefined).
    expect(res.facts.map(f => f.fact)).toContain('company private fact');
  });

  test('limit is enforced across the merged federated set', async () => {
    const ctx = ctxFor({
      remote: true,
      sourceId: 'personal-src',
      auth: {
        token: 't', clientId: 'c', scopes: ['read'],
        sourceId: 'personal-src',
        allowedSources: ['personal-src', 'company'],
      },
    });
    const res = await runRecall(ctx, { limit: 2 });
    expect(res.total).toBe(2);
    expect(res.facts.length).toBe(2);
  });

  test('grep is pushed into SQL — limit applies to matching rows, not the full window', async () => {
    // Pre-fix: grep was applied client-side AFTER the limit window.
    // On a source with e.g. 5,844 facts and limit=50, a grep over "needle"
    // only saw the first 50 rows even if 500 matches existed elsewhere.
    // Post-fix: grep is an ILIKE filter in the WHERE clause, so limit=N
    // returns the N most-recent matching rows, not the N most-recent rows
    // filtered by the substring.
    //
    // Test: insert facts where the matching one is older than the non-matching
    // ones, then use limit=1 to show only the SQL-filtered result appears.
    await engine.insertFact(
      { fact: 'needle: specific search term', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'company' },
    );
    await engine.insertFact(
      { fact: 'hay one', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'company' },
    );
    await engine.insertFact(
      { fact: 'hay two', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'company' },
    );

    const ctx = ctxFor({ remote: false, sourceId: 'company' });

    // Without grep: most-recent 2 facts (hay two, hay one) — needle is older
    const noGrep = await runRecall(ctx, { limit: 2 });
    expect(noGrep.facts.map(f => f.fact)).not.toContain('needle: specific search term');

    // With grep pushed into SQL: limit=2 returns the 2 most-recent MATCHING rows
    // (only one exists: the needle fact). Client-side filtering would have returned
    // zero because the needle didn't appear in the first-2 window.
    const withGrep = await runRecall(ctx, { grep: 'needle', limit: 2 });
    expect(withGrep.facts.map(f => f.fact)).toContain('needle: specific search term');
  });
});
