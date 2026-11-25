import test from 'node:test';
import assert from 'node:assert/strict';
import {googleBudgetFixture, budgetAction, gateway} from './fixtures/google-budget-writes.mjs';
import {googleWorld} from '../dist/tests/helpers/google-write-fake.js';
import {createPlan, on} from './helpers/google-policy-failure.mjs';
import {keywordAction, keywordWorld, keywords} from './helpers/google-keyword-group.mjs';

/**
 * r25-mf-groups, the audit of 2026-11-25, finding 1: a create of more than 25 records is split into parts, and the group's answer dropped the parts'
 * `duplicate_warning`, so repeating a list of 30 campaigns made 60 with no warning (each part held its warning, which nobody was shown). A group's answer now
 * carries the warning with the fields a single review's has (earlier_state, earlier_review_id, claimed_at, message) and the parts it holds for, and each
 * part's own warning is on its entry. The guard is the single review's: a warning, never a refusal; the person may want two. 30 synthetic budgets are
 * two parts, of 25 and 5.
 */
const budget = (name, amount = 5000000) => ({create: {name, amountMicros: String(amount), deliveryMethod: 'STANDARD'}});
const names = (prefix, from, to) => Array.from({length: to - from}, (_, i) => budget(prefix + ' ' + (from + i)));
const prepare = (f, operations) =>
  f.write({
    action: 'prepare',
    gateway,
    connection_id: 'g',
    arguments: {action: budgetAction, account_id: '123', payload: {operations}},
  });
/** A group of 30 budgets executed once, and the review IDs of its parts. */
async function made(f, prefix = 'Synthetic') {
  const first = await prepare(f, names(prefix, 0, 30));
  assert.equal(first.data?.group, true, JSON.stringify(first).slice(0, 400));
  assert.equal(first.data.duplicate_warning, undefined, 'nothing had been created when it was prepared');
  const done = await f.execute(first.data.review_id);
  assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
  return first.data.parts.map(p => p.review_id);
}

test('the repeat of a group that completed warns, with a single review’s fields, and names the parts; each part carries its own warning', async () => {
  const f = googleBudgetFixture();
  try {
    const earlier = await made(f),
      again = await prepare(f, names('Synthetic', 0, 30));
    assert.equal(again.success, true, 'a warning, not a refusal: ' + JSON.stringify(again).slice(0, 300));
    assert.equal(again.data.group, true);
    const warning = again.data.duplicate_warning;
    assert.ok(warning, 'the group’s answer carries the warning: ' + JSON.stringify(again.data).slice(0, 300));
    assert.equal(warning.earlier_state, 'complete');
    assert.ok(earlier.includes(warning.earlier_review_id), 'it names an earlier review of the same request');
    assert.equal(typeof warning.claimed_at, 'string');
    assert.match(warning.message, /second/);
    assert.deepEqual(warning.parts, [1, 2], 'and says which parts it holds for');
    // Nothing is lost in the aggregate: each part’s own warning is on its entry, naming the part it repeats.
    again.data.parts.forEach((part, i) => {
      assert.ok(part.duplicate_warning, 'part ' + (i + 1));
      assert.equal(part.duplicate_warning.earlier_review_id, earlier[i]);
      assert.equal(part.duplicate_warning.earlier_state, 'complete');
      assert.match(part.duplicate_warning.message, /second/);
    });
    // The person may want two: executing the warned group makes them, once each.
    const done = await f.execute(again.data.review_id);
    assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 400));
    assert.equal(f.writes.length, 4);
  } finally {
    f.close();
  }
});

test('only the parts that repeat a create are named: a group whose second part alone repeats one warns for that part', async () => {
  const f = googleBudgetFixture();
  try {
    const earlier = await made(f),
      mixed = await prepare(f, [...names('Other', 0, 25), ...names('Synthetic', 25, 30)]);
    assert.equal(mixed.success, true, JSON.stringify(mixed).slice(0, 300));
    assert.ok(mixed.data.duplicate_warning, 'the one part that repeats a create is not lost in the aggregate');
    assert.deepEqual(mixed.data.duplicate_warning.parts, [2]);
    assert.equal(mixed.data.duplicate_warning.earlier_review_id, earlier[1]);
    assert.equal(mixed.data.parts[0].duplicate_warning, undefined);
    assert.equal(mixed.data.parts[1].duplicate_warning.earlier_review_id, earlier[1]);
  } finally {
    f.close();
  }
});

test('no warning where there is nothing to warn of: another request, and a twin older than ten minutes', async () => {
  const f = googleBudgetFixture();
  try {
    const earlier = await made(f),
      other = await prepare(f, names('Other', 0, 30));
    assert.equal(other.success, true);
    assert.equal(other.data.duplicate_warning, undefined, 'another name is another request');
    assert.ok(other.data.parts.every(p => p.duplicate_warning === undefined));
    for (const id of earlier)
      f.store.db
        .prepare('UPDATE idempotency SET created_at=? WHERE tenant_id=? AND key=?')
        .run(Date.now() - 11 * 60000, f.actor.tenantId, id);
    const old = await prepare(f, names('Synthetic', 0, 30));
    assert.equal(old.success, true);
    assert.equal(old.data.duplicate_warning, undefined, 'eleven minutes old');
    assert.ok(old.data.parts.every(p => p.duplicate_warning === undefined));
  } finally {
    f.close();
  }
});

test('a group whose twin is still unresolved is refused at prepare as before, with nothing sent', async () => {
  const f = googleBudgetFixture();
  try {
    const first = await prepare(f, names('Synthetic', 0, 30));
    f.hooks.respond = () => {
      throw new TypeError('synthetic lost response');
    };
    assert.equal((await f.execute(first.data.review_id)).error?.code, 'WRITE_OUTCOME_UNCERTAIN');
    f.hooks.respond = undefined;
    const again = await prepare(f, names('Synthetic', 0, 30));
    assert.equal(again.error?.code, 'DUPLICATE_OF_UNCERTAIN_WRITE', JSON.stringify(again).slice(0, 500));
    assert.equal(f.writes.length, 1, 'nothing was sent for the refused prepare');
  } finally {
    f.close();
  }
});

test('a group prepared before an identical one completed is refused at execute with the call that prepares the whole group, not one part', async () => {
  const f = googleBudgetFixture();
  try {
    const a = await prepare(f, names('Synthetic', 0, 30)),
      b = await prepare(f, names('Synthetic', 0, 30));
    assert.equal((await f.execute(a.data.review_id)).success, true);
    const refused = await f.execute(b.data.review_id);
    assert.equal(refused.error?.code, 'DUPLICATE_OF_COMPLETED_WRITE', JSON.stringify(refused).slice(0, 500));
    assert.equal(refused.error.details.submission, 'not_sent');
    assert.equal(f.writes.length, 2, 'nothing was sent: no second set');
    const next = refused.error.details.next_call;
    assert.equal(next.arguments.action, 'prepare');
    assert.equal(
      next.arguments.arguments.payload.operations.length,
      30,
      'the whole request, not the 25 records of the part that was refused',
    );
    // Prepared again, it carries the warning and executes: the person has seen that two sets are wanted.
    const again = await f.write(next.arguments);
    assert.equal(again.data.group, true);
    assert.ok(again.data.duplicate_warning);
    assert.equal((await f.execute(again.data.review_id)).success, true);
    assert.equal(f.writes.length, 4);
  } finally {
    f.close();
  }
});

test('a plan step that repeats a completed group carries the warning in its review: run stops at it once, sends nothing, and the next run sends', async () => {
  const x = googleWorld({policy: on, world: keywordWorld()}),
    plan = input => x.call('amcp_campaign', input);
  try {
    const first = await x.prepare(keywordAction, keywords(30));
    assert.equal(first.data.group, true, JSON.stringify(first).slice(0, 300));
    assert.equal(first.data.duplicate_warning, undefined);
    assert.equal((await x.execute(first)).success, true);
    assert.equal(x.writes(), 2);
    const id = await createPlan(x, [
      {
        id: 'step1',
        kind: 'write',
        gateway: 'google_ads_native_action',
        connection_id: 'g',
        account_id: '123',
        description: 'step1',
        arguments: {action: 'google_ads_v23_' + keywordAction, payload: {operations: keywords(30)}},
      },
    ]);
    const preview = await plan({action: 'approve', id});
    assert.equal(
      (
        await plan({
          action: 'approve',
          id,
          confirmed: true,
          plan_hash: preview.data.plan_hash,
          summary_hash: preview.data.summary_hash,
        })
      ).success,
      true,
    );
    assert.equal((await plan({action: 'preflight', id})).success, true);
    // The step's review shows the group's warning, as a single review's does.
    const stopped = await plan({action: 'run', id});
    assert.equal(stopped.success, true, JSON.stringify(stopped.error ?? stopped).slice(0, 400));
    assert.equal(stopped.data.run.stopped, 'needs_attention', JSON.stringify(stopped.data.run).slice(0, 400));
    assert.match(stopped.data.run.reason, /carries a warning: an identical create completed/);
    assert.equal(x.writes(), 2, 'nothing was sent at the stop');
    const warned = x.store.document('google-world', 'campaign_run', id).steps[0].review.duplicate_warning;
    assert.deepEqual(warned.parts, [1, 2]);
    // The person has seen the warning and wants two: the next run sends, once.
    const sent = await plan({action: 'run', id});
    assert.equal(sent.success, true, JSON.stringify(sent.error ?? sent).slice(0, 400));
    assert.equal(sent.data.steps[0].status, 'verified', JSON.stringify(sent.data.steps).slice(0, 300));
    assert.equal(x.writes(), 4);
  } finally {
    x.store.close();
  }
});
