import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {reviewedFamilies} from '../dist/src/reviewed-families.js';
import {account, catalog, metaReconcileFixture} from './helpers/meta-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S4-5: the pages that a family's reader produces for a lookup's read were scope-checked but not checked for
 * being read-only, as the lookup's own requests are. A reconciliation only reads, so every page it sends is checked, whoever
 * built it: a family that handed the transport a request that is not independently read-only is refused before anything is sent.
 */
before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

test('a page that a family reader hands the transport and that is not read-only is refused, and nothing is sent', async () => {
  const f = metaReconcileFixture(),
    family = reviewedFamilies().find(candidate => candidate.name === 'meta_product_sets'),
    reader = family.reader;
  try {
    const {id} = await f.lose('set', {applied: true});
    // The catalog is the connection's own, so the scope guard has no ownership to refuse a page for: the page check is what stops it.
    f.store.rememberResource(f.connection, account, catalog);
    const sent = f.sent.length,
      requests = f.requests.length;
    // The family's reader answers the lookup's list read through a page of its own, which here is no longer marked read-only.
    family.reader = (request, next) => reader(request, page => next({...page, readOnly: false}));
    const refused = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(refused.error?.code, 'RECONCILIATION_UNSUPPORTED', JSON.stringify(refused).slice(0, 400));
    assert.equal(f.sent.length, sent, 'no mutation reached the provider');
    assert.deepEqual(f.requests.slice(requests), [], 'no request of the refused page was sent');
    assert.equal(f.claim(id).state, 'uncertain', 'the write is as it was');
    // The same read through the family as it is: read-only pages, and the check goes through.
    family.reader = reader;
    const checked = await f.call('amcp_write', {action: 'reconcile', review_id: id});
    assert.equal(checked.data.classification, 'appears_applied', JSON.stringify(checked.data));
  } finally {
    family.reader = reader;
    f.close();
  }
});
