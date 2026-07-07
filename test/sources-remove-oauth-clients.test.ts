/**
 * #F-D — `gbrain sources remove` vs oauth_clients ON DELETE RESTRICT.
 *
 * Live-verified failure: removing a source with a bound OAuth client died on
 * the RESTRICT FK and required a manual `gbrain auth revoke-client` first.
 * cleanupSourceOauthClients resolves the edge explicitly:
 *   - any client still holding oauth_tokens rows → BLOCKED (nothing deleted,
 *     caller aborts and lists the client_ids)
 *   - token-less clients → hard-deleted (cascades oauth_codes), unblocking
 *     the subsequent DELETE FROM sources
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cleanupSourceOauthClients } from '../src/commands/sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function addSource(id: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}') ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function addClient(clientId: string, sourceId: string) {
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name, source_id) VALUES ($1, $1, $2)`,
    [clientId, sourceId],
  );
}

async function addToken(clientId: string, hash: string) {
  await engine.executeRaw(
    `INSERT INTO oauth_tokens (token_hash, token_type, client_id) VALUES ($1, 'access', $2)`,
    [hash, clientId],
  );
}

describe('cleanupSourceOauthClients', () => {
  test('token-less clients are deleted; source becomes removable', async () => {
    await addSource('src-tokenless');
    await addClient('client-a', 'src-tokenless');
    await addClient('client-b', 'src-tokenless');

    // Sanity: RESTRICT actually blocks before cleanup.
    await expect(
      engine.executeRaw(`DELETE FROM sources WHERE id = $1`, ['src-tokenless']),
    ).rejects.toThrow();

    const r = await cleanupSourceOauthClients(engine, 'src-tokenless');
    expect(r.blocked).toEqual([]);
    expect(r.deleted.sort()).toEqual(['client-a', 'client-b']);

    // The FK edge is gone — the source row deletes cleanly now.
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, ['src-tokenless']);
    const left = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM sources WHERE id = $1`, ['src-tokenless']);
    expect(Number(left[0].n)).toBe(0);
  });

  test('clients holding tokens block the removal and NOTHING is deleted', async () => {
    await addSource('src-tokened');
    await addClient('client-live', 'src-tokened');
    await addClient('client-idle', 'src-tokened');
    await addToken('client-live', 'hash-live-1');

    const r = await cleanupSourceOauthClients(engine, 'src-tokened');
    expect(r.blocked).toEqual(['client-live']);
    // Abort leaves the brain exactly as found: the idle client survives too.
    expect(r.deleted).toEqual([]);
    const rows = await engine.executeRaw<{ client_id: string }>(
      `SELECT client_id FROM oauth_clients WHERE source_id = $1 ORDER BY client_id`,
      ['src-tokened'],
    );
    expect(rows.map((x) => x.client_id)).toEqual(['client-idle', 'client-live']);
  });

  test('after revoking the client, cleanup unblocks', async () => {
    // Simulate `gbrain auth revoke-client` (hard delete cascades tokens).
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id = $1`, ['client-live']);
    const r = await cleanupSourceOauthClients(engine, 'src-tokened');
    expect(r.blocked).toEqual([]);
    expect(r.deleted).toEqual(['client-idle']);
  });

  test('source with no clients is a clean no-op', async () => {
    await addSource('src-bare');
    const r = await cleanupSourceOauthClients(engine, 'src-bare');
    expect(r).toEqual({ deleted: [], blocked: [] });
  });
});
