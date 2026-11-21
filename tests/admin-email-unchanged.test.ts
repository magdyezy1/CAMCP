// r25-admin-email, item 5: what the variable does not change. The two-step rule for owners and administrators of
// write-enabled workspaces still applies to the second owner, with its grace period; the owner-only controls stay the
// owners' (an administrator given by hand still cannot use them); with the variable unset nothing is granted, marked or
// audited. These tests pin behaviour that needed no change. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAddress, site, type Site} from './helpers/admin-email-site.js';
import type {JsonObject} from '../src/types.js';

const day = 86400000;
const writeEnable = (f: Site) =>
  f.store.putConnection(
    {tenantId: f.tenant, userId: 'owner', role: 'admin'},
    {
      id: 'meta-login',
      tenantId: f.tenant,
      gateway: 'meta_native_action',
      accounts: ['111'],
      enabled: true,
      label: 'Synthetic Meta login',
      scopes: [],
      writeAccounts: ['111'],
    },
    {accessToken: 'synthetic'},
  );
const account = async (f: Site, headers: Record<string, string>) =>
  (await (await f.request('/api/account', 'GET', undefined, headers)).json()) as JsonObject;

test('two-step verification: the second owner of a write-enabled workspace gets the grace period, then MFA_ENROLLMENT_REQUIRED', async () => {
  const env = {AMCP_REQUIRE_MFA: 'admins', AMCP_MFA_GRACE_DAYS: '14'};
  const f = await site({adminEmail: adminAddress, env, allowWrites: true});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    writeEnable(f);
    const inside = (await f.switchTo(await f.signedIn(adminAddress))).headers!;
    let profile = await account(f, inside);
    assert.equal(profile.workspaceRole, 'owner');
    assert.equal(profile.mfaRequired, true);
    assert.equal(profile.mfaEnrollmentRequired, false, 'the grace period has not ended');
    assert.ok(Number(profile.mfaRequiredBy) > Date.now() + 13 * day, 'a role granted now has its full grace period');
    assert.equal((await f.request('/api/connector-tokens', 'GET', undefined, inside)).status, 200);

    // Thirty days on: the membership, the workspace's write grant and the baseline all began then, so the period is over.
    const since = JSON.stringify({since: Date.now() - 30 * day});
    f.store.db
      .prepare('UPDATE workspace_memberships SET created_at=? WHERE tenant_id=? AND user_id=?')
      .run(Date.now() - 30 * day, f.tenant, person.id);
    for (const id of ['mfa_baseline', 'mfa_write_enabled'])
      f.store.db
        .prepare("UPDATE documents SET data=? WHERE tenant_id=? AND kind='account_settings' AND id=?")
        .run(since, f.tenant, id);
    const g = await f.restart({adminEmail: adminAddress});
    try {
      const late = (await g.switchTo(await g.signedIn(adminAddress))).headers!;
      profile = await account(g, late);
      assert.equal(profile.mfaEnrollmentRequired, true);
      const blocked = await g.request('/api/connector-tokens', 'GET', undefined, late);
      assert.equal(blocked.status, 403);
      assert.equal(((await blocked.json()) as JsonObject).error.code, 'MFA_ENROLLMENT_REQUIRED');
      // Sign-in, the session and the enrollment routes stay reachable, as for any covered member.
      assert.equal((await g.request('/api/session', 'GET', undefined, late)).status, 200);
      assert.equal((await g.request('/api/account/mfa/start', 'POST', {}, late)).status, 200);
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('the owner-only controls stay the owners’: a hand-given administrator is refused, both owners may use them', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    const original = await f.deploymentOwner('owner@example.test'),
      second = await f.account(adminAddress, 'Second owner'),
      plain = await f.account('plain-admin@example.test');
    f.store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'admin',?)")
      .run(f.tenant, plain.id, Date.now());
    const as = async (email: string, own: boolean) => {
      const signed = await f.signedIn(email);
      return own ? signed : (await f.switchTo(signed)).headers!;
    };
    const control = (headers: Record<string, string>) =>
      f.request('/api/export-policy', 'POST', {viewer_downloads: true, confirmed: true}, headers);
    const refused = await control(await as('plain-admin@example.test', false));
    assert.equal(refused.status, 403);
    assert.equal(((await refused.json()) as JsonObject).error.code, 'OWNER_REQUIRED');
    for (const [email, own] of [
      ['owner@example.test', true],
      [adminAddress, false],
    ] as const)
      assert.equal((await control(await as(email, own))).status, 200, email);
    assert.ok(original && second);
  } finally {
    await f.close();
  }
});

test('without the variable nothing is granted, marked or audited, however the person signs in', async () => {
  const f = await site({social: {email: adminAddress, verified: true, subject: 'unset-google'}});
  try {
    await f.deploymentOwner();
    // The address that would be the administrator's, registering and signing in by every route.
    assert.equal(
      (await f.request('/api/account/register', 'POST', {name: 'Some person', email: adminAddress})).status,
      200,
    );
    await f.request('/api/account/verify-email', 'POST', {...f.link(), password: f.password});
    const pending = await f.login(adminAddress);
    assert.equal(pending.status, 403, 'a sign-up still waits for the owner’s approval');
    assert.equal(pending.body.error.code, 'ACCOUNT_PENDING_APPROVAL');
    f.store.db.prepare('UPDATE amcp_users SET approved=1 WHERE email=?').run(adminAddress);
    await f.signedIn(adminAddress);
    const person = f.store.db.prepare('SELECT id FROM amcp_users WHERE email=?').get(adminAddress) as JsonObject;
    assert.equal(f.membership(person.id), undefined);
    const google = await f.social('google');
    assert.match(String(google.headers.get('location')), /error=ACCOUNT_EXISTS/);
    assert.equal(f.grants().length, 0);
    assert.equal(f.events().filter(e => String(e.event).startsWith('admin_email')).length, 0);
    // The memberships table is exactly what it was: five columns, so the positional inserts of other code and tests work.
    const columns = (
      f.store.db.prepare("SELECT name FROM pragma_table_info('workspace_memberships')").all() as {name: string}[]
    ).map(c => c.name);
    assert.deepEqual(columns, ['tenant_id', 'user_id', 'role', 'active', 'created_at']);
    f.store.db
      .prepare('INSERT INTO workspace_memberships VALUES(?,?,?,?,?)')
      .run('positional', 'person', 'viewer', 1, Date.now());
    assert.equal(f.membership('person', 'positional')!.role, 'viewer');
  } finally {
    await f.close();
  }
});
