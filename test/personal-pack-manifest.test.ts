// gbrain-personal manifest shape — fork-local per-user personal-brain pack.
// Mirrors test/bravura-pack-manifest.test.ts so the personal taxonomy is
// CI-protected against drift. See personal-agents/ARCHITECTURE.md.
//
// v1.2.0 regression — the live mistyped-distill-output bug (2026-07):
// extends-chain resolution does NOT merge parent page_types
// (ResolvedPack.manifest is the child manifest only — same class as
// gbrain-bravura v1.5.1 / #22), and gbrain-personal declared ONLY `inbox`.
// So while the personal pack was active, inferTypeFromPack fell through
// every prefix for people/ companies/ meetings/ daily/ concepts/ projects/
// paths and stored untyped distill output as the default 'concept'
// (verified live: 9 people/*, 4 meetings/*, 3 daily/*, 1 companies/* under
// source bart-allan stored as concept). That silently broke the pack's own
// person-scoped works_at rule, the meeting-scoped attended rule, and
// find_experts routing over people. The pack must declare its types itself.
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

describe('gbrain-personal per-user brain pack', () => {
  const pack = loadPack('gbrain-personal');

  test('parses cleanly and extends gbrain-recommended', () => {
    expect(pack.name).toBe('gbrain-personal');
    expect(pack.api_version).toBe('gbrain-schema-pack-v1');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.extends).toBe('gbrain-recommended');
  });

  test('v1.2.0: declares inbox + every compiled-truth type the distill files (extends does not merge parent page_types)', () => {
    const names = pack.page_types.map((t) => t.name).sort();
    expect(names).toEqual([
      'company',
      'concept',
      'daily',
      'inbox',
      'meeting',
      'person',
      'project',
      'source',
    ]);
  });

  test('every filing-rule kind is a locally declared page type', () => {
    // The exact hole v1.1.0 shipped with: filing rules referenced types the
    // resolved manifest did not contain, so path inference could never
    // produce them. Now a closed loop: rule kind → declared type.
    const declared = new Set(pack.page_types.map((t) => t.name));
    for (const rule of pack.filing_rules) {
      expect(declared.has(rule.kind)).toBe(true);
    }
  });

  test('every frontmatter_links page_type is a locally declared page type', () => {
    const declared = new Set(pack.page_types.map((t) => t.name));
    for (const rule of pack.frontmatter_links) {
      expect(declared.has(rule.page_type)).toBe(true);
    }
  });

  test('primitives + flags mirror what the extends chain would have provided', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    // person/company: gbrain-base entity shapes; expertise loci.
    expect(byName.get('person')).toMatchObject({ primitive: 'entity', expert_routing: true, extractable: false });
    expect(byName.get('company')).toMatchObject({ primitive: 'entity', expert_routing: true, extractable: false });
    // meeting/daily: gbrain-recommended temporal, extractable.
    expect(byName.get('meeting')).toMatchObject({ primitive: 'temporal', extractable: true, expert_routing: false });
    expect(byName.get('daily')).toMatchObject({ primitive: 'temporal', extractable: true, expert_routing: false });
    // concept: gbrain-recommended concept, extractable.
    expect(byName.get('concept')).toMatchObject({ primitive: 'concept', extractable: true, expert_routing: false });
    // project: gbrain-recommended entity, link-hub only.
    expect(byName.get('project')).toMatchObject({ primitive: 'entity', extractable: false, expert_routing: false });
    // inbox/source: raw media landing/archive — never mined directly.
    expect(byName.get('inbox')).toMatchObject({ primitive: 'media', extractable: false, expert_routing: false });
    expect(byName.get('source')).toMatchObject({ primitive: 'media', extractable: false, expert_routing: false });
  });

  test('path prefixes match the filing-rule directories', () => {
    const byName = new Map(pack.page_types.map((t) => [t.name, t]));
    const expected: Record<string, string> = {
      inbox: 'inbox/',
      person: 'people/',
      company: 'companies/',
      meeting: 'meetings/',
      daily: 'daily/',
      concept: 'concepts/',
      project: 'projects/',
      source: 'sources/',
    };
    for (const [name, prefix] of Object.entries(expected)) {
      expect(byName.get(name)!.path_prefixes).toContain(prefix);
    }
  });

  test('v1.2.0: distill paths infer their intended types under the active pack (not concept)', () => {
    // Exact live shapes: untyped put_page writes from the personal distill
    // while gbrain-personal is active. Pre-fix every one returned 'concept'.
    expect(inferTypeFromPack('people/jane-doe', pack)).toBe('person');
    expect(inferTypeFromPack('people/jane-doe.md', pack)).toBe('person');
    expect(inferTypeFromPack('companies/acme-example', pack)).toBe('company');
    expect(inferTypeFromPack('meetings/2026-07-01-quarterly-planning', pack)).toBe('meeting');
    expect(inferTypeFromPack('daily/2026-07-01', pack)).toBe('daily');
    expect(inferTypeFromPack('concepts/saml-sso-setup', pack)).toBe('concept');
    expect(inferTypeFromPack('projects/company-brain-rollout', pack)).toBe('project');
    expect(inferTypeFromPack('inbox/2026-07-01-granola-abc123', pack)).toBe('inbox');
    expect(inferTypeFromPack('sources/.raw/2026-07-01-granola-abc123', pack)).toBe('source');
  });

  test('v1.2.0: meeting attendees on a pack-typed meeting page emit incoming attended edges', async () => {
    // End-to-end shape of the live bug: page type comes from
    // inferTypeFromPack (as put_page does) and the pack's meeting-scoped
    // attendees→attended rule (direction: incoming) must fire. Pre-fix
    // inferTypeFromPack said 'concept' and the rule was skipped.
    const known = new Set(['people/jane-doe', 'people/john-roe']);
    const resolver: SlugResolver = {
      async resolve(name: string) {
        if (SLUG_PATH_VALUE_RE.test(name)) return known.has(name.toLowerCase()) ? name.toLowerCase() : null;
        return null;
      },
    };
    const pageType = inferTypeFromPack('meetings/2026-07-01-quarterly-planning', pack);
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'meetings/2026-07-01-quarterly-planning', pageType,
      { participants: ['people/jane-doe', 'people/john-roe'] },
      resolver, pack,
    );
    expect(unresolved).toEqual([]);
    expect(candidates).toHaveLength(2);
    const froms = candidates.map((c) => c.fromSlug).sort();
    expect(froms).toEqual(['people/jane-doe', 'people/john-roe']);
    for (const c of candidates) {
      expect(c).toMatchObject({
        targetSlug: 'meetings/2026-07-01-quarterly-planning',
        linkType: 'attended',
        linkSource: 'frontmatter',
      });
    }
  });

  test('v1.2.0: person works_at slug-form ref on a pack-typed person page emits a works_at edge', async () => {
    const known = new Set(['companies/acme-example']);
    const resolver: SlugResolver = {
      async resolve(name: string) {
        if (SLUG_PATH_VALUE_RE.test(name)) return known.has(name.toLowerCase()) ? name.toLowerCase() : null;
        return null;
      },
    };
    const pageType = inferTypeFromPack('people/jane-doe', pack);
    const { candidates, unresolved } = await extractFrontmatterLinks(
      'people/jane-doe', pageType,
      { works_at: 'companies/acme-example' },
      resolver, pack,
    );
    expect(unresolved).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      fromSlug: 'people/jane-doe',
      targetSlug: 'companies/acme-example',
      linkType: 'works_at',
      linkSource: 'frontmatter',
    });
  });
});
