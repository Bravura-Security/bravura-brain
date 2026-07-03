/**
 * Per-type retrieval weights (inbox downweight).
 *
 * A post-fusion re-rank stage that multiplies each result's score by a
 * per-page-type weight. Motivated by the 2026-07 audit: `inbox`-typed pages
 * (raw connector intake — SF cases before distillation) are noisy and crowd
 * out curated content in retrieval. A DB-config weight lets operators tune
 * how hard each type is boosted or demoted WITHOUT re-authoring the pack.
 *
 * WEIGHTS SOURCE — DB config, NOT a pack schema field (locked decision,
 * REMEDIATION_PLAN_2026-07 conflict-resolution): `PageTypeSchema` is strict
 * Zod, and a pack field would couple ranking to pack version and add
 * upstream-merge friction. Keys are `search.type_weights.<type>` (e.g.
 * `search.type_weights.inbox`). Code defaults live in `DEFAULT_TYPE_WEIGHTS`;
 * anything not listed there resolves to 1.0 (no-op).
 *
 * Distinct in kind from the metadata-axis boosts (backlink / salience /
 * recency / graph): those are floor-ratio-gated so a weak page can't leapfrog
 * a strong hit. A type weight is NOT gated — a downweight must apply to EVERY
 * matching result (the whole point is to demote noisy `inbox` hits regardless
 * of their raw score); a floor gate would skip exactly the low-scoring inbox
 * rows we most want demoted.
 */

import type { SearchResult } from '../types.ts';

/**
 * Config-key prefix for per-type weights. A full key looks like
 * `search.type_weights.inbox`. Kept as a prefix (not a fixed key list like
 * SEARCH_MODE_CONFIG_KEYS) because the page-type set is pack-defined and
 * dynamic — the loader enumerates keys via `engine.listConfigKeys(prefix)`.
 */
export const TYPE_WEIGHTS_CONFIG_PREFIX = 'search.type_weights.';

/**
 * Code defaults. `inbox` is downweighted to 0.4 (audit: raw connector intake
 * crowds out curated content). Every other type resolves to the implicit 1.0
 * (no-op) unless a config key overrides it. Frozen so a caller can't mutate
 * the shared default map.
 */
export const DEFAULT_TYPE_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  inbox: 0.4,
});

/**
 * Sanity bounds for a config-supplied weight. 0 is allowed (fully suppress a
 * type's score contribution); the upper cap mirrors `title_boost`'s 5.0 clamp
 * so a fat-fingered config can't make one type dominate everything. Values
 * outside [0, 5] are ignored (fall through to the code default / 1.0).
 */
const MIN_TYPE_WEIGHT = 0;
const MAX_TYPE_WEIGHT = 5;

/**
 * Load the EFFECTIVE per-type weight map: code defaults merged under any
 * `search.type_weights.<type>` config overrides. Only types with a non-1.0
 * effective weight need to appear; the apply stage treats a missing type as
 * 1.0. But we return the merged map (defaults + overrides) so callers see the
 * full effective picture (and so the cache fingerprint is stable).
 *
 * One `listConfigKeys` round-trip + one `getConfig` per matching key. Volume
 * is tiny (a handful of downweighted types at most). Errors fall through to
 * the code defaults — matching `loadSearchModeConfig`'s silent-fallback shape
 * (the config table may not exist on very old brains).
 *
 * A config value of exactly 1.0 is honored as an explicit override — it lets
 * an operator neutralize the built-in `inbox=0.4` default without unsetting
 * the key.
 */
export async function loadTypeWeights(engine: {
  listConfigKeys(prefix: string): Promise<string[]>;
  getConfig(key: string): Promise<string | null>;
}): Promise<Record<string, number>> {
  const merged: Record<string, number> = { ...DEFAULT_TYPE_WEIGHTS };
  let keys: string[];
  try {
    keys = await engine.listConfigKeys(TYPE_WEIGHTS_CONFIG_PREFIX);
  } catch {
    return merged;
  }
  await Promise.all(
    keys.map(async (key) => {
      const type = key.slice(TYPE_WEIGHTS_CONFIG_PREFIX.length);
      if (type.length === 0) return; // guard the bare prefix, if it ever exists
      let raw: string | null;
      try {
        raw = await engine.getConfig(key);
      } catch {
        return;
      }
      if (typeof raw !== 'string') return;
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= MIN_TYPE_WEIGHT && n <= MAX_TYPE_WEIGHT) {
        merged[type] = n;
      }
    }),
  );
  return merged;
}

/**
 * A stable, order-independent fingerprint of the effective weight map, folded
 * into `knobsHash` so a config change to any type weight invalidates cached
 * rankings. Only NON-1.0 entries participate — a type at 1.0 is a no-op and
 * must NOT change the hash (otherwise adding a redundant `foo=1.0` key would
 * needlessly cold-miss the whole cache). Sorted by type for determinism;
 * 4-decimal precision so 0.4 and 0.41 fingerprint distinctly.
 *
 * Returns 'none' when every effective weight is 1.0, so a brain with the
 * built-in default neutralized hashes identically to a brain with no weights
 * configured (both are pure no-ops at query time).
 */
export function typeWeightsFingerprint(weights: Record<string, number>): string {
  const parts = Object.keys(weights)
    .filter((t) => weights[t] !== 1.0 && Number.isFinite(weights[t]))
    .sort()
    .map((t) => `${t}=${weights[t].toFixed(4)}`);
  return parts.length === 0 ? 'none' : parts.join(',');
}

/**
 * Apply the per-type weight stage: multiply each result's score by its type's
 * effective weight. Mutate-in-place; caller re-sorts. A type absent from the
 * map (or a weight of exactly 1.0) is a no-op — no score change, no stamp.
 *
 * NOT floor-ratio-gated (see module header): a downweight must reach every
 * matching result. `base_score` (stamped at runPostFusionStages entry) is not
 * touched, preserving the agent's dedup/evidence signal.
 */
export function applyTypeWeight(
  results: SearchResult[],
  weights: Record<string, number>,
): void {
  if (results.length === 0) return;
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    const w = weights[r.type];
    if (w === undefined || w === 1.0 || !Number.isFinite(w)) continue;
    r.score *= w;
    r.type_weight = w; // attribution stamp (v0.40.4 convention)
  }
}
