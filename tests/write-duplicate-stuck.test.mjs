import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {metaReconcileFixture} from './helpers/meta-reconcile-fixture.mjs';
import {MirrorError} from '../dist/src/errors.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';

/**
 * R2.5 M2, lead re-review 2, F2: a create that AMCP can look up but never find applied (a Meta catalog or creative, which nothing dates; or
 * one whose checks ran out) holds identical creates back with a refusal whose ways out were all closed: "settle that review, replace it or
 * accept it" cannot be done when its latest check is `undated_match` (it can be neither accepted nor replaced), or its automatic checks ran
 * out. The refusal now adds the way that is open: check the provider and, if that object is not the one wanted, change the request (its
 * name, for example), because a changed request is a new create and is not held back. It says so only then; an earlier create that can
 * still be settled keeps its message. No new Arabic: the message is built the same way as the guard's others.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const reconcile = (f, id) => f.call('amcp_write', {action: 'reconcile', review_id: id});
const wayOut = /change the request/i;
/** The worker the server runs, and one turn of it with every waiting check made due. */
const workerOf = f => {
  const overview = new ReportingOverview(f.service);
  return new ReportWorker(
    f.store,
    async () => ({}),
    (tenant, kind, input) => overview.work(tenant, kind, input),
  );
};
const runDue = (f, worker) => {
  f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
  return worker.once();
};
/** A budget create whose answer is lost; `applied`: Google made it. */
async function lostBudget(f, applied) {
  const prepared = await f.creates(1, 50000000);
  f.hooks.respond = body => {
    if (applied) {
      f.budgets.set(budgetName(101), String(body.operations[0].create.amountMicros));
      f.names.set(budgetName(101), body.operations[0].create.name);
    }
    throw new TypeError('synthetic lost response');
  };
  const lost = await f.execute(prepared.data.review_id);
  f.hooks.respond = undefined;
  assert.equal(lost.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(lost).slice(0, 300));
  return prepared.data.review_id;
}

test('a create that nothing dates (a Meta creative) is refused as a duplicate with the way out of a changed name once its check says undated_match', async () => {
  const f = metaReconcileFixture();
  try {
    const {id} = await f.lose('creative', {applied: true});
    const checked = await reconcile(f, id);
    assert.equal(checked.data.classification, 'indeterminate', JSON.stringify(checked.data).slice(0, 400));
    assert.equal(checked.data.reason, 'undated_match');
    const refused = await f.prepare('creative');
    assert.equal(refused.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 500));
    assert.equal(
      refused.error.details.earlier_checkable,
      true,
      'AMCP can look the create up; it just cannot find it applied',
    );
    assert.equal(refused.error.details.earlier_review_id, id);
    assert.match(refused.error.message, wayOut, refused.error.message);
    // The way out is real: a changed name is a new create, which the guard does not hold back.
    const renamed = await f.prepare('creative', payload => ({...payload, name: 'Another creative'}));
    assert.equal(renamed.success, true, JSON.stringify(renamed).slice(0, 400));
  } finally {
    f.close();
  }
});

test('a create whose automatic checks ran out is refused as a duplicate with the way out of a changed name', async () => {
  const f = googleBudgetFixture();
  try {
    const id = await lostBudget(f, true);
    // The provider cannot be read: the six automatic checks run out unsettled.
    const request = f.transport.request.bind(f.transport);
    f.transport.request = async (plan, ...rest) => {
      if (plan.readOnly) throw new MirrorError('UPSTREAM_UNAVAILABLE', 'Synthetic outage.', {}, 502, true);
      return request(plan, ...rest);
    };
    const worker = workerOf(f);
    for (let turn = 0; turn < 6; turn++) assert.equal(await runDue(f, worker), true);
    const shown = (await f.write({action: 'status', review_id: id})).data.reconciliation;
    assert.equal(shown.checks_exhausted, true, JSON.stringify(shown));
    f.transport.request = request;
    const refused = await f.creates(1, 50000000);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.earlier_checkable, true);
    assert.match(refused.error.message, wayOut, refused.error.message);
  } finally {
    f.close();
  }
});

test('an earlier create that can still be settled keeps its message: no way out of a changed name is offered over its reconcile', async () => {
  for (const found of ['not yet checked', 'found not applied']) {
    const f = googleBudgetFixture();
    try {
      const id = await lostBudget(f, false);
      if (found === 'found not applied') {
        const checked = await reconcile(f, id);
        assert.equal(checked.data.classification, 'appears_not_applied', JSON.stringify(checked.data).slice(0, 400));
      }
      const refused = await f.creates(1, 50000000);
      assert.equal(
        refused.error?.code,
        'DUPLICATE_OF_UNCERTAIN_WRITE',
        found + ': ' + JSON.stringify(refused).slice(0, 400),
      );
      assert.equal(refused.error.details.earlier_checkable, true);
      assert.doesNotMatch(refused.error.message, wayOut, found + ': ' + refused.error.message);
      assert.match(refused.error.message, /Settle that review first/, found);
    } finally {
      f.close();
    }
  }
});
