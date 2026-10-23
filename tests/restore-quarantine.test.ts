import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService, strictOptions} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {createEncryptedBackup, restoreDrill, restoreEncryptedBackup} from '../src/backup.js';
import {createHttpApp} from '../server/http-app.js';
import {endMcpGrants} from '../server/mcp-grants.js';
import type {JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';
import {runAdmin} from './admin-cli.js';

/**
 * SEC-07 S1: a restore is quarantined by default. A backup taken before a compromise holds the sessions, connector keys
 * and AI-client grants an owner revoked since; publishing it unchanged re-armed them. The quarantined copy ends every
 * session and emailed link, revokes every key, spends every grant, pauses writes and schedules and records why;
 * `--preserve-access` is the explicit opt-out that keeps them.
 */
const origin = 'https://amcp.shop',
  redirect = 'https://claude.ai/api/mcp/auth_callback',
  master = Buffer.alloc(32, 93).toString('base64'),
  password = 'synthetic-restore-admin-password';

async function site(store: Store) {
  const service = new MirrorService(new Registry(), store, new NativeTransport(), strictOptions, {
    allowWrites: true,
    requireBeforeState: true,
    maxBudgetChange: 0,
  });
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword: password,
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
    }),
  );
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const form = body instanceof URLSearchParams;
    const response = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(body === undefined
          ? {}
          : {'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json'}),
        ...headers,
      },
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    });
    const bytes = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status,
      headers: response.headers,
    });
  };
  const token = (body: Record<string, string>) => request('/token', 'POST', new URLSearchParams(body));
  return {
    request,
    token,
    signedIn: async (cookie: string) =>
      (await (await request('/api/session', 'GET', undefined, {Cookie: cookie})).json()).authenticated === true,
    mcp: async (access: string) =>
      (
        await request(
          '/mcp',
          'POST',
          {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}},
          {Authorization: 'Bearer ' + access, Accept: 'application/json, text/event-stream'},
        )
      ).status,
    close: async () => {
      const closing = new Promise<void>(r => listener.close(() => r()));
      listener.closeAllConnections();
      await closing;
    },
  };
}

/** A live database holding one website session, one connector key, one AI-client grant and an active schedule, and
 * an encrypted backup of it; afterwards everything is revoked in the live database. */
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-restore-quarantine-')),
    live = new Store(path.join(dir, 'live.sqlite'), master),
    s = await site(live);
  try {
    const login = await s.request('/api/session', 'POST', {password});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!,
      csrf = (await login.json()).csrf as string,
      headers = {Cookie: cookie, 'X-AMCP-CSRF': csrf};
    // The administrator password opens the deployment's workspace (no AMCP_TENANT_ID: 'local').
    const tenant = 'local';
    const registered = await s.request('/register', 'POST', {
      client_name: 'Claude',
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    assert.equal(registered.status, 201);
    const client = await registered.json(),
      verifier = randomBytes(48).toString('base64url');
    const start = await s.request(
      '/authorize?' +
        new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirect,
          response_type: 'code',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          scope: 'mcp:read',
          state: 'restore-state',
          resource: origin + '/mcp',
        }),
    );
    assert.equal(start.status, 303);
    const consentRequest = new URL(start.headers.get('location')!).searchParams.get('request')!;
    const decision = await s.request('/api/mcp/consent', 'POST', {request: consentRequest, approved: true}, headers);
    assert.equal(decision.status, 200, await decision.clone().text());
    const exchanged = await s.token({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: redirect,
      code: new URL((await decision.json()).url).searchParams.get('code')!,
      code_verifier: verifier,
      resource: origin + '/mcp',
    });
    assert.equal(exchanged.status, 200);
    const grant = await exchanged.json(),
      key = live.createKey({tenantId: tenant, userId: 'connector-user', role: 'admin'});
    live.putDocument(tenant, 'overview_schedule', 'weekly', {is_active: true, next_run_at: Date.now() + 86400000});
    // Everything works before the backup.
    assert.equal(await s.signedIn(cookie), true);
    assert.equal(await s.mcp(grant.access_token), 200);
    assert.equal(live.authenticate(key).tenantId, tenant);
    const archive = path.join(dir, 'before-compromise.amcp');
    await createEncryptedBackup(live, archive, master, {tmpdir: dir});
    // The owner revokes everything after the backup: sign-out, key revocation and the AI client's authorization.
    assert.equal((await s.request('/api/session', 'DELETE', undefined, headers)).status, 200);
    live.revokeKey(key);
    endMcpGrants(live, 'client_id=?', [client.client_id], 'workspace_revoke');
    assert.equal(await s.signedIn(cookie), false);
    assert.throws(() => live.authenticate(key), {code: 'UNAUTHORIZED'});
    return {dir, live, s, archive, tenant, cookie, client, grant, key};
  } catch (e) {
    await s.close();
    live.close();
    removeTestDirectory(dir, 'amcp-restore-quarantine-');
    throw e;
  }
}

async function restoredSite(file: string) {
  const store = new Store(file, master);
  return {store, s: await site(store)};
}

test('SEC-07 S1: a default restore quarantines access, so credentials revoked after the backup stay refused (regression: restore re-armed them)', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.dir, 'restored.sqlite'),
      receipt = await restoreEncryptedBackup(f.archive, target, master);
    assert.equal(receipt.status, 'restored');
    assert.equal(receipt.access.quarantined, true);
    assert.ok(Number(receipt.access.sessions_ended) >= 1);
    assert.ok(Number(receipt.access.keys_revoked) >= 2, 'the connector key and the AI client access key');
    assert.ok(Number(receipt.access.ai_client_grants_ended) >= 2, 'access and refresh grants');
    assert.equal(receipt.access.schedules_paused, 1);
    assert.ok(Number(receipt.access.workspaces_paused) >= 1);
    assert.match(String(receipt.restore_scope), /quarantined/);
    assert.equal(JSON.stringify(receipt).includes(f.grant.refresh_token), false);
    const r = await restoredSite(target);
    try {
      assert.equal(r.store.verifyAudit(), true);
      // Every credential the backup held is refused.
      assert.equal(await r.s.signedIn(f.cookie), false);
      assert.throws(() => r.store.authenticate(f.key), {code: 'UNAUTHORIZED'});
      assert.notEqual(await r.s.mcp(f.grant.access_token), 200);
      const refreshed = await r.s.token({
        grant_type: 'refresh_token',
        client_id: f.client.client_id,
        refresh_token: f.grant.refresh_token,
        resource: origin + '/mcp',
      });
      assert.equal(refreshed.status, 400);
      assert.match((await refreshed.json()).error_description, /restored from a backup/);
      // Writes are paused by the owner write pause, schedules are paused and the reason is audited.
      const pause = r.store.document(f.tenant, 'write_pause', 'workspace');
      assert.equal(pause.paused, true);
      assert.equal(pause.paused_by, 'system:restore');
      const schedule = r.store.document(f.tenant, 'overview_schedule', 'weekly');
      assert.equal(schedule.is_active, false);
      assert.equal(schedule.pause_reason, 'restore_quarantine');
      const events = (r.store.audit(f.tenant, 1000) as {event: string}[]).map(e => JSON.parse(e.event));
      const quarantined = events.find(e => e.event === 'restore_quarantined');
      assert.equal(quarantined?.backup_sha256, (receipt as JsonObject).sha256);
      // People can sign in again with the deployment password.
      const again = await r.s.request('/api/session', 'POST', {password});
      assert.equal(again.status, 200);
    } finally {
      await r.s.close();
      r.store.close();
    }
  } finally {
    await f.s.close();
    f.live.close();
    removeTestDirectory(f.dir, 'amcp-restore-quarantine-');
  }
});

test('SEC-07 S1: --preserve-access keeps the access the backup held, deliberately', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.dir, 'preserved.sqlite'),
      receipt = await restoreEncryptedBackup(f.archive, target, master, {preserveAccess: true});
    assert.deepEqual(receipt.access, {quarantined: false, reason: 'preserve_access'});
    assert.match(String(receipt.restore_scope), /--preserve-access/);
    const r = await restoredSite(target);
    try {
      assert.equal(r.store.verifyAudit(), true);
      assert.equal(await r.s.signedIn(f.cookie), true);
      assert.equal(r.store.authenticate(f.key).tenantId, f.tenant);
      assert.equal(await r.s.mcp(f.grant.access_token), 200);
      assert.equal(r.store.document(f.tenant, 'overview_schedule', 'weekly').is_active, true);
      assert.throws(() => r.store.document(f.tenant, 'write_pause', 'workspace'), {code: 'NOT_FOUND'});
    } finally {
      await r.s.close();
      r.store.close();
    }
  } finally {
    await f.s.close();
    f.live.close();
    removeTestDirectory(f.dir, 'amcp-restore-quarantine-');
  }
});

test('SEC-07 S1: the CLI restore and drill quarantine by default and accept --preserve-access', async () => {
  const f = await fixture();
  try {
    const env = {...process.env, MIRROR_DB: path.join(f.dir, 'must-not-exist.sqlite'), MIRROR_MASTER_KEY: master},
      run = (...args: string[]) => runAdmin(args, {env, timeout: 30000});
    const restored = run('backup-restore', f.archive, path.join(f.dir, 'cli.sqlite'));
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).access.quarantined, true);
    const preserved = run('backup-restore', f.archive, path.join(f.dir, 'cli-preserved.sqlite'), '--preserve-access');
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(JSON.parse(preserved.stdout).access.quarantined, false);
    const drill = run('backup-drill', f.archive, path.join(f.dir, 'drill.sqlite'));
    assert.equal(drill.status, 0, drill.stderr);
    assert.equal(JSON.parse(drill.stdout).access.quarantined, true);
    assert.equal(fs.existsSync(env.MIRROR_DB), false);
    // The library drill takes the same option.
    const record = await restoreDrill(f.archive, path.join(f.dir, 'drill-preserved.sqlite'), master, {
      preserveAccess: true,
    });
    assert.equal((record.access as JsonObject).quarantined, false);
  } finally {
    await f.s.close();
    f.live.close();
    removeTestDirectory(f.dir, 'amcp-restore-quarantine-');
  }
});
