/**
 * RDS IAM database authentication for the postgres.js pools.
 *
 * Opt-in via env `GBRAIN_DB_IAM_AUTH=1` — deliberately NOT a URL scheme:
 * the codebase's `postgres(ql)?://` regexes (url-redact, connection-manager
 * derive/detect, config source classification) all assume a plain postgres
 * URL, so a custom scheme would fight every one of them. With the flag set,
 * the URL password is stripped/ignored and each new backend connection
 * authenticates with a short-lived IAM auth token minted via
 * `@aws-sdk/rds-signer` (credentials come from the default AWS provider
 * chain — IRSA in the gbrain pod, SSO/profile locally).
 *
 * Wiring contract (guarded by test/rds-iam-auth-wiring.test.ts): every
 * `postgres(url, opts)` construction site routes through
 * `maybeApplyIamAuth(url, opts)` so the flag covers ALL pools — the db.ts
 * module singleton, the connection-manager read + direct pools, and the
 * postgres-engine instance pool. Migrations run on those same pools, so the
 * migrate path is covered by construction.
 *
 * Token lifecycle: RDS auth tokens are valid for 15 minutes. postgres.js
 * calls the async `pass` callback once per NEW backend connection (verified
 * against postgres@3.4.9 — connection.js resolves `options.pass()` at
 * password-message time), so we cache the minted token per host/port/user
 * and refresh when it's older than TOKEN_CACHE_TTL_MS (10 min), keeping a
 * 5-minute safety margin under the 15-minute expiry.
 *
 * TLS: RDS rejects IAM-token authentication over cleartext connections, so
 * when the flag is on we default `ssl: 'require'` (encrypted; postgres.js
 * maps it to rejectUnauthorized:false — acceptable in-VPC). For full CA
 * verification set `GBRAIN_DB_SSL_CA_FILE=/path/to/rds-bundle.pem`; the CA
 * bundle is read at pool-construction time and passed as a tls option
 * object. An explicit `?sslmode=` on the URL or a caller-provided
 * `opts.ssl` wins over both defaults.
 */

import { readFileSync } from 'node:fs';

export const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000; // refresh at 10min; token lives 15min

/** Flag check. '1' or 'true' (case-insensitive) enable IAM auth. */
export function isIamAuthEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.GBRAIN_DB_IAM_AUTH;
  return raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true');
}

export interface PgEndpoint {
  host: string;
  port: number;
  user: string;
}

/**
 * Parse host/port/user out of a postgres URL. Same http:// re-scheme trick
 * as resolvePrepare/isSupabasePoolerUrl so WHATWG URL accepts it.
 * Port defaults to 5432; user defaults to '' (signer will reject later,
 * which is the right failure — IAM auth needs an explicit user).
 */
export function parsePgEndpoint(url: string): PgEndpoint {
  const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
  return {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username || ''),
  };
}

/**
 * Region resolution: explicit env wins; otherwise derive from the RDS
 * hostname (`*.<region>.rds.amazonaws.com`). Returns null when neither
 * yields a region — mint fails loudly with remediation in that case.
 */
export function resolveRegion(
  host: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const fromEnv = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (fromEnv) return fromEnv;
  const m = host.match(/\.([a-z]{2}(?:-[a-z]+)+-\d+)\.rds\.amazonaws\.com$/i);
  return m ? m[1]! : null;
}

/**
 * Strip the password component from a postgres URL, preserving everything
 * else byte-for-byte (no WHATWG re-serialization — that can re-encode
 * search params and usernames). No-op when the URL has no password.
 */
export function stripUrlPassword(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:@/?#]*):[^@]*@/i, '$1@');
}

interface CacheEntry {
  token: string;
  mintedAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

/** Test hook — clear the module-level token cache between test cases. */
export function _resetIamTokenCacheForTests(): void {
  tokenCache.clear();
}

/** Injectable minter so unit tests don't need AWS credentials. */
export type TokenMinter = (endpoint: PgEndpoint, region: string) => Promise<string>;

async function defaultMinter(endpoint: PgEndpoint, region: string): Promise<string> {
  // Lazy import keeps the AWS SDK off the cold path for every non-IAM run
  // (the flag is opt-in; most installs never take this branch).
  const { Signer } = await import('@aws-sdk/rds-signer');
  const signer = new Signer({
    hostname: endpoint.host,
    port: endpoint.port,
    username: endpoint.user,
    region,
  });
  return signer.getAuthToken();
}

/**
 * Mint (or return cached) RDS IAM auth token for an endpoint. Cached per
 * host:port:user for TOKEN_CACHE_TTL_MS. Never caches failures — a throw
 * propagates to postgres.js's connect path, which surfaces it as a
 * connection error (retryable via connectWithRetry).
 */
export async function getIamAuthToken(
  endpoint: PgEndpoint,
  opts: { minter?: TokenMinter; now?: () => number; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const key = `${endpoint.host}:${endpoint.port}:${endpoint.user}`;
  const cached = tokenCache.get(key);
  if (cached && now() - cached.mintedAt < TOKEN_CACHE_TTL_MS) {
    return cached.token;
  }
  const region = resolveRegion(endpoint.host, opts.env ?? process.env);
  if (!region) {
    throw new Error(
      `GBRAIN_DB_IAM_AUTH: cannot resolve AWS region for host "${endpoint.host}" — set AWS_REGION`,
    );
  }
  if (!endpoint.user) {
    throw new Error(
      'GBRAIN_DB_IAM_AUTH: database URL has no username — IAM auth requires an explicit user',
    );
  }
  const minter = opts.minter ?? defaultMinter;
  const token = await minter(endpoint, region);
  tokenCache.set(key, { token, mintedAt: now() });
  return token;
}

/** True when the URL itself already pins an ssl/sslmode choice. */
function urlSpecifiesSsl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    return parsed.searchParams.has('sslmode') || parsed.searchParams.has('ssl');
  } catch {
    return false;
  }
}

/**
 * The single call-site hook. When GBRAIN_DB_IAM_AUTH is off this is an
 * identity function (returns `url`, leaves `opts` untouched) — zero
 * behavior change for every existing install. When on:
 *
 *   1. wires `opts.pass` to an async token provider (overrides any URL
 *      password — postgres.js option precedence: o.pass > url.password),
 *   2. defaults `opts.ssl = 'require'` (or a CA-verified tls object when
 *      GBRAIN_DB_SSL_CA_FILE is set) unless the caller/URL already chose,
 *   3. returns the URL with the password component stripped, so the dead
 *      password can't leak via URL-logging paths.
 *
 * Mutates `opts` in place (matches how the four construction sites build
 * their opts objects incrementally).
 */
export function maybeApplyIamAuth(
  url: string,
  opts: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!isIamAuthEnabled(env)) return url;

  const endpoint = parsePgEndpoint(url);
  opts.pass = () => getIamAuthToken(endpoint, { env });

  if (opts.ssl === undefined && !urlSpecifiesSsl(url)) {
    const caFile = env.GBRAIN_DB_SSL_CA_FILE;
    if (caFile) {
      // Read once at pool construction. Sync on purpose: all four call
      // sites build opts synchronously before `postgres(url, opts)`.
      opts.ssl = { ca: readFileSync(caFile, 'utf8'), rejectUnauthorized: true };
    } else {
      opts.ssl = 'require';
    }
  }

  return stripUrlPassword(url);
}
