import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {monitorOperation, evaluateMonitors} from '../dist/src/report-monitors.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {attentionStates, campaignPlanStates, operationCategory, operationKinds} from '../dist/src/operation-types.js';
import {recordAuthorized, recordRefreshFailed} from '../dist/src/connection-health.js';

/**
 * OPS-06 (owner decision D22): one attention vocabulary for Operations and Home, and the journey-4F sources in the
 * feed. Before, Home kept its own list of plan states and missed a plan in `attention`; failed monitor emails and logins
 * that need reauthorization were not in the feed at all, so they surfaced only when a later call failed.
 */

test('every state the campaign runner gives a plan has a category, and attention plans need attention', () => {
  const runner = fs.readFileSync('src/campaign-runner.ts', 'utf8'),
    assigned = new Set([
      ...[...runner.matchAll(/run\.state = '([a-z_]+)'/g)].map(m => m[1]),
      ...[...runner.matchAll(/state: '([a-z_]+)'/g)].map(m => m[1]).filter(s => s === 'draft'),
      ...[...runner.matchAll(/\? '([a-z_]+)' : settled\(step\) \? '([a-z_]+)' : '([a-z_]+)'/g)].flatMap(m =>
        m.slice(1),
      ),
      ...[...runner.matchAll(/\{\.\.\.run, state: '([a-z_]+)'\}/g)].map(m => m[1]),
    ]);
  for (const state of ['attention', 'awaiting_review', 'in_progress', 'complete', 'cancelled', 'draft'])
    assert.ok(assigned.has(state), 'the runner assigns ' + state);
  for (const state of assigned) assert.ok(campaignPlanStates.includes(state), state + ' is in campaignPlanStates');
  const categories = Object.fromEntries(campaignPlanStates.map(s => [s, operationCategory('campaign', s)]));
  assert.deepEqual(categories, {
    draft: 'active',
    awaiting_review: 'attention',
    in_progress: 'active',
    attention: 'attention',
    complete: 'complete',
    cancelled: 'complete',
  });
  assert.ok(attentionStates.includes('reauthorization_required'));
  assert.deepEqual(operationKinds.slice(-3), ['write', 'notice', 'connection']);
});

function noticeFixture(t) {
  const master = Buffer.alloc(32, 91).toString('base64'),
    store = new Store(':memory:', master),
    gates = {status: 503};
  t.after(() => store.close());
  const web = new WebStore(store, {
    origin: 'https://workspace.example.test',
    masterKey: master,
    authEnv: {AMCP_EMAIL_API_KEY: 'synthetic-mail', AMCP_EMAIL_FROM: 'alerts@example.test'},
    fetcher: async () => new Response('{}', {status: gates.status}),
  });
  const accounts = new UserAccounts(web),
    member = accounts.session(accounts.newUser('Member', 'member@example.test', null, true)).actor,
    second = accounts.newUser('Other', 'other@example.test', null, true);
  // Another member of the same workspace, who reads the same account and incident.
  store.db
    .prepare("INSERT INTO workspace_memberships(tenant_id,user_id,role,active,created_at) VALUES(?,?,'viewer',1,?)")
    .run(member.tenantId, second.id, Date.now());
  const other = accounts.session(second, member.tenantId).actor;
  store.putConnection(
    member,
    {
      id: 'meta',
      tenantId: member.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const context = {
    platform: 'meta',
    connection_id: 'meta',
    account_id: '100',
    currency: 'USD',
    timezone: 'UTC',
    result_definition: 'Purchases',
    attribution: '7-day click',
  };
  const rule = monitorOperation(store, member, {
    action: 'save_monitor',
    confirmed: true,
    monitor: {
      ...context,
      name: 'Spend ceiling',
      metric: 'spend',
      comparison: 'above',
      threshold: '50',
      max_age_hours: 24,
    },
  });
  const settings = () => monitorOperation(store, member, {action: 'monitor_notifications', id: rule.id});
  monitorOperation(store, member, {
    action: 'set_monitor_notifications',
    id: rule.id,
    enabled: true,
    subscription_version: settings().subscription_version,
    confirmed: true,
  });
  const group = {
    ...context,
    date_from: '2026-09-01',
    date_to: '2026-09-07',
    objective_group: 'sales',
    metrics: {spend: 60},
    complete: true,
  };
  store.putDocument(member.tenantId, 'overview_report', 'report-1', {
    state: 'complete',
    config: {sources: [context]},
    rows: [{...group, captured_at: Date.now()}],
    summary: [group],
  });
  evaluateMonitors(store, member, 'report-1');
  const feed = (actor, extra = {}) => operationsPage(store, actor, {state: 'attention', ...extra}, true);
  return {store, accounts, member, other, gates, settings, feed};
}

test('a monitor notice that ran out of attempts is attention for its subscriber only, and recovery clears it', async t => {
  t.mock.timers.enable({apis: ['Date'], now: Date.parse('2026-10-01T12:00:00Z')});
  const f = noticeFixture(t);
  for (let i = 0; i < 5; i++) {
    await f.accounts.deliverEmails();
    t.mock.timers.tick(180000);
  }
  const notice = f.settings().deliveries[0];
  assert.equal(notice.state, 'failed');
  const page = f.feed(f.member),
    row = page.operations.find(o => o.kind === 'notice');
  assert.ok(row, JSON.stringify(page.operations));
  assert.equal(row.id, notice.id);
  assert.equal(row.state, 'failed');
  assert.equal(row.category, 'attention');
  assert.equal(row.name, 'Spend ceiling');
  assert.equal(row.error_code, 'EMAIL_PROVIDER_REJECTED');
  assert.equal(row.website_path, '/monitors?incident_id=' + encodeURIComponent(notice.incident_id));
  assert.deepEqual(row.next_call, {
    tool: 'amcp_workspace',
    arguments: {action: 'monitor_notifications', id: notice.monitor_id},
  });
  assert.equal(row.automatic_retry_of_mutation, false);
  // Metadata only: no recipient, payload or provider wording.
  assert.doesNotMatch(JSON.stringify(page), /member@example|synthetic-mail|Email provider returned|secret|payload/);
  // Another member of the workspace does not see someone else's notice.
  assert.equal(
    f.feed(f.other).operations.some(o => o.kind === 'notice'),
    false,
  );
  // The kind filter and cursor accept the new kind.
  assert.equal(operationsPage(f.store, f.member, {kind: 'notice'}, true).operations.length, 1);
  // A confirmed recovery requeues the original notice: it leaves the attention feed until it fails again.
  monitorOperation(f.store, f.member, {
    action: 'retry_monitor_notification',
    notification_id: notice.id,
    notification_version: notice.notification_version,
    confirmed: true,
  });
  assert.equal(
    f.feed(f.member).operations.some(o => o.kind === 'notice'),
    false,
  );
  // After its 24 hours a failed notice stays listed as undelivered, no longer as attention.
  f.gates.status = 422;
  await f.accounts.deliverEmails();
  assert.equal(f.feed(f.member).operations.find(o => o.kind === 'notice')?.state, 'failed');
  t.mock.timers.tick(86400000);
  assert.equal(
    f.feed(f.member).operations.some(o => o.kind === 'notice'),
    false,
  );
  assert.equal(operationsPage(f.store, f.member, {kind: 'notice'}, true).operations[0].state, 'undelivered');
});

function connectionFixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 92).toString('base64')),
    admin = {tenantId: 'logins', userId: 'admin', role: 'admin'},
    operator = {tenantId: 'logins', userId: 'operator', role: 'operator'};
  const connection = {
    id: 'google',
    tenantId: admin.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['123', '456'],
    writeAccounts: ['123'],
    enabled: true,
    label: 'Agency Google login',
    scopes: [],
  };
  store.putConnection(admin, connection, {accessToken: 'synthetic', refreshToken: 'synthetic-refresh'});
  const current = () => store.listConnections(admin.tenantId).find(c => c.id === 'google');
  return {store, admin, operator, current};
}

test('a login the provider rejected is attention for administrators only, until it is reauthorized', () => {
  const f = connectionFixture();
  try {
    const call = (actor, extra = {}) => operationsPage(f.store, actor, {state: 'attention', ...extra}, true);
    assert.deepEqual(call(f.admin).operations, []);
    recordRefreshFailed(
      f.store,
      f.current(),
      {},
      {code: 'invalid_grant'.toUpperCase(), http_status: 400, grantRejected: true},
    );
    const row = call(f.admin).operations.find(o => o.kind === 'connection');
    assert.ok(row);
    assert.equal(row.state, 'reauthorization_required');
    assert.equal(row.category, 'attention');
    assert.equal(row.name, 'Agency Google login');
    assert.deepEqual(row.accounts, ['123', '456']);
    assert.equal(row.error_code, 'INVALID_GRANT');
    assert.equal(row.website_path, '/connections?connection_id=google');
    assert.equal(row.next_call.arguments.action, 'dashboard');
    assert.match(row.next_safe_action, /reauthorize this login in place/);
    assert.doesNotMatch(JSON.stringify(row), /synthetic|refresh_token|access/i);
    // Account and connection filters apply to it; operators and viewers never see a login's state.
    assert.equal(call(f.admin, {account_id: '456'}).operations.length, 1);
    assert.equal(call(f.admin, {account_id: '999'}).operations.length, 0);
    assert.deepEqual(call(f.operator).operations, []);
    // Reauthorizing records a healthy login: it leaves the feed.
    recordAuthorized(f.store, f.current(), {accessToken: 'synthetic', refreshToken: 'synthetic-refresh'});
    assert.deepEqual(call(f.admin).operations, []);
    // Repeated renewal failures are attention too; a record of an older login revision is not.
    recordRefreshFailed(
      f.store,
      f.current(),
      {},
      {code: 'TOKEN_REFRESH_FAILED', http_status: 503, grantRejected: false},
    );
    assert.equal(call(f.admin).operations[0].state, 'refresh_failed');
    const stale = f.store.document(f.admin.tenantId, 'connection_health', 'google');
    f.store.putDocument(f.admin.tenantId, 'connection_health', 'google', {...stale, login_revision: 99});
    assert.deepEqual(call(f.admin).operations, []);
    // A connection an administrator turned off is listed as deferred, not as attention.
    f.store.putConnection(f.admin, {...f.current(), enabled: false}, {accessToken: 'synthetic'});
    assert.deepEqual(call(f.admin).operations, []);
    const off = operationsPage(f.store, f.admin, {kind: 'connection'}, true).operations[0];
    assert.equal(off.state, 'disabled');
    assert.equal(off.category, 'deferred');
  } finally {
    f.store.close();
  }
});

test('the feed through MCP lists the new kinds within its scan bound and cursor binding', async () => {
  const f = connectionFixture();
  try {
    const service = new MirrorService(
      new Registry(),
      f.store,
      new NativeTransport(async () => {
        throw Error('Operations must never use the network');
      }),
      undefined,
      {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
    );
    recordRefreshFailed(f.store, f.current(), {}, {code: 'INVALID_GRANT', http_status: 400, grantRejected: true});
    for (let i = 0; i < 3; i++)
      f.store.putConnection(
        f.admin,
        {
          id: 'off-' + i,
          tenantId: f.admin.tenantId,
          gateway: 'meta_native_action',
          accounts: [String(100 + i)],
          enabled: false,
          label: 'Off ' + i,
          scopes: [],
        },
        {accessToken: 'synthetic'},
      );
    const rows = [];
    let cursor;
    do {
      const r = await service.call(
        'amcp_workspace',
        {action: 'operations', kind: 'connection', limit: 2, ...(cursor ? {cursor} : {})},
        f.admin,
      );
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.network_requests, 0);
      assert.ok(r.data.coverage.includes('notice') && r.data.coverage.includes('connection'));
      rows.push(...r.data.operations);
      cursor = r.data.next_cursor;
    } while (cursor);
    assert.equal(rows.length, 4);
    assert.equal(new Set(rows.map(r => r.key)).size, 4);
    // A cursor from one identity is refused for another.
    const first = await service.call('amcp_workspace', {action: 'operations', kind: 'connection', limit: 1}, f.admin);
    const refused = await service.call(
      'amcp_workspace',
      {action: 'operations', kind: 'connection', limit: 1, cursor: first.data.next_cursor},
      f.operator,
    );
    assert.equal(refused.error.code, 'INVALID_CURSOR');
  } finally {
    f.store.close();
  }
});
