/**
 * v0.42.56.0 — reconcile-fences batch command.
 *
 * Repairs fence drift: facts rows whose fence stamps say "row N of
 * page P's `## Facts` fence" (`row_num > 0` + `source_markdown_slug`)
 * but whose fence row is absent from the materialized checkout — the
 * page file is missing entirely, or the file exists without the row.
 *
 * How drift arises: fence writes that landed on a filesystem the
 * source's checkout never sees (an ephemeral pod clone, a since-reset
 * worktree). The DB rows are the surviving copy, so the repair
 * direction is DB → disk: re-render the missing rows into the fence,
 * preserving their existing row_nums. No DB writes — the stamps are
 * already correct; only the markdown is behind.
 *
 * Scope contract (mirrors the v51 keyspace split):
 *   - `row_num > 0`  — fence-owned rows. Only these are checked/repaired.
 *   - `row_num < 0`  — import:-origin frontmatter-promotion rows
 *     (src/core/frontmatter-promotion.ts). NOT fence-owned; never
 *     appear in a fence; excluded here exactly as the extract_facts
 *     wipe excludes them.
 *   - `row_num IS NULL` — legacy keyspace, owned by the v0_32_2
 *     backfill, not this command.
 *
 * Merge posture (fence stays canonical):
 *   - Disk rows that match a DB row_num keep their disk form verbatim
 *     (hand-edits like strikethrough survive).
 *   - Disk rows with row_nums the DB doesn't know are disk-ahead
 *     (extraction pending), kept untouched.
 *   - A disk row whose row_num matches a DB row but whose claim text
 *     differs is a conflict: the page is skipped and reported for
 *     operator triage — never overwritten.
 *
 * Missing files are materialized from the DB page (frontmatter +
 * compiled_truth + timeline via serializeMarkdown — same primitive as
 * phantom-redirect's materializeCanonicalToDisk) so a later `gbrain
 * sync` re-imports the full page, not a stub that would clobber the
 * DB body.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { BrainEngine } from '../core/engine.ts';
import {
  parseFactsFence,
  renderFactsTable,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
  type FactKind,
  type FactVisibility,
  type FactNotability,
} from '../core/facts-fence.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { withPageLock } from '../core/page-lock.ts';
import { createProgress } from '../core/progress.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

// ── Types ───────────────────────────────────────────────────

interface FenceOwnedRow {
  id: string;
  source_id: string;
  slug: string;
  row_num: number;
  fact: string;
  kind: FactKind;
  visibility: FactVisibility;
  notability: FactNotability;
  context: string | null;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  expired_at: Date | string | null;
  superseded_by: string | null;
  source: string | null;
  confidence: number;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
}

export type DriftKind = 'file_missing' | 'fence_gap' | 'conflict';

export interface DriftedPage {
  sourceId: string;
  slug: string;
  kind: DriftKind;
  dbRows: number;
  fenceRows: number;
  missingRowNums: number[];
  conflictRowNums: number[];
}

export interface SourceDriftSummary {
  sourceId: string;
  localPath: string | null;
  checkoutPresent: boolean;
  pagesChecked: number;
  pagesOk: number;
  pagesDrifted: number;
  fileMissing: number;
  fenceGap: number;
  conflict: number;
  /** Fenced pages that couldn't be checked (checkout absent on this host). */
  unverifiable: number;
}

export interface FenceDriftReport {
  sources: SourceDriftSummary[];
  drifted: DriftedPage[];
}

// ── Detection ───────────────────────────────────────────────

function normalizeCell(s: string): string {
  // Fence cells can't hold newlines and render pipes escaped; normalize
  // both sides of a claim comparison the same way the renderer flattens.
  return s.replace(/\s+/g, ' ').trim();
}

function toIsoDate(v: Date | string | null): string | undefined {
  if (v === null || v === undefined) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
}

/**
 * Map a DB fence-owned row back to its fence-row form. Inverse of
 * extract-from-fence.ts within the fence's representable columns:
 * struck when the DB marks the row superseded / expired / forgotten,
 * active otherwise. Context is preserved verbatim so the strikethrough
 * semantics (`superseded by #N` / `forgotten:`) round-trip.
 */
export function dbRowToParsedFact(row: FenceOwnedRow): ParsedFact {
  const context = row.context ?? undefined;
  const forgotten = context !== undefined && /^forgotten\s*:/i.test(context.trim());
  const active = row.superseded_by === null && row.expired_at === null && !forgotten;
  return {
    rowNum: row.row_num,
    claim: normalizeCell(row.fact),
    kind: row.kind,
    confidence: row.confidence,
    visibility: row.visibility,
    notability: row.notability,
    validFrom: toIsoDate(row.valid_from),
    validUntil: toIsoDate(row.valid_until),
    source: row.source ?? undefined,
    context: context !== undefined ? normalizeCell(context) : undefined,
    active,
    forgotten: !active && forgotten,
    claimMetric: row.claim_metric ?? undefined,
    claimValue: row.claim_value ?? undefined,
    claimUnit: row.claim_unit ?? undefined,
    claimPeriod: row.claim_period ?? undefined,
  };
}

function classifyPage(
  dbRows: FenceOwnedRow[],
  fileExists: boolean,
  body: string | null,
): { kind: DriftKind | 'ok'; fenceRows: number; missing: number[]; conflicts: number[] } {
  if (!fileExists) {
    return { kind: 'file_missing', fenceRows: 0, missing: dbRows.map(r => r.row_num), conflicts: [] };
  }
  const parsed = parseFactsFence(body ?? '');
  const byRowNum = new Map(parsed.facts.map(f => [f.rowNum, f]));
  const missing: number[] = [];
  const conflicts: number[] = [];
  for (const row of dbRows) {
    const disk = byRowNum.get(row.row_num);
    if (!disk) {
      missing.push(row.row_num);
    } else if (normalizeCell(disk.claim) !== normalizeCell(row.fact)) {
      conflicts.push(row.row_num);
    }
    // Same row_num + same claim = present; disk form wins (hand-edits kept).
  }
  if (conflicts.length > 0) return { kind: 'conflict', fenceRows: parsed.facts.length, missing, conflicts };
  if (missing.length > 0) return { kind: 'fence_gap', fenceRows: parsed.facts.length, missing, conflicts };
  return { kind: 'ok', fenceRows: parsed.facts.length, missing, conflicts };
}

/**
 * Walk every fence-owned row (`row_num > 0`) and compare each page's
 * fence on disk against the DB stamps. Shared by the CLI command and
 * the `facts_fence_drift` doctor check.
 */
export async function detectFenceDrift(
  engine: BrainEngine,
  opts: { sourceId?: string } = {},
): Promise<FenceDriftReport> {
  const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources`,
  );
  const localPathById = new Map(sources.map(s => [s.id, s.local_path]));

  const params: unknown[] = [];
  let where = `row_num > 0`;
  if (opts.sourceId) {
    params.push(opts.sourceId);
    where += ` AND source_id = $1`;
  }
  const rows = await engine.executeRaw<FenceOwnedRow>(
    `SELECT id, source_id, source_markdown_slug AS slug, row_num, fact, kind,
            visibility, notability, context, valid_from, valid_until,
            expired_at, superseded_by, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period
       FROM facts
      WHERE ${where}
      ORDER BY source_id, source_markdown_slug, row_num`,
    params,
  );

  const pages = new Map<string, FenceOwnedRow[]>();
  for (const row of rows) {
    // row_num is set with source_markdown_slug in every writer; guard anyway.
    if (!row.slug) continue;
    const key = `${row.source_id}\0${row.slug}`;
    const list = pages.get(key) ?? [];
    list.push(row);
    pages.set(key, list);
  }

  const summaries = new Map<string, SourceDriftSummary>();
  const summaryFor = (sourceId: string): SourceDriftSummary => {
    let s = summaries.get(sourceId);
    if (!s) {
      const localPath = localPathById.get(sourceId) ?? null;
      s = {
        sourceId,
        localPath,
        checkoutPresent: localPath !== null && existsSync(localPath),
        pagesChecked: 0,
        pagesOk: 0,
        pagesDrifted: 0,
        fileMissing: 0,
        fenceGap: 0,
        conflict: 0,
        unverifiable: 0,
      };
      summaries.set(sourceId, s);
    }
    return s;
  };

  const drifted: DriftedPage[] = [];
  for (const [key, dbRows] of pages) {
    const [sourceId, slug] = key.split('\0');
    const summary = summaryFor(sourceId);
    if (!summary.localPath || !summary.checkoutPresent) {
      // Checkout materialized on another host (split topology) — a missing
      // file here is an environment limitation, not drift.
      summary.unverifiable += 1;
      continue;
    }
    const filePath = join(summary.localPath, `${slug}.md`);
    const fileExists = existsSync(filePath);
    const body = fileExists ? readFileSync(filePath, 'utf-8') : null;
    const cls = classifyPage(dbRows, fileExists, body);
    summary.pagesChecked += 1;
    if (cls.kind === 'ok') {
      summary.pagesOk += 1;
      continue;
    }
    summary.pagesDrifted += 1;
    if (cls.kind === 'file_missing') summary.fileMissing += 1;
    else if (cls.kind === 'fence_gap') summary.fenceGap += 1;
    else summary.conflict += 1;
    drifted.push({
      sourceId,
      slug,
      kind: cls.kind,
      dbRows: dbRows.length,
      fenceRows: cls.fenceRows,
      missingRowNums: cls.missing,
      conflictRowNums: cls.conflicts,
    });
  }

  return { sources: Array.from(summaries.values()), drifted };
}

// ── Repair ──────────────────────────────────────────────────

/** Replace (or append) the `## Facts` fence with the given full row set. */
function replaceFactsFence(body: string, facts: ParsedFact[]): string {
  const newFence = renderFactsTable(facts);
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  if (beginIdx !== -1 && endIdx !== -1) {
    return body.slice(0, beginIdx) + newFence + body.slice(endIdx + FACTS_FENCE_END.length);
  }
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  return `${body}${sep}## Facts\n\n${newFence}\n`;
}

/**
 * Dirty-tree refusal, same posture as the v0_32_2 backfill (mirrors
 * src/core/dry-fix.ts): refuse to write into a checkout with
 * uncommitted changes unless the caller opts out (--allow-dirty, for
 * workspaces where a sync sidecar owns the commit loop).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo / git absent → the user opted out of git tracking;
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

export interface ReconcileFencesResult {
  status: 'ok' | 'dirty_tree';
  dirtySource?: string;
  pagesChecked: number;
  pagesRepaired: number;
  rowsRestored: number;
  pagesMaterialized: number;
  conflicts: DriftedPage[];
  failedPages: string[];
  unverifiable: number;
  sources: SourceDriftSummary[];
}

export interface ReconcileFencesOpts {
  sourceId?: string;
  dryRun?: boolean;
  allowDirty?: boolean;
}

async function materializePageBody(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
): Promise<string> {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) {
    // No DB page either — minimal stub so the fence has somewhere to land
    // (same fallback as phantom-redirect's materializeCanonicalToDisk).
    const title = slug.split('/').pop() ?? slug;
    return serializeMarkdown({}, `# ${title}\n`, '', { type: 'concept', title, tags: [] });
  }
  const tags = await engine.getTags(slug, { sourceId });
  return serializeMarkdown(
    page.frontmatter ?? {},
    page.compiled_truth ?? '',
    page.timeline ?? '',
    { type: page.type, title: page.title, tags },
  );
}

/**
 * Detect + repair fence drift. Idempotent: repaired pages classify as
 * `ok` on the next run; conflicts are never auto-resolved.
 */
export async function runReconcileFences(
  engine: BrainEngine,
  opts: ReconcileFencesOpts = {},
): Promise<ReconcileFencesResult> {
  const report = await detectFenceDrift(engine, { sourceId: opts.sourceId });

  const result: ReconcileFencesResult = {
    status: 'ok',
    pagesChecked: report.sources.reduce((a, s) => a + s.pagesChecked, 0),
    pagesRepaired: 0,
    rowsRestored: 0,
    pagesMaterialized: 0,
    conflicts: report.drifted.filter(d => d.kind === 'conflict'),
    failedPages: [],
    unverifiable: report.sources.reduce((a, s) => a + s.unverifiable, 0),
    sources: report.sources,
  };

  const repairable = report.drifted.filter(d => d.kind !== 'conflict');
  if (repairable.length === 0 || opts.dryRun) return result;

  // Dirty-tree refusal across every source we're about to write into.
  if (!opts.allowDirty) {
    const touchedSources = new Set(repairable.map(d => d.sourceId));
    for (const s of report.sources) {
      if (!touchedSources.has(s.sourceId) || !s.localPath) continue;
      if (isLocalPathDirty(s.localPath)) {
        result.status = 'dirty_tree';
        result.dirtySource = `${s.sourceId} (${s.localPath})`;
        return result;
      }
    }
  }

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('reconcile_fences.repair', repairable.length);

  const localPathById = new Map(report.sources.map(s => [s.sourceId, s.localPath]));

  for (const page of repairable) {
    const localPath = localPathById.get(page.sourceId);
    if (!localPath) {
      progress.tick(1, page.slug);
      continue;
    }
    const filePath = join(localPath, `${page.slug}.md`);
    const tmpPath = `${filePath}.tmp`;
    try {
      await withPageLock(page.slug, async () => {
        // Re-fetch the DB rows for just this page (small; keeps the lock
        // window honest against concurrent fence writers).
        const dbRows = await engine.executeRaw<FenceOwnedRow>(
          `SELECT id, source_id, source_markdown_slug AS slug, row_num, fact, kind,
                  visibility, notability, context, valid_from, valid_until,
                  expired_at, superseded_by, source, confidence,
                  claim_metric, claim_value, claim_unit, claim_period
             FROM facts
            WHERE row_num > 0 AND source_id = $1 AND source_markdown_slug = $2
            ORDER BY row_num`,
          [page.sourceId, page.slug],
        );

        let body: string;
        let materialized = false;
        if (existsSync(filePath)) {
          body = readFileSync(filePath, 'utf-8');
        } else {
          body = await materializePageBody(engine, page.sourceId, page.slug);
          materialized = true;
        }

        // Merge: disk rows win at their row_nums; DB rows fill the gaps.
        const parsed = parseFactsFence(body);
        const byRowNum = new Map(parsed.facts.map(f => [f.rowNum, f]));
        let restored = 0;
        for (const row of dbRows) {
          const disk = byRowNum.get(row.row_num);
          if (disk) {
            if (normalizeCell(disk.claim) !== normalizeCell(row.fact)) {
              // Conflict surfaced between detection and repair — bail on
              // this page rather than overwrite.
              throw new Error(`row ${row.row_num} claim conflict (disk vs DB)`);
            }
            continue;
          }
          byRowNum.set(row.row_num, dbRowToParsedFact(row));
          restored += 1;
        }
        if (restored === 0 && !materialized) return; // nothing to do (raced a concurrent repair)

        const merged = Array.from(byRowNum.values()).sort((a, b) => a.rowNum - b.rowNum);
        const newBody = replaceFactsFence(body, merged);

        // Atomic write: .tmp + re-parse + rename. On a failed re-parse the
        // .tmp is removed (checkouts with auto-commit sidecars would
        // otherwise commit the quarantine file).
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(tmpPath, newBody, 'utf-8');
        const reparsed = parseFactsFence(readFileSync(tmpPath, 'utf-8'));
        if (reparsed.warnings.length > 0) {
          unlinkSync(tmpPath);
          throw new Error(`re-parse failed: ${reparsed.warnings.join('; ')}`);
        }
        renameSync(tmpPath, filePath);

        result.pagesRepaired += 1;
        result.rowsRestored += restored;
        if (materialized) result.pagesMaterialized += 1;
      });
    } catch (e) {
      result.failedPages.push(`${page.slug} (${e instanceof Error ? e.message : String(e)})`);
    }
    progress.tick(1, page.slug);
  }

  progress.finish();
  return result;
}

// ── CLI entry ───────────────────────────────────────────────

export async function runReconcileFencesCli(engine: BrainEngine, args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const jsonOut = args.includes('--json');
  const allowDirty = args.includes('--allow-dirty');
  const srcIdx = args.indexOf('--source');
  const sourceId = srcIdx >= 0 && srcIdx + 1 < args.length ? args[srcIdx + 1] : undefined;

  const result = await runReconcileFences(engine, { sourceId, dryRun, allowDirty });

  if (jsonOut) {
    console.log(JSON.stringify(result));
    if (result.status === 'dirty_tree' || result.failedPages.length > 0) setCliExitVerdict(1);
    return;
  }

  if (result.status === 'dirty_tree') {
    console.log(
      `reconcile-fences: refusing to write — ${result.dirtySource} has uncommitted changes. ` +
      `Commit or stash, then re-run (or pass --allow-dirty if a sync sidecar owns the commit loop).`,
    );
    setCliExitVerdict(1);
    return;
  }

  const header = dryRun ? 'reconcile-fences (dry run)' : 'reconcile-fences';
  const driftedTotal = result.sources.reduce((a, s) => a + s.pagesDrifted, 0);
  console.log(
    `${header}: checked ${result.pagesChecked} fenced pages` +
    (dryRun
      ? `, ${driftedTotal} drifted`
      : `, repaired ${result.pagesRepaired} (${result.rowsRestored} rows restored, ` +
        `${result.pagesMaterialized} pages materialized from DB)`) +
    (result.conflicts.length > 0 ? `, ${result.conflicts.length} conflicts need triage` : '') +
    (result.unverifiable > 0 ? `, ${result.unverifiable} unverifiable (checkout on another host)` : ''),
  );
  for (const s of result.sources) {
    console.log(
      `  ${s.sourceId}: checked=${s.pagesChecked} ok=${s.pagesOk} drifted=${s.pagesDrifted} ` +
      `(file_missing=${s.fileMissing} fence_gap=${s.fenceGap} conflict=${s.conflict})` +
      (s.unverifiable > 0 ? ` unverifiable=${s.unverifiable}` : ''),
    );
  }
  for (const c of result.conflicts.slice(0, 10)) {
    console.log(`  CONFLICT ${c.sourceId}/${c.slug}: rows ${c.conflictRowNums.join(',')} differ between disk and DB`);
  }
  for (const f of result.failedPages.slice(0, 10)) {
    console.log(`  FAILED ${f}`);
  }
  if (result.failedPages.length > 0) setCliExitVerdict(1);
}
