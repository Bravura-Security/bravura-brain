/**
 * Cloudflare Access JWT authentication provider for `gbrain serve --http`.
 *
 * Cloudflare Access (self-hosted application mode) sits in front of the gbrain
 * HTTP MCP server. When a human user authenticates through the team's SSO
 * (Azure AD in this deployment), Cloudflare injects a signed JWT on every
 * request via the `Cf-Access-Jwt-Assertion` header. This module verifies that
 * JWT and maps the SSO identity to a gbrain scope + source isolation grant, so
 * human users do NOT need a hand-minted gbrain OAuth/bearer token.
 *
 * DUAL-MODE (wired in src/commands/serve-http.ts): when the
 * `Cf-Access-Jwt-Assertion` header is present the request takes this JWT path;
 * when absent it falls through to the existing OAuth/bearer path unchanged
 * (machine clients + internal/direct access keep working). A present-but-invalid
 * JWT FAILS CLOSED — it never falls through to the bearer path or to anon.
 *
 * Verification (RS256):
 *   - signature against the team's JWKS (`<team-domain>/cdn-cgi/access/certs`),
 *     fetched + cached with TTL and automatic key-id rotation (jose's
 *     createRemoteJWKSet handles cooldown + kid-miss re-fetch).
 *   - `iss` === `https://<team-domain>`
 *   - `aud` includes the configured Access application AUD
 *   - `exp` (and `nbf`/`iat` skew) via jose's standard claim checks.
 *
 * Identity → scope mapping (config-driven via GBRAIN_CF_ACCESS_GROUP_MAP):
 *   - Every authenticated user gets a DEFAULT of read `company` + write their
 *     own personal source (slug derived from the email local-part).
 *   - Any matching group ADDS its federated_read domains and MAY override the
 *     write source.
 *   - The personal source is JIT-created (DB-only) if it does not yet exist.
 *
 * The jose dependency is already in the tree (transitive via
 * @modelcontextprotocol/sdk); we pin it as a direct dependency in package.json.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { BrainEngine } from './engine.ts';
import type { AuthInfo } from './operations.ts';
import { isValidSourceId } from './source-id.ts';
import { addSource, SourceOpError } from './sources-ops.ts';

// ── Config ──────────────────────────────────────────────────────────────────

/** Header Cloudflare Access injects with the signed identity JWT. */
export const CF_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** Verified default team domain (env GBRAIN_CF_ACCESS_TEAM_DOMAIN). */
export const DEFAULT_CF_ACCESS_TEAM_DOMAIN = 'bravurasecurity.cloudflareaccess.com';

/** Verified default Access application AUD (env GBRAIN_CF_ACCESS_AUD). */
export const DEFAULT_CF_ACCESS_AUD =
  'f22ee20151e4be2ed6555ad7a9aa4dbaa46994b8c52981cfe51328560de43c48';

/** Default read domain every authenticated user gets (env GBRAIN_CF_ACCESS_DEFAULT_READ). */
export const DEFAULT_CF_ACCESS_DEFAULT_READ = 'company';

/** JWKS cache TTL in ms. jose re-fetches on kid-miss regardless of this. */
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_JWKS_COOLDOWN_MS = 30 * 1000; // 30s between forced re-fetches
const DEFAULT_JWKS_TIMEOUT_MS = 5 * 1000; // 5s fetch timeout

/**
 * One mapping entry. A group id/name resolves to (optionally) a write `source`
 * and a `federated_read` list that is UNION-ed into the user's read grant.
 */
export interface CfAccessGroupMapEntry {
  /** Override the write source for users in this group. */
  source?: string;
  /** Read domains to ADD to the user's federated_read for this group. */
  federated_read?: string[];
}

export type CfAccessGroupMap = Record<string, CfAccessGroupMapEntry>;

export interface CfAccessConfig {
  /** Cloudflare Access team domain, e.g. `bravurasecurity.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application AUD tag the JWT must carry. */
  aud: string;
  /** Default read source granted to every authenticated user. */
  defaultRead: string;
  /** Group id/name → scope-add mapping. */
  groupMap: CfAccessGroupMap;
  /** Whether the provider is enabled at all (header still required per-request). */
  enabled: boolean;
}

/**
 * Resolve the CF Access config from env, applying verified defaults.
 *
 * Env keys:
 *   - GBRAIN_CF_ACCESS_TEAM_DOMAIN  (default bravurasecurity.cloudflareaccess.com)
 *   - GBRAIN_CF_ACCESS_AUD          (default f22ee2...43c48)
 *   - GBRAIN_CF_ACCESS_DEFAULT_READ (default "company")
 *   - GBRAIN_CF_ACCESS_GROUP_MAP    (JSON object, default "{}")
 *   - GBRAIN_CF_ACCESS_ENABLED      ("0"/"false" to disable; default enabled)
 *
 * Fail-soft on a malformed GROUP_MAP: log-less return of `{}` so a bad env
 * value can never crash startup or silently widen access. (Defaults are the
 * fail-closed floor: read `company` + personal write source.)
 */
export function resolveCfAccessConfig(env: NodeJS.ProcessEnv = process.env): CfAccessConfig {
  const teamDomain = (env.GBRAIN_CF_ACCESS_TEAM_DOMAIN || DEFAULT_CF_ACCESS_TEAM_DOMAIN).trim();
  const aud = (env.GBRAIN_CF_ACCESS_AUD || DEFAULT_CF_ACCESS_AUD).trim();
  const defaultRead = (env.GBRAIN_CF_ACCESS_DEFAULT_READ || DEFAULT_CF_ACCESS_DEFAULT_READ).trim();
  const enabledRaw = (env.GBRAIN_CF_ACCESS_ENABLED ?? '').trim().toLowerCase();
  const enabled = !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'off');
  return {
    teamDomain,
    aud,
    defaultRead,
    groupMap: parseGroupMap(env.GBRAIN_CF_ACCESS_GROUP_MAP),
    enabled,
  };
}

/**
 * Parse GBRAIN_CF_ACCESS_GROUP_MAP JSON into a validated CfAccessGroupMap.
 * Drops malformed entries rather than throwing — a typo in one group entry
 * must not nuke the whole map (and never widens beyond the per-entry shape).
 */
export function parseGroupMap(raw: string | undefined): CfAccessGroupMap {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: CfAccessGroupMap = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const entry: CfAccessGroupMapEntry = {};
    if (typeof v.source === 'string' && isValidSourceId(v.source)) {
      entry.source = v.source;
    }
    if (Array.isArray(v.federated_read)) {
      entry.federated_read = v.federated_read.filter(
        (s): s is string => typeof s === 'string' && isValidSourceId(s),
      );
    }
    out[key] = entry;
  }
  return out;
}

// ── Slug derivation ───────────────────────────────────────────────────────

/**
 * Derive a gbrain personal-source slug from an email address.
 *
 * The local-part is lowercased, every run of non-alnum characters is collapsed
 * to a single hyphen, edge hyphens are stripped, and the result is truncated to
 * 32 chars (re-stripping any trailing hyphen the truncation exposed) so it
 * matches the canonical source_id regex `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`.
 *
 *   bart.allan@bravurasecurity.com  → "bart-allan"
 *   Jane.O'Brien+tag@example.com    → "jane-o-brien-tag"
 *
 * Returns null when no valid slug can be produced (empty local-part, or a
 * local-part with no alphanumerics) — the caller fails closed in that case.
 */
export function personalSourceSlug(email: string): string | null {
  const at = email.indexOf('@');
  const local = (at >= 0 ? email.slice(0, at) : email).toLowerCase();
  let slug = local
    .replace(/[^a-z0-9]+/g, '-') // non-alnum runs → single hyphen
    .replace(/^-+|-+$/g, ''); // strip edge hyphens
  if (slug.length > 32) {
    slug = slug.slice(0, 32).replace(/-+$/g, '');
  }
  return isValidSourceId(slug) ? slug : null;
}

// ── Verifier ────────────────────────────────────────────────────────────────

export interface CfAccessIdentity {
  /** Verified email claim (lowercased). */
  email: string;
  /** Group claim values, if present (optional; Azure-AD-via-Access varies). */
  groups: string[];
  /** The full verified payload (for debugging / future claims). */
  payload: JWTPayload;
}

export class CfAccessVerifyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_signature'
      | 'invalid_issuer'
      | 'invalid_audience'
      | 'expired'
      | 'missing_email'
      | 'malformed',
  ) {
    super(message);
    this.name = 'CfAccessVerifyError';
  }
}

export interface CfAccessVerifier {
  verify(token: string): Promise<CfAccessIdentity>;
}

/**
 * Extract the `groups` claim regardless of the exact shape Cloudflare/Azure
 * emits. Cloudflare Access usually carries SSO group identifiers under a
 * top-level `groups` array, but Azure-AD-via-Access deployments have been seen
 * to nest them under `custom.groups` or emit a single string. We accept:
 *   - `groups: string[]`            (the common case)
 *   - `groups: string`              (single group → one-element array)
 *   - `custom.groups: string[]`     (custom-claim mapping)
 * A MISSING groups claim yields `[]` — the user still gets the default
 * mapping (read `company` + personal write source), never a hard failure.
 */
export function extractGroups(payload: JWTPayload): string[] {
  const collect = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string');
    if (typeof v === 'string' && v.length > 0) return [v];
    return [];
  };
  const top = collect((payload as Record<string, unknown>).groups);
  if (top.length > 0) return top;
  const custom = (payload as Record<string, unknown>).custom;
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    return collect((custom as Record<string, unknown>).groups);
  }
  return [];
}

/**
 * Build a Cloudflare Access JWT verifier.
 *
 * The JWKS resolver defaults to jose's `createRemoteJWKSet` pointed at the
 * team's certs endpoint (TTL cache + kid rotation built in). Tests inject a
 * `getKey` override (a local key set) so verification runs offline.
 */
export function createCfAccessVerifier(
  config: CfAccessConfig,
  opts: { getKey?: JWTVerifyGetKey } = {},
): CfAccessVerifier {
  const issuer = `https://${config.teamDomain}`;
  const getKey =
    opts.getKey ??
    createRemoteJWKSet(new URL(`https://${config.teamDomain}/cdn-cgi/access/certs`), {
      cacheMaxAge: DEFAULT_JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: DEFAULT_JWKS_COOLDOWN_MS,
      timeoutDuration: DEFAULT_JWKS_TIMEOUT_MS,
    });

  return {
    async verify(token: string): Promise<CfAccessIdentity> {
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, getKey, {
          issuer,
          audience: config.aud,
          algorithms: ['RS256'],
        });
        payload = result.payload;
      } catch (e) {
        const code = (e as { code?: string }).code;
        // Map jose's documented error codes to our fail-closed buckets.
        if (code === 'ERR_JWT_EXPIRED') {
          throw new CfAccessVerifyError('Cloudflare Access JWT expired', 'expired');
        }
        if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
          const claim = (e as { claim?: string }).claim;
          if (claim === 'iss') {
            throw new CfAccessVerifyError('Cloudflare Access JWT issuer mismatch', 'invalid_issuer');
          }
          if (claim === 'aud') {
            throw new CfAccessVerifyError('Cloudflare Access JWT audience mismatch', 'invalid_audience');
          }
        }
        if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWKS_NO_MATCHING_KEY') {
          throw new CfAccessVerifyError('Cloudflare Access JWT signature invalid', 'invalid_signature');
        }
        throw new CfAccessVerifyError(
          `Cloudflare Access JWT verification failed: ${(e as Error).message}`,
          'malformed',
        );
      }

      const emailRaw = (payload as Record<string, unknown>).email;
      if (typeof emailRaw !== 'string' || emailRaw.length === 0) {
        throw new CfAccessVerifyError('Cloudflare Access JWT missing email claim', 'missing_email');
      }
      return {
        email: emailRaw.toLowerCase(),
        groups: extractGroups(payload),
        payload,
      };
    },
  };
}

// ── Identity → scope mapping ────────────────────────────────────────────────

export interface CfAccessScopeResolution {
  /** The user's write source (their personal source unless a group overrode it). */
  sourceId: string;
  /** Federated read grant (dedup'd union of default + personal + group reads). */
  allowedSources: string[];
  /** gbrain scopes — humans get read + write. */
  scopes: string[];
}

/**
 * Map a verified identity to a gbrain scope + source-isolation grant.
 *
 * Resolution:
 *   - write source defaults to the user's personal source (email slug);
 *     a matching group's `source` overrides it (last matching group wins).
 *   - federated_read starts at [defaultRead, personalSource] and UNION-s in
 *     every matching group's `federated_read` domains.
 *   - scopes are always ['read','write'] for an authenticated human.
 *
 * `personalSlug` is computed once by the caller (it's needed for JIT creation).
 */
export function resolveScopeForIdentity(
  identity: Pick<CfAccessIdentity, 'groups'>,
  personalSlug: string,
  config: Pick<CfAccessConfig, 'defaultRead' | 'groupMap'>,
): CfAccessScopeResolution {
  let writeSource = personalSlug;
  const reads = new Set<string>([config.defaultRead, personalSlug]);

  for (const group of identity.groups) {
    const entry = config.groupMap[group];
    if (!entry) continue;
    if (entry.source) writeSource = entry.source;
    for (const r of entry.federated_read ?? []) reads.add(r);
  }
  // The write source must always be readable.
  reads.add(writeSource);

  return {
    sourceId: writeSource,
    allowedSources: Array.from(reads),
    scopes: ['read', 'write'],
  };
}

// ── JIT source creation ─────────────────────────────────────────────────────

/**
 * Ensure a DB-only source exists, creating it if absent (JIT). Mirrors
 * `gbrain sources add <id>` with no --path/--url: a plain INSERT into the
 * `sources` table (sources-ops.ts addSource Path B). Idempotent — a concurrent
 * creation that loses the race (source_id_taken) is treated as success.
 */
export async function ensureSourceExists(
  engine: BrainEngine,
  sourceId: string,
  displayName?: string,
): Promise<void> {
  const existing = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (existing.length > 0) return;
  try {
    await addSource(engine, { id: sourceId, name: displayName ?? sourceId });
  } catch (e) {
    // Lost a creation race → the source now exists, which is what we wanted.
    if (e instanceof SourceOpError && e.code === 'source_id_taken') return;
    throw e;
  }
}

// ── End-to-end: header → AuthInfo ────────────────────────────────────────────

export interface CfAccessAuthResult {
  authInfo: AuthInfo;
  identity: CfAccessIdentity;
}

/**
 * Full JWT path: verify the assertion, derive the personal-source slug, JIT
 * the personal source, resolve scope, and produce an `AuthInfo` shaped exactly
 * like the OAuth path's so the /mcp handler builds the SAME OperationContext
 * (remote: true, scope read/write, sourceId = write source,
 * auth.allowedSources = federated-read list).
 *
 * Throws CfAccessVerifyError on any verification/identity failure so the caller
 * can fail closed (401) WITHOUT falling through to the bearer path.
 */
export async function authenticateCfAccess(
  engine: BrainEngine,
  verifier: CfAccessVerifier,
  config: CfAccessConfig,
  token: string,
): Promise<CfAccessAuthResult> {
  const identity = await verifier.verify(token);

  const personalSlug = personalSourceSlug(identity.email);
  if (!personalSlug) {
    throw new CfAccessVerifyError(
      `Cannot derive a valid source slug from email "${identity.email}"`,
      'missing_email',
    );
  }

  const resolution = resolveScopeForIdentity(identity, personalSlug, config);

  // JIT-create the personal write source (DB-only). If a group remapped the
  // write source to a shared/team source, that source is expected to already
  // exist (operator-provisioned) — we still ensure it so a fresh team source
  // is materialized on first login rather than 404-ing reads/writes.
  await ensureSourceExists(engine, resolution.sourceId, identity.email);

  const authInfo: AuthInfo = {
    token, // the raw assertion; carried for parity with the bearer AuthInfo shape
    clientId: `cf-access:${identity.email}`,
    clientName: identity.email,
    scopes: resolution.scopes,
    sourceId: resolution.sourceId,
    allowedSources: resolution.allowedSources,
  };

  return { authInfo, identity };
}
