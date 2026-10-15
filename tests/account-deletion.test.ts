// SEC-07 S4(d), owner decision P3 of 2026-10-11 (design to GDPR and KSA PDPL; offer self-service deletion). Before this
// change a person could not delete their own account: only the operator could, with `admin erase-account`. Account now
// previews what goes and erases the person's account and own workspace after a typed confirmation and a recent proof of
// identity, refusing the door sign-ins, the AMCP owner, a workspace other members use (AMCP cannot hand it to another
// owner), work still running and every deletion while AMCP_ACCOUNT_SELF_DELETION=off. Synthetic data only; no provider
// or e-mail traffic.
import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts, hashUserPassword} from '../server/user-accounts.js';
import {AccountSecurity} from '../server/account-security.js';
import {AccountDeletion} from '../server/account-deletion.js';
import {sha256} from '../src/security.js';
import type {Connection, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 59).toString('base64'),
  door = 'synthetic-deletion-admin-door',
  password = 'synthetic deletion member passphrase',
  sixteenMinutes = 16 * 60000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture(env: NodeJS.ProcessEnv = {}) {
  const store = new Store(':memory:', master),
    web = new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword: door,
      authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'amcp@example.test', ...env},
      fetcher: async () => {
        throw Error('No provider or e-mail traffic allowed');
      },
    }),
    accounts = new UserAccounts(web);
  const req = (s?: {id: string; csrf: string}): Request =>
    ({
      headers: {origin, ...(s ? {cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf} : {})},
      socket: {remoteAddress: '127.0.0.1'},
    }) as unknown as Request;
  return {store, web, accounts, deletion: new AccountDeletion(accounts), security: new AccountSecurity(accounts), req};
}
function connect(store: Store, tenant: string, userId: string, id: string, gateway = 'meta_native_action') {
  const c: Connection = {
    id,
    tenantId: tenant,
    gateway,
    accounts: ['111'],
    label: 'Synthetic ' + id,
    enabled: true,
    scopes: ['ads_read'],
  };
  store.putConnection({tenantId: tenant, userId, role: 'admin'}, c, {accessToken: 'synthetic-token-' + id});
}
const member = (store: Store, tenant: string, userId: string, role = 'viewer') =>
  store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(tenant, userId, role, Date.now());
const userExists = (store: Store, id: string) => !!store.db.prepare('SELECT 1 FROM amcp_users WHERE id=?').get(id);
const auditEvents = (store: Store, tenant: string, name: string) =>
  (store.db.prepare('SELECT event FROM audit WHERE tenant_id=? ORDER BY seq').all(tenant) as {event: string}[])
    .map(r => JSON.parse(r.event) as JsonObject)
    .filter(e => e.event === name);

test('P3: a person deletes their own account after a preview and a typed confirmation, and gets an erasure receipt', async () => {
  const f = fixture();
  try {
    const person = f.accounts.newUser('Deleting Person', 'deleting.person@example.test', null, true),
      colleague = f.accounts.newUser('Colleague', 'colleague@example.test', null, true),
      personTenant = String(person.tenant_id),
      colleagueTenant = String(colleague.tenant_id);
    connect(f.store, personTenant, person.id, 'person-meta');
    connect(f.store, personTenant, person.id, 'person-tiktok', 'tiktok_native_action');
    f.store.putDocument(personTenant, 'report_snapshot', 'weekly', {title: 'Deleting Person weekly report'});
    // The person also works in the colleague's workspace: that membership ends, the workspace stays.
    member(f.store, colleagueTenant, person.id);
    f.store.putDocument(colleagueTenant, 'report_snapshot', 'kept', {title: 'Colleague report'});
    const s = f.accounts.session(person),
      other = f.accounts.session(person);
    const preview = f.deletion.preview(f.req(s));
    assert.equal(preview.available, true);
    assert.equal(preview.confirm_with, 'email');
    assert.deepEqual(preview.platforms, ['meta_native_action', 'tiktok_native_action']);
    const will = preview.will_delete as JsonObject;
    assert.equal(will.workspaces, 1);
    assert.equal(will.platform_logins, 2);
    assert.equal(will.other_workspaces, 1);
    assert.equal(will.sessions, 2);
    assert.ok(Number(will.saved_records) >= 2, JSON.stringify(will));
    // The preview changed nothing.
    assert.equal(userExists(f.store, person.id), true);
    assert.equal(auditEvents(f.store, 'local', 'account_erased').length, 0);
    // The confirmation is the account's e-mail address; case and surrounding spaces do not matter.
    const result = f.deletion.delete(f.req(s), {confirm: '  Deleting.Person@Example.test '});
    assert.equal(result.deleted, true);
    const receipt = result.receipt as JsonObject;
    assert.match(String(receipt.erasure_id), /^[0-9a-f-]{36}$/);
    assert.equal(receipt.reason, 'self_service');
    assert.deepEqual(receipt.deleted, will, 'the receipt counts what the preview announced');
    assert.deepEqual(result.platforms, ['meta_native_action', 'tiktok_native_action']);
    // The account, its workspace and every session are gone; the colleague's workspace keeps its records.
    assert.equal(userExists(f.store, person.id), false);
    assert.equal(f.store.db.prepare('SELECT 1 FROM tenants WHERE id=?').get(personTenant), undefined);
    assert.equal(f.store.listConnections(personTenant).length, 0);
    for (const session of [s, other]) assert.equal(f.web.session(f.req(session)), undefined);
    assert.equal(
      f.store.db.prepare('SELECT 1 FROM workspace_memberships WHERE user_id=?').get(person.id),
      undefined,
      'the membership elsewhere ended',
    );
    assert.equal(f.store.documents(colleagueTenant, 'report_snapshot').length, 1);
    assert.equal(userExists(f.store, colleague.id), true);
    // The erasure is receipted and audited as the person's own request; the chain still verifies.
    const [erased] = auditEvents(f.store, 'local', 'account_erased');
    assert.equal(erased!.reason, 'self_service');
    assert.equal(erased!.by, 'self');
    assert.equal(erased!.erasure, receipt.erasure_id);
    assert.equal(f.store.document('local', 'erasure_receipt', String(receipt.erasure_id)).reason, 'self_service');
    assert.equal(f.store.verifyAudit(), true);
    // A confirmation naming the erasure is queued to the deleted address (sealed; delivered by the worker).
    const notice = f.store.db
      .prepare('SELECT tenant_id,state FROM amcp_email_outbox WHERE id=?')
      .get(sha256('notice:erased:' + receipt.erasure_id)) as JsonObject | undefined;
    assert.deepEqual({...notice}, {tenant_id: 'local', state: 'queued'});
  } finally {
    f.store.close();
  }
});

test('P3: deletion needs a recent proof of identity and the exact confirmation; each refusal deletes nothing', async () => {
  const f = fixture();
  try {
    const person = f.accounts.newUser('Careful Person', 'careful@example.test', await hashUserPassword(password), true),
      s = f.accounts.session(person);
    assert.throws(() => f.deletion.delete(f.req(s), {confirm: 'someone.else@example.test'}), {
      code: 'ACCOUNT_DELETION_CONFIRMATION',
    });
    assert.throws(() => f.deletion.delete(f.req(s), {}), {code: 'ACCOUNT_DELETION_CONFIRMATION'});
    // Signed in 16 minutes ago: "Confirm it's you" first (SEC-06), refused before any effect.
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now() - sixteenMinutes, sha(s.id));
    assert.throws(() => f.deletion.delete(f.req(s), {confirm: 'careful@example.test'}), {code: 'REAUTH_REQUIRED'});
    assert.equal(userExists(f.store, person.id), true);
    assert.equal(auditEvents(f.store, 'local', 'account_erased').length, 0);
    // A missing CSRF token is refused too.
    assert.throws(() => f.deletion.delete(f.req({id: s.id, csrf: 'wrong'}), {confirm: 'careful@example.test'}), {
      code: 'CSRF_INVALID',
    });
    assert.equal((await f.security.reauthenticate(f.req(s), {password})).reauthenticated, true);
    assert.equal(f.deletion.delete(f.req(s), {confirm: 'careful@example.test'}).deleted, true);
    assert.equal(userExists(f.store, person.id), false);
    // An account without an e-mail address (a social sign-in) confirms with its name, exactly.
    const social = f.accounts.newUser('Social Only Person', null, null, true),
      t = f.accounts.session(social);
    assert.equal(f.deletion.preview(f.req(t)).confirm_with, 'name');
    assert.throws(() => f.deletion.delete(f.req(t), {confirm: 'social only person'}), {
      code: 'ACCOUNT_DELETION_CONFIRMATION',
    });
    assert.equal(f.deletion.delete(f.req(t), {confirm: 'Social Only Person'}).deleted, true);
  } finally {
    f.store.close();
  }
});

test('P3: a sole owner whose workspace other members use, the AMCP owner, the door sign-ins and running work are refused', async () => {
  const f = fixture();
  try {
    const refusal = (s: {id: string; csrf: string}) => (f.deletion.preview(f.req(s)).refusal as JsonObject)?.code;
    // Sole owner with another active member: AMCP cannot transfer the workspace, so the member is removed first.
    const owner = f.accounts.newUser('Team Owner', 'team.owner@example.test', null, true),
      teammate = f.accounts.newUser('Teammate', 'teammate@example.test', null, true);
    member(f.store, String(owner.tenant_id), teammate.id, 'operator');
    const s = f.accounts.session(owner);
    assert.equal(f.deletion.preview(f.req(s)).available, false);
    assert.equal(refusal(s), 'ERASURE_WORKSPACE_SHARED');
    assert.throws(() => f.deletion.delete(f.req(s), {confirm: 'team.owner@example.test'}), {
      code: 'ERASURE_WORKSPACE_SHARED',
      status: 409,
    });
    assert.equal(userExists(f.store, owner.id), true);
    assert.equal(userExists(f.store, teammate.id), true);
    f.store.db
      .prepare('UPDATE workspace_memberships SET active=0 WHERE tenant_id=? AND user_id=?')
      .run(owner.tenant_id, teammate.id);
    assert.equal(f.deletion.preview(f.req(s)).available, true, 'a removed member no longer holds it back');
    // Work still running in the workspace: a leased job, or a write claimed in the last 15 minutes.
    const now = Date.now(),
      job = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO jobs(id,tenant_id,kind,input,state,available_at,lease_until,created_at,updated_at) VALUES(?,?,'report','{}','running',?,?,?,?)",
      )
      .run(job, owner.tenant_id, now, now + 60000, now, now);
    assert.equal(refusal(s), 'ACCOUNT_DELETION_BUSY');
    assert.throws(() => f.deletion.delete(f.req(s), {confirm: 'team.owner@example.test'}), {
      code: 'ACCOUNT_DELETION_BUSY',
      retryable: true,
    });
    f.store.db.prepare("UPDATE jobs SET state='complete',lease_until=NULL WHERE id=?").run(job);
    f.store.db
      .prepare("INSERT INTO idempotency(tenant_id,key,fingerprint,state,created_at) VALUES(?,?,?,'pending',?)")
      .run(owner.tenant_id, 'claim-1', 'fingerprint', now - 60000);
    assert.equal(refusal(s), 'ACCOUNT_DELETION_BUSY');
    f.store.db.prepare('UPDATE idempotency SET created_at=? WHERE key=?').run(now - 16 * 60000, 'claim-1');
    assert.equal(f.deletion.preview(f.req(s)).available, true, 'an abandoned claim older than 15 minutes is not work');
    // The AMCP owner (the deployment workspace's owner) moves the deployment to another owner first.
    const amcpOwner = randomUUID();
    f.store.db
      .prepare(
        "INSERT INTO amcp_users(id,email,name,tenant_id,approved,created_at) VALUES(?,'amcp.owner@example.test','AMCP Owner','local',1,?)",
      )
      .run(amcpOwner, now);
    member(f.store, 'local', amcpOwner, 'owner');
    const o = f.accounts.session(f.accounts.user(amcpOwner), 'local');
    assert.equal(refusal(o), 'ACCOUNT_DELETION_OWNER');
    assert.throws(() => f.deletion.delete(f.req(o), {confirm: 'amcp.owner@example.test'}), {
      code: 'ACCOUNT_DELETION_OWNER',
    });
    assert.equal(userExists(f.store, amcpOwner), true);
    // The administrator door has no personal account to delete.
    const admin = await f.web.signIn(door, '127.0.0.1');
    assert.throws(() => f.deletion.preview(f.req(admin)), {code: 'ACCOUNT_DELETION_UNAVAILABLE', status: 403});
    assert.throws(() => f.deletion.delete(f.req(admin), {confirm: 'anything'}), {code: 'ACCOUNT_DELETION_UNAVAILABLE'});
    assert.equal(auditEvents(f.store, 'local', 'account_erased').length, 0);
  } finally {
    f.store.close();
  }
});

test('P3: AMCP_ACCOUNT_SELF_DELETION=off leaves deletion to the operator; the preview says so', () => {
  const f = fixture({AMCP_ACCOUNT_SELF_DELETION: 'off'});
  try {
    const person = f.accounts.newUser('Operator Handled', 'operator.handled@example.test', null, true),
      s = f.accounts.session(person),
      preview = f.deletion.preview(f.req(s));
    assert.equal(preview.available, false);
    assert.equal((preview.refusal as JsonObject).code, 'ACCOUNT_DELETION_DISABLED');
    assert.throws(() => f.deletion.delete(f.req(s), {confirm: 'operator.handled@example.test'}), {
      code: 'ACCOUNT_DELETION_DISABLED',
      status: 403,
    });
    assert.equal(userExists(f.store, person.id), true);
  } finally {
    f.store.close();
  }
});

test('P3: over HTTP the deletion ends the browser session and clears its session and known-device cookies', async () => {
  const store = new Store(':memory:', master),
    app = createHttpApp(new MirrorService(new Registry(), store), store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        authEnv: {},
        fetcher: async () => {
          throw Error('No provider or e-mail traffic allowed');
        },
      },
    });
  const listener = await listenForFetch(app),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port,
    accounts = app.locals.website.accounts as UserAccounts,
    person = accounts.newUser('HTTP Person', 'http.person@example.test', await hashUserPassword(password), true);
  const call = (url: string, method = 'GET', body?: JsonObject, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method,
      headers: {
        origin,
        'sec-fetch-site': 'same-origin',
        ...(body ? {'content-type': 'application/json'} : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const login = await call('/api/account/login', 'POST', {email: person.email, password});
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!,
      headers = {cookie, 'x-amcp-csrf': ((await login.json()) as JsonObject).csrf as string};
    const preview = await call('/api/account/deletion', 'GET', undefined, headers);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(((await preview.json()) as JsonObject).available, true);
    const wrong = await call('/api/account/delete', 'POST', {confirm: 'nobody@example.test'}, headers);
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as JsonObject).error.code, 'ACCOUNT_DELETION_CONFIRMATION');
    const deleted = await call('/api/account/delete', 'POST', {confirm: 'http.person@example.test'}, headers);
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const body = (await deleted.json()) as JsonObject;
    assert.equal(body.deleted, true);
    assert.equal((body.receipt as JsonObject).reason, 'self_service');
    const cleared = deleted.headers.getSetCookie();
    assert.ok(
      cleared.some(c => c.startsWith('__Host-amcp_session=;') && /Max-Age=0/.test(c)),
      cleared.join(' | '),
    );
    assert.ok(
      cleared.some(c => c.startsWith('__Host-amcp_device=;') && /Max-Age=0/.test(c)),
      cleared.join(' | '),
    );
    const after = await call('/api/session', 'GET', undefined, headers);
    assert.equal(((await after.json()) as JsonObject).authenticated, false);
    assert.equal(userExists(store, person.id), false);
    assert.equal(store.verifyAudit(), true);
  } finally {
    listener.closeAllConnections();
    await new Promise(r => listener.close(r));
    store.close();
  }
});
