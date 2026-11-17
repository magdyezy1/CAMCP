import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S2-2: replacing an uncertain write is permanent. A review that a new review replaced is settled: it is never
 * reconciled again (which rewrote its record without `superseded_by` and let the replacement's object be accepted as its own, or a
 * second replacement be prepared), never accepted, and never replaced a second time. A check that read the provider while that
 * happened never writes over the record that settled it.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const lost = () => {
  throw new TypeError('synthetic lost response');
};
/** A budget create lost without being applied, found not applied, and its replacement prepared (it supersedes the old review). */
async function replaced(f) {
  const old = (await f.creates(1, 5000000)).data.review_id;
  f.hooks.respond = lost;
  assert.equal((await f.execute(old)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
  f.hooks.respond = undefined;
  const found = await f.write({action: 'reconcile', review_id: old});
  assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
  const replacement = await f.write(found.data.next_call.arguments);
  assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 500));
  return {old, found, replacement: replacement.data.review_id, call: found.data.next_call.arguments};
}

test('a replaced review is never reconciled again, so the replacement’s object is never taken for its own', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, found, replacement} = await replaced(f);
    const done = await f.execute(replacement);
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 400));
    const again = await f.write({action: 'reconcile', review_id: old});
    assert.equal(again.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(again).slice(0, 500));
    assert.equal(again.error.details.superseded_by, replacement);
    assert.deepEqual(again.error.details.next_call.arguments, {action: 'status', review_id: replacement});
    // Its status is still "superseded", with the replacement named, and nothing offers it as applied.
    const status = await f.write({action: 'status', review_id: old});
    assert.equal(status.data.state, 'superseded');
    assert.equal(status.data.reconciliation.superseded_by, replacement);
    assert.notEqual(status.data.next_call?.add_after_user_approval?.accept_applied, true);
    // Nor can the reconciliation it had before it was replaced be accepted.
    const accepted = await f.write({
      action: 'reconcile',
      review_id: old,
      accept_applied: true,
      reconciliation_id: found.data.reconciliation_id,
    });
    assert.equal(accepted.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(accepted).slice(0, 400));
    assert.equal(f.claim(old).state, 'uncertain', 'the old key is never completed');
    assert.equal(f.writes.length, 2, 'the lost write and the replacement, each sent once');
  } finally {
    f.close();
  }
});

test('a replaced review is never replaced a second time, whatever was reconciled in between', async () => {
  const f = googleBudgetFixture();
  try {
    const {old, replacement, call} = await replaced(f);
    const again = await f.write({action: 'reconcile', review_id: old});
    assert.equal(again.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(again).slice(0, 500));
    const second = await f.write(call);
    assert.equal(second.error?.code, 'RECONCILIATION_UNAVAILABLE', JSON.stringify(second).slice(0, 500));
    assert.equal(
      (await f.write({action: 'status', review_id: old})).data.reconciliation.superseded_by,
      replacement,
      'still the first replacement',
    );
    assert.equal((await f.execute(replacement)).success, true);
    assert.equal(f.writes.length, 2, 'one replacement ran, and no second one could');
  } finally {
    f.close();
  }
});

test('a check that read the provider while the review was replaced writes nothing over the record that settled it', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: false});
    let replacement;
    // The worker's check is reading when the person reconciles the same write, finds it not applied, and replaces it.
    f.state.hold = async () => {
      const found = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(found.data.classification, 'appears_not_applied', JSON.stringify(found.data));
      replacement = await f.call('amcp_write', found.data.next_call.arguments);
      assert.equal(replacement.success, true, JSON.stringify(replacement).slice(0, 400));
    };
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    assert.ok(replacement?.success, 'the replacement was prepared while the check was reading');
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(status.data.state, 'superseded', JSON.stringify(status.data));
    assert.equal(status.data.reconciliation.superseded_by, replacement.data.review_id);
    assert.notEqual(
      status.data.reconciliation.automatic,
      true,
      'the person’s record stands; the worker’s answer was dropped',
    );
    // The check is audited as dropped, not silently lost.
    const events = f.store.audit(f.actor.tenantId, 10000).map(row => JSON.parse(row.event).event);
    assert.ok(events.includes('write_reconciliation_dropped'), events.join());
  } finally {
    f.close();
  }
});

test('a check that read the provider while the person accepted the write leaves the acceptance as it was', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    f.state.hold = async () => {
      const found = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(found.data.classification, 'appears_applied', JSON.stringify(found.data));
      const accepted = await f.call('amcp_write', {
        action: 'reconcile',
        review_id: id,
        accept_applied: true,
        reconciliation_id: found.data.reconciliation_id,
      });
      assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 400));
    };
    f.store.db.prepare("UPDATE jobs SET available_at=0 WHERE kind='write_reconcile' AND state='queued'").run();
    assert.equal(await f.worker.once(), true);
    const status = await f.call('amcp_write', {action: 'status', review_id: id});
    assert.equal(status.data.state, 'reconciled', JSON.stringify(status.data).slice(0, 500));
    assert.ok(status.data.reconciliation.accepted_at, 'the acceptance is still recorded');
    assert.notEqual(
      status.data.reconciliation.automatic,
      true,
      'the worker’s answer did not replace the accepted record',
    );
    assert.equal(f.claim(id).state, 'complete');
  } finally {
    f.close();
  }
});
