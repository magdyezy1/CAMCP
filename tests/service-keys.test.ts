// SEC-06 S2 (review 2026-10-08, R04 owner-change-revokes-service-keys, confirmed): `revokeAccess` revoked every API key
// of the owner's workspace that had no credential_owners row, and `admin create-key` recorded no owner, so an owner
// enabling two-step verification (or changing a password) silently broke every automation key created on the server.
// Server-created keys are now service-owned and survive; door-era connector tokens and AI-client keys still end, and
// the security notice says how many did. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {serviceKeys} from '../src/owner-operations.js';
import {sha256} from '../src/security.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts, hashUserPassword} from '../server/user-accounts.js';
import {AccountSecurity, totp} from '../server/account-security.js';
import {removeTestDirectory} from './temp.js';
import {runAdmin} from './admin-cli.js';
import type {JsonObject} from '../src/types.js';

const master = Buffer.alloc(32, 71).toString('base64'),
  passphrase = 'synthetic service key passphrase';

test('SEC-06: a server-created key survives the owner enabling two-step verification; door-era tokens still end', async () => {
  const store = new Store(':memory:', master),
    emails: JsonObject[] = [];
  const web = new WebStore(store, {
      origin: 'https://amcp.shop',
      masterKey: master,
      authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>'},
      fetcher: async (_url, init) => {
        emails.push(JSON.parse(String(init?.body)));
        return new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}});
      },
    }),
    accounts = new UserAccounts(web),
    security = new AccountSecurity(accounts);
  const req = (s: {id: string; csrf: string}): Request =>
    ({
      headers: {origin: web.origin, cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf},
      socket: {remoteAddress: '127.0.0.1'},
    }) as unknown as Request;
  try {
    const owner = accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(passphrase), true),
      tenant = owner.tenant_id as string;
    const service = store.createServiceKey({tenantId: tenant, userId: 'nightly-sync', role: 'operator'}),
      // A server key created before this change: no owner row, and neither a connector token nor an AI-client key.
      legacyService = store.createKey({tenantId: tenant, userId: 'legacy-cli', role: 'reader'}),
      // Credentials the administrator door issued before the workspace had an owner account.
      doorConnector = store.createKey({tenantId: tenant, userId: 'connector/door-era', role: 'reader'}),
      doorClient = store.createKey({tenantId: tenant, userId: 'oauth/door-client', role: 'reader'});
    // A service key acts as before: no person account is attached to it.
    assert.equal(store.authenticate(service).ownerUserId, undefined);
    assert.equal(
      (store.db.prepare('SELECT user_id FROM credential_owners WHERE hash=?').get(sha256(service)) as JsonObject)
        .user_id,
      'service:cli',
    );
    // Owner health lists both, soonest expiry first, and never door-era connector tokens or AI-client keys.
    assert.deepEqual(
      serviceKeys(store, tenant)
        .map(k => [k.label, k.role, k.owner])
        .sort(),
      [
        ['legacy-cli', 'reader', 'service:legacy'],
        ['nightly-sync', 'operator', 'service:cli'],
      ],
    );
    const s = accounts.session(owner),
      setup = security.beginMfa(req(s));
    security.enableMfa(req(s), {ticket: setup.ticket, code: totp(setup.secret)});
    assert.equal(store.authenticate(service).role, 'operator', 'the service key survives');
    assert.equal(store.authenticate(legacyService).role, 'reader', 'an older server key survives');
    assert.throws(() => store.authenticate(doorConnector), {code: 'UNAUTHORIZED'});
    assert.throws(() => store.authenticate(doorClient), {code: 'UNAUTHORIZED'});
    // The notice says what ended, and that service keys were kept.
    while (await accounts.deliverEmails());
    const notice = emails.find(e => e.subject === 'Security change on your AMCP account');
    assert.match(String(notice?.text), /Two-step verification was turned on/);
    assert.match(String(notice?.text), /ended 1 connector token\(s\) and 0 AI-client connection\(s\)/);
    assert.match(String(notice?.text), /service keys were kept/);
  } finally {
    store.close();
  }
});

test('SEC-06: `admin create-key` records the key as service-owned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-service-key-')),
    database = path.join(dir, 'amcp.sqlite');
  try {
    const run = runAdmin(['create-key', 'cli-tenant', 'ops', 'reader'], {
      env: {...process.env, MIRROR_DB: database, MIRROR_MASTER_KEY: master, NODE_ENV: 'test'},
      timeout: 30000,
    });
    assert.equal(run.status, 0, run.stderr);
    const token = run.stdout.trim(),
      store = new Store(database, master);
    try {
      assert.equal(store.authenticate(token).role, 'reader');
      assert.equal(
        (store.db.prepare('SELECT user_id FROM credential_owners WHERE hash=?').get(sha256(token)) as JsonObject)
          .user_id,
        'service:cli',
      );
    } finally {
      store.close();
    }
  } finally {
    removeTestDirectory(dir, 'amcp-service-key-');
  }
});
