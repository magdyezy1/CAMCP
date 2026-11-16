import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {account, catalog, creates, gateway, metaReconcileFixture} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S3-2 and S3-3, two lookups of Meta that called an object this write's, or this write's absence, on less
 * than they knew.
 *  - A product set and a feed carry no creation time, so a new one of the frozen name (one the review did not see in its catalog)
 *    was "this write's" whenever the check ran: a set made after the prepare in Commerce Manager, by another tool or by a
 *    replacement counted, and the later the check, the wider the exposure. Such an object is now this write's only while the check
 *    runs within the window the other kinds are dated by (the claim + 15 minutes); a later check shows it and calls nothing applied.
 *  - A creative's absence was "no live creative of the exact name in a whole list". Meta may append a date and a hash to a
 *    creative's name (the L3 M6 report, unconfirmed), so a creative that was made would read as absent and a duplicate would follow.
 *    A creative whose name is the frozen one plus a separator and a date (and a hash) is now a doubt, as the exact name is.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const compile = kind => {
  const [action, params, payload] = creates[kind];
  return applyExecutionRisk(
    compiler.compile(
      gateway,
      {action, account_id: account, ...(params ? {params} : {}), payload: structuredClone(payload), dry_run: true},
      options,
    ),
  );
};
const minutes = n => n * 60000;
const claimed = Date.parse('2026-10-10T10:00:00Z');
const list = rows => ({status: 200, headers: {}, data: {data: rows}});
const ids = found => (found ?? []).map(f => f.id);
const set = (id, name = 'Synthetic set') => ({id, name, product_catalog: {id: catalog}});
const feed = (id, name = 'Synthetic feed') => ({id, name});
const frozen = {
  set: {sets: [{id: '7001', name: 'Shoes'}]},
  feed: {feeds: [{id: '6001', name: 'Existing feed'}]},
};

for (const [kind, row] of [
  ['set', set],
  ['feed', feed],
]) {
  test(
    'a product ' +
      kind +
      ' the review did not see is this write’s only while the check runs within 15 minutes of the claim',
    () => {
      const lookup = findCreated(compile(kind), {state: [frozen[kind]], claimedAt: claimed});
      assert.ok(lookup, 'a ' + kind + ' create has a lookup');
      const at = (delay, ...rows) => lookup.match([list(rows)], claimed, claimed + delay);
      assert.deepEqual(ids(at(minutes(1), row('7100')).found), ['7100'], 'a minute after the claim');
      assert.deepEqual(ids(at(minutes(15), row('7100')).found), ['7100'], 'at the end of the window');
      const late = at(minutes(15) + 1, row('7100'));
      assert.deepEqual(ids(late.found), [], 'a millisecond past it');
      assert.deepEqual(ids(late.undated), ['7100'], 'it is shown, a doubt, never called created');
      assert.equal(late.complete, true);
      const later = at(minutes(120), row('7100'), row('7101'));
      assert.deepEqual([ids(later.found), ids(later.undated).sort()], [[], ['7100', '7101']], 'two hours after');
      // A late check still proves absence where the whole list holds nothing new of the name.
      const none = at(minutes(120));
      assert.deepEqual([none.found.length, (none.undated ?? []).length, none.complete], [0, 0, true]);
      // An object of the name that the review saw is nobody's new one, early or late.
      const kept = {[kind + 's']: [...frozen[kind][kind + 's'], {id: '7200', name: row('7200').name}]},
        old = findCreated(compile(kind), {state: [kept], claimedAt: claimed});
      assert.deepEqual(
        ids(old.match([list([row('7200')])], claimed, claimed + minutes(120)).undated),
        [],
        'one the review saw is not shown even late',
      );
    },
  );
}

test('the time the check runs is now unless a caller says so: a claim a few minutes old finds the set, one an hour old only shows it', () => {
  const lookupAt = claimedAt => findCreated(compile('set'), {state: [frozen.set], claimedAt});
  const fresh = lookupAt(Date.now() - minutes(3)),
    old = lookupAt(Date.now() - minutes(60));
  assert.deepEqual(ids(fresh.match([list([set('7100')])], Date.now() - minutes(3)).found), ['7100']);
  const m = old.match([list([set('7100')])], Date.now() - minutes(60));
  assert.deepEqual([ids(m.found), ids(m.undated)], [[], ['7100']]);
});

for (const kind of ['set', 'feed']) {
  test(
    'a lost ' + kind + ' create found by a check 20 minutes after its claim is shown, not offered as applied',
    async () => {
      const f = metaReconcileFixture();
      try {
        const {id} = await f.lose(kind, {applied: true});
        f.store.db
          .prepare('UPDATE idempotency SET created_at=created_at-? WHERE tenant_id=? AND key=?')
          .run(minutes(20), f.actor.tenantId, id);
        const r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
        assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
        assert.equal(r.data.reason, 'undated_match');
        assert.deepEqual(r.data.undated, [{id: '9000'}]);
        assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
      } finally {
        f.close();
      }
    },
  );
}

// ----- S3-3: a creative's name may be decorated by Meta -----
const frozenName = 'Synthetic creative';
const creative = (id, name, status = 'ACTIVE') => ({id, name, status});
const creativeLookup = () => {
  const lookup = findCreated(compile('creative'), {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a creative create has a lookup');
  return lookup;
};

test('a creative whose name is the frozen one plus a separator, a date and a hash is a doubt, not another creative', () => {
  const lookup = creativeLookup(),
    match = (...names) => lookup.match([list(names.map((name, i) => creative(String(3100 + i), name)))], claimed);
  const decorated = [
    frozenName + ' 2026-10-10-ab12cd',
    frozenName + '_2026-10-10-ab12cd',
    frozenName + '-2026-10-10-AB12CD34',
    frozenName + '2026-10-10-ab12cd',
    frozenName + ' | 2026-10-10 ab12cd',
    '  ' + frozenName.toUpperCase() + ' 2026-10-10',
  ];
  for (const name of decorated) {
    const m = match(name);
    assert.deepEqual([m.found.length, ids(m.undated)], [0, ['3100']], name);
    assert.equal(m.complete, true);
  }
  // The exact name stays a doubt, and the doubts are shown together.
  assert.deepEqual(ids(match(frozenName, decorated[0]).undated), ['3100', '3101']);
  // Another creative is another creative: a different word, a different prefix, a number that is no date, a deleted one.
  for (const name of [
    frozenName + ' 2',
    frozenName + ' copy',
    frozenName + ' 2026',
    frozenName + ' 2026-10-10-ab12cd extra',
    'Other ' + frozenName + ' 2026-10-10-ab12cd',
    'Synthetic creativf 2026-10-10-ab12cd',
    'Existing creative',
  ]) {
    const m = match(name);
    assert.deepEqual([m.found.length, (m.undated ?? []).length, m.complete], [0, 0, true], name);
  }
  const deleted = lookup.match([list([creative('3300', frozenName + ' 2026-10-10-ab12cd', 'DELETED')])], claimed);
  assert.deepEqual([deleted.found.length, (deleted.undated ?? []).length], [0, 0], 'a deleted creative is no creative');
});

test('a lost creative create with a decorated creative in the account is indeterminate, never absent', async () => {
  const f = metaReconcileFixture();
  try {
    const [, , payload] = creates.creative;
    // Meta made the creative and wrote a date and a hash after the name; the answer to the create was lost.
    f.rows.creative.push(creative('3100', payload.name + ' 2026-10-10-ab12cd'));
    const prepared = await f.prepare('creative');
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 500));
    f.state.applied = false;
    f.state.lose = true;
    const refused = await f.execute(prepared.data.review_id);
    f.state.lose = false;
    assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN');
    const r = await f.call('amcp_write', {action: 'reconcile', review_id: prepared.data.review_id});
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'undated_match');
    assert.deepEqual(r.data.undated, [{id: '3100'}]);
    assert.equal(r.data.next_call.arguments.supersedes_review_id, undefined, 'no replacement is offered');
  } finally {
    f.close();
  }
});
