import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {findCreated} from '../dist/src/write-reconciliation.js';
import {standardBodies} from './helpers/tiktok-standard-creates.mjs';
import {stamp, tiktokReconcileFixture, gateway} from './helpers/tiktok-reconcile-fixture.mjs';

/**
 * R2.5 M2, lead review S3-1: the TikTok lookup doubted the time zone of `create_time` in a response but trusted the zone of its
 * creation filter. If TikTok applies the filter in the advertiser's zone (neither is confirmed live; both are documented as
 * UTC), the object the write made falls outside the window TikTok applies, the answer is empty and whole, and the check says
 * "not applied" with a replacement offered. So the window asked of TikTok is widened by the longest zone offset on each side,
 * the split stays in code (found inside the window, a doubt in the margin), and a list longer than a page is followed to its
 * end, because the wider window holds more rows.
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
const create = kind => {
  const {action, payload} = standardBodies('123')[kind];
  return applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true}, options));
};
const claimed = Date.parse('2026-10-10T10:00:00Z'),
  hours = n => n * 3600000;
const listed = (list, page = {}) => ({
  status: 200,
  data: {
    code: 0,
    message: 'OK',
    request_id: 'synthetic',
    data: {list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1, ...page}},
  },
});
const reconcile = (f, id) => f.call('amcp_write', {action: 'reconcile', review_id: id});
/** Other campaigns made in the same minutes, which a window of any width holds. */
const crowd = (f, count) => {
  for (let i = 0; i < count; i++)
    f.rows.campaign.push({
      campaign_id: String(900 + i),
      advertiser_id: f.world.id,
      campaign_name: 'Other campaign ' + i,
      operation_status: 'DISABLE',
      create_time: stamp(Date.now()),
    });
};

test('the window asked of TikTok is the claim window widened by 14 hours on each side, and the filter is no proof of absence', () => {
  const lookup = findCreated(create('campaign'), {state: [], claimedAt: claimed});
  assert.ok(lookup, 'a standard TikTok campaign create has a lookup');
  assert.deepEqual(lookup.reads[0].query.filtering, {
    creation_filter_start_time: '2026-10-09 19:58:00',
    creation_filter_end_time: '2026-10-11 00:15:00',
  });
  // The split stays in code: made in the claim window is this write's, in the margin is a doubt, outside the margin is another's.
  const row = (id, at) => ({campaign_id: id, campaign_name: 'Synthetic campaign', create_time: at});
  const m = lookup.match(
    [
      listed([
        row('1', '2026-10-10 10:00:05'),
        row('2', '2026-10-10 20:00:00'),
        row('3', '2026-10-09 20:30:00'),
        row('4', '2026-10-10 06:00:00'),
      ]),
    ],
    claimed,
  );
  assert.deepEqual(
    [m.found.map(f => f.id), m.undated.map(u => u.id)],
    [['1'], ['2', '3', '4']],
    'the margin holds doubts, never matches',
  );
});

test('a creation filter that TikTok applies in the advertiser’s zone does not hide the created object: it is found, and never called absent', async () => {
  const eight = hours(8);
  // The creation times TikTok shows are UTC, as documented; only the filter is read in the zone of the advertiser.
  const f = tiktokReconcileFixture();
  try {
    f.state.filterZoneMs = eight;
    const {id} = await f.lose('campaign', {applied: true});
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'created_found');
  } finally {
    f.close();
  }
  // A zone behind UTC moves the filter the other way, so the start of the window is as wide as its end.
  const behind = tiktokReconcileFixture();
  try {
    behind.state.filterZoneMs = -eight;
    const {id} = await behind.lose('campaign', {applied: true});
    const r = await reconcile(behind, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
  } finally {
    behind.close();
  }
  // Both are in the advertiser's zone: the object is in the answer, and its time cannot be told from an older one's.
  const g = tiktokReconcileFixture();
  try {
    g.state.filterZoneMs = eight;
    g.state.displayZoneMs = eight;
    const {id} = await g.lose('campaign', {applied: true});
    const r = await reconcile(g, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'undated_match');
    assert.equal(r.data.undated?.length, 1);
  } finally {
    g.close();
  }
  // A create that was not applied is still absent: the whole window holds nothing of the name.
  const h = tiktokReconcileFixture();
  try {
    h.state.filterZoneMs = eight;
    const {id} = await h.lose('campaign', {applied: false});
    const r = await reconcile(h, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'not_found');
  } finally {
    h.close();
  }
});

test('a list longer than a page is followed to its end: the object on a later page is found, and absence needs every page', async () => {
  const f = tiktokReconcileFixture();
  try {
    f.state.pageSize = 2;
    crowd(f, 4);
    const {id} = await f.lose('campaign', {applied: true}),
      before = f.pages.length;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data));
    assert.deepEqual(f.pages.slice(before), [1, 2, 3, 1, 2, 3], 'both rounds read all three pages, in order');
  } finally {
    f.close();
  }
  const g = tiktokReconcileFixture();
  try {
    g.state.pageSize = 2;
    crowd(g, 4);
    const {id} = await g.lose('campaign', {applied: false}),
      before = g.pages.length;
    const r = await reconcile(g, id);
    assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data));
    assert.deepEqual(g.pages.slice(before), [1, 2, 1, 2]);
  } finally {
    g.close();
  }
});

test('a list of more than ten pages is not whole: nothing is called absent from it, and no more than ten pages are read', async () => {
  const f = tiktokReconcileFixture();
  try {
    f.state.pageSize = 1;
    crowd(f, 11);
    const {id} = await f.lose('campaign', {applied: false}),
      before = f.pages.length;
    const r = await reconcile(f, id);
    assert.equal(r.data.classification, 'indeterminate', JSON.stringify(r.data));
    assert.equal(r.data.reason, 'lookup_incomplete');
    assert.equal(f.pages.length - before, 20, 'ten pages in each of the two rounds');
  } finally {
    f.close();
  }
});

test('the next page is asked for only while the answers follow each other, and a page that repeats is no page', () => {
  const lookup = findCreated(create('campaign'), {state: [], claimedAt: claimed});
  assert.equal(typeof lookup.more, 'function', 'the lookup follows its pages');
  const first = lookup.reads[0],
    one = listed([], {page: 1, total_page: 3, total_number: 250}),
    two = listed([], {page: 2, total_page: 3, total_number: 250});
  const next = lookup.more([one]);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0].query, {...first.query, page: 2});
  assert.deepEqual(
    lookup.more([one, two]).map(r => r.query.page),
    [3],
  );
  assert.deepEqual(
    lookup.more([one, two, listed([], {page: 3, total_page: 3, total_number: 250})]),
    [],
    'the last page',
  );
  assert.deepEqual(lookup.more([one, one]), [], 'the answer to page 2 says it is page 1: no more are asked for');
  assert.deepEqual(lookup.more([listed([], {page: 1, total_page: 1})]), [], 'a whole list');
  assert.deepEqual(lookup.more([{status: 200, data: {code: 0, data: {}}}]), [], 'an answer with no list');

  // The match is whole only with every page of the last answer's count, each following the one before.
  const row = id => ({campaign_id: id, campaign_name: 'Synthetic campaign', create_time: '2026-10-10 10:00:05'});
  const pages = [
    listed([], {page: 1, total_page: 3, total_number: 3}),
    listed([], {page: 2, total_page: 3, total_number: 3}),
    listed([row('7')], {page: 3, total_page: 3, total_number: 3}),
  ];
  assert.deepEqual(
    [lookup.match(pages, claimed).complete, lookup.match(pages, claimed).found.map(f => f.id)],
    [false, ['7']],
    'the counts say three rows and the pages hold one: not whole',
  );
  const whole = [
    listed([row('5'), row('6')], {page: 1, total_page: 2, total_number: 3, page_size: 2}),
    listed([{campaign_id: '8', campaign_name: 'Another', create_time: '2026-10-10 10:00:06'}], {
      page: 2,
      total_page: 2,
      total_number: 3,
      page_size: 2,
    }),
  ];
  assert.equal(lookup.match(whole, claimed).complete, true, 'every page, in order, with every row the count names');
  assert.equal(lookup.match([whole[0]], claimed).complete, false, 'the first page of two');
  assert.equal(lookup.match([whole[1], whole[0]], claimed).complete, false, 'the pages out of order');
  assert.equal(
    lookup.match([whole[0], whole[0]], claimed).found.length,
    2,
    'a page read twice does not count its objects twice',
  );
});
