/**
 * Unit tests for src/core/rds-iam-auth.ts — RDS IAM database auth helper.
 *
 * All env-dependent behavior is exercised via explicit env-object injection
 * (no process.env mutation — keeps check-test-isolation happy and the tests
 * parallel-safe). The token minter is injected so no AWS credentials are
 * needed; the default Signer path is covered by the one-off pod validation
 * documented in the PR, not here.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isIamAuthEnabled,
  parsePgEndpoint,
  resolveRegion,
  stripUrlPassword,
  getIamAuthToken,
  maybeApplyIamAuth,
  TOKEN_CACHE_TTL_MS,
  _resetIamTokenCacheForTests,
  type PgEndpoint,
} from '../src/core/rds-iam-auth.ts';

const HOST = 'gbrain-pg.cluster-abc123.ca-central-1.rds.amazonaws.com';
const URL_WITH_PASS = `postgres://gbrain_app:s3cret@${HOST}:5432/gbrain`;
const URL_NO_PASS = `postgres://gbrain_app@${HOST}:5432/gbrain`;

beforeEach(() => {
  _resetIamTokenCacheForTests();
});

describe('isIamAuthEnabled', () => {
  test('enabled by "1" and "true" (case-insensitive)', () => {
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: '1' })).toBe(true);
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: 'true' })).toBe(true);
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: 'TRUE' })).toBe(true);
  });

  test('disabled when unset, "0", "false", or empty', () => {
    expect(isIamAuthEnabled({})).toBe(false);
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: '0' })).toBe(false);
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: 'false' })).toBe(false);
    expect(isIamAuthEnabled({ GBRAIN_DB_IAM_AUTH: '' })).toBe(false);
  });
});

describe('parsePgEndpoint', () => {
  test('extracts host, port, user', () => {
    expect(parsePgEndpoint(URL_WITH_PASS)).toEqual({ host: HOST, port: 5432, user: 'gbrain_app' });
  });

  test('defaults port to 5432 when absent', () => {
    expect(parsePgEndpoint(`postgresql://u@${HOST}/db`).port).toBe(5432);
  });

  test('honors non-default port (pooler 6543)', () => {
    expect(parsePgEndpoint(`postgres://u:p@${HOST}:6543/db`).port).toBe(6543);
  });

  test('decodes percent-encoded usernames', () => {
    expect(parsePgEndpoint(`postgres://gbrain%2Eapp@${HOST}/db`).user).toBe('gbrain.app');
  });

  test('empty user comes back as empty string (rejected later at mint time)', () => {
    expect(parsePgEndpoint(`postgres://${HOST}/db`).user).toBe('');
  });
});

describe('resolveRegion', () => {
  test('AWS_REGION env wins over hostname derivation', () => {
    expect(resolveRegion(HOST, { AWS_REGION: 'us-east-1' })).toBe('us-east-1');
  });

  test('AWS_DEFAULT_REGION is the fallback env', () => {
    expect(resolveRegion('nonrds.example.com', { AWS_DEFAULT_REGION: 'eu-west-2' })).toBe('eu-west-2');
  });

  test('derives region from RDS hostname when env is unset', () => {
    expect(resolveRegion(HOST, {})).toBe('ca-central-1');
    expect(resolveRegion('db.cluster-xyz.us-gov-west-1.rds.amazonaws.com', {})).toBe('us-gov-west-1');
  });

  test('null for non-RDS hostnames with no env region', () => {
    expect(resolveRegion('db.example.supabase.co', {})).toBeNull();
  });
});

describe('stripUrlPassword', () => {
  test('strips the password component only', () => {
    expect(stripUrlPassword(URL_WITH_PASS)).toBe(URL_NO_PASS);
  });

  test('no-op when there is no password', () => {
    expect(stripUrlPassword(URL_NO_PASS)).toBe(URL_NO_PASS);
  });

  test('preserves query string and path byte-for-byte', () => {
    const url = `postgresql://u:p%40ss@${HOST}:6543/gbrain?sslmode=require&prepare=false`;
    expect(stripUrlPassword(url)).toBe(`postgresql://u@${HOST}:6543/gbrain?sslmode=require&prepare=false`);
  });

  test('no-op on a URL with no userinfo at all', () => {
    const url = `postgres://${HOST}/db`;
    expect(stripUrlPassword(url)).toBe(url);
  });
});

describe('getIamAuthToken — cache & refresh', () => {
  const endpoint: PgEndpoint = { host: HOST, port: 5432, user: 'gbrain_app' };
  const env = { AWS_REGION: 'ca-central-1' };

  test('mints once and serves from cache within TTL', async () => {
    let mints = 0;
    const minter = async () => `tok-${++mints}`;
    const t0 = 1_000_000;
    let now = t0;
    const clock = () => now;

    expect(await getIamAuthToken(endpoint, { minter, now: clock, env })).toBe('tok-1');
    now = t0 + TOKEN_CACHE_TTL_MS - 1;
    expect(await getIamAuthToken(endpoint, { minter, now: clock, env })).toBe('tok-1');
    expect(mints).toBe(1);
  });

  test('re-mints after the TTL elapses (refresh under the 15-min expiry)', async () => {
    let mints = 0;
    const minter = async () => `tok-${++mints}`;
    const t0 = 1_000_000;
    let now = t0;
    const clock = () => now;

    expect(await getIamAuthToken(endpoint, { minter, now: clock, env })).toBe('tok-1');
    now = t0 + TOKEN_CACHE_TTL_MS + 1;
    expect(await getIamAuthToken(endpoint, { minter, now: clock, env })).toBe('tok-2');
    expect(mints).toBe(2);
  });

  test('cache key is per host:port:user — different users mint separately', async () => {
    let mints = 0;
    const minter = async (ep: PgEndpoint) => `tok-${ep.user}-${++mints}`;
    const a = await getIamAuthToken({ ...endpoint, user: 'alpha' }, { minter, env });
    const b = await getIamAuthToken({ ...endpoint, user: 'beta' }, { minter, env });
    expect(a).toBe('tok-alpha-1');
    expect(b).toBe('tok-beta-2');
  });

  test('minter receives the resolved region and endpoint', async () => {
    let seen: { ep?: PgEndpoint; region?: string } = {};
    const minter = async (ep: PgEndpoint, region: string) => {
      seen = { ep, region };
      return 'tok';
    };
    await getIamAuthToken(endpoint, { minter, env: {} }); // region from hostname
    expect(seen.region).toBe('ca-central-1');
    expect(seen.ep).toEqual(endpoint);
  });

  test('throws with remediation when region cannot be resolved', async () => {
    const ep = { host: 'db.example.com', port: 5432, user: 'u' };
    await expect(getIamAuthToken(ep, { minter: async () => 'x', env: {} }))
      .rejects.toThrow(/AWS_REGION/);
  });

  test('throws when the URL had no username', async () => {
    const ep = { host: HOST, port: 5432, user: '' };
    await expect(getIamAuthToken(ep, { minter: async () => 'x', env }))
      .rejects.toThrow(/username/);
  });

  test('a failed mint is NOT cached — next call retries', async () => {
    let mints = 0;
    const minter = async () => {
      mints++;
      if (mints === 1) throw new Error('sts unavailable');
      return 'tok-recovered';
    };
    await expect(getIamAuthToken(endpoint, { minter, env })).rejects.toThrow('sts unavailable');
    expect(await getIamAuthToken(endpoint, { minter, env })).toBe('tok-recovered');
  });
});

describe('maybeApplyIamAuth', () => {
  test('identity when the flag is off — url unchanged, opts untouched', () => {
    const opts: Record<string, unknown> = { max: 10 };
    const out = maybeApplyIamAuth(URL_WITH_PASS, opts, {});
    expect(out).toBe(URL_WITH_PASS);
    expect(opts).toEqual({ max: 10 });
    expect(opts.pass).toBeUndefined();
    expect(opts.ssl).toBeUndefined();
  });

  test('enabled: strips password, wires async pass callback, defaults ssl:require', () => {
    const opts: Record<string, unknown> = { max: 10 };
    const out = maybeApplyIamAuth(URL_WITH_PASS, opts, { GBRAIN_DB_IAM_AUTH: '1' });
    expect(out).toBe(URL_NO_PASS);
    expect(typeof opts.pass).toBe('function');
    expect(opts.ssl).toBe('require');
  });

  test('caller-provided opts.ssl wins over the require default', () => {
    const opts: Record<string, unknown> = { ssl: { rejectUnauthorized: true } };
    maybeApplyIamAuth(URL_WITH_PASS, opts, { GBRAIN_DB_IAM_AUTH: '1' });
    expect(opts.ssl).toEqual({ rejectUnauthorized: true });
  });

  test('URL ?sslmode= wins — helper does not stomp URL-pinned ssl choice', () => {
    const opts: Record<string, unknown> = {};
    const url = `${URL_WITH_PASS}?sslmode=verify-full`;
    maybeApplyIamAuth(url, opts, { GBRAIN_DB_IAM_AUTH: '1' });
    expect(opts.ssl).toBeUndefined(); // postgres.js reads sslmode from the URL itself
    expect(typeof opts.pass).toBe('function');
  });

  test('GBRAIN_DB_SSL_CA_FILE upgrades ssl to CA-verified tls options', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-iam-ca-'));
    const caPath = join(dir, 'rds-ca.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    const opts: Record<string, unknown> = {};
    maybeApplyIamAuth(URL_WITH_PASS, opts, {
      GBRAIN_DB_IAM_AUTH: '1',
      GBRAIN_DB_SSL_CA_FILE: caPath,
    });
    const ssl = opts.ssl as { ca: string; rejectUnauthorized: boolean };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain('BEGIN CERTIFICATE');
  });

  test('passwordless URL passes through with pass wired (the intended prod shape)', () => {
    const opts: Record<string, unknown> = {};
    const out = maybeApplyIamAuth(URL_NO_PASS, opts, { GBRAIN_DB_IAM_AUTH: '1' });
    expect(out).toBe(URL_NO_PASS);
    expect(typeof opts.pass).toBe('function');
  });
});
