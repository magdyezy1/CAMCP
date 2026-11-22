// r25-admin-email, item 2': every place that assumed one owner of the AMCP workspace, handled on purpose now that the
// variable can add a second owner beside the original. Each test names the site it pins. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {accountsDueForErasure, eraseAccount} from '../src/account-erasure.js';
import {savePlanPolicy} from '../src/campaign-inventory.js';
import {WebStore} from '../server/web-store.js';
import {adminAddress, site, type Site} from './helpers/admin-email-site.js';
import {admin as planAdmin, actor as planActor, fixture as planFixture, squadPlan} from './snapchat-plan-fixture.js';
import type {Actor, JsonObject} from '../src/types.js';

/** The AMCP owner (own workspace = the deployment workspace) and a second owner the variable granted, both signed in. */
async function twoOwners() {
  const f = await site({adminEmail: adminAddress}),
    original = await f.deploymentOwner('owner@example.test'),
    second = await f.account(adminAddress, 'Second owner');
  const first = await f.signedIn(adminAddress),
    inside = await f.switchTo(first),
    originalHeaders = await f.signedIn('owner@example.test');
  assert.equal(f.membership(second.id)!.role, 'owner');
  return {f, original, second, secondHeaders: inside.headers!, originalHeaders};
}
const code = async (r: Response) => ((await r.json()) as JsonObject).error?.code;
const rows = (f: Site) =>
  JSON.stringify(f.store.db.prepare('SELECT * FROM workspace_memberships ORDER BY tenant_id,user_id').all());

test('S1: notices go to AMCP_OWNER_EMAIL, else the earliest hand-given owner, whichever membership row is older', async () => {
  const f = await site({adminEmail: adminAddress});
  try {
    // The second owner is granted first, so its membership row is the older one ...
    await f.account(adminAddress, 'Second owner');
    await f.signedIn(adminAddress);
    // ... and the AMCP owner's is created afterwards.
    const original = await f.deploymentOwner('owner@example.test');
    f.store.db
      .prepare('UPDATE workspace_memberships SET created_at=? WHERE tenant_id=? AND user_id=?')
      .run(Date.now() + 60000, f.tenant, original.id);
    assert.equal(f.accounts.ownerEmail(), 'owner@example.test');
    // Without the AMCP owner the second owner is the only owner left to tell.
    f.store.db.prepare('DELETE FROM workspace_memberships WHERE user_id=?').run(original.id);
    assert.equal(f.accounts.ownerEmail(), adminAddress);
    // The setting names the address outright.
    f.env.AMCP_OWNER_EMAIL = 'notices@example.test';
    assert.equal(f.accounts.ownerEmail(), 'notices@example.test');
  } finally {
    await f.close();
  }
});

test('S2, S3: both owners are the AMCP owner: the session says so and the owner routes open; a plain administrator is refused', async () => {
  const {f, secondHeaders, originalHeaders} = await twoOwners();
  try {
    for (const headers of [secondHeaders, originalHeaders]) {
      const session = (await (await f.request('/api/session', 'GET', undefined, headers)).json()) as JsonObject;
      assert.equal(session.workspaceRole, 'owner');
      assert.equal(session.instanceOwner, true);
      assert.equal((await f.request('/api/owner/accounts', 'GET', undefined, headers)).status, 200);
    }
    const plain = await f.account('plain-admin@example.test');
    f.store.db
      .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'admin',?)")
      .run(f.tenant, plain.id, Date.now());
    const inside = await f.switchTo(await f.signedIn('plain-admin@example.test'));
    assert.equal(
      await code(await f.request('/api/owner/accounts', 'GET', undefined, inside.headers)),
      'OWNER_REQUIRED',
    );
  } finally {
    await f.close();
  }
});

test('S6: an invitation from the second owner creates an approved account, as the AMCP owner’s does', async () => {
  const {f, secondHeaders} = await twoOwners();
  try {
    const before = f.emails.length;
    const sent = await f.request(
      '/api/workspaces/invite',
      'POST',
      {email: 'invited@example.test', role: 'viewer'},
      secondHeaders,
    );
    assert.equal(sent.status, 200);
    assert.ok(f.emails.length > before);
    const token = f.link().token;
    const accepted = await f.request('/api/account/verify-email', 'POST', {
      token,
      kind: 'invite',
      name: 'Invited person',
      password: f.password,
    });
    assert.equal(accepted.status, 200);
    assert.equal(
      (f.store.db.prepare('SELECT approved FROM amcp_users WHERE email=?').get('invited@example.test') as JsonObject)
        .approved,
      1,
    );
  } finally {
    await f.close();
  }
});

test('S7: neither owner can demote or remove the other through member editing, and nothing changes', async () => {
  const {f, original, second, secondHeaders, originalHeaders} = await twoOwners();
  try {
    const before = rows(f);
    for (const [headers, target] of [
      [secondHeaders, original],
      [originalHeaders, second],
    ] as const)
      for (const role of ['admin', 'operator', 'viewer', 'remove']) {
        const refused = await f.request('/api/workspaces/member', 'POST', {userId: target.id, role}, headers);
        assert.equal(await code(refused), 'OWNER_REQUIRED', role);
      }
    assert.equal(rows(f), before);
  } finally {
    await f.close();
  }
});

test('S4: neither owner can revoke the other’s account access; an ordinary member still can be revoked', async () => {
  const {f, original, second, secondHeaders, originalHeaders} = await twoOwners();
  try {
    for (const [headers, target] of [
      [secondHeaders, original],
      [originalHeaders, second],
    ] as const) {
      const refused = await f.request(
        '/api/owner/accounts/access',
        'POST',
        {user_id: target.id, grant: false},
        headers,
      );
      assert.equal(await code(refused), 'OWNER_REQUIRED');
      const row = f.store.db
        .prepare('SELECT approved,disabled FROM amcp_users WHERE id=?')
        .get(target.id) as JsonObject;
      assert.deepEqual({...row}, {approved: 1, disabled: 0});
      // The owner whose access was attacked still has their session.
      assert.equal(
        (await f.request('/api/session', 'GET', undefined, target.id === original.id ? originalHeaders : secondHeaders))
          .status,
        200,
      );
    }
    const ordinary = await f.account('ordinary@example.test');
    const revoked = await f.request(
      '/api/owner/accounts/access',
      'POST',
      {user_id: ordinary.id, grant: false},
      secondHeaders,
    );
    assert.equal(revoked.status, 200);
    assert.equal(((await revoked.json()) as JsonObject).state, 'revoked');
  } finally {
    await f.close();
  }
});

test('S5: neither owner can reset the other’s two-step verification; an ordinary member’s can be reset', async () => {
  const {f, original, second, secondHeaders, originalHeaders} = await twoOwners();
  try {
    const ordinary = await f.account('ordinary@example.test');
    for (const user of [original, second, ordinary])
      f.store.db
        .prepare('INSERT INTO amcp_mfa VALUES(?,?,?,?,?)')
        .run(user.id, f.web.sealAccount('mfa:' + String(user.id), {secret: 'AAAA'}), '[]', -1, Date.now());
    for (const [headers, target] of [
      [secondHeaders, original],
      [originalHeaders, second],
    ] as const) {
      const refused = await f.request('/api/owner/accounts/mfa-reset', 'POST', {user_id: target.id}, headers);
      assert.equal(await code(refused), 'OWNER_REQUIRED');
      assert.ok(f.store.db.prepare('SELECT 1 FROM amcp_mfa WHERE user_id=?').get(target.id), 'their two-step stays');
    }
    const reset = await f.request('/api/owner/accounts/mfa-reset', 'POST', {user_id: ordinary.id}, secondHeaders);
    assert.equal(reset.status, 200);
    assert.equal(f.store.db.prepare('SELECT 1 FROM amcp_mfa WHERE user_id=?').get(ordinary.id), undefined);
  } finally {
    await f.close();
  }
});

test('S8, S9: erasure and self-service deletion refuse both owners, a restore re-application still erases, the retention sweep skips them', async () => {
  const {f, original, second} = await twoOwners();
  try {
    const options = {deploymentTenant: f.tenant, reason: 'operator_request', by: 'cli'} as const;
    for (const user of [original, second]) {
      const plan = eraseAccount(f.store, {userId: String(user.id)}, {...options, dryRun: true});
      assert.equal(plan.status, 'refused');
      assert.equal(plan.refusal.code, 'ERASURE_REFUSED');
      // Review S4-7: no owner can be "moved" (AMCP has no such feature), so the refusal says what ends the role instead.
      assert.equal(
        plan.refusal.message,
        'An AMCP owner’s account and workspace cannot be erased while it holds the owner role. A second owner’s role ends when AMCP_ADMIN_EMAIL is removed.',
      );
      assert.throws(() => eraseAccount(f.store, {userId: String(user.id)}, options), {code: 'ERASURE_REFUSED'});
      assert.ok(f.store.db.prepare('SELECT 1 FROM amcp_users WHERE id=?').get(user.id), 'the account is still there');
    }
    // Control: an ordinary account is planned, not refused.
    const ordinary = await f.account('ordinary@example.test');
    assert.equal(eraseAccount(f.store, {userId: String(ordinary.id)}, {...options, dryRun: true}).status, 'planned');
    // A receipt re-applied on a restored copy still erases an account that held the role when the backup was taken.
    assert.equal(
      eraseAccount(f.store, {userId: String(second.id)}, {...options, reapplies: 'earlier-erasure', dryRun: true})
        .status,
      'planned',
    );
    // Self-service: the second owner's own page refuses with the owner's code, and the deletion changes nothing.
    const personal = await f.signedIn(adminAddress);
    const preview = (await (await f.request('/api/account/deletion', 'GET', undefined, personal)).json()) as JsonObject;
    assert.equal(preview.available, false);
    assert.equal(preview.refusal.code, 'ACCOUNT_DELETION_OWNER');
    assert.equal(
      preview.refusal.message,
      'An AMCP owner’s account cannot be deleted from Account while it holds the owner role. A second owner’s role ends when the operator removes AMCP_ADMIN_EMAIL.',
    );
    const deleted = await f.request('/api/account/delete', 'POST', {confirm: adminAddress}, personal);
    assert.equal(await code(deleted), 'ACCOUNT_DELETION_OWNER');
    assert.ok(f.store.db.prepare('SELECT 1 FROM amcp_users WHERE id=?').get(second.id));
    // The retention sweep never selects an owner of the deployment, revoked or not; it still selects an ordinary account.
    f.store.db.prepare('UPDATE amcp_users SET disabled=1,approved=0 WHERE id IN (?,?)').run(second.id, ordinary.id);
    const due = accountsDueForErasure(
      f.store,
      f.tenant,
      {pendingMs: null, revokedMs: 86400000},
      Date.now() + 10 * 86400000,
    );
    assert.ok(due.revoked.includes(String(ordinary.id)));
    assert.ok(!due.revoked.includes(String(second.id)));
  } finally {
    await f.close();
  }
});

test('S13: under the distinct-approver policy two owners are two people; the same person’s own AI credential is not another', async () => {
  const p = planFixture();
  try {
    new WebStore(p.store, {origin: 'https://amcp.shop'});
    const tenant = planActor.tenantId,
      now = Date.now();
    const owner = (email: string) => {
      const id = randomUUID();
      p.store.db
        .prepare('INSERT INTO amcp_users(id,email,name,tenant_id,created_at) VALUES(?,?,?,?,?)')
        .run(id, email, 'Owner', 'user-' + id, now);
      p.store.db
        .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'owner',?)")
        .run(tenant, id, now);
      return id;
    };
    const a = owner('a-owner@example.test'),
      b = owner('b-owner@example.test');
    const session = (id: string): Actor => ({
        tenantId: tenant,
        userId: id,
        ownerUserId: id,
        role: 'admin',
        membershipRole: 'owner',
      }),
      credential = (id: string): Actor => ({
        tenantId: tenant,
        userId: 'connector/synthetic',
        ownerUserId: id,
        role: 'admin',
      });
    const call = (as: Actor, input: JsonObject) => p.service.call('amcp_campaign', input, as) as Promise<JsonObject>;
    const created = await call(session(a), {
      action: 'create',
      name: 'Plan of the first owner',
      brief: 'Synthetic plan',
      steps: squadPlan(2),
    });
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 500));
    const id = created.data.id;
    savePlanPolicy(p.store, planAdmin, {require_distinct_approver: true, confirmed: true});
    const shown = (await call(session(a), {action: 'approve', id})).data;
    assert.equal(shown.approver_required, true, 'the plan’s own owner may not approve it');
    const approve = (as: Actor) =>
      call(as, {
        action: 'approve',
        id,
        plan_hash: shown.plan_hash,
        summary_hash: shown.summary_hash,
        confirmed: true,
        spend_change_confirmed: true,
      });
    for (const same of [session(a), credential(a)]) {
      const refused = await approve(same);
      assert.equal(refused.error?.code, 'DISTINCT_APPROVER_REQUIRED', JSON.stringify(refused).slice(0, 400));
    }
    const approved = await approve(session(b));
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 500));
    assert.equal(approved.data.approved.by, b);
  } finally {
    p.close();
  }
});
