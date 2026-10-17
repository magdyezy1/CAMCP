// SEC-06 S3 and S4 (review 2026-10-08, R04 mfa-enforcement-and-recovery, invitation-lifetime-and-revocation). Before
// this change two-step verification was opt-in per person with no workspace policy: neither owner spending authority nor
// personal-data uploads could require it, recovery codes could not be replaced, nobody could reset a member who lost
// their authenticator, invitations always expired after 30 minutes and could not be withdrawn. Synthetic only.
import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {assertTwoStepSession, ownerAccess} from '../src/spend-policy.js';
import {createHttpApp} from '../server/http-app.js';
import {WebStore, type WebSession} from '../server/web-store.js';
import {UserAccounts, hashUserPassword} from '../server/user-accounts.js';
import {AccountSecurity, totp} from '../server/account-security.js';
import {mfaBaseline, mfaBaselineConfig, mfaRequirement} from '../server/mfa-policy.js';
import {removeTestDirectory} from './temp.js';
import type {Actor, JsonObject} from '../src/types.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 83).toString('base64'),
  doorPassword = 'synthetic-mfa-policy-door-password',
  passphrase = 'synthetic mfa policy member passphrase',
  day = 86400000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const emailEnv = {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'AMCP <accounts@example.test>'};

function fixture(authEnv: Record<string, string> = {}) {
  const store = new Store(':memory:', master),
    emails: JsonObject[] = [];
  const web = new WebStore(store, {
      origin,
      masterKey: master,
      adminPassword: doorPassword,
      authEnv: {...emailEnv, ...authEnv},
      fetcher: async (_url, init) => {
        emails.push(JSON.parse(String(init?.body)));
        return new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}});
      },
    }),
    accounts = new UserAccounts(web),
    security = new AccountSecurity(accounts);
  const req = (s?: {id: string; csrf: string}, address = '127.0.0.1'): Request =>
    ({
      headers: {origin: web.origin, ...(s ? {cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf} : {})},
      socket: {remoteAddress: address},
    }) as unknown as Request;
  return {store, web, accounts, security, req, emails};
}
/** Turns two-step verification on for a person and returns their new, two-step-verified session and secret. */
function enroll(f: ReturnType<typeof fixture>, user: JsonObject, tenant = String(user.tenant_id)) {
  const first = f.accounts.session(f.accounts.user(String(user.id)), tenant),
    setup = f.security.beginMfa(f.req(first)),
    enabled = f.security.enableMfa(f.req(first), {ticket: setup.ticket, code: totp(setup.secret)});
  return {session: enabled.session as WebSession, secret: setup.secret, recoveryCodes: enabled.recoveryCodes};
}
const join = (store: Store, tenant: unknown, user: unknown, role: string, joined = Date.now()) =>
  store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(String(tenant), String(user), role, joined);
/** Delivers every queued email, including deliveries already started in the background. */
async function flush(f: {accounts: UserAccounts}) {
  for (let i = 0; i < 5; i++) {
    while (await f.accounts.deliverEmails());
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('SEC-06 S3: the deployment baseline requires owners and administrators of a write-enabled deployment', () => {
  assert.deepEqual(mfaBaselineConfig({}, true), {scope: 'admins', graceMs: 14 * day});
  assert.deepEqual(mfaBaselineConfig({}, false), {scope: 'off', graceMs: 14 * day});
  assert.deepEqual(mfaBaselineConfig({AMCP_REQUIRE_MFA: 'off'}, true).scope, 'off', 'the rollback');
  assert.deepEqual(mfaBaselineConfig({AMCP_REQUIRE_MFA: 'everyone', AMCP_MFA_GRACE_DAYS: '3'}, false), {
    scope: 'everyone',
    graceMs: 3 * day,
  });
  assert.throws(() => mfaBaselineConfig({AMCP_REQUIRE_MFA: 'owners'}, true), /AMCP_REQUIRE_MFA/);
  assert.throws(() => mfaBaselineConfig({AMCP_MFA_GRACE_DAYS: '91'}, true), /AMCP_MFA_GRACE_DAYS/);
  const store = new Store(':memory:', master);
  try {
    store.ensureTenant('local');
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_memberships(tenant_id TEXT,user_id TEXT,role TEXT,active INTEGER DEFAULT 1,created_at INTEGER)',
    );
    const first = mfaBaseline(store, 'local', {scope: 'admins', graceMs: 14 * day});
    // The start is recorded once, so a restart never moves the grace period.
    assert.equal(mfaBaseline(store, 'local', {scope: 'admins', graceMs: 14 * day}).since, first.since);
    const old = {...first, since: Date.now() - 30 * day};
    join(store, 'local', 'long-standing-admin', 'admin', Date.now() - 60 * day);
    join(store, 'local', 'new-admin', 'admin');
    join(store, 'local', 'viewer', 'viewer', Date.now() - 60 * day);
    // P2 covers write-enabled workspaces: without a write grant the baseline does not apply (regression: every
    // self-service owner of a write-enabled deployment was gated).
    const connection = {
      id: 'meta-login',
      tenantId: 'local',
      gateway: 'meta_native_action',
      accounts: ['111'],
      enabled: true,
      label: 'Synthetic Meta login',
      scopes: [],
    };
    store.putConnection({tenantId: 'local', userId: 'owner', role: 'admin'}, connection, {accessToken: 'synthetic'});
    assert.deepEqual(mfaRequirement(store, old, 'local', 'long-standing-admin', 'admin'), {
      required: false,
      by: null,
      workspacePolicy: false,
    });
    // A write grant makes the workspace write-enabled; its grace period counts from then.
    store.putConnection(
      {tenantId: 'local', userId: 'owner', role: 'admin'},
      {...connection, writeAccounts: ['111']},
      {accessToken: 'synthetic'},
    );
    const fresh = mfaRequirement(store, old, 'local', 'long-standing-admin', 'admin');
    assert.equal(fresh.required, true);
    assert.ok(
      fresh.by! > Date.now() + 13 * day,
      'a workspace that just became write-enabled has its full grace period',
    );
    // Long write-enabled: the grace period is over.
    store.db
      .prepare(
        "UPDATE documents SET data=? WHERE tenant_id='local' AND kind='account_settings' AND id='mfa_write_enabled'",
      )
      .run(JSON.stringify({since: Date.now() - 30 * day}));
    const due = mfaRequirement(store, old, 'local', 'long-standing-admin', 'admin');
    assert.equal(due.required, true);
    assert.ok(due.by! < Date.now(), 'its grace period is over');
    assert.ok(mfaRequirement(store, old, 'local', 'new-admin', 'admin').by! > Date.now() + 13 * day);
    assert.equal(mfaRequirement(store, old, 'local', 'viewer', 'viewer').required, false);
    // An owner of another workspace without write grants is not gated by the baseline.
    join(store, 'other', 'other-owner', 'owner', Date.now() - 60 * day);
    assert.equal(mfaRequirement(store, old, 'other', 'other-owner', 'owner').required, false);
    // `everyone` is the stricter explicit choice: every member of every workspace.
    const everyone = {...old, scope: 'everyone' as const};
    assert.equal(mfaRequirement(store, everyone, 'other', 'other-owner', 'owner').required, true);
  } finally {
    store.close();
  }
});

test('SEC-06 S3: an owner without two-step verification cannot require it; with the policy on, an unenrolled member reaches only enrollment routes', async () => {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store, undefined, undefined, {
      allowWrites: true,
      maxBudgetChange: 0,
      requireBeforeState: true,
    });
  const website = {
    origin,
    masterKey: master,
    adminPassword: doorPassword,
    authEnv: {...emailEnv, AMCP_REQUIRE_MFA: 'off'},
    fetcher: async () => new Response('{"id":"mail"}', {headers: {'Content-Type': 'application/json'}}),
  };
  const listener = await listenForFetch(createHttpApp(service, store, {publicOrigin: origin, website}));
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const web = new WebStore(store, website),
    accounts = new UserAccounts(web),
    security = new AccountSecurity(accounts);
  const req = (s: {id: string; csrf: string}): Request =>
    ({
      headers: {origin, cookie: web.cookie(s.id), 'x-amcp-csrf': s.csrf},
      socket: {remoteAddress: '127.0.0.1'},
    }) as unknown as Request;
  const call = async (s: WebSession, url: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + url, {
      method,
      headers: {
        Origin: origin,
        Cookie: web.cookie(s.id).split(';')[0]!,
        'X-AMCP-CSRF': s.csrf,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: r.status, body: (await r.json()) as JsonObject};
  };
  try {
    const owner = accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(passphrase), true),
      member = accounts.newUser('Member', 'member@example.test', await hashUserPassword(passphrase), true);
    join(store, owner.tenant_id, member.id, 'operator');
    // Refusal: requiring two-step verification of others while one's own account does not use it.
    const unenrolled = accounts.session(owner);
    assert.throws(() => security.saveSecurityPolicy(req(unenrolled), {require_mfa: 'everyone', grace_days: 0}), {
      code: 'MFA_ENROLLMENT_REQUIRED',
    });
    // A grace period first: members are told the date and keep working.
    const {session: ownerSession} = (() => {
      const first = accounts.session(owner),
        setup = security.beginMfa(req(first));
      return security.enableMfa(req(first), {ticket: setup.ticket, code: totp(setup.secret)});
    })();
    const saved = security.saveSecurityPolicy(req(ownerSession as WebSession), {
      require_mfa: 'everyone',
      grace_days: 7,
    });
    assert.equal(saved.require_mfa, 'everyone');
    const memberSession = accounts.session(member, owner.tenant_id);
    let profile = await call(memberSession, '/api/account');
    assert.equal(profile.body.mfaRequired, true);
    assert.equal(profile.body.mfaEnrollmentRequired, false);
    assert.ok(Number(profile.body.mfaRequiredBy) > Date.now() + 6 * day);
    assert.equal((await call(memberSession, '/api/connector-tokens')).status, 200);
    // The grace period ends: only sign-in, account and enrollment routes remain.
    store.db
      .prepare(
        "UPDATE documents SET data=json_set(data,'$.grace_until',?) WHERE tenant_id=? AND kind='account_settings' AND id='security'",
      )
      .run(Date.now() - 1000, owner.tenant_id);
    profile = await call(memberSession, '/api/account');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.mfaEnrollmentRequired, true);
    const blocked = await call(memberSession, '/api/connector-tokens');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error?.code, 'MFA_ENROLLMENT_REQUIRED');
    assert.equal((await call(memberSession, '/api/connector-tokens', 'POST', {name: 'x', role: 'reader'})).status, 403);
    assert.equal((await call(memberSession, '/api/session')).status, 200);
    assert.equal((await call(memberSession, '/api/account/sessions')).status, 200);
    const start = await call(memberSession, '/api/account/mfa/start', 'POST', {});
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const enabled = await call(memberSession, '/api/account/mfa/enable', 'POST', {
      ticket: start.body.ticket,
      code: totp(String(start.body.secret)),
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    // Enrolled: the member signs in with the second factor and every route opens again.
    const after = accounts.session(accounts.user(String(member.id)), String(owner.tenant_id), true);
    assert.equal((await call(after, '/api/connector-tokens')).status, 200);
    assert.equal((await call(after, '/api/account')).body.mfaEnrollmentRequired, false);
    // Turning the policy off is recorded in audit like turning it on.
    const fresh = accounts.session(accounts.user(String(owner.id)), String(owner.tenant_id), true);
    assert.equal(security.saveSecurityPolicy(req(fresh), {require_mfa: 'off'}).require_mfa, 'off');
    const events = (store.db.prepare('SELECT event FROM audit ORDER BY seq').all() as {event: string}[])
      .map(r => JSON.parse(r.event))
      .filter(e => e.event === 'workspace_security_policy_saved')
      .map(e => [e.previous_require_mfa, e.require_mfa]);
    assert.deepEqual(events, [
      ['off', 'everyone'],
      ['everyone', 'off'],
    ]);
  } finally {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    store.close();
  }
});

test('SEC-06 S3: while the workspace policy is on, owner authority needs a two-step-verified session', () => {
  const store = new Store(':memory:', master);
  try {
    const actor = {tenantId: 'local', userId: 'workspace-admin', role: 'admin'} as Actor;
    // Without the policy nothing changes: the administrator door and MCP keys keep working.
    assert.doesNotThrow(() => ownerAccess(store, actor, 'save_spend_policy'));
    assert.throws(() => assertTwoStepSession({...actor, mfaPolicy: true}, 'save_spend_policy'), {
      code: 'MFA_STEP_REQUIRED',
    });
    assert.throws(() => assertTwoStepSession({...actor, mfaPolicy: true}, 'execute_personal_data'), {
      code: 'MFA_STEP_REQUIRED',
    });
    assert.doesNotThrow(() => assertTwoStepSession({...actor, mfaPolicy: true, mfaVerified: true}, 'save_retention'));
    // Reads and emergency stops never wait for it.
    for (const action of ['health', 'pause_writes', 'disable_personal_data'])
      assert.doesNotThrow(() => assertTwoStepSession({...actor, mfaPolicy: true}, action));
  } finally {
    store.close();
  }
});

test('SEC-06 S3: new recovery codes need recent proof and a current code, and the previous codes stop working', async () => {
  const f = fixture({AMCP_REQUIRE_MFA: 'off'});
  try {
    const owner = f.accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(passphrase), true),
      {session, secret, recoveryCodes} = enroll(f, owner);
    const step = Math.floor(Date.now() / 30000);
    // Stale session: refused before anything changes.
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now() - 16 * 60000, sha(session.id));
    assert.throws(() => f.security.regenerateRecoveryCodes(f.req(session), {code: totp(secret, step + 1)}), {
      code: 'REAUTH_REQUIRED',
    });
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now(), sha(session.id));
    assert.throws(() => f.security.regenerateRecoveryCodes(f.req(session), {code: '000000'}), {code: 'MFA_INVALID'});
    const replaced = f.security.regenerateRecoveryCodes(f.req(session), {code: totp(secret, step + 1)});
    assert.equal(replaced.recoveryCodes.length, 10);
    assert.notDeepEqual(replaced.recoveryCodes, recoveryCodes);
    assert.throws(() => f.security.verifyCode(String(owner.id), recoveryCodes[0]), {code: 'MFA_INVALID'});
    assert.doesNotThrow(() => f.security.verifyCode(String(owner.id), replaced.recoveryCodes[0]));
    // The session that asked stays signed in, and the person is told.
    assert.ok(f.web.session(f.req(session)));
    await flush(f);
    assert.ok(f.emails.some(e => /previous recovery codes no longer work/.test(String(e.text))));
  } finally {
    f.store.close();
  }
});

test('SEC-06 S3: the AMCP owner resets a member who lost their authenticator, ending all of their access', async () => {
  const f = fixture({AMCP_REQUIRE_MFA: 'off'});
  try {
    const member = f.accounts.newUser('Member', 'member@example.test', await hashUserPassword(passphrase), true),
      plain = f.accounts.newUser('Plain', 'plain@example.test', await hashUserPassword(passphrase), true),
      outsider = f.accounts.newUser('Outsider', 'outsider@example.test', await hashUserPassword(passphrase), true),
      {session: memberSession} = enroll(f, member);
    const token = f.store.createKey({
      tenantId: String(member.tenant_id),
      userId: 'connector/' + 'member-token',
      role: 'reader',
    });
    f.store.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha(token), member.id);
    // Refusals: someone else's workspace owner, a stale owner session, and a member who has nothing to reset.
    const outsiderSession = f.accounts.session(outsider);
    assert.throws(() => f.security.resetMemberMfa(f.req(outsiderSession), {user_id: member.id}), {
      code: 'OWNER_REQUIRED',
    });
    const admin = await f.web.signIn(doorPassword, '127.0.0.1');
    f.store.db
      .prepare("UPDATE amcp_web_sessions SET actor=json_set(actor,'$.signedInAt',?) WHERE hash=?")
      .run(Date.now() - 16 * 60000, sha(admin.id));
    assert.throws(() => f.security.resetMemberMfa(f.req(admin), {user_id: member.id}), {code: 'REAUTH_REQUIRED'});
    assert.ok(f.accounts.hasMfa(String(member.id)));
    await f.security.reauthenticate(f.req(admin), {password: doorPassword});
    assert.throws(() => f.security.resetMemberMfa(f.req(admin), {user_id: plain.id}), {code: 'MFA_NOT_ENABLED'});
    assert.deepEqual(f.security.resetMemberMfa(f.req(admin), {user_id: member.id}), {
      success: true,
      mfaEnabled: false,
    });
    assert.equal(f.accounts.hasMfa(String(member.id)), false);
    assert.equal(f.web.session(f.req(memberSession)), undefined, 'their sessions ended');
    assert.throws(() => f.store.authenticate(token), {code: 'UNAUTHORIZED'});
    await flush(f);
    assert.ok(
      f.emails.some(e => e.to?.includes?.('member@example.test') && /reset two-step verification/.test(String(e.text))),
    );
    const audit = (f.store.db.prepare('SELECT event FROM audit').all() as {event: string}[]).map(r =>
      JSON.parse(r.event),
    );
    assert.ok(
      audit.some(e => e.event === 'account_mfa_reset' && e.user_id === member.id && e.by === 'workspace-admin'),
    );
  } finally {
    f.store.close();
  }
});

test('SEC-06 S3: `admin mfa-reset <email>` turns two-step verification off and ends the personâ€™s access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-mfa-reset-')),
    database = path.join(dir, 'amcp.sqlite');
  try {
    let memberId: string, token: string;
    {
      const store = new Store(database, master),
        web = new WebStore(store, {origin, masterKey: master, authEnv: emailEnv}),
        accounts = new UserAccounts(web),
        security = new AccountSecurity(accounts);
      const member = accounts.newUser('Member', 'member@example.test', await hashUserPassword(passphrase), true);
      memberId = String(member.id);
      const first = accounts.session(member),
        setup = security.beginMfa({
          headers: {origin, cookie: web.cookie(first.id), 'x-amcp-csrf': first.csrf},
          socket: {remoteAddress: '127.0.0.1'},
        } as unknown as Request);
      security.enableMfa(
        {
          headers: {origin, cookie: web.cookie(first.id), 'x-amcp-csrf': first.csrf},
          socket: {remoteAddress: '127.0.0.1'},
        } as unknown as Request,
        {ticket: setup.ticket, code: totp(setup.secret)},
      );
      token = store.createKey({tenantId: String(member.tenant_id), userId: 'connector/cli-reset', role: 'reader'});
      store.db.prepare('INSERT INTO credential_owners VALUES(?,?)').run(sha(token), memberId);
      store.close();
    }
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [path.resolve('dist/tools/admin.js'), ...args], {
        encoding: 'utf8',
        env: {...process.env, MIRROR_DB: database, MIRROR_MASTER_KEY: master, NODE_ENV: 'test'},
        timeout: 30000,
      });
    const missing = run('mfa-reset', 'nobody@example.test');
    assert.notEqual(missing.status, 0);
    const reset = run('mfa-reset', 'MEMBER@example.test');
    assert.equal(reset.status, 0, reset.stderr);
    const out = JSON.parse(reset.stdout);
    assert.equal(out.reset, true);
    assert.equal(out.connectorKeys, 1);
    const store = new Store(database, master);
    try {
      assert.equal(store.db.prepare('SELECT 1 FROM amcp_mfa WHERE user_id=?').get(memberId), undefined);
      assert.throws(() => store.authenticate(token), {code: 'UNAUTHORIZED'});
      assert.ok(
        (store.db.prepare('SELECT event FROM audit').all() as {event: string}[]).some(
          r => JSON.parse(r.event).event === 'account_mfa_reset',
        ),
      );
    } finally {
      store.close();
    }
    assert.notEqual(run('mfa-reset', 'member@example.test').status, 0, 'nothing left to reset');
  } finally {
    removeTestDirectory(dir, 'amcp-mfa-reset-');
  }
});

test('SEC-06 S4: invitations last the owner-set lifetime (7 days by default, owner decision P2) and a withdrawn invitation is refused', async () => {
  // Owner decision P2 (2026-10-11) set the invitation lifetime to 7 days; the default before it was 72 hours, so an
  // invitation sent on a Friday expired before the invitee's Tuesday (regression: 72-hour default).
  const f = fixture({AMCP_REQUIRE_MFA: 'off'});
  try {
    const owner = f.accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(passphrase), true),
      s = f.accounts.session(owner);
    const tokens: string[] = [];
    const invite = async (email: string) => {
      const result = await f.security.invite(f.req(s), {email, role: 'viewer'});
      await flush(f);
      const mail = f.emails.findLast(e => e.to?.includes?.(email));
      tokens.push(/token=([\w-]{43})/.exec(String(mail?.text))![1]!);
      return result;
    };
    const first = await invite('first@example.test');
    const lifetime = (id: string) => {
      const doc = f.store.document(String(owner.tenant_id), 'workspace_invite', id);
      return Number(doc.expires_at) - Number(doc.created_at);
    };
    assert.equal(lifetime(String(first.id)), 7 * day);
    assert.ok(Math.abs(Number(first.expires_at) - (Date.now() + 7 * day)) < 60000);
    // The link itself lasts the same 7 days, and the members list states the default.
    const firstLink = f.store.db
      .prepare("SELECT expires_at FROM amcp_account_challenges WHERE hash=? AND kind='invite'")
      .get(sha(tokens[0]!)) as JsonObject;
    assert.ok(Math.abs(Number(firstLink.expires_at) - Number(first.expires_at)) < 1000);
    assert.equal(f.security.members(f.req(s)).security.invitation_hours, 168);
    // The owner shortens it to 2 hours; the link itself expires then too.
    assert.throws(() => f.security.saveSecurityPolicy(f.req(s), {require_mfa: 'off', invitation_hours: 169}), {
      code: 'INVALID_ARGUMENT',
    });
    f.security.saveSecurityPolicy(f.req(s), {require_mfa: 'off', invitation_hours: 2});
    const second = await invite('second@example.test');
    assert.equal(lifetime(String(second.id)), 2 * 3600000);
    const link = f.store.db
      .prepare("SELECT expires_at FROM amcp_account_challenges WHERE hash=? AND kind='invite'")
      .get(sha(tokens[1]!)) as JsonObject;
    assert.ok(Math.abs(Number(link.expires_at) - Number(second.expires_at)) < 1000);
    // Pending invitations are listed without the address or the link.
    const listed = f.security.members(f.req(s)).invitations as JsonObject[];
    assert.deepEqual(listed.map(i => i.id).sort(), [first.id, second.id].sort());
    assert.ok(listed.every(i => !('emailHash' in i) && !('challengeHash' in i)));
    // Withdrawn: the link stops working at once and the invitation leaves the list.
    assert.deepEqual(f.security.revokeInvitation(f.req(s), String(first.id)), {success: true});
    await assert.rejects(f.security.accept(f.req(), {token: tokens[0], name: 'First', password: passphrase}), {
      code: 'LINK_EXPIRED',
    });
    assert.throws(() => f.security.revokeInvitation(f.req(s), String(first.id)), {code: 'INVITATION_NOT_PENDING'});
    assert.throws(() => f.security.revokeInvitation(f.req(s), 'unknown'), {code: 'NOT_FOUND'});
    assert.deepEqual(
      (f.security.members(f.req(s)).invitations as JsonObject[]).map(i => i.id),
      [second.id],
    );
    // An invitation sent before this change has no link hash: withdrawing it still refuses its link at acceptance.
    const third = await invite('third@example.test');
    const doc = f.store.document(String(owner.tenant_id), 'workspace_invite', String(third.id));
    const {id: _id, revision: _revision, challengeHash: _hash, ...legacy} = doc;
    f.store.putDocument(String(owner.tenant_id), 'workspace_invite', String(third.id), legacy);
    f.security.revokeInvitation(f.req(s), String(third.id));
    await assert.rejects(f.security.accept(f.req(), {token: tokens[2], name: 'Third', password: passphrase}), {
      code: 'INVITATION_REVOKED',
    });
    // The pending one is accepted while it is current, and refused once its lifetime is over.
    f.store.db
      .prepare("UPDATE amcp_account_challenges SET expires_at=? WHERE hash=? AND kind='invite'")
      .run(Date.now() - 1, sha(tokens[1]!));
    await assert.rejects(f.security.accept(f.req(), {token: tokens[1], name: 'Second', password: passphrase}), {
      code: 'LINK_EXPIRED',
    });
    const audit = (f.store.db.prepare('SELECT event FROM audit').all() as {event: string}[]).map(r =>
      JSON.parse(r.event),
    );
    assert.equal(audit.filter(e => e.event === 'workspace_invitation_revoked').length, 2);
  } finally {
    f.store.close();
  }
});

test('SEC-06 S4 (owner decision P2): a default invitation is accepted six days after it was sent; one past its seven days is refused', async () => {
  // Regression: under the earlier 72-hour default an invitation six days old was already refused with LINK_EXPIRED.
  const f = fixture({AMCP_REQUIRE_MFA: 'off'});
  try {
    const owner = f.accounts.newUser('Owner', 'owner@example.test', await hashUserPassword(passphrase), true),
      s = f.accounts.session(owner),
      tenant = String(owner.tenant_id);
    /** Sends an invitation, then moves it and its link `age` into the past, as if it had been sent then. */
    const sentAgo = async (email: string, age: number) => {
      const result = await f.security.invite(f.req(s), {email, role: 'viewer'});
      await flush(f);
      const token = /token=([\w-]{43})/.exec(String(f.emails.findLast(e => e.to?.includes?.(email))?.text))![1]!;
      f.store.db
        .prepare("UPDATE amcp_account_challenges SET expires_at=expires_at-? WHERE hash=? AND kind='invite'")
        .run(age, sha(token));
      const doc = f.store.document(tenant, 'workspace_invite', String(result.id));
      const {id: _id, revision: _revision, ...data} = doc;
      f.store.putDocument(tenant, 'workspace_invite', String(result.id), {
        ...data,
        created_at: Number(doc.created_at) - age,
        expires_at: Number(doc.expires_at) - age,
      });
      return token;
    };
    const late = await sentAgo('late@example.test', 6 * day);
    const accepted = await f.security.accept(f.req(), {token: late, name: 'Late', password: passphrase});
    assert.equal(accepted.workspaceId, tenant);
    assert.ok(
      f.store.db
        .prepare(
          'SELECT 1 FROM workspace_memberships m JOIN amcp_users u ON u.id=m.user_id WHERE u.email=? AND m.active=1',
        )
        .get('late@example.test'),
      'the six-day-old invitation made a membership',
    );
    const expired = await sentAgo('expired@example.test', 7 * day + 60000);
    await assert.rejects(f.security.accept(f.req(), {token: expired, name: 'Expired', password: passphrase}), {
      code: 'LINK_EXPIRED',
    });
    assert.equal(
      f.store.db.prepare('SELECT 1 FROM amcp_users WHERE email=?').get('expired@example.test'),
      undefined,
      'an expired invitation creates no account',
    );
  } finally {
    f.store.close();
  }
});

test('SEC-06 S4: the members list states the invitation lifetime in days when it is whole days, otherwise in hours', () => {
  // The website's own wording of the lifetime (web/account-security.js): the 7-day default reads "7 days", not
  // "168 hours"; an owner's shorter lifetime in hours is stated as set.
  const source = fs.readFileSync('web/account-security.js', 'utf8'),
    start = source.indexOf('function invitationLifetimeNote'),
    end = source.indexOf('\nrenderAuthPage = ', start);
  assert.ok(start >= 0 && end > start, 'web/account-security.js defines invitationLifetimeNote');
  const note = new Function('uiText', source.slice(start, end) + '\nreturn invitationLifetimeNote;')(
    (text: string, values: Record<string, unknown> = {}) =>
      text.replace(/\{(\w+)\}/g, (_: string, k: string) => String(values[k])),
  ) as (hours: number) => string;
  assert.match(note(168), /^Invitations expire after 7 days\./);
  assert.match(note(48), /^Invitations expire after 2 days\./);
  assert.match(note(2), /^Invitations expire after 2 hours\./);
  assert.match(note(30), /^Invitations expire after 30 hours\./);
});
