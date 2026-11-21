// r25-admin-email, item 3': when the variable is removed or names another address, the membership it granted goes back to
// the role that person held before the grant, or ends when they held none; their sessions, connector tokens and AI-client
// connections of the workspace stop; the audit row names the user ID and never the address. A role given by hand, and the
// original owner, are never touched. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {memberAccessSetId, setMemberAccessSet} from '../src/access-sets.js';
import {UserAccounts} from '../server/user-accounts.js';
import {WebStore} from '../server/web-store.js';
import {adminEmailFrom, reconcileAdminEmailGrants} from '../server/admin-email.js';
import {adminAddress, master, origin, site, type Site} from './helpers/admin-email-site.js';
import type {JsonObject} from '../src/types.js';

const revoked = (f: Site) => f.events().filter(e => e.event === 'admin_email_owner_revoked');
const setMembership = (f: Site, userId: unknown, role: string) =>
  f.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(f.tenant, userId as string, role, Date.now());
/** A refresh grant the person approved in the deployment workspace, as an AI client holds one. */
const aiClient = (f: Site, userId: unknown) =>
  f.store.db
    .prepare('INSERT INTO amcp_mcp_grants(hash,kind,client_id,tenant_id,data,expires_at,used) VALUES(?,?,?,?,?,?,0)')
    .run(
      'synthetic-grant-hash',
      'refresh',
      'synthetic-client',
      f.tenant,
      JSON.stringify({family: 'synthetic-family', scope: 'mcp:read', ownerUserId: userId}),
      Date.now() + 86400000,
    );

test('unsetting the variable ends the second owner: sessions, tokens and AI clients stop, and the audit row names no address', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    const original = await f.deploymentOwner(),
      second = await f.account(adminAddress, 'Second owner'),
      untouched = {...f.membership(original.id)};
    const inside = (await f.switchTo(await f.signedIn(adminAddress))).headers!;
    const minted = (await (
      await f.request('/api/connector-tokens', 'POST', {name: 'Synthetic connector', role: 'reader'}, inside)
    ).json()) as JsonObject;
    assert.ok(typeof minted.token === 'string', JSON.stringify(minted));
    f.store.assertActorActive(f.store.authenticate(minted.token));
    aiClient(f, second.id);
    assert.equal(
      ((await (await f.request('/api/session', 'GET', undefined, inside)).json()) as JsonObject).workspaceRole,
      'owner',
    );

    const g = await f.restart({adminEmail: undefined});
    try {
      assert.deepEqual(
        {...g.membership(second.id)},
        {
          role: 'viewer',
          active: 0,
          granted_by: null,
          granted_from: null,
          created_at: g.membership(second.id)!.created_at,
        },
      );
      // The session of that workspace stopped at once.
      assert.equal(
        ((await (await g.request('/api/session', 'GET', undefined, inside)).json()) as JsonObject).authenticated,
        false,
      );
      // The connector token is revoked, and a credential presented without that revocation meets the membership check.
      assert.throws(() => g.store.authenticate(minted.token), {code: 'UNAUTHORIZED'});
      assert.throws(
        () =>
          g.store.assertActorActive({
            tenantId: g.tenant,
            userId: 'connector/other',
            role: 'reader',
            ownerUserId: String(second.id),
          }),
        {code: 'MEMBERSHIP_REVOKED'},
      );
      // The AI client connection ended with the reason a membership change gives.
      const grant = g.store.db.prepare('SELECT used,data FROM amcp_mcp_grants').get() as JsonObject;
      assert.equal(grant.used, 1);
      assert.equal(JSON.parse(grant.data).ended_reason, 'membership_change');
      // One audit row, with the user ID, no address; the AMCP owner is as it was.
      assert.equal(revoked(g).length, 1);
      assert.equal(revoked(g)[0]!.user_id, second.id);
      assert.equal(revoked(g)[0]!.restored_role ?? null, null);
      assert.ok(!JSON.stringify(g.events()).toLowerCase().includes('example.test'));
      assert.deepEqual({...g.membership(original.id)}, untouched);
      // The person can still sign in, to their own workspace, and is not granted again.
      await g.signedIn(adminAddress);
      assert.equal(g.membership(second.id)!.active, 0);
      assert.equal(revoked(g).length, 1);
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('the role held before the grant comes back, and a role given by hand is never touched', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    const original = await f.deploymentOwner(),
      person = await f.account(adminAddress),
      other = await f.account('hand-given-admin@example.test');
    // The person was an administrator by hand before the variable made them an owner.
    setMembership(f, person.id, 'admin');
    setMembership(f, other.id, 'admin');
    const handCreated = f.membership(other.id)!.created_at;
    await f.signedIn(adminAddress);
    assert.equal(f.membership(person.id)!.role, 'owner');
    assert.equal(f.membership(person.id)!.granted_from, 'admin');
    const otherHeaders = (await f.switchTo(await f.signedIn('hand-given-admin@example.test'))).headers!;
    const originalKept = {...f.membership(original.id)};

    const g = await f.restart({adminEmail: undefined});
    try {
      assert.deepEqual(
        {...g.membership(person.id)},
        {
          role: 'admin',
          active: 1,
          granted_by: null,
          granted_from: null,
          created_at: g.membership(person.id)!.created_at,
        },
      );
      assert.equal(revoked(g)[0]!.restored_role, 'admin');
      // The administrator given by hand: untouched, still signed in.
      assert.deepEqual(
        {...g.membership(other.id)},
        {role: 'admin', active: 1, granted_by: null, granted_from: null, created_at: handCreated},
      );
      assert.equal(
        ((await (await g.request('/api/session', 'GET', undefined, otherHeaders)).json()) as JsonObject).authenticated,
        true,
      );
      assert.deepEqual({...g.membership(original.id)}, originalKept);
      assert.equal(revoked(g).length, 1);
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('the AMCP owner is never affected, even when the variable names that owner’s address and is then removed', async () => {
  const f = await site({adminEmail: 'owner@example.test'});
  try {
    const original = await f.deploymentOwner('owner@example.test');
    await f.signedIn('owner@example.test');
    const kept = {...f.membership(original.id)},
      headers = await f.signedIn('owner@example.test');
    const g = await f.restart({adminEmail: undefined});
    try {
      assert.deepEqual({...g.membership(original.id)}, kept);
      assert.equal(revoked(g).length, 0);
      assert.equal(
        ((await (await g.request('/api/session', 'GET', undefined, headers)).json()) as JsonObject).authenticated,
        true,
      );
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('a variable that names another address ends the first person’s role, and the other person gets it at their next sign-in', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const first = await f.account(adminAddress),
      next = await f.account('next-admin@example.test');
    await f.signedIn(adminAddress);
    const g = await f.restart({adminEmail: 'Next-Admin@Example.test'});
    try {
      assert.equal(g.membership(first.id)!.active, 0);
      assert.equal(g.membership(next.id), undefined, 'nothing is granted before the next sign-in');
      await g.signedIn('next-admin@example.test');
      assert.equal(g.membership(next.id)!.role, 'owner');
      await g.signedIn(adminAddress);
      assert.equal(g.membership(first.id)!.active, 0);
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('a member limited to a client access set gets that limit back with the old role', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    setMembership(f, person.id, 'operator');
    setMemberAccessSet(f.store, f.tenant, String(person.id), 'synthetic-set');
    await f.signedIn(adminAddress);
    assert.equal(f.membership(person.id)!.role, 'owner');
    assert.equal(memberAccessSetId(f.store, f.tenant, String(person.id)), undefined, 'an owner is never limited');
    assert.equal(f.membership(person.id)!.granted_from, 'operator:synthetic-set');
    const g = await f.restart({adminEmail: undefined});
    try {
      assert.equal(g.membership(person.id)!.role, 'operator');
      assert.equal(memberAccessSetId(g.store, g.tenant, String(person.id)), 'synthetic-set');
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('changing the account’s address ends the grant at once, without a restart', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    const headers = await f.signedIn(adminAddress);
    assert.equal(f.membership(person.id)!.role, 'owner');
    assert.equal((await f.request('/api/account/email', 'POST', {email: 'moved@example.test'}, headers)).status, 200);
    const changed = await f.request('/api/account/verify-email', 'POST', f.link());
    assert.equal(changed.status, 200);
    assert.equal(
      (f.store.db.prepare('SELECT email FROM amcp_users WHERE id=?').get(person.id) as JsonObject).email,
      'moved@example.test',
    );
    assert.equal(f.membership(person.id)!.active, 0);
    assert.equal(f.membership(person.id)!.granted_by, null);
    assert.equal(revoked(f).length, 1);
    // Signing in with the new address does not bring it back.
    await f.signedIn('moved@example.test');
    assert.equal(f.membership(person.id)!.active, 0);
  } finally {
    await f.close();
  }
});

test('a stale grant an older process wrote is ended at that person’s next request', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    await f.signedIn(adminAddress);
    const g = await f.restart({adminEmail: undefined});
    try {
      const ended = revoked(g).length;
      // A process that still held the variable (a deployment overlapping this start) grants again after the start-up pass.
      g.store.db
        .prepare(
          "UPDATE workspace_memberships SET role='owner',active=1,granted_by='env:AMCP_ADMIN_EMAIL',granted_from=NULL WHERE tenant_id=? AND user_id=?",
        )
        .run(g.tenant, person.id);
      const s = g.accounts.session(g.accounts.user(String(person.id)), g.tenant);
      const headers = {Cookie: g.web.cookie(s.id), 'X-AMCP-CSRF': s.csrf};
      const answer = (await (await g.request('/api/session', 'GET', undefined, headers)).json()) as JsonObject;
      assert.equal(answer.authenticated, false);
      assert.equal(g.membership(person.id)!.active, 0);
      assert.equal(revoked(g).length, ended + 1);
    } finally {
      await g.close();
    }
  } catch (error) {
    await f.close().catch(() => undefined);
    throw error;
  }
});

test('the worker, which builds no website and holds no variable, never ends a grant', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    await f.signedIn(adminAddress);
    const before = {...f.membership(person.id)};
    // What server/worker.ts builds: accounts over a store, with no website options for the variable.
    new UserAccounts(new WebStore(f.store, {origin, masterKey: master}));
    assert.deepEqual({...f.membership(person.id)}, before);
    assert.equal(revoked(f).length, 0);
  } finally {
    await f.close();
  }
});

test('the end-of-grant pass keeps what the variable still justifies and ends the rest', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress);
    await f.signedIn(adminAddress);
    const pass = (configured: string | undefined, tenant = f.tenant) =>
      reconcileAdminEmailGrants(f.store, tenant, configured);
    assert.equal(pass(adminAddress), 0, 'justified');
    assert.equal(pass(adminEmailFrom('  ' + adminAddress.toUpperCase())), 0, 'the same address in another spelling');
    // Each of these takes the justification away; the grant is made again by hand between them.
    const regrant = () =>
      f.store.db
        .prepare(
          "UPDATE workspace_memberships SET role='owner',active=1,granted_by='env:AMCP_ADMIN_EMAIL',granted_from=NULL WHERE tenant_id=? AND user_id=?",
        )
        .run(f.tenant, person.id);
    const set = (sql: string) => f.store.db.prepare(sql).run(person.id);
    for (const [name, change, configured, tenant] of [
      ['a disabled account', () => set('UPDATE amcp_users SET disabled=1 WHERE id=?'), adminAddress, f.tenant],
      [
        'a test account',
        () => set('UPDATE amcp_users SET disabled=0,test_account=1 WHERE id=?'),
        adminAddress,
        f.tenant,
      ],
      [
        'another address on the account',
        () => set("UPDATE amcp_users SET test_account=0,email='elsewhere@example.test' WHERE id=?"),
        adminAddress,
        f.tenant,
      ],
      [
        'another address in the variable',
        () => set("UPDATE amcp_users SET email='" + adminAddress + "' WHERE id=?"),
        'someone-else@example.test',
        f.tenant,
      ],
      ['another deployment workspace', () => undefined, adminAddress, 'another-deployment'],
    ] as const) {
      regrant();
      change();
      assert.equal(pass(configured, tenant), 1, name);
      assert.equal(f.membership(person.id)!.active, 0, name);
    }
  } finally {
    await f.close();
  }
});
