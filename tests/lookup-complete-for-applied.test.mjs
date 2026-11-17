import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {metaReconcileFixture, metaTime} from './helpers/meta-reconcile-fixture.mjs';
import {stamp, tiktokReconcileFixture} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead re-review N11: "applied" needs a whole list, as "absent" does. One match on the first page of a list that goes on was
 * called applied, although a second match may follow on a later page: Meta's campaign, ad set and ad read was one page of 25 by name with no
 * pages followed, and a TikTok list is cut at ten pages. It can only be wrong with two objects of that name inside the window, and it cost
 * liveness the other way (a name repeated across many parents ended lookup_incomplete). Now a match counts as applied only when the list was
 * whole, and Meta's edge read follows its pages, as every other list lookup does (up to the ten batches of one check).
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
const oldTime = '2026-01-01T08:00:00+0000';
/** A campaign row as the synthetic Meta account stores it. */
const metaRow = (id, createdAt, name = 'Synthetic campaign') => ({id, name, created_time: createdAt});

test('Meta: a campaign list that goes on past its first page is followed, so a second match inside the window is seen, never "applied"', async () => {
  const f = metaReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    // A second campaign of the same name was made in the same minutes: it is on the page after the first.
    f.rows.campaign.push(metaRow('9500', metaTime(Date.now())));
    f.state.limit = 1;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data).slice(0, 600));
    assert.equal(r.data.reason, 'ambiguous');
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
    assert.equal(r.data.found.length, 2, 'both are shown');
    assert.equal(f.sent.length, 1, 'nothing was sent but the lost create');
  } finally {
    f.close();
  }
});

test('Meta: a campaign of the name made long ago on the first page no longer hides the one this write made on the second', async () => {
  const f = metaReconcileFixture();
  try {
    // An older campaign of the same name comes first in the list: the answer was one page, whole only if it named no page after it.
    f.rows.campaign.push(metaRow('2002', oldTime));
    const {id} = await f.lose('campaign', {applied: true});
    f.state.limit = 1;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data).slice(0, 600));
    assert.deepEqual(
      r.data.found.map(o => o.id),
      [f.rows.campaign.at(-1).id],
    );
    assert.deepEqual(r.data.observed_ids, [f.rows.campaign.at(-1).id]);
  } finally {
    f.close();
  }
});

test('Meta: a list longer than one check reads (ten pages) settles nothing: not applied, not absent', async () => {
  const f = metaReconcileFixture();
  try {
    for (let i = 0; i < 11; i++) f.rows.campaign.push(metaRow(String(2100 + i), oldTime));
    const {id} = await f.lose('campaign', {applied: true});
    f.state.limit = 1;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data).slice(0, 600));
    assert.equal(r.data.reason, 'lookup_incomplete');
    assert.equal(r.data.observed_ids, undefined);
  } finally {
    f.close();
  }
});

test('TikTok: one match among the first ten pages of a longer list is not "applied": a second may follow', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    const now = Date.now();
    // Eleven other campaigns made in the same minutes, after it: the list is twelve pages of one row, and a check reads ten.
    for (let i = 0; i < 11; i++)
      f.rows.campaign.push({
        campaign_id: String(900 + i),
        advertiser_id: f.world.id,
        campaign_name: 'Another campaign ' + i,
        operation_status: 'DISABLE',
        create_time: stamp(now),
        _at: now,
      });
    f.state.pageSize = 1;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data).slice(0, 600));
    assert.equal(r.data.reason, 'lookup_incomplete');
    assert.equal(r.data.observed_ids, undefined, 'nothing is offered for acceptance');
    assert.equal(r.data.found.length, 1, 'the match is still shown');
  } finally {
    f.close();
  }
});

test('a match in a whole list is still applied: the rule costs nothing where the list ends', async () => {
  const f = tiktokReconcileFixture();
  try {
    const {id} = await f.lose('campaign', {applied: true});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data).slice(0, 600));
    const m = metaReconcileFixture();
    try {
      const lost = await m.lose('campaign', {applied: true});
      const answer = await reconcile(m, lost.id);
      assert.equal(answer.data.classification, 'appears_applied', JSON.stringify(answer.data).slice(0, 600));
    } finally {
      m.close();
    }
  } finally {
    f.close();
  }
});
