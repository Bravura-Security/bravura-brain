/**
 * #F-B — frontmatter-as-body salvage tests.
 *
 * Root cause (live-verified on support/cases/case-00024476): agent-authored
 * put_page content whose LEADING `---` YAML block contains an unquoted plain
 * scalar with `: ` (e.g. `event: Case opened (Priority: Normal) ...`) is a
 * js-yaml hard error. gray-matter throws, parseMarkdown fell back to
 * frontmatter={} + raw content as body — so the page chunked its own YAML
 * as prose and produced zero frontmatter-derived edges/tags.
 *
 * The salvage path (salvageLeadingFrontmatter) recovers the block —
 * verbatim, or after quoting the offending scalars — and strips it from the
 * stored body. Guards: only a LEADING block (first non-empty line exactly
 * `---`), closing fence required, block must parse to a YAML mapping.
 */

import { describe, test, expect } from 'bun:test';
import { parseMarkdown, salvageLeadingFrontmatter } from '../src/core/markdown.ts';

const BROKEN_CASE = `---
type: support_case
for_customer: customers/depository-trust-and-clearing-corporation-dtcc
affects_product: Bravura Mainframe Connector
caused_by: null
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

Body text.
`;

describe('salvageLeadingFrontmatter', () => {
  test('recovers the live-broken unquoted-colon shape', () => {
    const r = salvageLeadingFrontmatter(BROKEN_CASE);
    expect(r).not.toBeNull();
    expect(r!.data.type).toBe('support_case');
    expect(r!.data.for_customer).toBe('customers/depository-trust-and-clearing-corporation-dtcc');
    const timeline = r!.data.timeline as Array<Record<string, unknown>>;
    expect(timeline.length).toBe(2);
    expect(timeline[0].event).toBe('Case opened (Priority: Normal) by contact Said Mounaji');
    expect((r!.data.key_outcomes as string[]).length).toBe(1);
    expect(r!.body.trim().startsWith('# Case 00024476')).toBe(true);
    expect(r!.body).not.toContain('key_outcomes');
  });

  test('recovers a valid block behind a leading blank line (gray-matter never engages)', () => {
    const r = salvageLeadingFrontmatter('\n---\ntype: note\ntitle: Hello\n---\nbody here');
    expect(r).not.toBeNull();
    expect(r!.data.type).toBe('note');
    expect(r!.body.trim()).toBe('body here');
  });

  test('rejects prose between two horizontal rules (not a mapping)', () => {
    expect(salvageLeadingFrontmatter('---\nJust a poetic line\n---\nrest')).toBeNull();
  });

  test('rejects when the first non-empty line is not ---', () => {
    expect(salvageLeadingFrontmatter('# Title\n\n---\ntype: note\n---\n')).toBeNull();
  });

  test('rejects an unclosed block', () => {
    expect(salvageLeadingFrontmatter('---\ntype: note\nno closing fence')).toBeNull();
  });

  test('rejects an empty block', () => {
    expect(salvageLeadingFrontmatter('---\n\n---\nbody')).toBeNull();
  });

  test('handles CRLF line endings', () => {
    const r = salvageLeadingFrontmatter('---\r\ntype: note\r\nevent: a (b: c) d\r\n---\r\nbody');
    expect(r).not.toBeNull();
    expect(r!.data.event).toBe('a (b: c) d');
  });

  test('accepts YAML document-end ... as the closing fence', () => {
    const r = salvageLeadingFrontmatter('---\ntype: note\n...\nbody');
    expect(r).not.toBeNull();
    expect(r!.data.type).toBe('note');
  });
});

describe('parseMarkdown integration', () => {
  test('malformed leading block lands in frontmatter, not the body', () => {
    const r = parseMarkdown(BROKEN_CASE, 'support/cases/case-00024476.md');
    expect(r.type).toBe('support_case');
    expect(r.frontmatter.for_customer).toBe('customers/depository-trust-and-clearing-corporation-dtcc');
    expect(Array.isArray(r.frontmatter.timeline)).toBe(true);
    expect(Array.isArray(r.frontmatter.key_outcomes)).toBe(true);
    expect(r.compiled_truth.startsWith('# Case 00024476')).toBe(true);
    expect(r.compiled_truth).not.toContain('for_customer:');
  });

  test('valid frontmatter is never second-guessed by the salvage path', () => {
    const r = parseMarkdown('---\ntype: concept\ntitle: Fine\ntags: [a]\n---\nbody\n\n---\n\nafter an hr', 'x.md');
    expect(r.type).toBe('concept');
    expect(r.title).toBe('Fine');
    expect(r.tags).toEqual(['a']);
    expect(r.compiled_truth).toContain('after an hr');
  });

  test('plain markdown without frontmatter is untouched', () => {
    const r = parseMarkdown('# Hello\n\nSome text\n\n---\n\nmore text', 'notes/hello.md');
    expect(Object.keys(r.frontmatter)).toEqual([]);
    expect(r.compiled_truth).toContain('# Hello');
  });

  test('salvaged tags/title/type flow through the normal extraction', () => {
    const content = '\n---\ntype: meeting\ntitle: Sync (topic: budgets)\ntags: [finance]\n---\nnotes';
    const r = parseMarkdown(content, 'meetings/sync.md');
    expect(r.type).toBe('meeting');
    expect(r.title).toBe('Sync (topic: budgets)');
    expect(r.tags).toEqual(['finance']);
    expect(r.compiled_truth).toBe('notes');
    // extracted top-keys are stripped from the residual frontmatter
    expect(r.frontmatter.title).toBeUndefined();
    expect(r.frontmatter.type).toBeUndefined();
  });
});
