// SEC-07 retention (owner decision P3 of 2026-10-11: design to GDPR and KSA PDPL). Before this change revoked accounts
// were kept forever unless the owner set AMCP_REVOKED_ACCOUNT_DAYS, report records were kept forever unless a workspace
// owner saved a period, accounts whose workspace others use were selected (and refused) by every hourly sweep ahead of
// erasable ones, a sweep left no record of its own, and an erasure left the erased pages in the write-ahead log until
// some unrelated deletion asked for a checkpoint. Synthetic accounts and reports only; no provider or e-mail traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {Store} from '../src/store.js';
import {WebStore} from '../server/web-store.js';
import {UserAccounts} from '../server/user-accounts.js';
import {AccountSecurity} from '../server/account-security.js';
import {accountLifecycleSweeper} from '../server/account-lifecycle.js';
import {loadConfig} from '../server/config.js';
import {
  accountsDueForErasure,
  accountRetention,
  eraseAccount,
  retentionBlockedAccounts,
} from '../src/account-erasure.js';
import {
  DEFAULT_REPORT_RETENTION_DAYS,
  reportRetention,
  reportRetentionDefault,
  reportRetentionKinds,
} from '../src/data-retention.js';
import {cleanupReports, ownerOperations} from '../src/owner-operations.js';
import type {JsonObject} from '../src/types.js';
import {removeTestDirectory} from './temp.js';

const origin = 'https://amcp.shop',
  master = Buffer.alloc(32, 83).toString('base64'),
  day = 86400000,
  prefix = 'amcp-data-retention-';

function site(store: Store) {
  const web = new WebStore(store, {
    origin,
    masterKey: master,
    adminPassword: 'synthetic-retention-admin-door',
    authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-email-key', AMCP_EMAIL_FROM: 'amcp@example.test'},
    fetcher: async () => {
      throw Error('No provider or e-mail traffic allowed');
    },
  });
  return {web, accounts: new UserAccounts(web)};
}
const events = (store: Store, tenant: string, name: string) =>
  (store.db.prepare('SELECT event FROM audit WHERE tenant_id=? ORDER BY seq').all(tenant) as {event: string}[])
    .map(r => JSON.parse(r.event) as JsonObject)
    .filter(e => e.event === name);
const userIds = (store: Store) =>
  (store.db.prepare('SELECT id FROM amcp_users ORDER BY id').all() as {id: string}[]).map(r => r.id);
/** Revokes `id` as the AMCP owner does: disabled, with the revocation audited at `at` (the audit is append-only). */
function revoke(store: Store, id: string, at: number) {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    store.db.prepare('UPDATE amcp_users SET approved=0,disabled=1 WHERE id=?').run(id);
    store.appendAudit('local', randomUUID(), {event: 'account_access_revoked', user_id: id});
  } finally {
    Date.now = realNow;
  }
}

test('P3: revoked accounts are erased 90 days after revocation by default, and each sweep that erased leaves a retention_sweep record', () => {
  const store = new Store(':memory:', master);
  try {
    const {accounts} = site(store),
      now = Date.now(),
      longAgo = accounts.newUser('Revoked long ago', 'revoked-long-ago@example.test', null, true),
      recently = accounts.newUser('Revoked recently', 'revoked-recently@example.test', null, true),
      active = accounts.newUser('Active', 'active@example.test', null, true);
    revoke(store, longAgo.id, now - 91 * day);
    revoke(store, recently.id, now - 89 * day);
    // The default retention, with nothing set: before owner decision P3 nothing revoked was ever selected.
    assert.deepEqual(accountsDueForErasure(store, 'local', accountRetention({}), now), {
      pending: [],
      revoked: [longAgo.id],
    });
    const lines: Record<string, unknown>[] = [],
      sweep = accountLifecycleSweeper(store, {tenantId: 'local', env: {}, now: () => now, log: e => lines.push(e)});
    assert.deepEqual(sweep(), {
      reviewer_connections: 0,
      accounts_erased: {pending: 0, revoked: 1, refused: 0, blocked: 0},
    });
    assert.deepEqual(userIds(store), [recently.id, active.id].sort());
    // The scheduled sweep also writes one metadata-only log line: counts, never an account.
    assert.deepEqual(lines.slice(), [
      {level: 'info', event: 'retention_sweep', pending: 0, revoked: 1, refused: 0, blocked: 0},
    ]);
    const [record] = events(store, 'local', 'retention_sweep');
    assert.deepEqual(record, {
      event: 'retention_sweep',
      pending_erased: 0,
      revoked_erased: 1,
      refused: 0,
      blocked: 0,
      pending_days: 30,
      revoked_days: 90,
    });
    assert.equal(events(store, 'local', 'account_erased')[0]!.reason, 'revoked_retention');
    // A run that erased nothing leaves no record; `off` keeps revoked accounts.
    const quiet = accountLifecycleSweeper(store, {
      tenantId: 'local',
      env: {AMCP_REVOKED_ACCOUNT_DAYS: 'off'},
      now: () => now + 30 * day,
      log: e => lines.push(e),
    });
    assert.deepEqual(quiet(), {
      reviewer_connections: 0,
      accounts_erased: {pending: 0, revoked: 0, refused: 0, blocked: 0},
    });
    assert.equal(events(store, 'local', 'retention_sweep').length, 1);
    assert.equal(lines.length, 1);
    assert.deepEqual(userIds(store), [recently.id, active.id].sort());
    assert.equal(store.verifyAudit(), true);
  } finally {
    store.close();
  }
});

test('P3: accounts whose workspace other members use no longer hold back the sweep; the owner sees them counted (regression: 100 refusals per run starved every later account)', () => {
  const store = new Store(':memory:', master);
  try {
    const {web, accounts} = site(store),
      now = Date.now(),
      colleague = accounts.newUser('Colleague', 'colleague@example.test', null, true),
      insert = store.db.prepare(
        'INSERT INTO amcp_users(id,email,name,tenant_id,approved,disabled,created_at) VALUES(?,?,?,?,0,1,?)',
      ),
      member = store.db.prepare(
        "INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,'operator',?)",
      );
    // 100 revoked accounts, all older than the erasable one, whose own workspace the colleague still works in.
    for (let i = 0; i < 100; i++) {
      const id = 'blocked-' + String(i).padStart(3, '0'),
        tenant = 'user-blocked-' + i;
      store.ensureTenant(tenant);
      insert.run(id, id + '@example.test', 'Blocked ' + i, tenant, now - 400 * day + i);
      member.run(tenant, id, now - 400 * day);
      member.run(tenant, colleague.id, now - 400 * day);
    }
    const erasable = accounts.newUser('Erasable revoked', 'erasable@example.test', null, true);
    store.db.prepare('UPDATE amcp_users SET created_at=? WHERE id=?').run(now - 300 * day, erasable.id);
    revoke(store, erasable.id, now - 120 * day);
    const retention = accountRetention({});
    assert.deepEqual(accountsDueForErasure(store, 'local', retention, now).revoked, [erasable.id]);
    assert.equal(retentionBlockedAccounts(store, 'local', retention, now), 100);
    const sweep = accountLifecycleSweeper(store, {tenantId: 'local', env: {}, now: () => now});
    assert.deepEqual(sweep(), {
      reviewer_connections: 0,
      accounts_erased: {pending: 0, revoked: 1, refused: 0, blocked: 100},
    });
    assert.equal(store.db.prepare('SELECT 1 FROM amcp_users WHERE id=?').get(erasable.id), undefined);
    assert.equal(events(store, 'local', 'retention_sweep')[0]!.blocked, 100);
    // The AMCP owner's access list states both periods and how many accounts the sweep keeps.
    const admin = web.createSession({tenantId: 'local', userId: 'workspace-admin', role: 'admin'}),
      req = {
        headers: {origin, cookie: web.cookie(admin.id), 'x-amcp-csrf': admin.csrf},
        socket: {remoteAddress: '127.0.0.1'},
      } as unknown as Request,
      list = new AccountSecurity(accounts).accessRequests(req);
    assert.equal(list.pendingRetentionDays, 30);
    assert.equal(list.revokedRetentionDays, 90);
    assert.equal(list.retentionBlocked, 100);
  } finally {
    store.close();
  }
});

test('P3: an erasure truncates the write-ahead log at the next maintenance pass (regression: no checkpoint was asked for)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
    file = path.join(dir, 'live.sqlite'),
    store = new Store(file, master);
  try {
    const {accounts} = site(store),
      person = accounts.newUser('WAL Person', 'wal.person@example.test', null, true);
    store.putDocument(String(person.tenant_id), 'report_snapshot', 'weekly', {title: 'WAL Person weekly report'});
    // Nothing deleted yet: no checkpoint is pending.
    assert.equal(store.checkpointAfterDeletes(), false);
    eraseAccount(store, {userId: person.id}, {deploymentTenant: 'local', reason: 'operator_request', by: 'cli'});
    assert.equal(store.checkpointAfterDeletes(), true);
    assert.equal(fs.statSync(file + '-wal').size, 0);
  } finally {
    store.close();
    removeTestDirectory(dir, prefix);
  }
});

test('P3: report records follow the deployment default (365 days) without a workspace period, the workspace period wins, off keeps them, and each cleanup is audited', () => {
  assert.equal(reportRetentionDefault({}), DEFAULT_REPORT_RETENTION_DAYS);
  assert.equal(DEFAULT_REPORT_RETENTION_DAYS, 365);
  assert.equal(reportRetentionDefault({AMCP_REPORT_RETENTION_DAYS: 'off'}), null);
  assert.equal(reportRetentionDefault({AMCP_REPORT_RETENTION_DAYS: '730'}), 730);
  for (const value of ['6', '3651', '30.5', 'forever'])
    assert.throws(() => reportRetentionDefault({AMCP_REPORT_RETENTION_DAYS: value}), /AMCP_REPORT_RETENTION_DAYS/);
  assert.deepEqual(reportRetention(undefined, 365), {days: 365, source: 'deployment_default'});
  assert.deepEqual(reportRetention({days: 30}, 365), {days: 30, source: 'workspace'});
  assert.deepEqual(reportRetention({days: 30}, null), {days: 30, source: 'workspace'});
  assert.deepEqual(reportRetention({archived_campaign_plans_days: 30}, null), {days: null, source: 'off'});
  const store = new Store(':memory:', master);
  try {
    const now = Date.now(),
      put = (tenant: string, kind: string, id: string, data: JsonObject) => store.putDocument(tenant, kind, id, data);
    const seed = (tenant: string) => {
      store.ensureTenant(tenant);
      put(tenant, 'overview_report', 'old', {state: 'complete', created_at: now - 400 * day});
      put(tenant, 'overview_report', 'middle', {state: 'complete', created_at: now - 60 * day});
      put(tenant, 'overview_report', 'old-running', {state: 'running', created_at: now - 400 * day});
      put(tenant, 'report_presentation', 'old', {title: 'Old snapshot presentation'});
      put(tenant, 'decision_report', 'old-analysis', {captured_at: now - 400 * day});
      put(tenant, 'report_incident', 'old-open', {state: 'open', updated_at: now - 400 * day});
      put(tenant, 'report_incident', 'old-resolved', {state: 'resolved', updated_at: now - 400 * day});
      // Finished report jobs of two kinds past the period, and one inside it.
      const job = (id: string, kind: string, state: string, at: number) =>
        store.db
          .prepare(
            "INSERT INTO jobs(id,tenant_id,kind,input,state,available_at,created_at,updated_at) VALUES(?,?,?,'{}',?,?,?,?)",
          )
          .run(tenant + ':' + id, tenant, kind, state, at, at, at);
      job('old-overview', 'report_overview', 'complete', now - 400 * day);
      job('old-export', 'sheets_export', 'failed', now - 400 * day);
      job('recent-overview', 'report_overview', 'complete', now - 10 * day);
    };
    const jobs = (tenant: string) =>
      (store.db.prepare('SELECT id FROM jobs WHERE tenant_id=? ORDER BY id').all(tenant) as {id: string}[]).map(r =>
        r.id.slice(tenant.length + 1),
      );
    const ids = (tenant: string, kind: string) =>
      store
        .documents(tenant, kind)
        .map(d => String(d.id))
        .sort();
    seed('no-period');
    seed('own-period');
    seed('plans-only');
    put('own-period', 'retention_policy', 'reports', {days: 30});
    put('plans-only', 'retention_policy', 'reports', {archived_campaign_plans_days: 3650});
    cleanupReports(store, 365);
    // Without a workspace period the default applies (before P3 nothing was ever deleted there).
    for (const tenant of ['no-period', 'plans-only']) {
      assert.deepEqual(ids(tenant, 'overview_report'), ['middle', 'old-running'], tenant);
      assert.deepEqual(ids(tenant, 'report_presentation'), [], tenant);
      assert.deepEqual(ids(tenant, 'decision_report'), [], tenant);
      assert.deepEqual(ids(tenant, 'report_incident'), ['old-open'], tenant);
      const [record] = events(store, tenant, 'report_retention_applied');
      assert.deepEqual(record, {
        event: 'report_retention_applied',
        days: 365,
        source: 'deployment_default',
        deleted: {
          report_incident: 1,
          decision_report: 1,
          overview_report: 1,
          report_presentation: 1,
          'job:report_overview': 1,
          'job:sheets_export': 1,
        },
      });
      // Regression (wave 3a review): jobs were counted under one `jobs` key that matched no declared kind.
      for (const kind of Object.keys(record!.deleted as JsonObject))
        assert.ok(reportRetentionKinds.includes(kind), kind + ' is a declared retention kind');
      assert.deepEqual(jobs(tenant), ['recent-overview'], tenant);
    }
    // The workspace's own period wins over the default.
    assert.deepEqual(ids('own-period', 'overview_report'), ['old-running']);
    assert.equal(events(store, 'own-period', 'report_retention_applied')[0]!.source, 'workspace');
    // A second pass with nothing left to delete leaves no further record.
    cleanupReports(store, 365);
    assert.equal(events(store, 'no-period', 'report_retention_applied').length, 1);
    // With the default off, a workspace without its own period keeps everything.
    seed('kept');
    cleanupReports(store, null);
    assert.deepEqual(ids('kept', 'overview_report'), ['middle', 'old', 'old-running']);
    assert.equal(events(store, 'kept', 'report_retention_applied').length, 0);
    assert.equal(store.verifyAudit(), true);
    // The owner's health names the period in force and where it comes from.
    const health = ownerOperations(store, {action: 'health'}, {tenantId: 'no-period', userId: 'owner', role: 'admin'});
    assert.equal((health.report_retention as JsonObject).days, 365);
    assert.equal((health.report_retention as JsonObject).source, 'deployment_default');
    assert.ok(((health.report_retention as JsonObject).kinds as string[]).includes('overview_report'));
    const own = ownerOperations(store, {action: 'health'}, {tenantId: 'own-period', userId: 'owner', role: 'admin'});
    assert.deepEqual(
      {days: (own.report_retention as JsonObject).days, source: (own.report_retention as JsonObject).source},
      {days: 30, source: 'workspace'},
    );
  } finally {
    store.close();
  }
});

test('P3: unknown retention or self-service deletion values stop the website and the worker', () => {
  assert.throws(() => loadConfig({AMCP_REPORT_RETENTION_DAYS: '5'}, 'http'), /AMCP_REPORT_RETENTION_DAYS/);
  assert.throws(() => loadConfig({AMCP_REPORT_RETENTION_DAYS: 'never'}, 'worker'), /AMCP_REPORT_RETENTION_DAYS/);
  assert.throws(() => loadConfig({AMCP_ACCOUNT_SELF_DELETION: 'maybe'}, 'http'), /AMCP_ACCOUNT_SELF_DELETION/);
  assert.throws(() => loadConfig({AMCP_REVOKED_ACCOUNT_DAYS: '0'}, 'http'), /AMCP_REVOKED_ACCOUNT_DAYS/);
  for (const env of [
    {AMCP_REPORT_RETENTION_DAYS: 'off'},
    {AMCP_REPORT_RETENTION_DAYS: '90'},
    {AMCP_ACCOUNT_SELF_DELETION: 'off'},
    {AMCP_REVOKED_ACCOUNT_DAYS: 'off'},
  ])
    assert.equal(loadConfig(env, 'http').entry, 'http');
  assert.equal(loadConfig({AMCP_REPORT_RETENTION_DAYS: '5'}, 'stdio').entry, 'stdio');
});
