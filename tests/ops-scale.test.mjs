// OPS-08 measured scaling: the global due-schedule query that replaced one query per workspace on every worker cycle,
// and provider quota by issuer (shared app identity) with a per-workspace share and a reserved slice.
// Synthetic stores and a fake fetcher only; no provider request, real credential or production database is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../dist/src/store.js';
import {NativeTransport} from '../dist/src/transport.js';
import {operationsHealth} from '../dist/src/operations-health.js';
import {dueScheduleTenants, dueSchedules, dueTenantSQL} from '../dist/src/scheduled-work.js';
import {
  issuerKey,
  providerQuotaHealth,
  quotaPolicyFromEnv,
  requestOperations,
  runWithQuotaPurpose,
} from '../dist/src/provider-quota.js';
import {removeTestDirectory} from '../dist/tests/temp.js';

const key = Buffer.alloc(32, 63).toString('base64'),
  kinds = ['reporting_schedule', 'overview_schedule'];

test('the global due query names exactly the workspaces a per-workspace scan selects from, in workspace order', () => {
  const store = new Store(':memory:', key),
    at = 1791000000000;
  try {
    store.transaction(() => {
      for (let t = 0; t < 300; t++) store.ensureTenant('w-' + String(t).padStart(3, '0'));
      const put = (tenant, kind, id, data) => store.putDocument(tenant, kind, id, data);
      // Due, in two workspaces listed out of order.
      put('w-250', 'reporting_schedule', 's1', {is_active: true, next_run_at: at - 1});
      put('w-007', 'reporting_schedule', 's1', {is_active: 1, next_run_at: at});
      // Legacy declarations the exact predicate still treats as due.
      put('w-100', 'overview_schedule', 's1', {is_active: 'yes', next_run_at: String(at - 5)});
      // Not due: inactive, in the future, falsy legacy values, another kind.
      put('w-001', 'reporting_schedule', 's1', {is_active: false, next_run_at: at - 1});
      put('w-002', 'reporting_schedule', 's1', {is_active: true, next_run_at: at + 1});
      put('w-003', 'reporting_schedule', 's1', {is_active: '', next_run_at: at - 1});
      put('w-004', 'reporting_schedule', 's1', {is_active: 0, next_run_at: at - 1});
      put('w-005', 'unrelated', 's1', {is_active: true, next_run_at: 0});
      // A document of a workspace that no longer exists is never named (listTenants parity).
      store.db
        .prepare("INSERT INTO documents(tenant_id,kind,id,data) VALUES('gone','reporting_schedule','s1',?)")
        .run(JSON.stringify({is_active: true, next_run_at: at - 1}));
    });
    for (const kind of kinds) {
      const scanned = store.listTenants().filter(tenant => dueSchedules(store, tenant, kind, at).length);
      assert.deepEqual(dueScheduleTenants(store, kind, at), scanned, kind);
      const plan = store.db
        .prepare('EXPLAIN QUERY PLAN ' + dueTenantSQL[kind])
        .all(at)
        .map(row => row.detail)
        .join('\n');
      assert.match(plan, new RegExp('USING (COVERING )?INDEX ' + kind + '_due_global'), plan);
      assert.doesNotMatch(plan, /SCAN documents\b(?! USING)/, plan);
    }
    assert.deepEqual(dueScheduleTenants(store, 'reporting_schedule', at), ['w-007', 'w-250']);
    assert.deepEqual(dueScheduleTenants(store, 'overview_schedule', at), ['w-100']);
    assert.deepEqual(dueScheduleTenants(store, 'reporting_schedule', at - 1), ['w-250']);
  } finally {
    store.close();
  }
});

test('the per-workspace selection keeps its own index beside the global one', () => {
  const store = new Store(':memory:', key);
  try {
    for (const kind of kinds)
      assert.match(
        store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT id FROM documents WHERE tenant_id=? AND kind='" +
              kind +
              "' AND json_extract(data,'$.is_active') IS NOT NULL AND json_extract(data,'$.is_active')<>0 AND json_extract(data,'$.is_active')<>'' AND coalesce(CAST(json_extract(data,'$.next_run_at') AS REAL),0)<=? ORDER BY id",
          )
          .all('w', 1)
          .map(row => row.detail)
          .join('\n'),
        new RegExp('USING INDEX ' + kind + '_due \\('),
      );
  } finally {
    store.close();
  }
});

// --- Provider quota by issuer (OPS-08) ---------------------------------------------------------------------------
const sharedApp = 'synthetic-shared-oauth-client-id',
  plan = {
    gateway: 'meta_native_action',
    action: 'list',
    method: 'GET',
    path: '/v26.0/act_123/campaigns',
    query: {limit: 1},
    headers: {},
    readOnly: true,
    destructive: false,
    requiresConfirmation: false,
    accountId: '123',
    evidence: 'TEST',
    warnings: [],
  },
  connectionOf = tenantId => ({
    id: 'c-' + tenantId,
    tenantId,
    gateway: 'meta_native_action',
    accounts: ['123'],
    label: 'synthetic',
    enabled: true,
    scopes: [],
  }),
  credentials = {accessToken: 'SYNTHETIC_TOKEN_NOT_REAL', clientId: sharedApp};
function quotaFixture(file) {
  const store = new Store(file, key);
  let sent = 0;
  const transport = new NativeTransport(
    async () => {
      sent++;
      return new Response('{"data":[]}', {status: 200, headers: {'Content-Type': 'application/json'}});
    },
    async () => {},
  );
  transport.coordination = store;
  return {store, transport, sent: () => sent};
}
const enforce = {
  mode: 'enforce',
  profiles: {meta_native_action: {daily_requests: 20, reserved_fraction: 0.1, tenant_share: 0.5}},
};

test('quota profiles: observe by default; invalid modes and profiles stop start-up', () => {
  assert.deepEqual(quotaPolicyFromEnv({}), {mode: 'observe', profiles: {}});
  assert.deepEqual(
    quotaPolicyFromEnv({
      AMCP_PROVIDER_QUOTA_MODE: 'enforce',
      AMCP_PROVIDER_QUOTA_PROFILES: '{"google_ads_native_action":{"daily_requests":15000}}',
    }),
    {
      mode: 'enforce',
      profiles: {google_ads_native_action: {daily_requests: 15000, reserved_fraction: 0.1, tenant_share: 0.5}},
    },
  );
  for (const env of [
    {AMCP_PROVIDER_QUOTA_MODE: 'on'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '[1]'},
    {AMCP_PROVIDER_QUOTA_PROFILES: 'not json'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '{"google_ads_native_action":{"daily_requests":0}}'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '{"google_ads_native_action":{"daily_requests":10,"reserved_fraction":0.9}}'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '{"google_ads_native_action":{"daily_requests":10,"tenant_share":0}}'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '{"google_ads_native_action":{"daily_requests":10,"burst":5}}'},
    {AMCP_PROVIDER_QUOTA_PROFILES: '{"../etc":{"daily_requests":10}}'},
  ])
    assert.throws(() => quotaPolicyFromEnv(env), TypeError, JSON.stringify(env));
});

test('the issuer is a gateway-scoped hash of the app identity, never the raw value', () => {
  const a = issuerKey('meta_native_action', {clientId: sharedApp}),
    b = issuerKey('google_ads_native_action', {clientId: sharedApp});
  assert.match(a, /^iss_[0-9a-f]{24}$/);
  assert.notEqual(a, b, 'scoped by gateway');
  assert.equal(issuerKey('meta_native_action', {clientId: sharedApp}), a, 'stable');
  assert.doesNotMatch(a, /synthetic/);
  assert.match(issuerKey('microsoft_ads_native_action', {developerToken: 'SYNTHETIC-DEV-TOKEN'}), /^iss_/);
  assert.equal(issuerKey('meta_native_action', {accessToken: 'only-a-token'}), null);
  assert.equal(requestOperations({operations: [{}, {}, {}]}), 3);
  assert.equal(requestOperations(undefined), 1);
});

test('two workspaces share an issuer: A exhausts its share, B and a reserved verification still run, and the counts survive a restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-issuer-quota-')),
    file = path.join(directory, 'mirror.sqlite');
  try {
    let f = quotaFixture(file);
    f.store.quotaPolicy = enforce;
    // Pool 18 (20 less a 10% reserved slice); one workspace's share is 9.
    for (let i = 0; i < 9; i++) await f.transport.request(plan, connectionOf('tenant-a'), credentials);
    assert.equal(f.sent(), 9);
    await assert.rejects(
      f.transport.request(plan, connectionOf('tenant-a'), credentials),
      e => e.code === 'PROVIDER_QUOTA_SHARE_EXHAUSTED' && e.retryable && e.details.scope === 'workspace_share',
    );
    assert.equal(f.sent(), 9, 'the refusal sent nothing');
    await f.transport.request(plan, connectionOf('tenant-b'), credentials);
    assert.equal(f.sent(), 10, "tenant B's read still runs");
    await runWithQuotaPurpose('reserved', () => f.transport.request(plan, connectionOf('tenant-a'), credentials));
    assert.equal(f.sent(), 11, 'a reserved verification read uses the reserved slice');
    const health = providerQuotaHealth(f.store.db, 'tenant-a', enforce);
    assert.equal(health.issuers.length, 1);
    const [issuer] = health.issuers;
    assert.equal(issuer.issuer, issuerKey('meta_native_action', credentials));
    assert.deepEqual(
      [issuer.today.requests, issuer.today.reserved_requests, issuer.today.refused],
      [11, 1, 1],
      'deployment-wide counts',
    );
    assert.deepEqual([issuer.workspace_today.requests, issuer.workspace_today.reserved_requests], [10, 1]);
    assert.equal(issuer.general_pool_remaining, 8);
    assert.doesNotMatch(JSON.stringify(health), /synthetic-shared|SYNTHETIC_TOKEN/);
    f.store.close();
    // A new process on the same database sees the same day's counts.
    f = quotaFixture(file);
    f.store.quotaPolicy = enforce;
    await assert.rejects(
      f.transport.request(plan, connectionOf('tenant-a'), credentials),
      e => e.code === 'PROVIDER_QUOTA_SHARE_EXHAUSTED',
    );
    for (let i = 0; i < 8; i++) await f.transport.request(plan, connectionOf('tenant-b'), credentials);
    // Tenant B has now used its share of 9: the pool of 18 standard requests is spent by A and B together.
    await assert.rejects(
      f.transport.request(plan, connectionOf('tenant-b'), credentials),
      e => e.code === 'PROVIDER_QUOTA_SHARE_EXHAUSTED' && e.details.scope === 'workspace_share',
    );
    // The reserved slice holds until the issuer's whole daily budget (20) is used.
    await runWithQuotaPurpose('reserved', () => f.transport.request(plan, connectionOf('tenant-b'), credentials));
    await assert.rejects(
      runWithQuotaPurpose('reserved', () => f.transport.request(plan, connectionOf('tenant-b'), credentials)),
      e => e.code === 'PROVIDER_QUOTA_SHARE_EXHAUSTED' && e.details.scope === 'issuer_daily',
    );
    assert.equal(f.sent(), 9);
    f.store.close();
  } finally {
    removeTestDirectory(directory, 'amcp-issuer-quota-');
  }
});

test('observe mode never refuses; it counts what enforcement would have refused', async () => {
  const f = quotaFixture(':memory:');
  try {
    f.store.quotaPolicy = {...enforce, mode: 'observe'};
    for (let i = 0; i < 12; i++) await f.transport.request(plan, connectionOf('tenant-a'), credentials);
    assert.equal(f.sent(), 12);
    const [issuer] = providerQuotaHealth(f.store.db, 'tenant-a', f.store.quotaPolicy).issuers;
    assert.equal(issuer.today.requests, 12);
    assert.equal(issuer.today.would_refuse, 3, 'requests 10 to 12 exceeded the share of 9');
    assert.equal(issuer.today.refused, 0);
    // Without a profile, requests are still counted for the baseline.
    f.store.quotaPolicy = {mode: 'enforce', profiles: {}};
    await f.transport.request(plan, connectionOf('tenant-a'), credentials);
    assert.equal(providerQuotaHealth(f.store.db, 'tenant-a', f.store.quotaPolicy).issuers[0].today.requests, 13);
    // Owner health carries the same view.
    assert.equal(operationsHealth(f.store, 'tenant-a').provider_quota.issuers[0].today.requests, 13);
    assert.deepEqual(operationsHealth(f.store, 'tenant-other').provider_quota.issuers, [], 'only issuers it used');
  } finally {
    f.store.close();
  }
});
