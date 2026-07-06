/**
 * 2026-07 data-loss incident regression tests (sync jobs 4722 + 5649).
 *
 * Verified incident chain: put_page write-through committed pages only into
 * the autopilot pod's local checkout → the sidecar push failed silently →
 * pod restart fresh-cloned origin (losing the unpushed commits) → the DB
 * sync anchor pointed at a now-missing commit → "Sync anchor object missing
 * → full reimport" → performFullSync's delete-reconcile HARD-deleted every
 * page whose source_path file was absent from the fresh clone
 * (page_versions destroyed via ON DELETE CASCADE).
 *
 * Four defenses under test here:
 *   1. The reconcile SOFT-deletes by default (recoverable); --hard-reconcile
 *      restores the old destructive path.
 *   2. A full sync triggered by a MISSING anchor object skips the reconcile
 *      entirely (fresh-clone-behind-DB is expected, not evidence of deletion).
 *   3. Mass-delete circuit breaker: > max(20, 2% of active pages) stale pages
 *      in one sweep is refused unless --force-reconcile.
 *   4. Anchor-after-push: last_commit only advances to a commit reachable
 *      from a remote-tracking ref (a local-only commit demotes the anchor to
 *      the origin-reachable merge-base).
 * Plus the "ghost-write" fix: putPage onto a soft-deleted row resurrects it
 * (clears deleted_at) instead of updating a row the purge sweep will destroy.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SRC = 'testsrc-reconcile';

let engine: PGLiteEngine;
let repoPath: string;

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(dir: string): void {
  sh(dir, 'git init -b main');
  sh(dir, 'git config user.email "test@test.com"');
  sh(dir, 'git config user.name "Test"');
}

function writePage(dir: string, rel: string, title: string): void {
  writeFileSync(join(dir, rel), [
    '---',
    'type: concept',
    `title: ${title}`,
    '---',
    '',
    `Content for ${title}. Enough text to be a real page body.`,
  ].join('\n'));
}

async function pageRow(slug: string): Promise<{ slug: string; deleted_at: string | null } | null> {
  const rows = await engine.executeRaw<{ slug: string; deleted_at: string | null }>(
    `SELECT slug, deleted_at FROM pages WHERE source_id = $1 AND slug = $2`,
    [SRC, slug],
  );
  return rows[0] ?? null;
}

async function syncOpts(extra: Record<string, unknown> = {}) {
  const { performSync } = await import('../src/commands/sync.ts');
  return performSync(engine, {
    repoPath,
    sourceId: SRC,
    noPull: true,
    noEmbed: true,
    noExtract: true,
    ...extra,
  });
}

describe('2026-07 sync reconcile data-loss defenses', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    const sources = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = '${SRC}'`,
    );
    if (sources.length === 0) {
      await runSources(engine, ['add', SRC, '--no-federated']);
    }
    // resetPgliteState may keep the row but stale anchors from a prior test
    // would break isolation — always clear.
    await engine.executeRaw(`UPDATE sources SET last_commit = NULL, local_path = NULL WHERE id = '${SRC}'`);

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-'));
    initRepo(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('defense 1: reconcile SOFT-deletes stale pages (row + recovery window survive)', async () => {
    writePage(repoPath, 'topics/keep.md', 'Keep Page');
    writePage(repoPath, 'topics/reap.md', 'Reap Page');
    sh(repoPath, 'git add -A && git commit -m initial');
    const first = await syncOpts({ full: true });
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(first.added).toBe(2);

    unlinkSync(join(repoPath, 'topics/reap.md'));
    sh(repoPath, 'git add -A && git commit -m "remove reap"');

    const second = await syncOpts({ full: true });
    expect(second.deleted).toBe(1);

    // The reaped page's row SURVIVES with deleted_at set (soft delete) —
    // pre-fix it was a raw DELETE and page_versions cascaded away.
    const reaped = await pageRow('topics/reap');
    expect(reaped).not.toBeNull();
    expect(reaped!.deleted_at).not.toBeNull();
    // Restorable via the canonical restore path.
    const restored = await engine.restorePage(reaped!.slug, { sourceId: SRC });
    expect(restored).toBe(true);

    const kept = await pageRow('topics/keep');
    expect(kept).not.toBeNull();
    expect(kept!.deleted_at).toBeNull();
  }, 120_000);

  test('defense 1 escape hatch: --hard-reconcile hard-deletes (row gone)', async () => {
    writePage(repoPath, 'topics/keep.md', 'Keep Page');
    writePage(repoPath, 'topics/reap.md', 'Reap Page');
    sh(repoPath, 'git add -A && git commit -m initial');
    await syncOpts({ full: true });

    unlinkSync(join(repoPath, 'topics/reap.md'));
    sh(repoPath, 'git add -A && git commit -m "remove reap"');

    const second = await syncOpts({ full: true, hardReconcile: true });
    expect(second.deleted).toBe(1);
    const reaped = await pageRow('topics/reap');
    expect(reaped).toBeNull();
  }, 120_000);

  test('defense 2: anchor-object-missing full sync SKIPS the delete-reconcile', async () => {
    writePage(repoPath, 'topics/keep.md', 'Keep Page');
    writePage(repoPath, 'topics/ghost.md', 'Ghost Page');
    sh(repoPath, 'git add -A && git commit -m initial');
    await syncOpts({ full: true });

    // Simulate the incident: the page's backing file is gone from the working
    // tree (fresh clone lost the unpushed commit) AND the anchor points at a
    // commit that no longer exists anywhere.
    unlinkSync(join(repoPath, 'topics/ghost.md'));
    sh(repoPath, 'git add -A && git commit -m "clone is behind"');
    await engine.executeRaw(
      `UPDATE sources SET last_commit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' WHERE id = '${SRC}'`,
    );

    // Incremental sync path → cat-file fails → full reimport with
    // anchorMissing:true → reconcile skipped → ghost page SURVIVES, active.
    const result = await syncOpts({});
    expect(result.status).toBe('first_sync');
    expect(result.deleted).toBe(0);
    const ghost = await pageRow('topics/ghost');
    expect(ghost).not.toBeNull();
    expect(ghost!.deleted_at).toBeNull();
  }, 120_000);

  test('defense 3: mass-delete circuit breaker trips above max(20, 2%) and --force-reconcile overrides', async () => {
    const N = 25;
    for (let i = 0; i < N; i++) writePage(repoPath, `topics/page-${String(i).padStart(2, '0')}.md`, `Bulk Page ${i}`);
    sh(repoPath, 'git add -A && git commit -m initial');
    const first = await syncOpts({ full: true });
    expect(first.added).toBe(N);

    // Remove 22 of 25 → threshold = max(20, ceil(25*0.02)) = 20 → 22 > 20 trips.
    for (let i = 0; i < 22; i++) unlinkSync(join(repoPath, `topics/page-${String(i).padStart(2, '0')}.md`));
    sh(repoPath, 'git add -A && git commit -m "mass removal"');

    const tripped = await syncOpts({ full: true });
    expect(tripped.deleted).toBe(0);
    expect(tripped.reconcileSuppressed).toBe(22);
    const active = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
      [SRC],
    );
    expect(active[0].n).toBe(N); // nothing reaped

    // Explicit override proceeds (and still soft-deletes).
    const forced = await syncOpts({ full: true, forceReconcile: true });
    expect(forced.deleted).toBe(22);
    expect(forced.reconcileSuppressed).toBeUndefined();
    const stillActive = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
      [SRC],
    );
    expect(stillActive[0].n).toBe(3);
    const softDeleted = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL`,
      [SRC],
    );
    expect(softDeleted[0].n).toBe(22);
  }, 240_000);

  test('defense 4: last_commit anchor only advances to an origin-reachable commit', async () => {
    // Bare origin + working clone (upstream tracking configured by clone).
    const originPath = mkdtempSync(join(tmpdir(), 'gbrain-origin-'));
    const clonePath = mkdtempSync(join(tmpdir(), 'gbrain-clone-'));
    try {
      sh(originPath, 'git init --bare -b main');
      rmSync(clonePath, { recursive: true, force: true });
      sh(tmpdir(), `git clone "${originPath}" "${clonePath}"`);
      sh(clonePath, 'git config user.email "test@test.com"');
      sh(clonePath, 'git config user.name "Test"');
      mkdirSync(join(clonePath, 'topics'), { recursive: true });
      writePage(clonePath, 'topics/pushed.md', 'Pushed Page');
      sh(clonePath, 'git add -A && git commit -m pushed');
      sh(clonePath, 'git push -u origin main');
      const pushedSha = sh(clonePath, 'git rev-parse HEAD');

      repoPath = clonePath; // syncOpts() targets the clone from here on
      await syncOpts({ full: true });
      let anchor = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = '${SRC}'`,
      );
      // Pushed HEAD is origin-reachable → anchors normally.
      expect(anchor[0].last_commit).toBe(pushedSha);

      // Local-only commit (the incident's unpushed put_page write-through).
      writePage(clonePath, 'topics/unpushed.md', 'Unpushed Page');
      sh(clonePath, 'git add -A && git commit -m unpushed');
      const unpushedSha = sh(clonePath, 'git rev-parse HEAD');

      const result = await syncOpts({});
      expect(['synced', 'up_to_date']).toContain(result.status);
      anchor = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = '${SRC}'`,
      );
      // Anchor must NOT advance to the unpushed commit — it demotes to the
      // origin-reachable merge-base (== the pushed commit). A fresh clone can
      // always resolve this anchor, so anchor-missing can never fire from an
      // unpushed-commit restart again.
      expect(anchor[0].last_commit).toBe(pushedSha);
      expect(anchor[0].last_commit).not.toBe(unpushedSha);
      // The unpushed page still imported fine (anchor gating ≠ import gating).
      const unpushedPage = await pageRow('topics/unpushed');
      expect(unpushedPage).not.toBeNull();

      // After the push lands, the anchor self-heals to HEAD.
      sh(clonePath, 'git push origin main');
      await syncOpts({});
      anchor = await engine.executeRaw<{ last_commit: string | null }>(
        `SELECT last_commit FROM sources WHERE id = '${SRC}'`,
      );
      expect(anchor[0].last_commit).toBe(unpushedSha);
    } finally {
      rmSync(originPath, { recursive: true, force: true });
      if (clonePath !== repoPath) rmSync(clonePath, { recursive: true, force: true });
    }
  }, 240_000);

  test('ghost-write fix: putPage onto a soft-deleted row resurrects it', async () => {
    await engine.putPage('ghost-write-victim', {
      type: 'concept',
      title: 'Ghost Write Victim',
      compiled_truth: 'original body',
      timeline: '',
      frontmatter: {},
    }, { sourceId: SRC });

    const deleted = await engine.softDeletePage('ghost-write-victim', { sourceId: SRC });
    expect(deleted).not.toBeNull();

    // Pre-fix (job 4620 "docusign ghost-write"): this update landed on the
    // soft-deleted row WITHOUT clearing deleted_at — content silently written
    // to a page queued for the purge sweep.
    await engine.putPage('ghost-write-victim', {
      type: 'concept',
      title: 'Ghost Write Victim',
      compiled_truth: 'updated body after soft delete',
      timeline: '',
      frontmatter: {},
    }, { sourceId: SRC });

    const rows = await engine.executeRaw<{ deleted_at: string | null; compiled_truth: string }>(
      `SELECT deleted_at, compiled_truth FROM pages WHERE source_id = $1 AND slug = 'ghost-write-victim'`,
      [SRC],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].deleted_at).toBeNull(); // restore-on-write
    expect(rows[0].compiled_truth).toContain('updated body');
  }, 60_000);
});
