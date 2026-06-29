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

  test('declares the support + internal + sales-stub page types', () => {
    const names = pack.page_types.map((t) => t.name).sort();
    expect(names).toEqual([
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

  test('support_case + support_pattern + product_area + process are extractable; kb/inbox/entities are not', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    const isExtractable = (n: string) => byName.get(n)!.extractable !== false;
    expect(isExtractable('support_case')).toBe(true);
    expect(isExtractable('support_pattern')).toBe(true);
    expect(isExtractable('product_area')).toBe(true);
    expect(isExtractable('process')).toBe(true);
    expect(isExtractable('kb_article')).toBe(false);
    expect(isExtractable('inbox')).toBe(false);
    expect(isExtractable('customer')).toBe(false);
  });

  test('declares the Bravura link verbs with inverses', () => {
    const inv = new Map(pack.link_types.map((l) => [l.name, l.inverse]));
    expect(inv.get('for_customer')).toBe('has_case');
    expect(inv.get('affects_product')).toBe('affected_by');
    expect(inv.get('caused_by')).toBe('causes');
    expect(inv.get('resolved_by')).toBe('resolves');
    expect(inv.get('escalated_to')).toBe('handled_by');
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
