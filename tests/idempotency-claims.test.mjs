// QA-02 (mutants M11 and M12): the idempotency claim is the last guard against a second send. Every state of a claim
// is pinned here, at the store and through a reviewed write: a pending or uncertain key is never claimed again, a key
// used for another request is a conflict, a completed key replays, and only a pending claim is released (D12).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {budgetName, googleBudgetFixture} from './fixtures/google-budget-writes.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

test('a claim is fresh once; pending and uncertain keys refuse a second send; another request is a conflict', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64'));
  try {
    assert.deepEqual(store.claim('t', 'k1', 'fp-a'), {fresh: true});
    // A concurrent execute of the same request while the first is in flight.
    assert.throws(
      () => store.claim('t', 'k1', 'fp-a'),
      e => assertRefused(e, 'WRITE_OUTCOME_UNCERTAIN'),
    );
    assert.throws(
      () => store.claim('t', 'k1', 'fp-b'),
      e => assertRefused(e, 'IDEMPOTENCY_CONFLICT'),
    );
    store.complete('t', 'k1', {receipt: 'r1'});
    assert.deepEqual(store.claim('t', 'k1', 'fp-a'), {fresh: false, result: {receipt: 'r1'}});
    assert.throws(
      () => store.claim('t', 'k1', 'fp-b'),
      e => assertRefused(e, 'IDEMPOTENCY_CONFLICT'),
    );
    assert.equal(store.release('t', 'k1', 'fp-a'), false, 'a completed claim is never released');

    assert.deepEqual(store.claim('t', 'k2', 'fp-a'), {fresh: true});
    store.uncertain('t', 'k2');
    assert.throws(
      () => store.claim('t', 'k2', 'fp-a'),
      e => assertRefused(e, 'WRITE_OUTCOME_UNCERTAIN'),
    );
    assert.equal(store.release('t', 'k2', 'fp-a'), false, 'an uncertain claim is never released');

    // The liveness exit for a refusal raised before any request (D12): the pending claim is released and can be taken.
    assert.deepEqual(store.claim('t', 'k3', 'fp-a'), {fresh: true});
    assert.equal(store.release('t', 'k3', 'fp-b'), false, 'only the same request releases its claim');
    assert.equal(store.release('t', 'k3', 'fp-a'), true);
    assert.deepEqual(store.claim('t', 'k3', 'fp-a'), {fresh: true});
    // Keys are per workspace.
    assert.deepEqual(store.claim('other', 'k1', 'fp-b'), {fresh: true});
  } finally {
    store.close();
  }
});

// r25-mf-groups (audit of 2026-11-25, finding 3): a second execute of a write group that was still being sent turned the group the first had
// completed into an uncertain one. A claim becomes uncertain only while it is pending.
test('a claim becomes uncertain only while it is pending: a completed, a rejected or an uncertain claim is never moved', () => {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    row = key => store.db.prepare('SELECT state,result FROM idempotency WHERE tenant_id=? AND key=?').get('t', key),
    marks = key => store.document('t', 'operation_journal', key).events.filter(e => e.phase === 'uncertain').length;
  try {
    assert.deepEqual(store.claim('t', 'p', 'fp'), {fresh: true});
    assert.equal(store.uncertain('t', 'p'), true, 'a pending claim becomes uncertain');
    assert.equal(row('p').state, 'uncertain');
    assert.equal(marks('p'), 1);
    assert.equal(store.uncertain('t', 'p'), false, 'an uncertain claim stays as it is');
    assert.equal(marks('p'), 1, 'and is not journaled again');

    assert.deepEqual(store.claim('t', 'c', 'fp'), {fresh: true});
    store.complete('t', 'c', {receipt: 'kept'});
    assert.equal(store.uncertain('t', 'c'), false, 'a completed claim is never made uncertain');
    assert.equal(row('c').state, 'complete');
    assert.deepEqual(JSON.parse(row('c').result), {receipt: 'kept'});
    assert.deepEqual(store.claim('t', 'c', 'fp'), {fresh: false, result: {receipt: 'kept'}}, 'it still replays');
    assert.equal(
      store.document('t', 'operation_journal', 'c').phase,
      'responded',
      'and its journal still says it answered',
    );

    assert.deepEqual(store.claim('t', 'r', 'fp'), {fresh: true});
    assert.equal(store.rejected('t', 'r', 'fp', {code: 'UPSTREAM_ERROR'}), true);
    assert.equal(store.uncertain('t', 'r'), false, 'a rejected claim keeps its retired key');
    assert.equal(row('r').state, 'rejected');

    assert.equal(store.uncertain('t', 'never-claimed'), false, 'no claim, nothing to move');
    assert.equal(row('never-claimed'), undefined);
  } finally {
    store.close();
  }
});

test('a reviewed write executes only under its own key; another review key is refused and sends nothing', async () => {
  const f = googleBudgetFixture();
  try {
    f.spendPolicy({max_daily_increase_native: 500000000});
    const first = (await f.update(100000000)).data.review_id;
    const done = await f.execute(first, {idempotency_key: first});
    assert.equal(done.success, true, JSON.stringify(done).slice(0, 600));
    const second = (await f.update(120000000)).data.review_id;
    // The service binds the key to the review before the store's fingerprint check (defense in depth, tested above).
    assertRefused(await f.execute(second, {idempotency_key: first}), 'IDEMPOTENCY_REQUIRED');
    assertRefused(await f.execute(second, {idempotency_key: 'free-text'}), 'IDEMPOTENCY_REQUIRED');
    assert.equal(f.writes.length, 1);
    assert.equal(f.budgets.get(budgetName(1)), '100000000');
    // The completed review with its own key replays without sending.
    assert.equal((await f.execute(first, {idempotency_key: first})).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});
