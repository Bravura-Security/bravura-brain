/**
 * Cloudflare Access JWT auth provider tests.
 *
 * Covers the native dual-mode provider wired into `gbrain serve --http`:
 *   - personal-source slug derivation from the email local-part
 *   - GBRAIN_CF_ACCESS_GROUP_MAP parsing (incl. malformed-entry tolerance)
 *   - groups-claim extraction across the shapes Azure-AD-via-Access emits
 *   - identity → scope resolution (default mapping + a group mapping)
 *   - JWT verification: valid → identity; bad signature / aud / iss / exp → reject
 *   - end-to-end authenticateCfAccess → AuthInfo shape + JIT source creation
 *
 * Verification runs OFFLINE: a local RSA keypair signs the test JWTs and the
 * verifier is built with a `getKey` override backed by createLocalJWKSet, so
 * no network JWKS fetch occurs. The HTTP dual-mode fallthrough (header absent
 * → OAuth/bearer path) is asserted at the unit level via the middleware
 * contract documented in serve-http.ts (header gate), and is exercised here by
 * confirming the provider only engages when an assertion is present.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from 'jose';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  personalSourceSlug,
  parseGroupMap,
  extractGroups,
  resolveScopeForIdentity,
  resolveCfAccessConfig,
  createCfAccessVerifier,
  authenticateCfAccess,
  ensureSourceExists,
  CfAccessVerifyError,
  type CfAccessConfig,
} from '../src/core/cf-access-auth.ts';
import type { JWTVerifyGetKey } from 'jose';

const TEAM_DOMAIN = 'bravurasecurity.cloudflareaccess.com';
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUD = 'f22ee20151e4be2ed6555ad7a9aa4dbaa46994b8c52981cfe51328560de43c48';
const KID = 'test-key-1';

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const { publicKey, privateKey: pk } = await generateKeyPair('RS256', { extractable: true });
  privateKey = pk;
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  getKey = createLocalJWKSet({ keys: [jwk] }) as unknown as JWTVerifyGetKey;
});

/** Mint a signed CF-Access-style JWT with overridable claims/timing. */
async function mintJwt(
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: string | number; key?: CryptoKey; kid?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? '5m');
  return jwt.sign(opts.key ?? privateKey);
}

function testConfig(overrides: Partial<CfAccessConfig> = {}): CfAccessConfig {
  return {
    teamDomain: TEAM_DOMAIN,
    aud: AUD,
    defaultRead: 'company',
    groupMap: {},
    enabled: true,
    ...overrides,
  };
}

// ── slug derivation ──────────────────────────────────────────────────────

describe('personalSourceSlug', () => {
  test('derives bart-allan from bart.allan@…', () => {
    expect(personalSourceSlug('bart.allan@bravurasecurity.com')).toBe('bart-allan');
  });

  test('collapses punctuation runs and strips edge hyphens', () => {
    expect(personalSourceSlug("Jane.O'Brien+tag@example.com")).toBe('jane-o-brien-tag');
  });

  test('lowercases', () => {
    expect(personalSourceSlug('BART@x.com')).toBe('bart');
  });

  test('truncates to 32 chars and re-strips a trailing hyphen', () => {
    const slug = personalSourceSlug('a'.repeat(40) + '@x.com');
    expect(slug).toBe('a'.repeat(32));
    expect(slug!.length).toBe(32);
  });

  test('returns null for a local-part with no alphanumerics', () => {
    expect(personalSourceSlug('...@x.com')).toBeNull();
    expect(personalSourceSlug('@x.com')).toBeNull();
  });
});

// ── group map parsing ──────────────────────────────────────────────────────

describe('parseGroupMap', () => {
  test('parses valid JSON map', () => {
    const map = parseGroupMap('{"sales-group":{"source":"team-sales","federated_read":["company","team-sales"]}}');
    expect(map).toEqual({ 'sales-group': { source: 'team-sales', federated_read: ['company', 'team-sales'] } });
  });

  test('empty / missing → {}', () => {
    expect(parseGroupMap(undefined)).toEqual({});
    expect(parseGroupMap('')).toEqual({});
    expect(parseGroupMap('   ')).toEqual({});
  });

  test('malformed JSON → {} (never throws, never widens)', () => {
    expect(parseGroupMap('{not json')).toEqual({});
    expect(parseGroupMap('[1,2,3]')).toEqual({});
  });

  test('drops invalid source ids and non-string reads but keeps valid siblings', () => {
    const map = parseGroupMap(
      '{"g":{"source":"BAD_UNDERSCORE","federated_read":["company",5,"team-sales"]}}',
    );
    expect(map).toEqual({ g: { federated_read: ['company', 'team-sales'] } });
  });
});

// ── groups claim extraction ──────────────────────────────────────────────

describe('extractGroups', () => {
  test('top-level array', () => {
    expect(extractGroups({ groups: ['a', 'b'] } as any)).toEqual(['a', 'b']);
  });
  test('single string → one-element array', () => {
    expect(extractGroups({ groups: 'solo' } as any)).toEqual(['solo']);
  });
  test('nested custom.groups', () => {
    expect(extractGroups({ custom: { groups: ['x'] } } as any)).toEqual(['x']);
  });
  test('missing groups → [] (default mapping still applies)', () => {
    expect(extractGroups({ email: 'x@y.com' } as any)).toEqual([]);
  });
});

// ── scope resolution ─────────────────────────────────────────────────────

describe('resolveScopeForIdentity', () => {
  test('default mapping: read company + personal, write personal, scopes read/write', () => {
    const res = resolveScopeForIdentity({ groups: [] }, 'bart-allan', {
      defaultRead: 'company',
      groupMap: {},
    });
    expect(res.sourceId).toBe('bart-allan');
    expect(res.scopes).toEqual(['read', 'write']);
    expect(new Set(res.allowedSources)).toEqual(new Set(['company', 'bart-allan']));
  });

  test('group mapping ADDS federated reads and overrides write source', () => {
    const res = resolveScopeForIdentity({ groups: ['sales-group'] }, 'bart-allan', {
      defaultRead: 'company',
      groupMap: { 'sales-group': { source: 'team-sales', federated_read: ['company', 'team-sales'] } },
    });
    expect(res.sourceId).toBe('team-sales');
    // company + personal slug + team-sales (write source always readable)
    expect(new Set(res.allowedSources)).toEqual(new Set(['company', 'bart-allan', 'team-sales']));
  });

  test('unmatched group is ignored (default mapping)', () => {
    const res = resolveScopeForIdentity({ groups: ['unknown-group'] }, 'bart-allan', {
      defaultRead: 'company',
      groupMap: { 'sales-group': { federated_read: ['team-sales'] } },
    });
    expect(res.sourceId).toBe('bart-allan');
    expect(new Set(res.allowedSources)).toEqual(new Set(['company', 'bart-allan']));
  });
});

// ── env config resolution ────────────────────────────────────────────────

describe('resolveCfAccessConfig', () => {
  test('verified defaults when env unset', () => {
    const cfg = resolveCfAccessConfig({} as NodeJS.ProcessEnv);
    expect(cfg.teamDomain).toBe('bravurasecurity.cloudflareaccess.com');
    expect(cfg.aud).toBe(AUD);
    expect(cfg.defaultRead).toBe('company');
    expect(cfg.enabled).toBe(true);
    expect(cfg.groupMap).toEqual({});
  });

  test('env overrides + disable toggle', () => {
    const cfg = resolveCfAccessConfig({
      GBRAIN_CF_ACCESS_TEAM_DOMAIN: 'other.cloudflareaccess.com',
      GBRAIN_CF_ACCESS_AUD: 'aud123',
      GBRAIN_CF_ACCESS_DEFAULT_READ: 'org',
      GBRAIN_CF_ACCESS_GROUP_MAP: '{"g":{"source":"team-sales"}}',
      GBRAIN_CF_ACCESS_ENABLED: 'false',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.teamDomain).toBe('other.cloudflareaccess.com');
    expect(cfg.aud).toBe('aud123');
    expect(cfg.defaultRead).toBe('org');
    expect(cfg.enabled).toBe(false);
    expect(cfg.groupMap).toEqual({ g: { source: 'team-sales' } });
  });
});

// ── verifier ────────────────────────────────────────────────────────────

describe('createCfAccessVerifier', () => {
  test('valid JWT → identity with lowercased email + groups', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'Bart.Allan@bravurasecurity.com', groups: ['sales-group'] });
    const id = await verifier.verify(token);
    expect(id.email).toBe('bart.allan@bravurasecurity.com');
    expect(id.groups).toEqual(['sales-group']);
  });

  test('rejects bad signature', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256', { extractable: true });
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'x@y.com' }, { key: otherKey });
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'CfAccessVerifyError',
      code: 'invalid_signature',
    });
  });

  test('rejects wrong audience', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'x@y.com' }, { aud: 'wrong-aud' });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid_audience' });
  });

  test('rejects wrong issuer', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'x@y.com' }, { iss: 'https://evil.cloudflareaccess.com' });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'invalid_issuer' });
  });

  test('rejects expired JWT', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    // exp in the past.
    const token = await mintJwt({ email: 'x@y.com' }, { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'expired' });
  });

  test('rejects missing email claim', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ sub: 'no-email' });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'missing_email' });
  });
});

// ── end-to-end + JIT source creation ──────────────────────────────────────

describe('authenticateCfAccess (engine-backed)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  async function sourceExists(id: string): Promise<boolean> {
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [id]);
    return rows.length > 0;
  }

  test('valid JWT (default mapping) → AuthInfo + JIT personal source', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'bart.allan@bravurasecurity.com' });
    expect(await sourceExists('bart-allan')).toBe(false);

    const { authInfo } = await authenticateCfAccess(engine, verifier, testConfig(), token);

    expect(authInfo.scopes).toEqual(['read', 'write']);
    expect(authInfo.sourceId).toBe('bart-allan');
    expect(new Set(authInfo.allowedSources)).toEqual(new Set(['company', 'bart-allan']));
    expect(authInfo.clientId).toBe('cf-access:bart.allan@bravurasecurity.com');
    expect(authInfo.clientName).toBe('bart.allan@bravurasecurity.com');
    // JIT created the personal source.
    expect(await sourceExists('bart-allan')).toBe(true);
  });

  test('group mapping → write team source, federated reads, JIT team source', async () => {
    const config = testConfig({
      groupMap: { 'sales-group': { source: 'team-sales', federated_read: ['company', 'team-sales'] } },
    });
    const verifier = createCfAccessVerifier(config, { getKey });
    const token = await mintJwt({ email: 'rep.one@bravurasecurity.com', groups: ['sales-group'] });

    const { authInfo } = await authenticateCfAccess(engine, verifier, config, token);
    expect(authInfo.sourceId).toBe('team-sales');
    expect(new Set(authInfo.allowedSources)).toEqual(new Set(['company', 'rep-one', 'team-sales']));
    expect(await sourceExists('team-sales')).toBe(true);
  });

  test('ensureSourceExists is idempotent', async () => {
    await ensureSourceExists(engine, 'idem-src');
    await ensureSourceExists(engine, 'idem-src');
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, ['idem-src']);
    expect(rows.length).toBe(1);
  });

  test('invalid JWT throws before any source creation (fail closed)', async () => {
    const verifier = createCfAccessVerifier(testConfig(), { getKey });
    const token = await mintJwt({ email: 'never.created@bravurasecurity.com' }, { aud: 'wrong' });
    await expect(authenticateCfAccess(engine, verifier, testConfig(), token)).rejects.toBeInstanceOf(
      CfAccessVerifyError,
    );
    expect(await sourceExists('never-created')).toBe(false);
  });
});
