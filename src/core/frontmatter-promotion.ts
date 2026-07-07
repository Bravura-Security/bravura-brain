/**
 * #F-A — deterministic frontmatter → structured-knowledge promotion.
 *
 * Agent-authored pages (dream/backfill campaigns, schema packs like
 * gbrain-bravura) carry `key_outcomes:` (list of short strings) and
 * `timeline:` (list of `{date, event}`) in frontmatter. Pre-fix nothing
 * promoted them: `recall`/facts stayed empty brain-wide and
 * timeline_entries barely used. This module promotes both at import time
 * (importFromContent post-transaction hook) with ZERO agent/prompt changes.
 *
 * Contracts:
 *   - Idempotent on re-put. importFromContent's content-hash short-circuit
 *     skips unchanged content (heal mode below covers the
 *     already-imported-before-this-fix backlog); on CHANGED content facts
 *     promotion is wipe-then-reinsert scoped to `source LIKE 'import:%'`
 *     rows on the page coordinate (the fence-reconcile convention from
 *     src/core/cycle/extract-facts.ts), and timeline promotion rides the
 *     (page_id, date, summary, source) ON CONFLICT DO NOTHING dedupe that
 *     add_timeline_entry uses.
 *   - Promoted fact rows key on (source_id, source_markdown_slug=page slug,
 *     row_num) under the v51 partial UNIQUE index. row_num uses the
 *     NEGATIVE band -(i+1) so promoted rows can never collide with
 *     fence-owned rows (parseFactsFence assigns positive row numbers) and
 *     never trip the legacy-row guard (row_num IS NULL).
 *   - The extract_facts cycle phase's destructive fence reconcile excludes
 *     the 'import:' source prefix (same rationale as 'cli:' — these rows
 *     are not recreatable from a `## Facts` fence; they're recreated from
 *     frontmatter on the next import instead).
 *   - Fail-soft: callers wrap this in try/catch; a promotion failure never
 *     fails the import (same posture as the page_aliases projection).
 *   - visibility='world': the fact text is verbatim page frontmatter that
 *     any reader with access to the page already sees via get_page/search,
 *     so promoting at world visibility widens nothing — and remote `recall`
 *     callers (the whole point of the promotion) are world-filtered.
 */

import type { BrainEngine } from './engine.ts';
import { coerceFrontmatterString } from './markdown.ts';

/** Source label stamped on promoted fact rows. */
export const FRONTMATTER_FACTS_SOURCE = 'import:key_outcomes';
/**
 * Prefix protected from the extract_facts fence reconcile AND used by the
 * wipe-then-reinsert here. Keep in sync with the excludeSourcePrefixes list
 * in src/core/cycle/extract-facts.ts.
 */
export const FRONTMATTER_FACTS_SOURCE_PREFIX = 'import:';
/** `timeline_entries.source` label for frontmatter-promoted entries. */
export const FRONTMATTER_TIMELINE_SOURCE = 'frontmatter';

/** Extract valid key_outcomes strings. Non-arrays / non-strings → []. */
export function extractKeyOutcomes(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] {
  const raw = frontmatter?.key_outcomes;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

export interface FrontmatterTimelineEntry {
  date: string;
  summary: string;
}

/**
 * Strict YYYY-MM-DD with year 1900-2199 and a real calendar day. Mirrors the
 * add_timeline_entry op's validation (src/core/operations.ts) — PG DATE
 * accepts year 5874897 silently, which nobody wants.
 */
export function isValidTimelineDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(date);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/**
 * Extract promotable `timeline:` frontmatter entries. Canonical item shape is
 * `{date, event}`; `summary` is accepted as an alias for `event`. Dates may
 * arrive as strings or js-yaml Date objects (unquoted `date: 2025-01-16`
 * parses to a Date) — coerceFrontmatterString normalizes both. Items with a
 * missing/invalid date or empty event are counted in `skipped`, never thrown.
 */
export function extractFrontmatterTimeline(
  frontmatter: Record<string, unknown> | null | undefined,
): { entries: FrontmatterTimelineEntry[]; skipped: number } {
  const raw = frontmatter?.timeline;
  if (!Array.isArray(raw)) return { entries: [], skipped: 0 };
  const entries: FrontmatterTimelineEntry[] = [];
  let skipped = 0;
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      skipped++;
      continue;
    }
    const rec = item as Record<string, unknown>;
    const date = coerceFrontmatterString(rec.date).trim();
    const summary = (
      typeof rec.event === 'string' ? rec.event
      : typeof rec.summary === 'string' ? rec.summary
      : ''
    ).trim();
    if (!summary || !isValidTimelineDate(date)) {
      skipped++;
      continue;
    }
    entries.push({ date, summary });
  }
  return { entries, skipped };
}

export interface PromotionResult {
  facts_deleted: number;
  facts_inserted: number;
  timeline_inserted: number;
  timeline_skipped: number;
}

export interface PromotionOpts {
  sourceId?: string;
  /** Skip fact embeddings entirely (importFromContent threads opts.noEmbed). */
  noEmbed?: boolean;
  /**
   * Page effective_date (frontmatter date > filename date > timestamps
   * chain) used as facts.valid_from so trajectory/recency queries see claim
   * dates, not import dates — same rationale as the extract_facts cycle
   * phase threading page.effective_date (v0.35.4 D-ENG-1).
   */
  effectiveDate?: Date | null;
  /**
   * Frontmatter of the page row BEFORE this import. Drives clear-on-removal:
   * when the previous version had key_outcomes and the new one doesn't, the
   * stale promoted facts are wiped (mirrors the always-call contract of
   * setPageAliases).
   */
  previousFrontmatter?: Record<string, unknown> | null;
  /**
   * 'import' (default): content changed / new page — wipe promoted rows,
   * reinsert from current frontmatter.
   * 'heal': content-hash short-circuit path — the page predates this
   * feature or was re-put unchanged. Facts insert only when the page has
   * ZERO 'import:'-sourced rows (one cheap indexed COUNT, and only for
   * pages that actually carry key_outcomes); timeline insert always runs
   * (single batched ON CONFLICT DO NOTHING).
   */
  mode?: 'import' | 'heal';
}

/**
 * Promote frontmatter key_outcomes → facts and timeline → timeline_entries.
 * Deterministic — no LLM calls. May call the embedding gateway (fail-open,
 * mirrors the extract_facts cycle phase's batch-embed posture).
 *
 * Callers MUST treat this as fail-soft (wrap in try/catch): pre-v40 brains
 * have no facts table, ancient brains no timeline_entries — a promotion
 * failure must never fail the import.
 */
export async function promoteFrontmatterKnowledge(
  engine: BrainEngine,
  slug: string,
  frontmatter: Record<string, unknown>,
  opts: PromotionOpts = {},
): Promise<PromotionResult> {
  const sourceId = opts.sourceId ?? 'default';
  const mode = opts.mode ?? 'import';
  const result: PromotionResult = {
    facts_deleted: 0,
    facts_inserted: 0,
    timeline_inserted: 0,
    timeline_skipped: 0,
  };

  // ── Facts: key_outcomes ─────────────────────────────────────
  const outcomes = extractKeyOutcomes(frontmatter);
  const hadOutcomes = extractKeyOutcomes(opts.previousFrontmatter).length > 0;

  let insertOutcomes = false;
  if (mode === 'import') {
    // Wipe-then-reinsert scoped to promoted rows only ('import:' prefix) —
    // fence-owned (positive row_num, NULL/empty source) and 'cli:' rows on
    // the same page coordinate are untouched. Skip the DELETE round-trip
    // entirely for the overwhelmingly common no-key_outcomes page.
    if (outcomes.length > 0 || hadOutcomes) {
      const del = await engine.deleteFactsForPage(slug, sourceId, {
        onlySourcePrefixes: [FRONTMATTER_FACTS_SOURCE_PREFIX],
      });
      result.facts_deleted = del.deleted;
    }
    insertOutcomes = outcomes.length > 0;
  } else if (outcomes.length > 0) {
    // heal: only when this page has no promoted rows yet (pre-feature
    // backlog). COUNT is indexed via idx_facts_fence_key prefix.
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM facts
       WHERE source_id = $1 AND source_markdown_slug = $2 AND source LIKE $3`,
      [sourceId, slug, `${FRONTMATTER_FACTS_SOURCE_PREFIX}%`],
    );
    insertOutcomes = Number(rows[0]?.n ?? 0) === 0;
  }

  if (insertOutcomes) {
    const forCustomer = coerceFrontmatterString(frontmatter.for_customer).trim();
    const entitySlug = forCustomer.length > 0 ? forCustomer : null;

    // Best-effort embeddings so consolidate clustering / drift scoring see
    // vectors (fail-open exactly like the cycle phase: no gateway → NULL
    // embeddings, facts still land).
    let embeddings: (Float32Array | null)[] = outcomes.map(() => null);
    if (!opts.noEmbed) {
      try {
        const { embed, isAvailable } = await import('./ai/gateway.ts');
        if (isAvailable('embedding')) {
          const vecs = await embed(outcomes);
          if (vecs.length === outcomes.length) embeddings = vecs;
        }
      } catch {
        // fail-open: NULL embeddings
      }
    }

    const ins = await engine.insertFacts( // gbrain-allow-direct-insert: frontmatter key_outcomes ARE the system of record here; this projection mirrors them into the facts index (wipe-then-reinsert on import:% rows), exactly like the fence reconcile
      outcomes.map((fact, i) => ({
        fact,
        kind: 'fact' as const,
        entity_slug: entitySlug,
        visibility: 'world' as const,
        context: `key_outcomes: ${slug}`,
        source: FRONTMATTER_FACTS_SOURCE,
        ...(opts.effectiveDate ? { valid_from: opts.effectiveDate } : {}),
        embedding: embeddings[i],
        // Negative band: structurally collision-free vs fence rows.
        row_num: -(i + 1),
        source_markdown_slug: slug,
      })),
      { source_id: sourceId },
    );
    result.facts_inserted = ins.inserted;
  }

  // ── Timeline: frontmatter timeline entries ──────────────────
  const { entries, skipped } = extractFrontmatterTimeline(frontmatter);
  result.timeline_skipped = skipped;
  if (entries.length > 0) {
    result.timeline_inserted = await engine.addTimelineEntriesBatch(
      entries.map((e) => ({
        slug,
        date: e.date,
        source: FRONTMATTER_TIMELINE_SOURCE,
        summary: e.summary,
        detail: '',
        source_id: sourceId,
      })),
      { auditSite: 'import.frontmatter_promotion' },
    );
  }

  return result;
}

/** True when the frontmatter carries anything this module would promote. */
export function hasPromotableFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
): boolean {
  if (!frontmatter) return false;
  return (
    extractKeyOutcomes(frontmatter).length > 0 ||
    extractFrontmatterTimeline(frontmatter).entries.length > 0
  );
}
