// B1: get_timeline include_linked rollup.
//
// Verifies that include_linked=true unions timeline entries from pages that
// link INTO the target entity page via typed edges (for_customer /
// affects_product / works_on), annotates each entry with origin_slug, dedupes
// by entry id, and that the default path (no flag) is byte-identical to the
// old engine.getTimeline call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: LOGGER as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

function findOp(name: string) {
  const op = operations.find(o => o.name === name);
  if (!op) throw new Error(`operation ${name} not found`);
  return op;
}

async function seedPage(slug: string) {
  await engine.putPage(slug, {
    title: slug,
    type: 'concept' as never,
    compiled_truth: 'body',
    timeline: '',
    frontmatter: {},
    source_path: `${slug}.md`,
  });
}

async function addLink(from: string, to: string, linkType: string) {
  await engine.addLinksBatch([
    { from_slug: from, to_slug: to, link_type: linkType, link_source: 'test' },
  ]);
}

async function addEntry(slug: string, date: string, summary: string) {
  await engine.addTimelineEntry(slug, { date, summary }, { sourceId: 'default' });
}

const getTimeline = findOp('get_timeline');

describe('get_timeline — include_linked rollup (B1)', () => {
  // (d) Default path unchanged: no include_linked flag returns only own entries.
  it('default (no include_linked): returns only own timeline entries', async () => {
    await seedPage('customers/acme');
    await seedPage('support/cases/case-001');
    await addLink('support/cases/case-001', 'customers/acme', 'for_customer');
    await addEntry('support/cases/case-001', '2026-01-15', 'Case opened');
    await addEntry('customers/acme', '2026-01-10', 'Customer entry');

    const result = await getTimeline.handler(makeCtx(), { slug: 'customers/acme' }) as any[];
    // Only the own entry — case-001 not included without flag.
    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Customer entry');
    // No origin_slug annotation on plain getTimeline result
    expect(result[0].origin_slug).toBeUndefined();
  });

  // (e) include_linked rolls up linked entries with origin slug.
  it('include_linked: unions timeline entries from for_customer linking pages', async () => {
    await seedPage('customers/acme');
    await seedPage('support/cases/case-001');
    await addLink('support/cases/case-001', 'customers/acme', 'for_customer');
    await addEntry('support/cases/case-001', '2026-01-15', 'Case opened');
    await addEntry('customers/acme', '2026-01-10', 'Customer entry');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'customers/acme',
      include_linked: true,
    }) as any[];

    expect(result).toHaveLength(2);

    // Each entry has origin_slug
    const caseEntry = result.find((e: any) => e.summary === 'Case opened');
    const ownEntry = result.find((e: any) => e.summary === 'Customer entry');
    expect(caseEntry).toBeDefined();
    expect(ownEntry).toBeDefined();
    expect(caseEntry!.origin_slug).toBe('support/cases/case-001');
    expect(ownEntry!.origin_slug).toBe('customers/acme');
  });

  it('include_linked: works with affects_product link type', async () => {
    await seedPage('products/bravura-pass');
    await seedPage('support/cases/case-002');
    await addLink('support/cases/case-002', 'products/bravura-pass', 'affects_product');
    await addEntry('support/cases/case-002', '2026-02-01', 'Product bug filed');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'products/bravura-pass',
      include_linked: true,
    }) as any[];

    expect(result).toHaveLength(1);
    expect(result[0].summary).toBe('Product bug filed');
    expect(result[0].origin_slug).toBe('support/cases/case-002');
  });

  it('include_linked: works with works_on link type', async () => {
    await seedPage('projects/relaunch');
    await seedPage('people/alice');
    await addLink('people/alice', 'projects/relaunch', 'works_on');
    await addEntry('people/alice', '2026-03-01', 'Alice joined project');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'projects/relaunch',
      include_linked: true,
    }) as any[];

    expect(result).toHaveLength(1);
    expect(result[0].origin_slug).toBe('people/alice');
  });

  it('include_linked: non-qualifying link types (mentions) are excluded', async () => {
    await seedPage('customers/beta');
    await seedPage('notes/a-note');
    // 'mentions' is not in TIMELINE_ROLLUP_LINK_TYPES
    await addLink('notes/a-note', 'customers/beta', 'mentions');
    await addEntry('notes/a-note', '2026-04-01', 'Note entry');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'customers/beta',
      include_linked: true,
    }) as any[];

    // Note's entry is NOT rolled up — wrong link type.
    expect(result.some((e: any) => e.summary === 'Note entry')).toBe(false);
  });

  it('include_linked: dedupes when a page has multiple qualifying edges to the target', async () => {
    await seedPage('customers/corp');
    await seedPage('support/cases/multi-edge');
    // Same from → same to, but two different qualifying link types.
    await addLink('support/cases/multi-edge', 'customers/corp', 'for_customer');
    await addLink('support/cases/multi-edge', 'customers/corp', 'affects_product');
    await addEntry('support/cases/multi-edge', '2026-05-01', 'Multi-edge case entry');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'customers/corp',
      include_linked: true,
    }) as any[];

    // Entry appears exactly once despite two edges.
    const entries = result.filter((e: any) => e.summary === 'Multi-edge case entry');
    expect(entries).toHaveLength(1);
  });

  it('include_linked: multiple linking pages all contribute entries', async () => {
    await seedPage('customers/globex');
    await seedPage('support/cases/case-10');
    await seedPage('support/cases/case-11');
    await addLink('support/cases/case-10', 'customers/globex', 'for_customer');
    await addLink('support/cases/case-11', 'customers/globex', 'for_customer');
    await addEntry('support/cases/case-10', '2026-06-01', 'First case');
    await addEntry('support/cases/case-11', '2026-06-02', 'Second case');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'customers/globex',
      include_linked: true,
    }) as any[];

    expect(result).toHaveLength(2);
    expect(result.map((e: any) => e.origin_slug).sort()).toEqual([
      'support/cases/case-10',
      'support/cases/case-11',
    ]);
  });

  it('include_linked: newest-first ordering across own + linked entries', async () => {
    await seedPage('customers/newest-test');
    await seedPage('support/cases/case-x');
    await addLink('support/cases/case-x', 'customers/newest-test', 'for_customer');
    await addEntry('customers/newest-test', '2026-01-01', 'Old own entry');
    await addEntry('support/cases/case-x', '2026-06-01', 'Recent linked entry');

    const result = await getTimeline.handler(makeCtx(), {
      slug: 'customers/newest-test',
      include_linked: true,
    }) as any[];

    expect(result).toHaveLength(2);
    // Most recent first
    expect(result[0].summary).toBe('Recent linked entry');
    expect(result[1].summary).toBe('Old own entry');
  });
});
