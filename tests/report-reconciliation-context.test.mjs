import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
const actor = {tenantId: 'reconciliation-context', userId: 'owner', role: 'admin'};
const report = (extra = {}) => ({
  gateway: 'google_ads_native_action',
  account_id: '100',
  connection_id: 'login',
  source: 'provider_read',
  preset: 'google_campaign',
  grain: 'campaign × day',
  captured_at: Date.now(),
  source_hash: 'a'.repeat(64),
  semantics: {
    currency: 'USD',
    timezone: 'UTC',
    date_from: '2026-09-01',
    date_to: '2026-09-02',
    attribution: 'Google primary conversions; interaction date',
    conversion_definition: 'primary conversions',
    source_name: 'Synthetic',
    complete: true,
  },
  mapping: {spend: '/metrics/costMicros', clicks: '/metrics/clicks', conversions: '/metrics/conversions'},
  totals: {
    spend: '9007199254740993.13',
    clicks: '10',
    conversions: null,
    impressions: null,
    conversion_value: null,
    reach: null,
    frequency: null,
  },
  rows: [],
  ...extra,
});
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 76).toString('base64'));
  const connection = {
    id: 'login',
    tenantId: actor.tenantId,
    gateway: 'google_ads_native_action',
    accounts: ['100'],
    enabled: true,
    label: 'Synthetic',
    scopes: [],
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  const service = new DecisionReporting(store, async () => {
    throw Error('Reconciliation must not request provider data');
  });
  const save = (id, data) => store.putDocument(actor.tenantId, 'decision_report', id, data);
  save('current', report());
  save('reference', report({source_hash: 'b'.repeat(64)}));
  return {store, connection, save, call: input => service.handle(input, actor)};
}
test('manual numerical agreement is explicitly unverified context and preserves the legacy matched value', async () => {
  const f = fixture();
  try {
    const out = await f.call({
      action: 'reconcile',
      id: 'current',
      reference: {label: 'Manual totals', captured_at: Date.now(), totals: {spend: '9007199254740993.13'}},
    });
    assert.equal(out.matched, true);
    assert.equal(out.comparison_kind, 'manual_totals');
    assert.equal(out.context_compatible, null);
    assert.equal(out.independently_verified, false);
    assert.match(out.qualification, /numerical.*account.*dates.*attribution/i);
  } finally {
    f.store.close();
  }
});
test('retained report reconciliation binds both sources and calculates exact differences without fresh reads', async () => {
  const f = fixture();
  try {
    f.save(
      'reference',
      report({source_hash: 'b'.repeat(64), totals: {...report().totals, spend: '9007199254740993.12', clicks: '12'}}),
    );
    const out = await f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'});
    assert.equal(out.comparison_kind, 'retained_reports');
    assert.equal(out.context_compatible, true);
    assert.equal(out.independently_verified, false);
    assert.equal(out.reference_report_id, 'reference');
    assert.equal(out.source_hash, 'a'.repeat(64));
    assert.equal(out.reference_source_hash, 'b'.repeat(64));
    assert.equal(out.network_requests, 0);
    assert.equal(out.differences.find(d => d.metric === 'spend').difference, '0.01');
    assert.equal(out.differences.find(d => d.metric === 'clicks').difference, '-2');
    assert.equal(out.differences.find(d => d.metric === 'conversions').matched, null);
    assert.equal(out.matched, false);
    assert.equal(f.store.documents(actor.tenantId, 'report_reconciliation').length, 1);
    assert.equal(f.store.document(actor.tenantId, 'decision_report', 'current').source_hash, 'a'.repeat(64));
  } finally {
    f.store.close();
  }
});
test('retained comparisons refuse mismatched or unknown context, unsupported grain and self comparison', async () => {
  const f = fixture();
  try {
    for (const patch of [
      {currency: 'SAR'},
      {timezone: 'Asia/Riyadh'},
      {date_from: '2026-08-01'},
      {date_to: '2026-09-03'},
      {attribution: 'unknown'},
      {attribution: 'UNKNOWN'},
      {conversion_definition: 'all conversions'},
      {complete: false},
    ]) {
      f.save('reference', report({semantics: {...report().semantics, ...patch}}));
      await assert.rejects(
        f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'}),
        e => e.code === 'REPORT_SEMANTICS_MISMATCH',
      );
    }
    for (const patch of [{preset: 'google_adset'}, {preset: undefined}, {grain: 'campaign × week'}]) {
      f.save('reference', report(patch));
      await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'}));
    }
    await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'current'}));
    assert.equal(f.store.documents(actor.tenantId, 'report_reconciliation').length, 0);
  } finally {
    f.store.close();
  }
});
test('retained comparisons cannot read a reference through another account or revoked login', async () => {
  const f = fixture();
  try {
    f.save('reference', report({account_id: '999'}));
    await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'}));
    f.save('reference', report({connection_id: 'removed'}));
    await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'}));
    f.store.putDocument('another-tenant', 'decision_report', 'foreign', report());
    await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'foreign'}));
    assert.equal(f.store.documents(actor.tenantId, 'report_reconciliation').length, 0);
  } finally {
    f.store.close();
  }
});
test('retained Overview comparisons require the same frozen definition and semantic group', async () => {
  const f = fixture();
  try {
    const data = report({
      source: 'overview_snapshot',
      preset: undefined,
      grain: undefined,
      source_request: {overview_id: 'snapshot-a', group_id: 'group', grain: 'daily'},
      source_lineage: {definition_fingerprint: 'definition'},
    });
    f.save('current', data);
    f.save('reference', {...data, source_request: {...data.source_request, overview_id: 'snapshot-b'}});
    assert.equal(
      (await f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'})).context_compatible,
      true,
    );
    f.save('reference', {...data, source_lineage: {definition_fingerprint: 'different'}});
    await assert.rejects(f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference'}));
  } finally {
    f.store.close();
  }
});
test('retained comparison tolerances are explicit exact decimals and cannot cover nonadditive metrics', async () => {
  const f = fixture();
  try {
    f.save('current', report({mapping: {spend: '/spend'}}));
    f.save('reference', report({mapping: {spend: '/spend'}, totals: {spend: '9007199254740993.12'}}));
    const out = await f.call({
      action: 'reconcile_report',
      id: 'current',
      reference_id: 'reference',
      options: {tolerance: {spend: '0.01'}},
    });
    assert.equal(out.matched, true);
    assert.equal(out.differences[0].difference, '0.01');
    assert.equal(out.differences[0].tolerance, '0.01');
    for (const tolerance of [{spend: '-1'}, {spend: 'NaN'}, {reach: '1'}])
      await assert.rejects(
        f.call({action: 'reconcile_report', id: 'current', reference_id: 'reference', options: {tolerance}}),
      );
  } finally {
    f.store.close();
  }
});
