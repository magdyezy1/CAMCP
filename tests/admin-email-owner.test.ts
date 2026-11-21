// r25-admin-email, item 2': a verified sign-in of AMCP_ADMIN_EMAIL becomes a second owner of the deployment's workspace.
// Verified e-mail only (the link, or a Google or Apple token that says so); never a test or disabled account; a pending
// account is approved; the grant records its source and the role held before it; the audit row holds the user ID and
// never the address; a second sign-in changes nothing. Synthetic addresses and a fake transport only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {base32, totp} from '../server/account-security.js';
import {adminAddress, password, site, type Site} from './helpers/admin-email-site.js';
import type {JsonObject} from '../src/types.js';

const grantedBy = 'env:AMCP_ADMIN_EMAIL',
  granted = (f: Site) => f.events().filter(e => e.event === 'admin_email_owner_granted');
const userByEmail = (f: Site, email: string) =>
  f.store.db.prepare('SELECT * FROM amcp_users WHERE email=?').get(email) as JsonObject | undefined;
const setMembership = (f: Site, userId: unknown, role: string, active = 1) =>
  f.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,?,?,?)')
    .run(f.tenant, userId as string, role, active, Date.now());

test('the configured address registers the usual way, is approved at its first sign-in and becomes a second owner, once', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    const original = await f.deploymentOwner(),
      before = f.membership(original.id);
    assert.equal(
      (await f.request('/api/account/register', 'POST', {name: 'Second owner', email: ' Admin@Example.TEST '})).status,
      200,
    );
    assert.equal((await f.request('/api/account/verify-email', 'POST', {...f.link(), password})).status, 200);
    const created = userByEmail(f, adminAddress)!;
    assert.equal(created.approved, 0, 'the account waits for approval until its first sign-in');
    assert.equal(f.membership(created.id), undefined, 'nothing is granted before a sign-in');
    assert.equal(granted(f).length, 0);

    const headers = await f.signedIn(adminAddress);
    assert.equal(userByEmail(f, adminAddress)!.approved, 1, 'the account is approved by the grant');
    assert.deepEqual(
      {...f.membership(created.id)},
      {
        role: 'owner',
        active: 1,
        granted_by: grantedBy,
        granted_from: null,
        created_at: f.membership(created.id)!.created_at,
      },
    );
    const listed = (await (await f.request('/api/workspaces', 'GET', undefined, headers)).json()) as JsonObject;
    assert.ok(listed.workspaces.some((w: JsonObject) => w.id === f.tenant && w.role === 'owner'));
    const inside = await f.switchTo(headers);
    assert.equal(inside.status, 200);
    const session = (await (await f.request('/api/session', 'GET', undefined, inside.headers)).json()) as JsonObject;
    assert.equal(session.workspaceId, f.tenant);
    assert.equal(session.workspaceRole, 'owner');
    assert.equal(session.instanceOwner, true);

    // A second sign-in changes nothing and writes no second audit row.
    const first = {...f.membership(created.id)};
    await f.signedIn(adminAddress);
    await f.switchTo(await f.signedIn(adminAddress));
    assert.deepEqual({...f.membership(created.id)}, first);
    assert.equal(granted(f).length, 1);
    const row = granted(f)[0]!;
    assert.equal(row.user_id, created.id);
    assert.equal(row.role, 'owner');
    assert.equal(row.previous_role ?? null, null);
    assert.ok(!JSON.stringify(f.events()).toLowerCase().includes('example.test'), 'no audit row names the address');
    // The deployment's own owner is untouched.
    assert.deepEqual({...f.membership(original.id)}, {...before});
    assert.equal(f.membership(original.id)!.granted_by, null);
  } finally {
    await f.close();
  }
});

test('only the exact address matches: close addresses get nothing', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    for (const email of [
      'admin@example.test.evil',
      'xadmin@example.test',
      'admin+x@example.test',
      'admin@sub.example.test',
      'admin@example.tes',
    ]) {
      const account = await f.account(email);
      await f.signedIn(email);
      assert.equal(f.membership(account.id), undefined, email);
    }
    assert.equal(granted(f).length, 0);
  } finally {
    await f.close();
  }
});

test('an address that was never verified gets nothing: an unfinished registration, a Facebook identity, a Google token that says false', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    // A registration whose link was never opened has no account at all.
    assert.equal(
      (await f.request('/api/account/register', 'POST', {name: 'Never verified', email: adminAddress})).status,
      200,
    );
    assert.equal(userByEmail(f, adminAddress), undefined);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS n FROM workspace_memberships WHERE granted_by IS NOT NULL').get()!.n,
      0,
    );

    // Facebook never gives AMCP a verified address, whatever its profile says.
    f.state.facebookEmail = adminAddress;
    const facebook = await f.social('facebook');
    assert.match(String(facebook.headers.get('location')), /error=ACCOUNT_PENDING_APPROVAL/);
    const facebookAccount = f.store.db
      .prepare("SELECT u.* FROM amcp_users u JOIN amcp_identities i ON i.user_id=u.id WHERE i.provider='facebook'")
      .get() as JsonObject;
    assert.equal(facebookAccount.email, null);
    assert.equal(facebookAccount.approved, 0, 'the account stays pending');
    assert.equal(f.membership(facebookAccount.id), undefined);

    // A Google token whose e-mail claim is not verified gives an account with no address.
    for (const verified of [false, 'false'] as const) {
      f.state.email = adminAddress;
      f.state.verified = verified;
      f.state.subject = 'google-unverified-' + String(verified);
      const google = await f.social('google');
      assert.match(String(google.headers.get('location')), /error=ACCOUNT_PENDING_APPROVAL/);
      const row = f.store.db
        .prepare('SELECT u.* FROM amcp_users u JOIN amcp_identities i ON i.user_id=u.id WHERE i.subject=?')
        .get(f.state.subject) as JsonObject;
      assert.equal(row.email, null);
      assert.equal(row.approved, 0);
      assert.equal(f.membership(row.id), undefined);
    }
    assert.equal(granted(f).length, 0);

    // Control: the same sign-in with a token that says the address is verified does get the role.
    f.state.verified = true;
    f.state.subject = 'google-verified';
    const verified = await f.social('google');
    assert.match(String(verified.headers.get('location')), /\/auth\/complete$/);
    const person = userByEmail(f, adminAddress)!;
    assert.equal(person.approved, 1);
    assert.equal(f.membership(person.id)!.role, 'owner');
    assert.equal(granted(f).length, 1);
  } finally {
    await f.close();
  }
});

test('a test account or a disabled account with the address gets nothing', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const reviewer = await f.account(adminAddress, 'Reviewer', true, true);
    await f.signedIn(adminAddress);
    assert.equal(f.membership(reviewer.id), undefined);
    f.store.db.prepare('DELETE FROM amcp_users WHERE id=?').run(reviewer.id);
    f.store.db.prepare('DELETE FROM workspace_memberships WHERE user_id=?').run(reviewer.id);

    const disabled = await f.account(adminAddress);
    f.store.db.prepare('UPDATE amcp_users SET disabled=1 WHERE id=?').run(disabled.id);
    const refused = await f.login(adminAddress);
    assert.equal(refused.status, 401);
    assert.equal(f.membership(disabled.id), undefined);
    assert.equal(granted(f).length, 0);
  } finally {
    await f.close();
  }
});

test('the role held before the grant is recorded, an existing owner keeps owner, and nobody is demoted', async () => {
  for (const before of ['viewer', 'operator', 'admin']) {
    const f = await site({adminEmail: adminAddress});
    try {
      await f.deploymentOwner();
      const person = await f.account(adminAddress);
      setMembership(f, person.id, before);
      const created = f.membership(person.id)!.created_at;
      await f.signedIn(adminAddress);
      assert.deepEqual(
        {...f.membership(person.id)},
        {role: 'owner', active: 1, granted_by: grantedBy, granted_from: before, created_at: created},
        before,
      );
      assert.equal(granted(f)[0]!.previous_role, before);
    } finally {
      await f.close();
    }
  }
  // Removed by hand (inactive): the person held no role, so there is nothing to restore later.
  const g = await site({adminEmail: adminAddress});
  try {
    await g.deploymentOwner();
    const person = await g.account(adminAddress);
    setMembership(g, person.id, 'operator', 0);
    await g.signedIn(adminAddress);
    assert.deepEqual(
      {...g.membership(person.id)},
      {
        role: 'owner',
        active: 1,
        granted_by: grantedBy,
        granted_from: null,
        created_at: g.membership(person.id)!.created_at,
      },
    );
  } finally {
    await g.close();
  }
  // The deployment's own owner holds the address: still the owner, with no marker and no audit row.
  const h = await site({adminEmail: 'owner@example.test'});
  try {
    const original = await h.deploymentOwner('owner@example.test'),
      kept = {...h.membership(original.id)};
    await h.signedIn('owner@example.test');
    assert.deepEqual({...h.membership(original.id)}, kept);
    assert.equal(h.membership(original.id)!.granted_by, null);
    assert.equal(granted(h).length, 0);
  } finally {
    await h.close();
  }
});

test('with two-step verification the role waits for the code', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    await f.deploymentOwner();
    const person = await f.account(adminAddress),
      secret = base32(randomBytes(20));
    f.store.db
      .prepare('INSERT INTO amcp_mfa VALUES(?,?,?,?,?)')
      .run(person.id, f.web.sealAccount('mfa:' + person.id, {secret}), '[]', -1, Date.now());
    const first = await f.login(adminAddress);
    assert.equal(first.status, 200);
    assert.equal(first.body.mfaRequired, true);
    assert.equal(f.membership(person.id), undefined, 'the password alone grants nothing');
    assert.equal(granted(f).length, 0);
    const done = await f.request('/api/account/mfa/login', 'POST', {ticket: first.body.ticket, code: totp(secret)});
    assert.equal(done.status, 200);
    assert.equal(f.membership(person.id)!.role, 'owner');
    assert.equal(granted(f).length, 1);
  } finally {
    await f.close();
  }
});

test('the address is never logged', async () => {
  const written: string[] = [],
    stderr = process.stderr.write.bind(process.stderr),
    stdout = process.stdout.write.bind(process.stdout);
  process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
  const f = await site({adminEmail: ' Admin@Example.TEST '});
  try {
    await f.deploymentOwner();
    await f.account(adminAddress);
    await f.switchTo(await f.signedIn(adminAddress));
    await (await f.restart({adminEmail: undefined})).close();
  } finally {
    process.stderr.write = stderr;
    process.stdout.write = stdout;
  }
  assert.ok(
    !written.join('').toLowerCase().includes('admin@example.test'),
    'a start-up or request line names the address',
  );
});
