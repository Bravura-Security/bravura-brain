/**
 * v0.42.56.0 — reconcile-fences command tests.
 *
 * Covers detection (fence-owned rows only — the negative import:
 * keyspace is never counted), the three drift classes (file_missing /
 * fence_gap / conflict), DB→disk repair with row_num preservation,
 * disk-row precedence (hand-edits + disk-ahead rows survive), struck
 * rendering for expired/forgotten rows, idempotency, dry-run, and the
 * dirty-tree refusal.
 *
 * Real PGLite + real tempdir filesystem, same harness as
 * test/migrations-v0_32_2.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { detectFenceDrift, runReconcileFences, dbRowToParsedFact } from '../src/commands/reconcile-fences.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'reconcile-fences-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM pages');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

async function seedFencedFact(input: {
  slug: string;
  row_num: number;
  fact: string;
  source?: string;
  context?: string | null;
  expired_at?: string | null;
  valid_until?: string | null;
}): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await (engine as any).db.query(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability,
                        valid_from, valid_until, expired_at, source, confidence,
                        row_num, source_markdown_slug, context)
     VALUES ('default', $1, $2, 'fact', 'private', 'medium',
             '2026-01-05T00:00:00Z', $3, $4, $5, 1.0, $6, $1, $7)
     RETURNING id`,
    [
      input.slug,
      input.fact,
      input.valid_until ?? null,
      input.expired_at ?? null,
      input.source ?? 'mcp:put_page',
      input.row_num,
      input.context ?? null,
    ],
  );
  return r.rows[0].id;
}

function writePageWithFence(slug: string, fenceRows: string[], prose = 'Some notes.\n'): string {
  const filePath = join(brainDir, `${slug}.md`);
  mkdirSync(join(filePath, '..'), { recursive: true });
  const fence = [
    '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...fenceRows,
    '<!--- gbrain:facts:end -->',
  ].join('\n');
  writeFileSync(
    filePath,
    `---\ntype: person\ntitle: T\nslug: ${slug}\n---\n\n# T\n\n${prose}\n## Facts\n\n${fence}\n`,
    'utf-8',
  );
  return filePath;
}

describe('detectFenceDrift — keyspace contract', () => {
  test('negative row_nums (import: frontmatter promotion) are never drift', async () => {
    await seedFencedFact({ slug: 'meetings/2026-01-05-sync', row_num: -1, fact: 'Outcome A', source: 'import:frontmatter' });
    await seedFencedFact({ slug: 'meetings/2026-01-05-sync', row_num: -2, fact: 'Outcome B', source: 'import:frontmatter' });
    // No file on disk at all — still not drift: negative rows are not fence-owned.

    const report = await detectFenceDrift(engine);
    expect(report.drifted).toHaveLength(0);
    const summary = report.sources.find(s => s.sourceId === 'default');
    expect(summary?.pagesChecked ?? 0).toBe(0);
  });

  test('classifies file_missing, fence_gap, and ok', async () => {
    // ok: fence matches DB.
    await seedFencedFact({ slug: 'people/ok', row_num: 1, fact: 'Fine' });
    writePageWithFence('people/ok', ['| 1 | Fine | fact | 1.0 | private | medium | 2026-01-05 |  | mcp:put_page |  |']);
    // fence_gap: file exists, row 2 missing from fence.
    await seedFencedFact({ slug: 'people/gap', row_num: 1, fact: 'Present' });
    await seedFencedFact({ slug: 'people/gap', row_num: 2, fact: 'Lost row' });
    writePageWithFence('people/gap', ['| 1 | Present | fact | 1.0 | private | medium | 2026-01-05 |  | mcp:put_page |  |']);
    // file_missing.
    await seedFencedFact({ slug: 'people/ghost', row_num: 1, fact: 'No file' });

    const report = await detectFenceDrift(engine);
    const kinds = new Map(report.drifted.map(d => [d.slug, d.kind]));
    expect(kinds.get('people/gap')).toBe('fence_gap');
    expect(kinds.get('people/ghost')).toBe('file_missing');
    expect(kinds.has('people/ok')).toBe(false);
    const summary = report.sources.find(s => s.sourceId === 'default');
    expect(summary).toMatchObject({ pagesChecked: 3, pagesOk: 1, pagesDrifted: 2, fileMissing: 1, fenceGap: 1 });
  });

  test('checkout missing on this host → unverifiable, not drift', async () => {
    await seedFencedFact({ slug: 'people/elsewhere', row_num: 1, fact: 'On another pod' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [join(brainDir, 'not-here')],
    );

    const report = await detectFenceDrift(engine);
    expect(report.drifted).toHaveLength(0);
    expect(report.sources.find(s => s.sourceId === 'default')?.unverifiable).toBe(1);
  });
});

describe('runReconcileFences — repair', () => {
  test('restores missing fence rows with their DB row_nums; disk rows untouched', async () => {
    await seedFencedFact({ slug: 'people/gap', row_num: 1, fact: 'Present' });
    await seedFencedFact({ slug: 'people/gap', row_num: 3, fact: 'Lost row' });
    // Disk has row 1 (hand-tweaked confidence) and a disk-ahead row 9 the DB
    // doesn't know yet.
    writePageWithFence('people/gap', [
      '| 1 | Present | fact | 0.7 | private | medium | 2026-01-05 |  | hand-edit |  |',
      '| 9 | Disk-ahead claim | fact | 1.0 | private | low | 2026-01-06 |  | manual |  |',
    ]);

    const result = await runReconcileFences(engine);
    expect(result.status).toBe('ok');
    expect(result.pagesRepaired).toBe(1);
    expect(result.rowsRestored).toBe(1);
    expect(result.failedPages).toHaveLength(0);

    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/gap.md'), 'utf-8'));
    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.facts.map(f => f.rowNum)).toEqual([1, 3, 9]);
    // Disk row 1 kept its hand-edited form; row 3 restored from DB.
    expect(parsed.facts.find(f => f.rowNum === 1)).toMatchObject({ confidence: 0.7, source: 'hand-edit' });
    expect(parsed.facts.find(f => f.rowNum === 3)).toMatchObject({ claim: 'Lost row' });
    expect(parsed.facts.find(f => f.rowNum === 9)).toMatchObject({ claim: 'Disk-ahead claim' });
  });

  test('materializes a missing file from the DB page (not a stub)', async () => {
    await engine.putPage('people/ghost', {
      type: 'person',
      title: 'Ghost',
      compiled_truth: '# Ghost\n\nRich body that must survive materialization.\n',
    });
    await seedFencedFact({ slug: 'people/ghost', row_num: 1, fact: 'No file yet' });

    const result = await runReconcileFences(engine);
    expect(result.pagesRepaired).toBe(1);
    expect(result.pagesMaterialized).toBe(1);

    const body = readFileSync(join(brainDir, 'people/ghost.md'), 'utf-8');
    expect(body).toContain('Rich body that must survive materialization.');
    const parsed = parseFactsFence(body);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0]).toMatchObject({ rowNum: 1, claim: 'No file yet' });
  });

  test('conflict (same row_num, different claim) is reported, never overwritten', async () => {
    await seedFencedFact({ slug: 'people/conflict', row_num: 1, fact: 'DB version of the claim' });
    const filePath = writePageWithFence('people/conflict', [
      '| 1 | Disk version of the claim | fact | 1.0 | private | medium | 2026-01-05 |  | manual |  |',
    ]);
    const before = readFileSync(filePath, 'utf-8');

    const result = await runReconcileFences(engine);
    expect(result.pagesRepaired).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ slug: 'people/conflict', kind: 'conflict', conflictRowNums: [1] });
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  test('idempotent: second run finds nothing to repair', async () => {
    await seedFencedFact({ slug: 'people/gap', row_num: 1, fact: 'Lost row' });
    writePageWithFence('people/gap', []);

    const first = await runReconcileFences(engine);
    expect(first.pagesRepaired).toBe(1);

    const second = await runReconcileFences(engine);
    expect(second.pagesRepaired).toBe(0);
    expect(second.sources.find(s => s.sourceId === 'default')?.pagesOk).toBe(1);
  });

  test('dry-run detects but writes nothing', async () => {
    await seedFencedFact({ slug: 'people/ghost', row_num: 1, fact: 'No file' });

    const result = await runReconcileFences(engine, { dryRun: true });
    expect(result.sources.find(s => s.sourceId === 'default')?.pagesDrifted).toBe(1);
    expect(existsSync(join(brainDir, 'people/ghost.md'))).toBe(false);
  });

  test('expired / forgotten rows render struck and round-trip', async () => {
    await seedFencedFact({
      slug: 'people/struck', row_num: 1, fact: 'Old claim',
      expired_at: '2026-02-01T00:00:00Z', valid_until: '2026-02-01T00:00:00Z',
    });
    await seedFencedFact({
      slug: 'people/struck', row_num: 2, fact: 'Removed claim',
      context: 'forgotten: user asked', valid_until: '2026-03-01T00:00:00Z',
    });

    const result = await runReconcileFences(engine);
    expect(result.pagesRepaired).toBe(1);
    const parsed = parseFactsFence(readFileSync(join(brainDir, 'people/struck.md'), 'utf-8'));
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[0]).toMatchObject({ rowNum: 1, active: false, validUntil: '2026-02-01' });
    expect(parsed.facts[1]).toMatchObject({ rowNum: 2, active: false, forgotten: true });
  });

  test('refuses to write into a dirty git checkout without --allow-dirty', async () => {
    execFileSync('git', ['-C', brainDir, 'init', '-q']);
    writeFileSync(join(brainDir, 'uncommitted.md'), 'dirty\n', 'utf-8');
    await seedFencedFact({ slug: 'people/ghost', row_num: 1, fact: 'No file' });

    const refused = await runReconcileFences(engine);
    expect(refused.status).toBe('dirty_tree');
    expect(existsSync(join(brainDir, 'people/ghost.md'))).toBe(false);

    const allowed = await runReconcileFences(engine, { allowDirty: true });
    expect(allowed.status).toBe('ok');
    expect(allowed.pagesRepaired).toBe(1);
  });
});

describe('dbRowToParsedFact', () => {
  test('flattens newlines and preserves fence-representable fields', () => {
    const parsed = dbRowToParsedFact({
      id: '1', source_id: 'default', slug: 'people/x', row_num: 4,
      fact: 'multi\nline  claim', kind: 'fact', visibility: 'world', notability: 'high',
      context: null, valid_from: new Date('2026-01-02T10:00:00Z'), valid_until: null,
      expired_at: null, superseded_by: null, source: 'mcp:think', confidence: 0.85,
      claim_metric: 'arr', claim_value: 10, claim_unit: 'USD', claim_period: 'annual',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(parsed).toMatchObject({
      rowNum: 4, claim: 'multi line claim', active: true, validFrom: '2026-01-02',
      claimMetric: 'arr', claimValue: 10,
    });
  });
});
