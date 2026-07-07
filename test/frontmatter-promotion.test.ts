/**
 * #F-A — frontmatter → structured-knowledge promotion tests (PGLite,
 * in-memory, no DATABASE_URL required).
 *
 * Pins:
 *   - extractKeyOutcomes / extractFrontmatterTimeline / isValidTimelineDate
 *     input hygiene (non-arrays, non-strings, invalid dates, Date objects
 *     from js-yaml, event/summary alias)
 *   - importFromContent promotes key_outcomes → facts (entity from
 *     for_customer, source 'import:key_outcomes', NEGATIVE row_num band,
 *     visibility world) and timeline → timeline_entries (source
 *     'frontmatter', dedupe via the (page_id, date, summary, source) index)
 *   - idempotency: identical re-put (hash short-circuit) adds nothing;
 *     changed content replaces promoted facts; key_outcomes removal clears
 *     them; heal mode backfills pre-feature pages
 *   - deleteFactsForPage onlySourcePrefixes narrows the wipe (fence/cli
 *     rows survive) and is mutually exclusive with excludeSourcePrefixes
 *   - #F-B integration: a put_page-shaped body whose LEADING frontmatter
 *     block is malformed YAML (unquoted `: ` scalar) still promotes —
 *     the salvage parse recovers key_outcomes/timeline/for_customer
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  extractKeyOutcomes,
  extractFrontmatterTimeline,
  isValidTimelineDate,
  promoteFrontmatterKnowledge,
  FRONTMATTER_FACTS_SOURCE,
  FRONTMATTER_TIMELINE_SOURCE,
} from '../src/core/frontmatter-promotion.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function factsFor(slug: string) {
  return engine.executeRaw<{
    id: number; fact: string; entity_slug: string | null; source: string;
    row_num: number; visibility: string;
  }>(
    `SELECT id, fact, entity_slug, source, row_num, visibility
     FROM facts WHERE source_id = 'default' AND source_markdown_slug = $1
     ORDER BY row_num DESC`,
    [slug],
  );
}

async function timelineFor(slug: string) {
  return engine.executeRaw<{ date: string; summary: string; source: string }>(
    `SELECT te.date::text AS date, te.summary, te.source
     FROM timeline_entries te JOIN pages p ON p.id = te.page_id
     WHERE p.slug = $1 AND p.source_id = 'default'
     ORDER BY te.id`,
    [slug],
  );
}

describe('extractors', () => {
  test('extractKeyOutcomes: strings only, trimmed, non-arrays rejected', () => {
    expect(extractKeyOutcomes({ key_outcomes: [' a ', '', 42, null, 'b'] })).toEqual(['a', 'b']);
    expect(extractKeyOutcomes({ key_outcomes: 'not-a-list' })).toEqual([]);
    expect(extractKeyOutcomes({})).toEqual([]);
    expect(extractKeyOutcomes(null)).toEqual([]);
  });

  test('extractFrontmatterTimeline: {date, event} canonical, summary alias, Date objects, invalid skipped', () => {
    const r = extractFrontmatterTimeline({
      timeline: [
        { date: '2025-01-16', event: 'Case opened' },
        { date: new Date('2025-02-01T00:00:00Z'), summary: 'Escalated' }, // js-yaml Date + alias
        { date: '2025-13-40', event: 'bad date' },
        { date: '2025-02-30', event: 'not a real day' },
        { date: '2025-03-01' },              // no event
        'not-an-object',
      ],
    });
    expect(r.entries).toEqual([
      { date: '2025-01-16', summary: 'Case opened' },
      { date: '2025-02-01', summary: 'Escalated' },
    ]);
    expect(r.skipped).toBe(4);
    expect(extractFrontmatterTimeline({ timeline: 'prose section' })).toEqual({ entries: [], skipped: 0 });
  });

  test('isValidTimelineDate mirrors add_timeline_entry op semantics', () => {
    expect(isValidTimelineDate('2025-01-16')).toBe(true);
    expect(isValidTimelineDate('1899-01-01')).toBe(false);
    expect(isValidTimelineDate('2200-01-01')).toBe(false);
    expect(isValidTimelineDate('2025-02-30')).toBe(false);
    expect(isValidTimelineDate('2025-1-6')).toBe(false);
    expect(isValidTimelineDate('not-a-date')).toBe(false);
  });
});

describe('deleteFactsForPage onlySourcePrefixes', () => {
  test('narrow wipe deletes only matching-source rows; mutual exclusion throws', async () => {
    const slug = 'wiki/only-prefix-test';
    await engine.insertFacts([
      { fact: 'promoted one', source: 'import:key_outcomes', row_num: -1, source_markdown_slug: slug },
      { fact: 'fence-owned', source: '', row_num: 1, source_markdown_slug: slug },
      { fact: 'conversation fact', source: 'cli:extract', row_num: 2, source_markdown_slug: slug },
    ], { source_id: 'default' });

    const del = await engine.deleteFactsForPage(slug, 'default', { onlySourcePrefixes: ['import:'] });
    expect(del.deleted).toBe(1);
    const rest = await factsFor(slug);
    expect(rest.map(f => f.fact).sort()).toEqual(['conversation fact', 'fence-owned']);

    await expect(
      engine.deleteFactsForPage(slug, 'default', {
        onlySourcePrefixes: ['import:'],
        excludeSourcePrefixes: ['cli:'],
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });
});

const PAGE_V1 = `---
type: support_case
title: "Case 00099001"
for_customer: customers/acme-corp
date: 2025-04-02
timeline:
  - date: 2025-04-02
    event: "Case opened"
  - date: 2025-04-03
    event: "Case closed"
  - date: not-a-date
    event: "invalid, skipped"
key_outcomes:
  - "Root cause was a misconfigured connector."
  - "Fixed by rotating the service credential."
---
# Case 00099001

Body of the case.
`;

describe('importFromContent promotion round-trip', () => {
  const slug = 'support/cases/case-00099001';

  test('imports and promotes facts + timeline deterministically', async () => {
    const r = await importFromContent(engine, slug, PAGE_V1, { noEmbed: true });
    expect(r.status).toBe('imported');

    const facts = await factsFor(slug);
    expect(facts.length).toBe(2);
    expect(facts.map(f => f.fact)).toEqual([
      'Root cause was a misconfigured connector.',
      'Fixed by rotating the service credential.',
    ]);
    for (const f of facts) {
      expect(f.entity_slug).toBe('customers/acme-corp');
      expect(f.source).toBe(FRONTMATTER_FACTS_SOURCE);
      expect(f.visibility).toBe('world');
      expect(f.row_num).toBeLessThan(0); // negative band — fence-collision-free
    }
    // valid_from tracks the page's effective date (frontmatter `date:`).
    const vf = await engine.executeRaw<{ d: string }>(
      `SELECT to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM facts
       WHERE source_markdown_slug = $1 LIMIT 1`, [slug]);
    expect(vf[0].d).toBe('2025-04-02');

    const tl = await timelineFor(slug);
    expect(tl.length).toBe(2); // invalid date skipped
    expect(tl.map(t => t.summary)).toEqual(['Case opened', 'Case closed']);
    for (const t of tl) expect(t.source).toBe(FRONTMATTER_TIMELINE_SOURCE);
  });

  test('identical re-put (hash short-circuit) adds nothing', async () => {
    const before = await factsFor(slug);
    const r = await importFromContent(engine, slug, PAGE_V1, { noEmbed: true });
    expect(r.status).toBe('skipped');
    const after = await factsFor(slug);
    expect(after.map(f => f.id)).toEqual(before.map(f => f.id)); // same rows, not re-written
    expect((await timelineFor(slug)).length).toBe(2);
  });

  test('heal mode backfills a pre-feature page on unchanged re-put', async () => {
    // Simulate a page imported BEFORE this feature: wipe its promoted rows.
    await engine.deleteFactsForPage(slug, 'default', { onlySourcePrefixes: ['import:'] });
    expect((await factsFor(slug)).length).toBe(0);

    const r = await importFromContent(engine, slug, PAGE_V1, { noEmbed: true });
    expect(r.status).toBe('skipped'); // hash unchanged
    expect((await factsFor(slug)).length).toBe(2); // healed
    expect((await timelineFor(slug)).length).toBe(2); // dedupe held — no duplicates
  });

  test('changed content replaces promoted facts (no duplicates, no strays)', async () => {
    const v2 = PAGE_V1.replace(
      'Fixed by rotating the service credential.',
      'Fixed by upgrading the connector to 12.7.',
    );
    const r = await importFromContent(engine, slug, v2, { noEmbed: true });
    expect(r.status).toBe('imported');
    const facts = await factsFor(slug);
    expect(facts.length).toBe(2);
    expect(facts.map(f => f.fact)).toContain('Fixed by upgrading the connector to 12.7.');
    expect(facts.map(f => f.fact)).not.toContain('Fixed by rotating the service credential.');
  });

  test('removing key_outcomes clears promoted facts; non-import rows survive', async () => {
    // Plant a cli-origin fact on the same page coordinate — must survive.
    await engine.insertFacts([
      { fact: 'survivor', source: 'cli:extract', row_num: 100, source_markdown_slug: slug },
    ], { source_id: 'default' });

    const noOutcomes = PAGE_V1
      .replace(/key_outcomes:\n(  - .*\n)+/m, '')
      .replace('Body of the case.', 'Body of the case, updated.');
    const r = await importFromContent(engine, slug, noOutcomes, { noEmbed: true });
    expect(r.status).toBe('imported');
    const facts = await factsFor(slug);
    expect(facts.map(f => f.fact)).toEqual(['survivor']);
  });
});

describe('#F-B integration: malformed leading YAML still promotes', () => {
  test('unquoted `: ` scalar in the leading block is salvaged and promoted', async () => {
    const slug = 'support/cases/case-00024476-repro';
    // The live-verified breakage shape: `event: Case opened (Priority: Normal)`
    // is a js-yaml hard error, so gray-matter threw and the whole block used
    // to land verbatim in the body with zero frontmatter.
    const content = `---
type: support_case
for_customer: customers/dtcc
date: 2025-01-16T15:46:00+00:00
timeline:
  - date: 2025-01-16
    event: Case opened (Priority: Normal) by contact Said Mounaji
  - date: 2025-01-16
    event: Case closed
key_outcomes:
  - Product question about the Mainframe Connector - password vs passphrase handling.
---
# Case 00024476

Body.
`;
    const r = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(r.status).toBe('imported');
    expect(r.parsedPage!.type).toBe('support_case');
    // The raw '---' block must NOT be in the stored body.
    expect(r.parsedPage!.compiled_truth.startsWith('# Case 00024476')).toBe(true);
    expect(r.parsedPage!.compiled_truth).not.toContain('key_outcomes:');

    const facts = await factsFor(slug);
    expect(facts.length).toBe(1);
    expect(facts[0].entity_slug).toBe('customers/dtcc');
    const tl = await timelineFor(slug);
    expect(tl.map(t => t.summary)).toEqual([
      'Case opened (Priority: Normal) by contact Said Mounaji',
      'Case closed',
    ]);
  });
});

describe('promoteFrontmatterKnowledge direct', () => {
  test('no promotable frontmatter → all-zero result, no DB writes', async () => {
    const slug = 'wiki/plain-page';
    await importFromContent(engine, slug, '---\ntitle: Plain\n---\nJust text.', { noEmbed: true });
    const res = await promoteFrontmatterKnowledge(engine, slug, { title: 'Plain' }, { noEmbed: true });
    expect(res).toEqual({ facts_deleted: 0, facts_inserted: 0, timeline_inserted: 0, timeline_skipped: 0 });
    expect((await factsFor(slug)).length).toBe(0);
  });
});
