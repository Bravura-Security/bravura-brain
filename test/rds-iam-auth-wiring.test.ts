/**
 * Static-shape wiring guard: every postgres.js client construction site
 * must route its URL through maybeApplyIamAuth so GBRAIN_DB_IAM_AUTH=1
 * covers ALL pools (module singleton, connection-manager read + direct,
 * postgres-engine instance). Migrations run on these same pools, so the
 * migrate path is covered transitively.
 *
 * Same pattern as test/autopilot-fanout-wiring.test.ts: the construction
 * sites are deep inside connect paths that need a live Postgres to
 * integration-test, so we pin the source shape instead. If a refactor adds
 * a fifth `postgres(...)` construction site without IAM wiring, the count
 * assertions here fail first.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = (rel: string) => readFileSync(join(import.meta.dir, '..', 'src', rel), 'utf8');

const DB_SRC = SRC('core/db.ts');
const CM_SRC = SRC('core/connection-manager.ts');
const PE_SRC = SRC('core/postgres-engine.ts');

/** Count postgres.js CLIENT constructions (calls like `postgres(<url>, opts)`),
 * excluding regex literals / comments that merely mention `postgres(`. */
function constructionSites(src: string): string[] {
  return src.split('\n').filter(line =>
    /(?:=|return)\s*postgres\(/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'),
  );
}

describe('RDS IAM auth wiring — db.ts (module singleton)', () => {
  test('imports maybeApplyIamAuth from rds-iam-auth.ts', () => {
    expect(DB_SRC).toMatch(/import\s+\{[^}]*maybeApplyIamAuth[^}]*\}\s+from\s+'\.\/rds-iam-auth\.ts'/);
  });

  test('the singleton construction routes through maybeApplyIamAuth', () => {
    expect(DB_SRC).toMatch(/const effectiveUrl = maybeApplyIamAuth\(url, opts\);\s*\n\s*sql = postgres\(effectiveUrl, opts\)/);
  });

  test('every construction site in db.ts is IAM-wired', () => {
    const sites = constructionSites(DB_SRC);
    expect(sites.length).toBe(1);
    // The wired form uses effectiveUrl produced by maybeApplyIamAuth.
    expect(sites[0]).toContain('postgres(effectiveUrl, opts)');
  });
});

describe('RDS IAM auth wiring — connection-manager.ts (read + direct pools)', () => {
  test('imports maybeApplyIamAuth from rds-iam-auth.ts', () => {
    expect(CM_SRC).toMatch(/import\s+\{[^}]*maybeApplyIamAuth[^}]*\}\s+from\s+'\.\/rds-iam-auth\.ts'/);
  });

  test('both pool constructions wrap their URL in maybeApplyIamAuth', () => {
    const sites = constructionSites(CM_SRC);
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site).toContain('postgres(maybeApplyIamAuth(');
    }
  });
});

describe('RDS IAM auth wiring — postgres-engine.ts (instance pool)', () => {
  test('imports maybeApplyIamAuth from rds-iam-auth.ts', () => {
    expect(PE_SRC).toMatch(/import\s+\{[^}]*maybeApplyIamAuth[^}]*\}\s+from\s+'\.\/rds-iam-auth\.ts'/);
  });

  test('the instance pool construction wraps its URL in maybeApplyIamAuth', () => {
    const sites = constructionSites(PE_SRC);
    expect(sites.length).toBe(1);
    expect(sites[0]).toContain('postgres(maybeApplyIamAuth(url, opts), opts)');
  });
});

describe('RDS IAM auth wiring — no unwired construction sites anywhere', () => {
  test('postgres is only imported by the three wired core modules', () => {
    // If a new module starts constructing its own postgres.js client, it
    // must import + wire maybeApplyIamAuth and extend this guard.
    const wired = ['core/db.ts', 'core/connection-manager.ts', 'core/postgres-engine.ts'];
    for (const rel of wired) {
      expect(SRC(rel)).toMatch(/from 'postgres'/);
    }
  });
});
