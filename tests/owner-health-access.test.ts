import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import type {Actor, JsonObject} from '../src/types.js';

/**
 * Snapchat S7, from the owner's live test on 2026-09-29: amcp_workspace health answered the connected user with
 * "Only the workspace owner can change safety and spending policies." and the remedy "prepare again", although
 * nothing was being changed or prepared. Each owner action now names itself, the remedy is to ask the owner, and an
 * administrator who does not own the workspace sees connection status and queue depth.
 */
const tenantId = 'owner-health';
const roles: Record<string, Actor> = {
  owner: {tenantId, userId: 'owner', role: 'admin', ownerUserId: 'u-owner', membershipRole: 'owner'},
  administrator: {tenantId, userId: 'admin', role: 'admin', ownerUserId: 'u-admin', membershipRole: 'admin'},
  member: {tenantId, userId: 'member', role: 'operator', ownerUserId: 'u-member', membershipRole: 'operator'},
  test_account: {tenantId, userId: 'reviewer', role: 'admin', testAccount: true},
};
const acts: Record<string, RegExp> = {
  health: /read the whole workspace health/,
  support_bundle: /export the support bundle/,
  save_spend_policy: /change spending policies/,
  save_retention: /change how long reports are kept/,
  pause_writes: /pause every write/,
  resume_writes: /resume writes/,
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 12).toString('base64'));
  // The website's user table: member actors are checked against it on every call.
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,name TEXT NOT NULL,tenant_id TEXT UNIQUE NOT NULL,password_hash TEXT,version INTEGER NOT NULL DEFAULT 1,disabled INTEGER NOT NULL DEFAULT 0,approved INTEGER NOT NULL DEFAULT 1,test_account INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)',
  );
  for (const id of ['u-owner', 'u-admin', 'u-member'])
    store.db
      .prepare('INSERT INTO amcp_users(id,email,name,tenant_id,created_at) VALUES(?,?,?,?,?)')
      .run(id, id + '@example.test', id, id === 'u-owner' ? tenantId : id + '-home', Date.now());
  for (const [user, role] of [
    ['u-owner', 'owner'],
    ['u-admin', 'admin'],
    ['u-member', 'operator'],
  ] as [string, string][])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenantId, user, role, Date.now());
  store.putConnection(
    roles.owner!,
    {
      id: 'snap',
      tenantId,
      gateway: 'snapchat_native_action',
      accounts: ['acct1'],
      writeAccounts: ['acct1'],
      enabled: true,
      label: 'Client name that only the owner sees here',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(new Registry(), store);
  return {
    store,
    call: (action: string, who: Actor) => service.call('amcp_workspace', {action}, who) as Promise<JsonObject>,
  };
}

test('each role gets an answer about the action it asked for', async () => {
  const f = setup();
  try {
    for (const [role, actor] of Object.entries(roles))
      for (const [action, act] of Object.entries(acts)) {
        const r = await f.call(action, actor);
        const label = role + ' ' + action;
        if (role === 'owner') {
          // The owner reaches the action itself; a missing confirmation is the action's own refusal.
          assert.notEqual(r.error?.code, 'OWNER_REQUIRED', label);
          continue;
        }
        if (role === 'administrator' && action === 'health') {
          assert.equal(r.success, true, label);
          continue;
        }
        assert.equal(r.error.code, 'OWNER_REQUIRED', label);
        assert.match(r.error.message, act, label);
        if (role === 'test_account') assert.match(r.error.message, /^Reviewer test accounts cannot/, label);
        // Nothing to correct or prepare: the remedy is asking the owner.
        assert.equal(r.error.remedy.category, 'permission', label);
        assert.match(r.error.remedy.action, /owner/, label);
        assert.doesNotMatch(r.error.remedy.action, /prepare again/, label);
      }
  } finally {
    f.store.close();
  }
});

test('an administrator sees connection status and queue depth, and nothing that is the owner’s', async () => {
  const f = setup();
  try {
    const owner = (await f.call('health', roles.owner!)).data,
      admin = (await f.call('health', roles.administrator!)).data;
    assert.ok(owner.policies && owner.storage && owner.email, 'the owner keeps the whole view');
    assert.equal(admin.scope, 'administrator');
    assert.deepEqual(Object.keys(admin).sort(), ['at', 'connections', 'jobs', 'owner_view', 'scope', 'writes_paused']);
    assert.deepEqual(admin.connections, [
      {id: 'snap', gateway: 'snapchat_native_action', enabled: true, account_count: 1, needs_attention: false},
    ]);
    assert.equal(JSON.stringify(admin).includes('Client name'), false);
    const member = await f.call('health', roles.member!);
    // LEAD-03 (package r25-m0-errors): the sentence that said "Administrators see ... ask one of them or the owner" is
    // replaced by the rule itself (tests/owner-health-refusal.test.mjs pins the whole text).
    assert.match(member.error.message, /and an administrator its connection status and job queues/);
  } finally {
    f.store.close();
  }
});
