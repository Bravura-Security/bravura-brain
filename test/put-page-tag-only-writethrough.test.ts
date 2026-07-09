/**
 * Tag-only write-through skip (the recurring git-conflict class).
 *
 * Backfill/dream agents re-put connector-owned inbox/* pages appending ONLY
 * an idempotency tag. Pre-fix, put_page's write-through re-rendered the .md
 * into the brain-content checkout (fresh ingested_at + tag line), colliding
 * with the connector's own re-ingest rewrites of the same files.
 *
 * Contract pinned here:
 *   1. importFromContent flags `tagOnlyChange: true` when the update changes
 *      NOTHING but the frontmatter `tags` key (title/type/body/timeline +
 *      all other stable frontmatter identical to the existing row).
 *   2. put_page skips file materialization on tag-only changes
 *      (write_through.skipped === 'tag_only_change'); the DB write proceeds
 *      and the tags table carries the delta.
 *   3. Content changes still write the file exactly as before.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resolvePageFilePath } from '../src/core/markdown.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

let engine: PGLiteEngine;
let tmpRoot: string;
let brainDir: string;

beforeAll(async () => {
  // Hermeticity: pin the gateway + stub the embed transport (same pattern as
  // put-page-provenance.test.ts) so put_page's embed never hits the network.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => ({
    embeddings: values.map(() => new Array(1536).fill(0)),
    usage: { tokens: 0 },
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-tag-only-wt-'));
  brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
});

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

const SLUG = 'inbox/2026-07-01-granola-abc123';
const BASE = [
  '---',
  'type: inbox',
  'title: Quarterly Planning (raw)',
  'meeting_id: granola-abc123',
  'tags: [inbox, granola]',
  '---',
  '',
  '# Quarterly Planning',
  '',
  'Raw transcript body.',
  '',
].join('\n');
// Same page, ONLY the tags key differs (idempotency tag appended).
const TAG_ONLY = BASE.replace(
  'tags: [inbox, granola]',
  'tags: [inbox, granola, distilled-2026-07-01]',
);
// Tags appended AND body changed → NOT tag-only.
const TAG_AND_BODY = TAG_ONLY.replace('Raw transcript body.', 'Raw transcript body. (edited)');

describe('importFromContent tagOnlyChange detection', () => {
  test('tag append with identical body + frontmatter → tagOnlyChange: true', async () => {
    const first = await importFromContent(engine, SLUG, BASE, { noEmbed: true, sourceId: 'default' });
    expect(first.status).toBe('imported');
    expect(first.tagOnlyChange).toBeUndefined();

    const second = await importFromContent(engine, SLUG, TAG_ONLY, { noEmbed: true, sourceId: 'default' });
    expect(second.status).toBe('imported'); // DB write proceeds — tags table carries the delta
    expect(second.tagOnlyChange).toBe(true);
    const tags = await engine.getTags(SLUG, { sourceId: 'default' });
    expect(tags).toContain('distilled-2026-07-01');
  });

  test('tag append + body change → tagOnlyChange unset', async () => {
    await importFromContent(engine, SLUG, BASE, { noEmbed: true, sourceId: 'default' });
    const res = await importFromContent(engine, SLUG, TAG_AND_BODY, { noEmbed: true, sourceId: 'default' });
    expect(res.status).toBe('imported');
    expect(res.tagOnlyChange).toBeUndefined();
  });

  test('tag append + other frontmatter key change → tagOnlyChange unset', async () => {
    await importFromContent(engine, SLUG, BASE, { noEmbed: true, sourceId: 'default' });
    const changedFm = TAG_ONLY.replace('meeting_id: granola-abc123', 'meeting_id: granola-def456');
    const res = await importFromContent(engine, SLUG, changedFm, { noEmbed: true, sourceId: 'default' });
    expect(res.status).toBe('imported');
    expect(res.tagOnlyChange).toBeUndefined();
  });

  test('identical re-put stays a plain skip (hash short-circuit, no flag)', async () => {
    await importFromContent(engine, SLUG, BASE, { noEmbed: true, sourceId: 'default' });
    const res = await importFromContent(engine, SLUG, BASE, { noEmbed: true, sourceId: 'default' });
    expect(res.status).toBe('skipped');
    expect(res.tagOnlyChange).toBeUndefined();
  });

  test('new page (no existing row) → tagOnlyChange unset', async () => {
    const res = await importFromContent(engine, 'inbox/brand-new', BASE, { noEmbed: true, sourceId: 'default' });
    expect(res.status).toBe('imported');
    expect(res.tagOnlyChange).toBeUndefined();
  });
});

describe('put_page write-through skips tag-only changes', () => {
  test('tag-only change → no file write (skipped: tag_only_change), DB tags updated', async () => {
    const ctx = makeCtx();
    const first = (await putPageOp.handler(ctx, { slug: SLUG, content: BASE })) as any;
    expect(first.write_through?.written).toBe(true);
    const filePath = resolvePageFilePath(brainDir, SLUG, 'default');
    expect(fs.existsSync(filePath)).toBe(true);

    // Simulate the live topology: the file on disk is connector-owned.
    // Remove it so ANY write by the tag-only re-put is unambiguous.
    fs.rmSync(filePath);

    const second = (await putPageOp.handler(ctx, { slug: SLUG, content: TAG_ONLY })) as any;
    expect(second.status).toBe('created_or_updated');
    expect(second.write_through).toEqual({ written: false, skipped: 'tag_only_change' });
    expect(fs.existsSync(filePath)).toBe(false); // file NOT re-materialized

    // The durable sink still carried the delta.
    const tags = await engine.getTags(SLUG, { sourceId: 'default' });
    expect(tags).toContain('distilled-2026-07-01');
  });

  test('content change → file written as before', async () => {
    const ctx = makeCtx();
    await putPageOp.handler(ctx, { slug: SLUG, content: BASE });
    const filePath = resolvePageFilePath(brainDir, SLUG, 'default');
    fs.rmSync(filePath);

    const res = (await putPageOp.handler(ctx, { slug: SLUG, content: TAG_AND_BODY })) as any;
    expect(res.write_through?.written).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('(edited)');
  });

  test('tag-only skip logs a debug line', async () => {
    const lines: string[] = [];
    const ctx = makeCtx({
      logger: { info: (m: string) => { lines.push(m); }, warn: () => {}, error: () => {} },
    });
    await putPageOp.handler(ctx, { slug: SLUG, content: BASE });
    await putPageOp.handler(ctx, { slug: SLUG, content: TAG_ONLY });
    expect(lines.some((l) => l.includes('tag_only_change') && l.includes(SLUG))).toBe(true);
  });
});
