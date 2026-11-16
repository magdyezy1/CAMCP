import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {currentQuotaPurpose} from '../dist/src/provider-quota.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2, the lead's decision on the report's quota class: the reads of a reconciliation, the worker's automatic check and the
 * person's own `reconcile` alike, count against a provider app's quota as `reserved`, as the read-backs of write verification do
 * (OPS-08). It is a handful of reads, and in a busy or throttled workspace the standard share runs out first, while reserved work
 * may still use the reserved slice. The write itself, and every read before it, stay standard.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

/** What the transport is asked for, with the quota class each request is made under. */
function spy(f) {
  const seen = [],
    request = f.transport.request.bind(f.transport);
  f.transport.request = (...args) => {
    seen.push({read: args[0].readOnly === true, purpose: currentQuotaPurpose()});
    return request(...args);
  };
  return seen;
}
async function lostCreate(f) {
  const prepared = await f.creates(1, 50000000);
  f.hooks.respond = body => {
    f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
    f.names.set(budgetName(101), body.operations[0].create.name);
    throw new TypeError('synthetic lost response');
  };
  const lost = await f.execute(prepared.data.review_id);
  f.hooks.respond = undefined;
  assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
  return prepared.data.review_id;
}

test('the reads of the person’s reconcile are reserved; the prepare and the write before it are standard', async () => {
  const f = googleBudgetFixture();
  try {
    const seen = spy(f);
    const id = await lostCreate(f);
    assert.ok(
      seen.length > 0 && seen.every(r => r.purpose === 'standard'),
      'prepare and execute are standard requests',
    );
    const before = seen.length;
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
      .run(120000, f.actor.tenantId, id);
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data).slice(0, 300));
    const reconciling = seen.slice(before);
    assert.ok(reconciling.length > 0, 'it read the provider');
    assert.deepEqual(
      reconciling.map(request => [request.read, request.purpose]),
      reconciling.map(() => [true, 'reserved']),
      'every request of a reconciliation is a read, made as reserved',
    );
    // The class does not outlive the reconciliation: the next call is standard again.
    await f.call('amcp_write', {action: 'status', review_id: id});
    const later = await f.creates(1, 70000000);
    assert.equal(later.success, true);
    assert.equal(
      seen.slice(before + reconciling.length).every(request => request.purpose === 'standard'),
      true,
    );
  } finally {
    f.close();
  }
});

test('the reads of the worker’s automatic check are reserved too', async () => {
  const f = googleBudgetFixture();
  try {
    const seen = spy(f);
    await lostCreate(f);
    const before = seen.length;
    const overview = new ReportingOverview(f.service),
      worker = new ReportWorker(
        f.store,
        async () => ({}),
        (tenant, kind, input) => overview.work(tenant, kind, input),
      );
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    f.store.db
      .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=?')
      .run(120000, f.actor.tenantId);
    assert.equal(await worker.once(), true, 'the worker leased the check');
    const checking = seen.slice(before);
    assert.ok(checking.length > 0, 'it read the provider');
    assert.deepEqual(
      checking.map(request => [request.read, request.purpose]),
      checking.map(() => [true, 'reserved']),
    );
  } finally {
    f.close();
  }
});
