import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './x-catalog-fixture.mjs';
import {lower, upper, catalog} from './fixtures/x-catalog-price-data.mjs';
const create = 'x_product_catalogs_product_catalog_id_product_sets_post',
  remove = 'x_product_catalogs_product_catalog_id_product_sets_product_set_id_delete';
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 900));
  return r.data;
};

test('a product set price filter change after a deletion review withholds the deletion', async () => {
  const f = setup();
  try {
    const original = f.sets[9001].get('7002');
    original.filters[0].value = lower;
    const p = await f.prepare(remove, undefined, {...catalog, product_set_id: '7002'});
    assert.equal(ok(p).creative_impact.deleting.filters[0].value.amount, '999999999999.000001');
    original.filters[0].value = upper;
    const r = await f.execute(p);
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'STATE_CHANGED');
    assert.equal(f.writes(), 0);
    assert.equal(f.sets[9001].get('7002'), original);
  } finally {
    f.store.close();
  }
});

for (const attribute of ['price', 'sale_price']) {
  test(`rounded ${attribute} product set filters retire old verified caches and retain exact native input`, async () => {
    const f = setup();
    try {
      const input = {
        name: 'Exact filter',
        type: 'FILTERED',
        filters: [{attribute, operator: 'GREATER_THAN', value: lower}],
      };
      const p = await f.prepare(create, input, catalog);
      assert.equal(ok(p).creative_impact.creating.filters[0].value.amount, '999999999999.000001');
      const accepted = ok(await f.execute(p)),
        id = accepted.data.data.id;
      assert.deepEqual(f.calls.find(c => c.method === 'POST').body, input);
      f.store.putDocument(f.actor.tenantId, 'write_verification', p.data.review_id, {
        status: 'verified',
        checked_at: Date.now(),
        checks: [],
      });
      const reads = f.calls.length;
      const observed = ok(await f.verify(p));
      assert.equal(observed.status, 'inconclusive');
      assert.equal(observed.cached, undefined);
      assert.ok(f.calls.length > reads);
      assert.ok(observed.checks[0].changed_fields.includes('/set/filters'));
      const mismatch = ok(await f.verify(p));
      assert.equal(mismatch.status, 'mismatch');
      assert.equal(mismatch.checks[0].diff[0].expected[0].value.amount, '999999999999.000001');
      assert.equal(mismatch.checks[0].diff[0].actual[0].value.amount, '999999999999');
      f.sets[9001].get(id).filters[0].value = lower;
      assert.equal(ok(await f.verify(p)).status, 'verified');
      const exactReads = f.calls.length;
      assert.equal(ok(await f.verify(p)).cached, true);
      assert.equal(f.calls.length, exactReads);
      ok(await f.execute(p));
      assert.equal(f.writes(), 1);
    } finally {
      f.store.close();
    }
  });
}
