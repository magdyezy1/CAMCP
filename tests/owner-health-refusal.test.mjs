import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {localeProblems} from '../tools/check-locales.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * LEAD-03 (Round 2.5, M0): amcp_workspace health from an AI client answered OWNER_REQUIRED with "Only the workspace owner
 * can read the whole workspace health ... Administrators see connection status and job queues; ask one of them or the
 * owner." while details.required_role said "owner or administrator". An AI client connection is only ever operator or
 * reader (owner decision D16, server/mcp-oauth.ts), so even the owner's own AI session got that refusal and its advice to
 * ask an administrator. The refusal now states the rule the code enforces, says where the owner reads the view (the
 * website's /settings, under Review friction and the workspace health), and what an operator or reader can read instead. It
 * never suggests that the AI session could be given more. Every fixture is synthetic.
 */
const tenantId = 'owner-health-refusal',
  catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const roles = {
  owner: {tenantId, userId: 'owner', role: 'admin', ownerUserId: 'u-owner', membershipRole: 'owner'},
  administrator: {tenantId, userId: 'admin', role: 'admin', ownerUserId: 'u-admin', membershipRole: 'admin'},
  operator: {tenantId, userId: 'operator', role: 'operator', ownerUserId: 'u-operator', membershipRole: 'operator'},
  reader: {tenantId, userId: 'viewer', role: 'reader', ownerUserId: 'u-viewer', membershipRole: 'viewer'},
  test_account: {tenantId, userId: 'reviewer', role: 'admin', testAccount: true},
};
function setup() {
  const store = new Store(':memory:', Buffer.alloc(32, 13).toString('base64'));
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS amcp_users(id TEXT PRIMARY KEY,email TEXT UNIQUE COLLATE NOCASE,name TEXT NOT NULL,tenant_id TEXT UNIQUE NOT NULL,password_hash TEXT,version INTEGER NOT NULL DEFAULT 1,disabled INTEGER NOT NULL DEFAULT 0,approved INTEGER NOT NULL DEFAULT 1,test_account INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL)',
  );
  for (const id of ['u-owner', 'u-admin', 'u-operator', 'u-viewer'])
    store.db
      .prepare('INSERT INTO amcp_users(id,email,name,tenant_id,created_at) VALUES(?,?,?,?,?)')
      .run(id, id + '@example.test', id, id === 'u-owner' ? tenantId : id + '-home', Date.now());
  for (const [user, role] of [
    ['u-owner', 'owner'],
    ['u-admin', 'admin'],
    ['u-operator', 'operator'],
    ['u-viewer', 'viewer'],
  ])
    store.db
      .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(tenantId, user, role, Date.now());
  store.putConnection(
    roles.owner,
    {
      id: 'meta',
      tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management'],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(new Registry(), store);
  return {store, call: (input, who) => service.call('amcp_workspace', input, who)};
}

const message =
  // Package r25-admin-email, fix round (the lead's review S4-7, 2026-11-21): an AI client connection is no longer always limited to
  // the operator or reader role (an owner of the deployment's workspace may give one owner access), so the sentence says what is
  // always true of the connection that meets this refusal: it does not carry owner access. It still hints at nothing to raise.
  'Only the workspace owner can read the whole workspace health (policies, e-mail, storage and backups), and an administrator its connection status and job queues. An AI client connection without owner access can read neither; the owner reads the whole view on the website at /settings, under Review friction and the workspace health.';
const remedy =
  'Nothing in the request changes this. The workspace owner reads the health on the website at /settings (Review friction and the workspace health); from an AI client, amcp_workspace capabilities shows each account’s readiness and blockers, and amcp_workspace check one account’s prerequisites.';
/** Words that would hint a session could be given more than it has. */
const raising =
  /\b(raise|upgrade|promot|elevat|escalat|become|become the owner|owner role|admin role|grant you|give you|make you)\w*/i;

test('operator and reader sessions are told the rule, where the owner reads the view, and that they can read neither part', async () => {
  const f = setup();
  try {
    for (const who of ['operator', 'reader']) {
      const r = await f.call({action: 'health'}, roles[who]);
      assertRefused(r, 'OWNER_REQUIRED');
      assert.equal(r.error.message, message, who);
      assert.equal(r.error.details.action, 'health');
      assert.equal(r.error.details.required_role, 'owner or administrator');
      assert.equal(r.error.details.website_path, '/settings');
      // The statement that contradicted required_role is gone.
      assert.doesNotMatch(r.error.message, /ask one of them or the owner/);
      assert.doesNotMatch(r.error.message, /Administrators see connection status/);
      assert.match(r.error.message, /an administrator its connection status and job queues/);
      assert.match(r.error.message, /AI client connection without owner access can read neither/);
      assert.doesNotMatch(r.error.message, /limited to the operator or reader role/);
      assert.match(r.error.message, /\/settings, under Review friction/);
      // Nothing hints that the session could be raised.
      assert.doesNotMatch(r.error.message + r.error.remedy.action + JSON.stringify(r.error.details), raising, who);
    }
  } finally {
    f.store.close();
  }
});

test('the next step is the owner’s website view and what a session can read, not the generic ask-the-owner advice', async () => {
  const f = setup();
  try {
    const r = await f.call({action: 'health'}, roles.operator);
    assert.deepEqual(r.error.remedy, {
      category: 'permission',
      owner: 'workspace_owner',
      action: remedy,
      mutation_retry_safe: false,
    });
    assert.equal(r.error.next_action, remedy);
    assert.doesNotMatch(r.error.remedy.action, /give you what you need from it/);
    // The call it names runs for the same session, and nothing about it is owner-only.
    const next = r.error.details.next_call;
    assert.deepEqual(next, {tool: 'amcp_workspace', arguments: {action: 'capabilities'}});
    const offered = await f.call(next.arguments, roles.operator);
    assert.equal(offered.success, true, JSON.stringify(offered.error));
    const reader = await f.call(next.arguments, roles.reader);
    assert.equal(reader.success, true, JSON.stringify(reader.error));
  } finally {
    f.store.close();
  }
});

test('the owner still reads the whole view, an administrator its connections and queues, and a reviewer account is still refused in its own words', async () => {
  const f = setup();
  try {
    const owner = await f.call({action: 'health'}, roles.owner);
    assert.equal(owner.success, true, JSON.stringify(owner.error));
    assert.ok(owner.data.policies && owner.data.storage && owner.data.email);
    const administrator = await f.call({action: 'health'}, roles.administrator);
    assert.equal(administrator.success, true, JSON.stringify(administrator.error));
    assert.equal(administrator.data.scope, 'administrator');
    const reviewer = await f.call({action: 'health'}, roles.test_account);
    assertRefused(reviewer, 'OWNER_REQUIRED');
    assert.match(reviewer.error.message, /^Reviewer test accounts cannot read the whole workspace health/);
    assert.equal(
      reviewer.error.remedy.action,
      'Ask the workspace owner to do this, or to give you what you need from it. Changing the request does not help.',
    );
  } finally {
    f.store.close();
  }
});

test('every other owner-only action keeps its own message, its owner-only role and the generic remedy', async () => {
  const f = setup();
  try {
    for (const [action, act] of [
      ['save_spend_policy', 'change spending policies'],
      ['support_bundle', 'export the support bundle'],
      ['pause_writes', 'pause every write'],
    ]) {
      const r = await f.call({action}, roles.operator);
      assertRefused(r, 'OWNER_REQUIRED');
      assert.equal(r.error.message, 'Only the workspace owner can ' + act + '.', action);
      assert.deepEqual(r.error.details, {action, required_role: 'owner'}, action);
      assert.equal(
        r.error.remedy.action,
        'Ask the workspace owner to do this, or to give you what you need from it. Changing the request does not help.',
        action,
      );
    }
  } finally {
    f.store.close();
  }
});

test('the new message and next step have their Arabic, keeping the native names', () => {
  assert.deepEqual(localeProblems(catalog, [message, remedy]), []);
  for (const text of [message, remedy]) {
    assert.match(catalog[text], /[؀-ۿ]/u);
    for (const token of new Set(text.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g) ?? []))
      assert.ok(catalog[text].includes(token), text + ' keeps ' + token);
  }
  assert.ok(catalog[message].includes('/settings'));
  assert.ok(catalog[remedy].includes('/settings'));
});
