// SEC-07 S4 (review 2026-10-08, R04 account-workspace-erasure): revoking access only set approved=0 and disabled=1;
// nothing could delete an account, its workspace or what it holds, the append-only audit chain forbade removing
// anything, and never-approved sign-ups stayed forever. An operator erasure (dry run first), a retention sweep and the
// re-application of erasure receipts after a restore now remove them, while the audit chain still verifies.
// Synthetic accounts only; no provider or e-mail traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import {accountLifecycleSweeper} from '../server/account-lifecycle.js';
import {loadConfig} from '../server/config.js';
import {
  accountRetention,
  accountsDueForErasure,
  eraseAccount,
  erasureReceipts,
  reapplyErasures,
} from '../src/account-erasure.js';
import {auditTombstone} from '../src/store.js';
import {createEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup} from '../src/backup.js';
import {sha256} from '../src/security.js';
import type {Connection, JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 71).toString('base64'),
  day = 86400000,
  erasedEmail = 'erase.me@example.test',
  erasedName = 'Erasable Synthetic Person',
  cli = path.resolve('dist/tools/admin.js'),
  prefix = 'amcp-account-erasure-';
const options = {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'} as const;

function site(store: Store) {
  const web = new WebStore(store, {
    origin,
    masterKey: master,
    adminPassword: 'synthetic-erasure-admin-door',
    authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'amcp@example.test'},
    fetcher: async () => {
      throw Error('No provider or e-mail traffic allowed');
    },
  });
  return {web, accounts: new UserAccounts(web)};
}
function connect(store: Store, tenant: string, userId: string, id: string) {
  const c: Connection = {
    id,
    tenantId: tenant,
    gateway: 'meta_native_action',
    accounts: ['111'],
    label: 'Synthetic ' + id,
    enabled: true,
    scopes: ['ads_read'],
  };
  store.putConnection({tenantId: tenant, userId, role: 'admin'}, c, {accessToken: 'synthetic-token-' + id});
}
/** Every table with a tenant_id column. */
const tenantTables = (store: Store) =>
  (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[])
    .map(t => t.name)
    .filter(name => store.db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name='tenant_id'").get(name));
const rows = (store: Store, sql: string, ...params: (string | number)[]) =>
  store.db.prepare(sql).all(...params) as JsonObject[];
/** Whether any text cell of any table holds `needle` in the clear. */
function plaintextHolds(store: Store, needle: string) {
  for (const {name} of store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[]) {
    const columns = (store.db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as {name: string}[]).map(
      c => c.name,
    );
    for (const column of columns)
      if (
        store.db
          .prepare(
            'SELECT 1 FROM "' + name + '" WHERE typeof("' + column + '")=\'text\' AND instr("' + column + '",?)>0',
          )
          .get(needle)
      )
        return name + '.' + column;
  }
}

/**
 * A deployment ('local') with two people. The one to erase owns a workspace holding a login, documents, a job, media,
 * keys and audit records, and is an operator in the other person's workspace, with a key, a monitor subscription, a
 * pending notice and an invitation there; a session, a two-step secret, a social identity, an AI-client grant, an
 * emailed link and queued e-mails name them.
 */
function populate(store: Store) {
  const {web, accounts} = site(store),
    erased = accounts.newUser(erasedName, erasedEmail, null, true),
    kept = accounts.newUser('Kept Synthetic Person', 'kept@example.test', null, true),
    E = String(erased.tenant_id),
    K = String(kept.tenant_id),
    now = Date.now();
  connect(store, E, erased.id, 'erased-login');
  connect(store, K, kept.id, 'kept-login');
  store.putDocument(E, 'report_snapshot', 'weekly', {title: erasedName + ' weekly report'});
  store.putDocument(K, 'report_snapshot', 'weekly', {title: 'Kept weekly report'});
  store.enqueue(E, 'report', {synthetic: true});
  store.enqueue(K, 'report', {synthetic: true});
  store.db.prepare('INSERT INTO media_chunks VALUES(?,?,?,?)').run(E, 'upload-1', 0, 'synthetic');
  store.db
    .prepare('INSERT INTO media_staging(tenant_id,id,secret,expires_at) VALUES(?,?,?,?)')
    .run(E, 'upload-1', 'x', now);
  store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)').run(E, 'write-1', 'f', 'done', '{}', now);
  store.db.prepare('INSERT INTO resource_ownership VALUES(?,?,?,?,?)').run(E, 'erased-login', '111', 'c1', now + day);
  // The person is an operator in the kept workspace, with their own key and work there.
  store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)")
    .run(K, erased.id, now);
  const erasedKeyInK = store.createKey({tenantId: K, userId: erased.id, ownerUserId: erased.id, role: 'operator'}),
    erasedOwnKey = store.createKey({tenantId: E, userId: erased.id, ownerUserId: erased.id, role: 'admin'}),
    keptKey = store.createKey({tenantId: K, userId: kept.id, ownerUserId: kept.id, role: 'admin'});
  store.putDocument(K, 'monitor_subscription', 'sub-erased', {user_id: erased.id, enabled: true});
  store.putDocument(K, 'monitor_notice', 'notice-erased', {user_id: erased.id, state: 'pending'});
  store.putDocument(K, 'workspace_invite', 'invite-erased', {emailHash: sha256(erasedEmail), state: 'accepted'});
  store.putDocument(K, 'monitor_subscription', 'sub-kept', {user_id: kept.id, enabled: true});
  // An AI client the person approved in the deployment's workspace: its access key and grant.
  const aiHash = sha256('synthetic-ai-access-' + randomUUID());
  store.ensureTenant('local');
  store.db
    .prepare("INSERT INTO api_keys(hash,tenant_id,user_id,role,expires_at) VALUES(?,'local','mcp:client','reader',?)")
    .run(aiHash, now + day);
  store.db
    .prepare("INSERT INTO amcp_mcp_grants VALUES(?,'access','client-1','local',?,?,0)")
    .run(aiHash, JSON.stringify({ownerUserId: erased.id}), now + day);
  // Sign-in material.
  accounts.session(erased);
  accounts.session(kept);
  store.db
    .prepare('INSERT INTO amcp_mfa(user_id,secret,recovery,enabled_at) VALUES(?,?,?,?)')
    .run(erased.id, web.sealAccount('mfa:' + erased.id, {secret: 'synthetic'}), '[]', now);
  store.db.prepare("INSERT INTO amcp_identities VALUES('google','synthetic-subject',?,?)").run(erased.id, now);
  accounts.challenge('reset', {userId: erased.id, email: erasedEmail});
  accounts.challenge('reset', {userId: kept.id, email: 'kept@example.test'});
  // Queued e-mails: one in the person's workspace, one about them in the deployment's (only its sealed content
  // names them), and one for the kept person.
  accounts.queueNotice(E, erasedEmail, 'Synthetic', 'Synthetic notice', 'erased-own');
  accounts.queueNotice(
    'local',
    'owner@example.test',
    'AMCP access request',
    erasedEmail + ' asked for access',
    'about',
  );
  accounts.queueNotice(K, 'kept@example.test', 'Synthetic', 'Synthetic notice', 'kept-own');
  store.appendAudit(E, randomUUID(), {event: 'synthetic_work', note: erasedName});
  store.appendAudit(K, randomUUID(), {event: 'synthetic_work'});
  return {web, accounts, erased, kept, E, K, erasedKeyInK, erasedOwnKey, keptKey, aiHash};
}
/** What the kept person and their workspace hold, apart from the erased person's rows there. */
const keptState = (store: Store, K: string, keptId: string, erasedId: string) => ({
  connections: rows(store, 'SELECT id,data,secret FROM connections WHERE tenant_id=? ORDER BY id', K),
  documents: rows(
    store,
    "SELECT kind,id,data,revision FROM documents WHERE tenant_id=? AND id NOT IN ('sub-erased','notice-erased','invite-erased') ORDER BY kind,id",
    K,
  ),
  jobs: rows(store, 'SELECT id,input,state FROM jobs WHERE tenant_id=? ORDER BY id', K),
  keys: rows(store, 'SELECT * FROM api_keys WHERE tenant_id=? AND user_id<>? ORDER BY hash', K, erasedId),
  members: rows(
    store,
    'SELECT * FROM workspace_memberships WHERE tenant_id=? AND user_id<>? ORDER BY user_id',
    K,
    erasedId,
  ),
  user: rows(store, 'SELECT * FROM amcp_users WHERE id=?', keptId),
  sessions: rows(store, "SELECT hash FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=?", keptId),
  outbox: rows(store, 'SELECT id,secret FROM amcp_email_outbox WHERE tenant_id=? ORDER BY id', K),
  audit: rows(store, 'SELECT * FROM audit WHERE tenant_id=? ORDER BY seq', K),
});

test('SEC-07 S4: a dry run counts every row an erasure would remove and changes nothing', () => {
  const store = new Store(':memory:', master);
  try {
    const f = populate(store),
      before = keptState(store, f.K, f.kept.id, f.erased.id),
      seq = rows(store, 'SELECT max(seq) AS s FROM audit')[0]!.s;
    const plan = eraseAccount(store, {email: erasedEmail.toUpperCase()}, {...options, dryRun: true});
    assert.equal(plan.status, 'planned');
    assert.equal(plan.user_id, f.erased.id);
    assert.equal(plan.tenant_id, f.E);
    const counts = plan.counts as Record<string, number>;
    assert.equal(counts.connections, 1);
    assert.equal(counts.tenants, 1);
    assert.equal(counts.amcp_users, 1);
    assert.equal(
      counts.api_keys,
      3,
      'their own workspace key, their key in the kept workspace, their AI client access',
    );
    assert.equal(counts.workspace_memberships, 2);
    assert.equal(counts.documents, 5, 'workspace name and report; subscription, notice and invitation elsewhere');
    assert.equal(counts.amcp_email_outbox, 2, 'their own notice, and the deployment notice that names them');
    assert.equal(counts.amcp_account_challenges, 1);
    assert.equal(counts.amcp_mfa, 1);
    assert.equal(counts.amcp_identities, 1);
    assert.equal(counts.amcp_web_sessions, 1);
    assert.equal(counts.media_chunks, 1);
    assert.ok(Number(plan.audit_records_to_tombstone) >= 2);
    // Nothing changed.
    assert.deepEqual(keptState(store, f.K, f.kept.id, f.erased.id), before);
    assert.equal(rows(store, 'SELECT max(seq) AS s FROM audit')[0]!.s, seq);
    assert.equal(rows(store, 'SELECT 1 FROM amcp_users WHERE id=?', f.erased.id).length, 1);
    assert.equal(store.authenticate(f.erasedOwnKey).tenantId, f.E);
  } finally {
    store.close();
  }
});

test('SEC-07 S4: erasing a synthetic account leaves zero rows of its workspace, the chain verifies and other workspaces are unchanged (regression: there was no erasure path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    store = new Store(path.join(dir, 'live.sqlite'), master);
  try {
    const f = populate(store),
      before = keptState(store, f.K, f.kept.id, f.erased.id);
    assert.equal(plaintextHolds(store, erasedEmail), 'amcp_users.email');
    const receipt = eraseAccount(store, {email: erasedEmail}, options);
    assert.equal(receipt.status, 'erased');
    assert.equal(receipt.reason, 'operator_request');
    assert.match(String(receipt.erasure_id), /^[0-9a-f-]{36}$/);
    // Zero rows of the erased workspace in every table with a tenant_id, except the audit, whose records stay in
    // the chain as tombstones of this erasure.
    for (const table of tenantTables(store)) {
      if (table === 'audit') continue;
      assert.equal(rows(store, 'SELECT 1 FROM "' + table + '" WHERE tenant_id=?', f.E).length, 0, table);
    }
    const audit = rows(store, 'SELECT event,request_id FROM audit WHERE tenant_id=?', f.E);
    assert.ok(audit.length >= 2);
    for (const row of audit) {
      assert.equal(row.event, auditTombstone(String(receipt.erasure_id)));
      assert.equal(row.request_id, '');
    }
    assert.equal(rows(store, 'SELECT 1 FROM tenants WHERE id=?', f.E).length, 0);
    // The person: account, identities, two-step secret, sessions, links, keys and grants are gone everywhere.
    for (const [sql, ...params] of [
      ['SELECT 1 FROM amcp_users WHERE id=?', f.erased.id],
      ['SELECT 1 FROM amcp_identities WHERE user_id=?', f.erased.id],
      ['SELECT 1 FROM amcp_mfa WHERE user_id=?', f.erased.id],
      ["SELECT 1 FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=?", f.erased.id],
      ['SELECT 1 FROM workspace_memberships WHERE user_id=?', f.erased.id],
      ['SELECT 1 FROM credential_owners WHERE user_id=?', f.erased.id],
      ['SELECT 1 FROM api_keys WHERE hash=?', f.aiHash],
      ["SELECT 1 FROM amcp_mcp_grants WHERE json_extract(data,'$.ownerUserId')=?", f.erased.id],
      ["SELECT 1 FROM documents WHERE id IN ('sub-erased','notice-erased','invite-erased')"],
    ] as [string, ...string[]][])
      assert.equal(rows(store, sql, ...params).length, 0, sql);
    assert.throws(() => store.authenticate(f.erasedKeyInK), {code: 'UNAUTHORIZED'});
    assert.throws(() => store.authenticate(f.erasedOwnKey), {code: 'UNAUTHORIZED'});
    assert.equal(rows(store, 'SELECT 1 FROM amcp_account_challenges').length, 1, 'only the kept person’s link');
    // Neither the address nor the name remains in the clear anywhere.
    assert.equal(plaintextHolds(store, erasedEmail), undefined);
    assert.equal(plaintextHolds(store, erasedName), undefined);
    // The other workspace and person are unchanged, and the chain verifies with the erasure's receipt.
    assert.deepEqual(keptState(store, f.K, f.kept.id, f.erased.id), before);
    assert.equal(store.authenticate(f.keptKey).tenantId, f.K);
    assert.equal(store.verifyAudit(), true);
    const event = rows(store, "SELECT event FROM audit WHERE tenant_id='local' ORDER BY seq DESC LIMIT 1")[0]!;
    const erasedEvent = JSON.parse(String(event.event));
    assert.equal(erasedEvent.event, 'account_erased');
    assert.equal(erasedEvent.tombstoned_rows, audit.length);
    assert.deepEqual(erasureReceipts(store, 'local'), [
      {
        erasure_id: receipt.erasure_id,
        user_id: f.erased.id,
        tenant_id: f.E,
        reason: 'operator_request',
        erased_at: receipt.erased_at,
      },
    ]);
    // Backup verification passes on the erased database.
    const archive = path.join(dir, 'after-erasure.amcp');
    await createEncryptedBackup(store, archive, master, {tmpdir: dir});
    assert.equal((await verifyEncryptedBackup(archive, master, dir)).status, 'verified');
    // A second erasure of the same person finds nothing.
    assert.throws(() => eraseAccount(store, {email: erasedEmail}, options), {code: 'NOT_FOUND'});
  } finally {
    store.close();
    removeTestDirectory(dir, prefix);
  }
});

test('SEC-07 S4: the audit admits only receipted tombstones; any other change still fails', () => {
  const store = new Store(':memory:', master);
  try {
    const f = populate(store);
    eraseAccount(store, {email: erasedEmail}, options);
    assert.equal(store.verifyAudit(), true);
    // Ordinary updates and deletes stay refused.
    assert.throws(() => store.db.exec("UPDATE audit SET event='{}'"), /append only/);
    assert.throws(() => store.db.exec('DELETE FROM audit'), /append only/);
    // A tombstone no account_erased record accounts for breaks verification, though the trigger lets its shape pass.
    store.db
      .prepare("UPDATE audit SET event=?,request_id='' WHERE seq=(SELECT max(seq) FROM audit WHERE tenant_id=?)")
      .run(auditTombstone(randomUUID()), f.K);
    assert.equal(store.verifyAudit(), false);
  } finally {
    store.close();
  }
});

test('SEC-07 S4: the deployment owner and a workspace other members use are refused; nothing is erased', () => {
  const store = new Store(':memory:', master);
  try {
    const f = populate(store);
    // The kept person's workspace has the person to erase as an active member.
    const plan = eraseAccount(store, {userId: f.kept.id}, {...options, dryRun: true});
    assert.equal(plan.status, 'refused');
    assert.equal((plan.refusal as JsonObject).code, 'ERASURE_WORKSPACE_SHARED');
    assert.throws(() => eraseAccount(store, {userId: f.kept.id}, options), {code: 'ERASURE_WORKSPACE_SHARED'});
    assert.equal(rows(store, 'SELECT 1 FROM amcp_users WHERE id=?', f.kept.id).length, 1);
    // An account of the deployment's own workspace (the owner after migration) is refused.
    const ownerId = randomUUID();
    store.db
      .prepare(
        "INSERT INTO amcp_users(id,email,name,tenant_id,created_at) VALUES(?,'owner@example.test','Owner','local',?)",
      )
      .run(ownerId, Date.now());
    assert.throws(() => eraseAccount(store, {email: 'owner@example.test'}, options), {code: 'ERASURE_REFUSED'});
    assert.throws(() => eraseAccount(store, {email: 'nobody@example.test'}, options), {code: 'NOT_FOUND'});
    assert.equal(store.verifyAudit(), true);
  } finally {
    store.close();
  }
});

test('SEC-07 S4: the retention sweep erases only never-approved sign-ups older than 30 days, and revoked accounts only when set', () => {
  assert.deepEqual(accountRetention({}), {pendingMs: 30 * day, revokedMs: null});
  assert.deepEqual(accountRetention({AMCP_PENDING_ACCOUNT_DAYS: 'off', AMCP_REVOKED_ACCOUNT_DAYS: '90'}), {
    pendingMs: null,
    revokedMs: 90 * day,
  });
  for (const value of ['0', '366', '1.5', 'never'])
    assert.throws(() => accountRetention({AMCP_PENDING_ACCOUNT_DAYS: value}), /AMCP_PENDING_ACCOUNT_DAYS/);
  // The website and the worker refuse to start with an unknown value; the stdio server keeps no accounts.
  assert.throws(() => loadConfig({AMCP_PENDING_ACCOUNT_DAYS: '0'}, 'http'), /AMCP_PENDING_ACCOUNT_DAYS/);
  assert.throws(() => loadConfig({AMCP_REVOKED_ACCOUNT_DAYS: 'soon'}, 'worker'), /AMCP_REVOKED_ACCOUNT_DAYS/);
  assert.equal(loadConfig({AMCP_PENDING_ACCOUNT_DAYS: '0'}, 'stdio').tenantId, undefined);
  assert.equal(loadConfig({AMCP_PENDING_ACCOUNT_DAYS: 'off'}, 'http').tenantId, undefined);
  const store = new Store(':memory:', master);
  // An unknown value stops start-up.
  assert.throws(
    () => accountLifecycleSweeper(store, {tenantId: 'local', env: {AMCP_REVOKED_ACCOUNT_DAYS: '0'}}),
    /AMCP_REVOKED_ACCOUNT_DAYS/,
  );
  try {
    const {accounts} = site(store),
      now = Date.now(),
      later = now + 31 * day,
      oldPending = accounts.newUser('Old pending', 'old-pending@example.test', null, false),
      newPending = accounts.newUser('New pending', 'new-pending@example.test', null, false),
      approved = accounts.newUser('Approved', 'approved@example.test', null, true),
      revoked = accounts.newUser('Revoked', 'revoked@example.test', null, true);
    // Signed up 21 days before `later`.
    store.db.prepare('UPDATE amcp_users SET created_at=? WHERE id=?').run(now + 10 * day, newPending.id);
    store.db.prepare('UPDATE amcp_users SET approved=0,disabled=1 WHERE id=?').run(revoked.id);
    store.appendAudit('local', randomUUID(), {event: 'account_access_revoked', user_id: revoked.id});
    assert.deepEqual(accountsDueForErasure(store, 'local', accountRetention({}), later), {
      pending: [oldPending.id],
      revoked: [],
    });
    const sweep = accountLifecycleSweeper(store, {tenantId: 'local', env: {}, now: () => later});
    assert.deepEqual(sweep(), {reviewer_connections: 0, accounts_erased: {pending: 1, revoked: 0, refused: 0}});
    const remaining = rows(store, 'SELECT id FROM amcp_users ORDER BY id').map(r => r.id);
    assert.deepEqual(remaining, [newPending.id, approved.id, revoked.id].sort());
    assert.equal(rows(store, 'SELECT 1 FROM tenants WHERE id=?', oldPending.tenant_id).length, 0);
    assert.equal(erasureReceipts(store, 'local')[0]!.reason, 'pending_retention');
    // At most once an hour.
    assert.equal(sweep(), undefined);
    // With a revoked-account period set, a revocation that long ago is erased too.
    const revokedSweep = accountLifecycleSweeper(store, {
      tenantId: 'local',
      env: {AMCP_REVOKED_ACCOUNT_DAYS: '30'},
      now: () => later,
    });
    assert.deepEqual(revokedSweep(), {reviewer_connections: 0, accounts_erased: {pending: 0, revoked: 1, refused: 0}});
    assert.deepEqual(
      rows(store, 'SELECT id FROM amcp_users ORDER BY id').map(r => r.id),
      [newPending.id, approved.id].sort(),
    );
    assert.equal(store.verifyAudit(), true);
  } finally {
    store.close();
  }
});

test('SEC-07 S4: erasure receipts are re-applied to a restored copy, by the library and the CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite'),
    store = new Store(file, master);
  let closed = false;
  try {
    const f = populate(store),
      archive = path.join(dir, 'before-erasure.amcp');
    await createEncryptedBackup(store, archive, master, {tmpdir: dir});
    eraseAccount(store, {email: erasedEmail}, options);
    const receipts = erasureReceipts(store, 'local');
    // A restored copy holds the erased account again until the receipts are re-applied.
    const restoredFile = path.join(dir, 'restored.sqlite');
    await restoreEncryptedBackup(archive, restoredFile, master);
    const restored = new Store(restoredFile, master);
    try {
      assert.equal(rows(restored, 'SELECT 1 FROM amcp_users WHERE id=?', f.erased.id).length, 1);
      const results = reapplyErasures(restored, JSON.parse(JSON.stringify(receipts)), 'local');
      assert.equal(results.length, 1);
      assert.equal(results[0]!.status, 'reapplied');
      for (const table of tenantTables(restored))
        if (table !== 'audit')
          assert.equal(rows(restored, 'SELECT 1 FROM "' + table + '" WHERE tenant_id=?', f.E).length, 0, table);
      assert.equal(rows(restored, 'SELECT 1 FROM amcp_users WHERE id=?', f.erased.id).length, 0);
      assert.equal(restored.verifyAudit(), true);
      const again = erasureReceipts(restored, 'local');
      assert.equal(again[0]!.reason, 'restore_reapply');
      // Applying them again finds nothing.
      assert.deepEqual(reapplyErasures(restored, receipts, 'local'), [
        {erasure_id: receipts[0]!.erasure_id, status: 'absent'},
      ]);
      assert.throws(() => reapplyErasures(restored, [{erasure_id: 'x; DROP TABLE'}], 'local'), {
        code: 'INVALID_ERASURE_RECEIPTS',
      });
    } finally {
      restored.close();
    }
    store.close();
    closed = true;
    // The CLI: a dry run, a confirmed erasure, the receipts and their re-application to another restored copy.
    const env = {...process.env, MIRROR_DB: file, MIRROR_MASTER_KEY: master, AMCP_TENANT_ID: 'local'},
      run = (...args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...env}, timeout: 30000});
    const kept = run('erase-account', 'kept@example.test', '--dry-run');
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(JSON.parse(kept.stdout).status, 'planned', 'the kept workspace is no longer shared');
    assert.equal(run('erase-account', 'kept@example.test').status, 1, 'a mode is required');
    const erased = run('erase-account', 'kept@example.test', '--confirm');
    assert.equal(erased.status, 0, erased.stderr);
    assert.equal(JSON.parse(erased.stdout).status, 'erased');
    assert.equal(erased.stdout.includes('kept@example.test'), false);
    const listed = run('erasure-receipts');
    assert.equal(listed.status, 0, listed.stderr);
    const receiptFile = path.join(dir, 'receipts.json');
    fs.writeFileSync(receiptFile, listed.stdout);
    assert.equal(JSON.parse(listed.stdout).length, 2);
    const second = path.join(dir, 'restored-cli.sqlite');
    await restoreEncryptedBackup(archive, second, master);
    const reapplied = spawnSync(process.execPath, [cli, 'erasure-reapply', receiptFile], {
      encoding: 'utf8',
      env: {...env, MIRROR_DB: second},
      timeout: 30000,
    });
    assert.equal(reapplied.status, 0, reapplied.stderr);
    const report = JSON.parse(reapplied.stdout);
    assert.equal(report.reapplied, 2);
    assert.equal(report.audit_chain_valid, true);
    const verified = new Store(second, master);
    try {
      assert.equal(rows(verified, 'SELECT 1 FROM amcp_users').length, 0);
      assert.equal(verified.verifyAudit(), true);
    } finally {
      verified.close();
    }
  } finally {
    if (!closed) store.close();
    removeTestDirectory(dir, prefix);
  }
});
