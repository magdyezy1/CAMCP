import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';

const actor = {tenantId: 'reference-import', userId: 'owner', role: 'admin'};
const semantics = {
  currency: 'USD',
  timezone: 'UTC',
  date_from: '2026-09-01',
  date_to: '2026-09-02',
  attribution: '7 day click',
  conversion_definition: 'primary conversions',
  source_name: 'Synthetic report',
  complete: true,
};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'decision_report', 'report', {
    gateway: 'google_ads_native_action',
    account_id: '100',
    connection_id: 'login',
    source: 'provider_read',
    preset: 'google_campaign',
    grain: 'campaign × day',
    source_hash: 'b'.repeat(64),
    captured_at: Date.now(),
    semantics,
    mapping: {spend: '/metrics/costMicros', clicks: '/metrics/clicks'},
    totals: {spend: '9007199254740993.13', clicks: '10'},
    rows: [],
  });
  const service = new DecisionReporting(store, async () => {
    throw Error('Reference comparison must not request provider data');
  });
  const reference = () => ({
    label: 'Declared export totals',
    captured_at: Date.now(),
    totals: {spend: '9007199254740993.12', clicks: '10'},
    context: {
      gateway: 'google_ads_native_action',
      account_id: '100',
      ...Object.fromEntries(Object.entries(semantics).filter(([k]) => k !== 'source_name')),
      grain: 'campaign × day',
      same_entities_and_filters: true,
    },
    file: {
      sha256: 'a'.repeat(64),
      bytes: 100,
      encoding: 'utf-8',
      delimiter: ',',
      rows: 1,
      number_format: 'decimal_dot',
      columns: {spend: 'Cost', clicks: 'Clicks'},
      money_scales: {spend: 0},
    },
  });
  return {store, reference, call: r => service.handle({action: 'reconcile', id: 'report', reference: r}, actor)};
}

test('declared external reference context and file provenance retain exact differences without independent verification', async () => {
  const f = fixture();
  try {
    const r = await f.call(f.reference());
    assert.equal(r.comparison_kind, 'declared_reference');
    assert.equal(r.context_compatible, true);
    assert.equal(r.independently_verified, false);
    assert.equal(r.source_hash, 'b'.repeat(64));
    assert.equal(r.reference.file.sha256, 'a'.repeat(64));
    assert.equal(r.file_hash_verified_by_server, false);
    assert.equal(r.differences[0].difference, '0.01');
    assert.equal(r.network_requests, 0);
    assert.match(r.qualification, /caller.declared/i);
    assert.equal(r.matched, false);
  } finally {
    f.store.close();
  }
});

test('external reference context must explicitly match the account, period, known measurement settings and source grain', async () => {
  const f = fixture();
  try {
    for (const [key, value] of [
      ['gateway', 'meta_native_action'],
      ['account_id', '999'],
      ['currency', 'EUR'],
      ['timezone', 'Europe/Berlin'],
      ['date_from', '2026-09-02'],
      ['date_to', '2026-09-03'],
      ['attribution', 'unknown'],
      ['conversion_definition', 'other conversions'],
      ['complete', false],
      ['grain', 'ad × day'],
      ['same_entities_and_filters', false],
    ]) {
      const r = f.reference();
      r.context[key] = value;
      await assert.rejects(f.call(r), e => e.code === 'REPORT_SEMANTICS_MISMATCH', key);
    }
    const noContext = f.reference();
    delete noContext.context;
    await assert.rejects(f.call(noContext), e => e.code === 'REPORT_REFERENCE_REQUIRED');
    const r = await f.call(f.reference());
    assert.equal(r.context_compatible, true);
  } finally {
    f.store.close();
  }
});

test('CSV provenance is bounded and exact; arbitrary file contents or extra columns cannot be retained', async () => {
  const f = fixture();
  try {
    for (const patch of [
      {sha256: 'not-a-hash'},
      {bytes: 65537},
      {rows: 2},
      {encoding: 'guess'},
      {delimiter: '|'},
      {number_format: 'auto'},
      {columns: {spend: 'Cost', clicks: 'Cost'}},
      {money_scales: {spend: 3}},
      {columns: {spend: 'Cost', clicks: 'Clicks', email: 'Personal'}},
    ]) {
      const r = f.reference();
      Object.assign(r.file, patch);
      await assert.rejects(f.call(r), e => e.code === 'REPORT_REFERENCE_REQUIRED');
    }
    const raw = f.reference();
    raw.file.csv = 'private raw file contents';
    await assert.rejects(f.call(raw));
    const invalidUnknown = f.reference();
    delete invalidUnknown.file;
    invalidUnknown.totals.conversions = '=SUM(A1:A2)';
    await assert.rejects(f.call(invalidUnknown));
    const empty = f.reference();
    empty.totals = {};
    empty.file.columns = {};
    await assert.rejects(f.call(empty), e => e.code === 'REPORT_REFERENCE_REQUIRED');
    const r = await f.call(f.reference());
    assert.equal(Object.hasOwn(r.reference.file, 'csv'), false);
    assert.equal(Object.hasOwn(r.reference.file.columns, 'email'), false);
  } finally {
    f.store.close();
  }
});

test('declared references without a file keep the same context qualification and preserve unknown metrics', async () => {
  const f = fixture();
  try {
    const ref = f.reference();
    delete ref.file;
    ref.totals.conversions = null;
    const r = await f.call(ref);
    assert.equal(r.comparison_kind, 'declared_reference');
    assert.equal(r.differences.find(d => d.metric === 'conversions').difference, null);
    assert.equal(r.differences.find(d => d.metric === 'conversions').matched, null);
    assert.equal(r.matched, false);
  } finally {
    f.store.close();
  }
});
