import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconciliationFixture,
  reconciliationInput,
  reconciliationRows,
  reconciliationRow,
} from './fixtures/portfolio-reconciliation-data.mjs';
function noArtifacts(f) {
  for (const kind of ['campaign_plan', 'campaign_run', 'write_review', 'decision_report', 'portfolio_snapshot'])
    assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
  assert.ok(f.requests.every(row => row.method === 'POST' && /googleAds:search$/.test(row.path)));
}
test('two complete current reads retain exact native IDs, micros, original fields and explicit observation limits', async t => {
  const f = reconciliationFixture(t),
    r = await f.call();
  assert.equal(r.success, true, JSON.stringify(r));
  const out = r.data;
  assert.equal(out.record_kind, 'portfolio_reconciliation');
  assert.equal(out.status, 'same_supported_fields');
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[0].id, '9007199254740993');
  assert.equal(out.rows[0].budget_micros, '9007199254740993');
  assert.equal(out.changes.unchanged_count, 3);
  assert.equal(out.collection_usage.requests, 2);
  assert.equal(out.collection_usage.rows, 6);
  assert.equal(out.observations.length, 2);
  assert.deepEqual(out.observations[0].source_context, {currency: 'USD', timezone: 'UTC'});
  assert.equal(out.observations[0].content_sha256, out.observations[1].content_sha256);
  for (const key of [
    'atomic_snapshot',
    'deleted_entity_inventory',
    'absence_authorizes_delete',
    'historical_assignment',
  ])
    assert.equal(out.coverage[key], false);
  assert.doesNotMatch(JSON.stringify(r), /UNUSED-PRIVATE|synthetic-reconciliation-secret|synthetic-developer/);
  assert.equal(f.requests.length, 2);
  noArtifacts(f);
});
test('changed, added and no-longer-observed entities remain independent exact observations without removal intent', async t => {
  const f = reconciliationFixture(t);
  f.rows(count => {
    if (count === 1) return reconciliationRows().slice(0, 2);
    const changed = reconciliationRow();
    changed.campaign.name = 'New original name';
    changed.campaign.status = 'ENABLED';
    changed.campaignBudget.amountMicros = '9007199254740995';
    return [changed, reconciliationRow('9007199254740999')];
  });
  const r = await f.call();
  assert.equal(r.success, true, JSON.stringify(r));
  const changes = r.data.changes;
  assert.equal(r.data.status, 'changes_observed');
  assert.equal(changes.observed_added[0].id, '9007199254740999');
  assert.equal(changes.not_observed_again[0].id, '9007199254740995');
  assert.equal(changes.supported_fields_changed[0].id, '9007199254740993');
  assert.equal(changes.supported_fields_changed[0].before.budget_micros, '9007199254740993');
  assert.equal(changes.supported_fields_changed[0].after.budget_micros, '9007199254740995');
  assert.equal(changes.unchanged_count, 0);
  assert.equal(r.data.provider_mutations, 0);
  noArtifacts(f);
});
test('two independently complete bounded scans follow their original continuations and charge one whole-workflow allowance', async t => {
  const f = reconciliationFixture(t),
    r = await f.call({...reconciliationInput, limit: 2, max_pages: 2, max_entities: 3});
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.collection_usage.requests, 4);
  assert.equal(r.data.collection_usage.rows, 6);
  assert.deepEqual(
    r.data.observations.map(o => o.pages.map(p => p.row_count)),
    [
      [2, 1],
      [2, 1],
    ],
  );
  assert.equal(f.requests.length, 4);
  noArtifacts(f);
});
test('empty complete selections retain qualified empty observations without inferring account context or deletions', async t => {
  const f = reconciliationFixture(t);
  f.rows(() => []);
  const r = await f.call();
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.data.rows.length, 0);
  assert.equal(r.data.observations[0].source_context, null);
  assert.equal(r.data.status, 'same_supported_fields');
  assert.equal(r.data.coverage.absence_authorizes_delete, false);
  assert.equal(f.requests.length, 2);
  noArtifacts(f);
});
for (const [field, value, code] of [
  ['limit', 0, 'INVALID_ARGUMENT'],
  ['max_entities', 1001, 'INVALID_ARGUMENT'],
  ['max_pages', 26, 'INVALID_ARGUMENT'],
  ['cursor', 'foreign', 'INVALID_ARGUMENT'],
  ['gateway', 'unknown_native_action', 'PORTFOLIO_UNQUALIFIED'],
])
  test('comparison refuses invalid ' + field + ' before native dispatch', async t => {
    const f = reconciliationFixture(t),
      r = await f.call({...reconciliationInput, [field]: value});
    assert.equal(r.success, false);
    assert.equal(r.error.code, code);
    assert.equal(f.requests.length, 0);
    noArtifacts(f);
  });
for (const [name, args, reads] of [
  ['entity limit', {limit: 2, max_entities: 2}, 2],
  ['page limit', {limit: 2, max_pages: 1}, 1],
])
  test('incomplete ' + name + ' never becomes a matching comparison or absence claim', async t => {
    const f = reconciliationFixture(t),
      r = await f.call({...reconciliationInput, ...args});
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'PORTFOLIO_RECONCILIATION_INCOMPLETE');
    assert.equal(f.requests.length, reads);
    noArtifacts(f);
  });
test('a changed account context within a scan is refused before a second observation', async t => {
  const f = reconciliationFixture(t);
  f.edit((_query, data, count) => {
    if (count === 2) data.results.forEach(row => (row.customer.timeZone = 'Asia/Riyadh'));
    return data;
  });
  const r = await f.call({...reconciliationInput, limit: 2});
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'PORTFOLIO_RECONCILIATION_INCOMPLETE');
  assert.equal(f.requests.length, 2);
  noArtifacts(f);
});
test('authority and credential changes during the original read refuse disclosure and follow-up scans', async t => {
  for (const changed of ['revoke', 'credentials']) {
    const f = reconciliationFixture(t);
    f.edit((_query, data) => {
      if (changed === 'revoke') f.store.revokeKey(f.key);
      else f.store.putConnection(f.owner, f.connection, {...f.credentials, accessToken: 'rotated-synthetic'});
      return data;
    });
    const r = await f.call();
    assert.equal(r.success, false);
    assert.ok(['UNAUTHORIZED', 'CONNECTION_AUTHORITY_CHANGED'].includes(r.error.code), JSON.stringify(r));
    assert.equal(f.requests.length, 1);
    noArtifacts(f);
  }
});
