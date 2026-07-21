/**
 * v0.42.56.1 — CLI_ONLY dispatch reachability pin.
 *
 * A command whose implementation lives in handleCliOnly's switch is only
 * reachable if its name is ALSO in the CLI_ONLY set at the top of
 * src/cli.ts — dispatch checks the set before the switch, so a case
 * without a set entry is dead code that greets users with
 * "Unknown command". This bit `reconcile-links` (v0.20.0, unreachable
 * since the CLI_ONLY gate refactor) and then `reconcile-fences`
 * (v0.42.56.0, modeled on it).
 *
 * Source-scan pin, same posture as test/cli-exit-verdict-pin.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cliSource = readFileSync(join(import.meta.dir, '../src/cli.ts'), 'utf-8');

function parseCliOnlySet(src: string): Set<string> {
  const m = src.match(/const CLI_ONLY = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error('CLI_ONLY set literal not found in src/cli.ts');
  const names = Array.from(m[1].matchAll(/'([^']+)'/g)).map(x => x[1]);
  return new Set(names);
}

describe('CLI_ONLY dispatch reachability', () => {
  const cliOnly = parseCliOnlySet(cliSource);

  // Commands implemented as top-level cases in handleCliOnly's switch that
  // regressed to "Unknown command" at least once. Extend when adding a new
  // CLI-only command: the case label AND the CLI_ONLY entry ship together.
  for (const cmd of ['reconcile-links', 'reconcile-fences']) {
    test(`'${cmd}' has a handleCliOnly case AND a CLI_ONLY entry`, () => {
      expect(cliSource).toContain(`case '${cmd}':`);
      expect(cliOnly.has(cmd)).toBe(true);
    });
  }
});
