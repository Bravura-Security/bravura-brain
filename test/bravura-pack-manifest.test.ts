// gbrain-bravura manifest shape — fork-local company-brain pack.
// Mirrors test/lens-pack-manifests.test.ts so the Bravura taxonomy is
// CI-protected against drift. See brain-deploy/docs/BRAVURA_BRAIN_DESIGN.md.
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSchemaPackManifest,
  parseYamlMini,
  type SchemaPackManifest,
} from '../src/core/schema-pack/index.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';
import {
  extractFrontmatterLinks,
  SLUG_PATH_VALUE_RE,
  type SlugResolver,
} from '../src/core/link-extraction.ts';

const here = dirname(fileURLToPath(import.meta.url));
const baseDir = join(here, '..', 'src', 'core', 'schema-pack', 'base');

function loadPack(name: string): SchemaPackManifest {
  const p = join(baseDir, `${name}.yaml`);
  if (!existsSync(p)) throw new Error(`bundled pack not found at ${p}`);
  return parseSchemaPackManifest(parseYamlMini(readFileSync(p, 'utf-8')), { path: p });
}

describe('gbrain-bravura company-brain pack', () => {
  const pack = loadPack('gbrain-bravura');

  test('parses cleanly and extends gbrain-recommended', () => {
    expect(pack.name).toBe('gbrain-bravura');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.extends).toBe('gbrain-recommended');
  });

  test('declares the support + internal + sales-stub + connector reference page types', () => {
    const names = pack.page_types.map((t) => t.name).sort();
    expect(names).toEqual([
      'customer',
      'deal',
      'documentation',
      'inbox',
      'kb_article',
      'knowledge_article',
      'person', // v1.5.1 — must be declared locally; extends does not merge parent page_types
      'process',
      'product_area',
      'responsive_qa',
      'rfp',
      'support_case',
      'support_pattern',
      'team',
    ]);
  });

  test('support_case + support_pattern + product_area + process are extractable; kb/inbox/entities/connector-refs are not', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    const isExtractable = (n: string) => byName.get(n)!.extractable !== false;
    expect(isExtractable('support_case')).toBe(true);
    expect(isExtractable('support_pattern')).toBe(true);
    expect(isExtractable('product_area')).toBe(true);
    expect(isExtractable('process')).toBe(true);
    expect(isExtractable('kb_article')).toBe(false);
    expect(isExtractable('inbox')).toBe(false);
    expect(isExtractable('customer')).toBe(false);
    expect(isExtractable('responsive_qa')).toBe(false);
    expect(isExtractable('documentation')).toBe(false);
    expect(isExtractable('knowledge_article')).toBe(false);
    expect(isExtractable('deal')).toBe(false);
  });

  test('connector reference types have correct path_prefixes', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    expect(byName.get('responsive_qa')!.path_prefixes).toContain('responsive/');
    expect(byName.get('documentation')!.path_prefixes).toContain('paligo/');
    expect(byName.get('knowledge_article')!.path_prefixes).toContain('salesforce-kb/');
  });

  test('v1.5: documentation also types confluence/ pages', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    expect(byName.get('documentation')!.path_prefixes).toEqual(['paligo/', 'confluence/']);
  });

  test('v1.4: deal types sales/opportunities/ pages (Salesforce opportunity ingest)', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    const deal = byName.get('deal')!;
    expect(deal.primitive).toBe('temporal');
    expect(deal.path_prefixes).toContain('sales/opportunities/');
    expect(deal.path_prefixes).toContain('deals/');
    expect(deal.extractable).toBe(false);
    expect(deal.expert_routing).toBe(false);
  });

  test('v1.4: deal account frontmatter wires for_customer with a customers/ dir hint', () => {
    const fl = (pack.frontmatter_links ?? []).find(
      (l) => l.page_type === 'deal' && l.fields.includes('account'),
    );
    expect(fl?.link_type).toBe('for_customer');
    expect(fl?.target_dirs).toEqual(['customers/']);
    expect(fl?.fields).toContain('for_customer'); // verb-named field, v1.3 convention
  });

  test('customer has expert_routing enabled in v1.1', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    expect(byName.get('customer')!.expert_routing).toBe(true);
  });

  test('mapping_rules declared for the three connector reference types', () => {
    expect(pack.mapping_rules).toBeDefined();
    const retypes = (pack.mapping_rules ?? []).filter((r) => r.kind === 'retype');
    const fromTypes = retypes.map((r) => r.from_type).sort();
    expect(fromTypes).toContain('responsive_qa');
    expect(fromTypes).toContain('documentation');
    expect(fromTypes).toContain('knowledge_article');
  });

  test('v1.5: concept→documentation retype rule migrates confluence/ pages, prefix-scoped', () => {
    const rule = (pack.mapping_rules ?? []).find(
      (r) => r.kind === 'retype' && r.from_type === 'concept',
    );
    expect(rule).toBeDefined();
    if (rule?.kind !== 'retype') throw new Error('expected retype rule');
    expect(rule.to_type).toBe('documentation');
    expect(rule.subtype_field).toBe('origin');
    expect(rule.subtype).toBe('confluence');
    // Without the path_filter this rule would swallow every real concept page.
    expect(rule.path_filter).toBe('confluence/%');
  });

  test('declares the Bravura link verbs with inverses', () => {
    const inv = new Map(pack.link_types.map((l) => [l.name, l.inverse]));
    expect(inv.get('for_customer')).toBe('has_case');
    expect(inv.get('affects_product')).toBe('affected_by');
    expect(inv.get('caused_by')).toBe('causes');
    expect(inv.get('resolved_by')).toBe('resolves');
    expect(inv.get('escalated_to')).toBe('handled_by');
    expect(inv.get('works_on')).toBe('worked_on_by'); // v1.5
  });

  test('v1.5: person works_on frontmatter wires works_on edges with a products/ dir hint', () => {
    const fl = (pack.frontmatter_links ?? []).find(
      (l) => l.page_type === 'person' && l.fields.includes('works_on'),
    );
    expect(fl?.link_type).toBe('works_on');
    expect(fl?.target_dirs).toEqual(['products/']);
  });

  test('v1.3: verb-named frontmatter fields (for_customer, affects_product) are mapped', () => {
    // The enrich agent writes `for_customer: customers/docusign` /
    // `affects_product: products/bravura-identity` (slug-form) on the pages
    // it authors. Unmapped fields are silently ignored by
    // extractFrontmatterLinks — no edge, not even an unresolved report —
    // so the verb-named fields must be declared alongside the
    // display-name fields (account, product, ...).
    const byField = (pageType: string, field: string) =>
      (pack.frontmatter_links ?? []).find(
        (fl) => (fl.page_type === undefined || fl.page_type === pageType) && fl.fields.includes(field),
      );
    expect(byField('support_case', 'for_customer')?.link_type).toBe('for_customer');
    expect(byField('support_case', 'account')?.link_type).toBe('for_customer');
    expect(byField('support_case', 'affects_product')?.link_type).toBe('affects_product');
    expect(byField('support_pattern', 'affects_product')?.link_type).toBe('affects_product');
  });

  // v1.5.1 regression — the live zero-works_on-edges bug (2026-07-09).
  //
  // gbrain-bravura's frontmatter_links declare `page_type: person →
  // works_on`, and its comments claim person is "inherited from the
  // extends chain" — but extends-chain resolution does NOT merge parent
  // page_types (ResolvedPack.manifest is the child manifest only), and
  // gbrain-recommended declares ZERO page_types anyway. Consequence:
  // `inferTypeFromPack('people/…', pack)` fell through every declared
  // prefix and returned the default 'concept', so put_page stored
  // people/* pages as type=concept and the person-scoped works_on rule
  // never fired — 21 live pages carrying `works_on: [products/…]`
  // produced ZERO edges. person was also absent from expert_routing, so
  // find_experts never ranked people. The pack must declare person itself.
  test('v1.5.1: person page type is declared — people/ prefix, expert routing', () => {
    const person = pack.page_types.find((t) => t.name === 'person');
    expect(person).toBeDefined();
    expect(person!.primitive).toBe('entity');
    expect(person!.path_prefixes).toContain('people/');
    expect(person!.expert_routing).toBe(true);
  });

  test('v1.5.1: people/* paths infer type person under the active pack (not concept)', () => {
    // Exact live shape: people/matt-vasich written via put_page while
    // gbrain-bravura is active. Pre-fix this returned 'concept'.
    expect(inferTypeFromPack('people/matt-vasich', pack)).toBe('person');
    expect(inferTypeFromPack('people/matt-vasich.md', pack)).toBe('person');
  });

  test('v1.5.1: works_on array of slug-form refs on a pack-typed person page emits one edge per product', async () => {
    // End-to-end shape of the live bug: page type comes from
    // inferTypeFromPack (as put_page does), frontmatter carries an ARRAY
    // of slug-form product refs, and the pack's person→works_on rule must
    // produce one frontmatter edge per element. Pre-fix: inferTypeFromPack
    // said 'concept', the person-scoped rule was skipped, zero candidates.
    const known = new Set(['products/bravura-safe', 'products/bravura-pass']);
    const resolver: SlugResolver = {
      async resolve(name: string) {
        if (SLUG_PATH_VALUE_RE.test(name)) return known.has(name.toLowerCase()) ? name.toLowerCase() : null;
        return null;
      },
    };
    const pageType = inferTypeFromPack('people/matt-vasich', pack);
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'people/matt-vasich', pageType,
      { source: 'company', works_on: ['products/bravura-safe', 'products/bravura-pass'] },
      resolver, pack,
    );
    expect(unresolved).toEqual([]);
    expect(candidates).toHaveLength(2);
    const targets = candidates.map((c) => c.targetSlug).sort();
    expect(targets).toEqual(['products/bravura-pass', 'products/bravura-safe']);
    for (const c of candidates) {
      expect(c).toMatchObject({
        fromSlug: 'people/matt-vasich',
        linkType: 'works_on',
        linkSource: 'frontmatter',
        originSlug: 'people/matt-vasich',
        originField: 'works_on',
      });
    }
  });

  test('filing rules cover every authored type', () => {
    const kinds = pack.filing_rules.map((r) => r.kind).sort();
    expect(kinds).toEqual([
      'customer',
      'inbox',
      'kb_article',
      'process',
      'product_area',
      'rfp',
      'support_case',
      'support_pattern',
      'team',
    ]);
  });
});
