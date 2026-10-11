import test from 'node:test';
import assert from 'node:assert/strict';
import {xCatalogRemovalFixture as fixture} from './fixtures/x-catalog-removal.mjs';
import {xProductSource} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';

/**
 * COM-02 C: a selected-removal step is checked by its own native review read against the bound product, not by a
 * separate pair of full catalog comparisons before prepare and again before execute. Before the fix, two removals on a
 * 1,000-product catalog cost 261 GETs against 79 for two updates; each removal step now costs what an update step costs.
 */
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1300));
  return r.data;
};
const gets = f => f.calls.filter(c => c.method === 'GET').length;

async function runSteps(f, id, count) {
  for (let i = 0; i < count; i++) {
    const prepared = ok(await f.campaign({action: 'prepare_next', id}));
    ok(await f.campaign({...prepared.next_call.arguments, spend_change_confirmed: true}));
  }
  return f.store.document(f.actor.tenantId, 'campaign_run', id);
}

test('removal steps on a 1,000-product catalog read no more than update steps and record their native requests', async t => {
  const removal = fixture(t, {products: 1000});
  const preview = ok(await removal.preview()),
    saved = ok(await removal.save(preview)),
    before = gets(removal),
    removed = await runSteps(removal, saved.id, 2),
    removalGets = gets(removal) - before;
  assert.equal(removal.writes(), 2);
  assert.ok(
    removed.steps.every(s => s.status === 'verified'),
    JSON.stringify(removed.steps).slice(0, 800),
  );

  const update = fixture(t, {products: 1000, tenant: 'synthetic-x-update-baseline'});
  const plan = ok(
    await update.service.call(
      'amcp_workspace',
      {
        ...update.input,
        action: 'catalog_plan',
        products: [
          xProductSource(product(1), {name: 'Changed title 1'}),
          xProductSource(product(2), {name: 'Changed title 2'}),
        ],
      },
      update.actor,
    ),
  );
  const start = gets(update),
    updated = await runSteps(update, plan.id, 2),
    updateGets = gets(update) - start;
  assert.ok(updated.steps.every(s => s.status === 'verified'));

  // Owners (3 GETs) and ten 100-product pages per state read: prepare, execute and read-back, about 40 per step.
  assert.ok(removalGets <= updateGets, `removal ${removalGets} GETs, update ${updateGets} GETs`);
  assert.ok(removalGets / 2 <= 40, `removal step ${removalGets / 2} GETs`);
  assert.ok(removalGets < 261 / 2, 'well below the pre-fix marker for two removals');

  // The journal counter: every native GET of a step is recorded against its phase (the plan's one account metadata
  // read is the plan's, not a step's), and the step deleted one product.
  const journal = removed.steps.map(s => s.native_requests),
    sum = steps =>
      steps.reduce(
        (n, s) =>
          n + s.native_requests.prepare.reads + s.native_requests.execute.reads + s.native_requests.verify.reads,
        0,
      );
  assert.ok(removalGets - sum(removed.steps) <= 1, `${removalGets} GETs, ${sum(removed.steps)} in the journal`);
  assert.equal(removalGets - sum(removed.steps), updateGets - sum(updated.steps));
  for (const j of journal) {
    assert.deepEqual(Object.keys(j).sort(), ['execute', 'prepare', 'verify']);
    assert.equal(j.prepare.writes, 0);
    assert.equal(j.execute.writes, 1);
    assert.equal(j.verify.writes, 0);
  }
  assert.deepEqual(
    removed.steps.map(s => s.native_requests),
    updated.steps.map(s => s.native_requests),
    'a removal step and an update step cost the same native requests',
  );
});

test('the review read still refuses a selected product that changed or became grouped after the draft', async t => {
  for (const change of ['title', 'grouped', 'price', 'unsent', 'missing']) {
    const f = fixture(t);
    const saved = ok(await f.save(ok(await f.preview())));
    const row = f.items[9001].find(p => p.id === 'sku-1');
    if (change === 'title') row.title = 'Changed after the draft';
    if (change === 'grouped') row.item_group_id = 'group-1';
    if (change === 'price') row.price = '21.00 SAR';
    if (change === 'unsent') row.gtin = '0123456789012';
    if (change === 'missing') f.items[9001].splice(f.items[9001].indexOf(row), 1);
    const refused = await f.campaign({action: 'prepare_next', id: saved.id});
    assert.equal(refused.success, false, change);
    assert.equal(refused.error.code, 'CATALOG_REMOVAL_CHANGED', change + ': ' + JSON.stringify(refused.error));
    assert.equal(f.writes(), 0, change);
    // A refused review is not retained, and the step is unchanged: it is checked again on the next call.
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0, change);
    const run = f.store.document(f.actor.tenantId, 'campaign_run', saved.id);
    assert.equal(run.steps[0].status, 'pending', change);
  }
});

test('a price that only changes its written form is the same exact value and does not refuse the removal', async t => {
  const f = fixture(t);
  const saved = ok(await f.save(ok(await f.preview())));
  f.items[9001].find(p => p.id === 'sku-1').price = '20 SAR';
  const prepared = ok(await f.campaign({action: 'prepare_next', id: saved.id}));
  assert.equal(prepared.step_id, 'remove-1');
  assert.equal(f.writes(), 0);
});
