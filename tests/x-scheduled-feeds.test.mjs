import test from 'node:test';
import assert from 'node:assert/strict';
import {actionContracts} from '../dist/src/action-contracts.js';
import {registry, setup} from './x-catalog-fixture.mjs';

/**
 * Scheduled feeds of X catalogs, opened by the owner on 2026-09-29, from X's "Catalog Management API Reference"
 * (docs.x.com, read 2026-09-29): "Only one product feed is supported per user"; imports are "additive"; repeat is
 * required for WEEKLY (MONDAY to SUNDAY) and HOURLY (1, 2, 3, 4, 6, 8, 12) and absent for DAILY.
 */
const actions = {
  create: 'x_product_catalogs_product_catalog_id_scheduled_feeds_post',
  update: 'x_product_catalogs_product_catalog_id_scheduled_feeds_scheduled_feed_id_put',
  remove: 'x_product_catalogs_product_catalog_id_scheduled_feeds_scheduled_feed_id_delete',
};
const feed = {
  feed_url: 'https://shop.example.test/feed.xml',
  feed_format: 'XML',
  frequency: 'DAILY',
  start_time: '03:00',
  time_zone: 'Asia/Riyadh',
};
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
  return r;
};
const refused = (r, code) => assert.equal(r.error?.code, code, JSON.stringify(r).slice(0, 800));

test("a catalog's one feed is created with when X fetches it, and read back", async () => {
  const x = setup({feed: false});
  try {
    const p = ok(await x.prepare(actions.create, feed, {product_catalog_id: '9001'}));
    assert.equal(
      p.data.creative_impact.fetches,
      'DAILY at 03:00 (Asia/Riyadh) from https://shop.example.test/feed.xml',
    );
    assert.match(p.data.creative_impact.effect, /additive/);
    ok(await x.execute(p));
    const sent = x.calls.find(c => c.method === 'POST');
    assert.match(sent.type, /x-www-form-urlencoded/);
    assert.deepEqual(sent.body, feed);
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    refused(await x.prepare(actions.create, feed, {product_catalog_id: '9001'}), 'CONFIGURATION_EXISTS');
    refused(await x.prepare(actions.create, feed, {product_catalog_id: '9009'}), 'STATE_TARGET_MISMATCH');
  } finally {
    x.store.close();
  }
});

test('schedules follow the repeat rules, over HTTPS, without credentials', async () => {
  const x = setup({feed: false});
  try {
    for (const [label, payload] of [
      ['http', {...feed, feed_url: 'http://shop.example.test/feed.xml'}],
      ['credentials in the address', {...feed, feed_url: 'https://u:p@shop.example.test/feed.xml'}],
      ['username', {...feed, username: 'u'}],
      ['daily with repeat', {...feed, repeat: '6'}],
      ['weekly without repeat', {...feed, frequency: 'WEEKLY'}],
      ['hourly every 5', {...feed, frequency: 'HOURLY', repeat: '5'}],
      ['time', {...feed, start_time: '3:00'}],
      ['abbreviated zone', {...feed, time_zone: 'PST'}],
      ['format', {...feed, feed_format: 'JSON'}],
      ['missing time zone', {...feed, time_zone: undefined}],
    ])
      assert.equal(
        (await x.prepare(actions.create, JSON.parse(JSON.stringify(payload)), {product_catalog_id: '9001'})).success,
        false,
        label,
      );
    assert.equal(x.calls.length, 0);
    ok(await x.prepare(actions.create, {...feed, frequency: 'HOURLY', repeat: '6'}, {product_catalog_id: '9001'}));
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});

test('an update changes what is sent and reads back; a change X cannot express is refused', async () => {
  const x = setup();
  try {
    const at = {product_catalog_id: '9001', scheduled_feed_id: '8001'};
    const p = ok(await x.prepare(actions.update, {start_time: '07:30'}, at));
    assert.equal(p.data.creative_impact.before.start_time, '01:30');
    assert.equal(
      p.data.creative_impact.fetches,
      'WEEKLY on SATURDAY at 07:30 (Asia/Riyadh) from https://shop.example.test/feed.csv',
    );
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    const daily = await x.prepare(actions.update, {frequency: 'DAILY'}, at);
    refused(daily, 'INVALID_X_SCHEDULED_FEED');
    assert.match(daily.error.message, /no way to clear repeat/);
    refused(await x.prepare(actions.update, {frequency: 'HOURLY'}, at), 'INVALID_X_SCHEDULED_FEED');
    refused(await x.prepare(actions.update, {repeat: '6'}, at), 'INVALID_X_SCHEDULED_FEED');
    refused(await x.prepare(actions.update, {start_time: '07:30'}, at), 'INVALID_X_SCHEDULED_FEED');
    ok(await x.prepare(actions.update, {frequency: 'HOURLY', repeat: '12'}, at));
    refused(
      await x.prepare(actions.update, {start_time: '08:00'}, {...at, scheduled_feed_id: '8999'}),
      'STATE_NOT_FOUND',
    );
  } finally {
    x.store.close();
  }
});

test("a feed is deleted with X's additive rule stated, and read back gone", async () => {
  const x = setup();
  try {
    const p = ok(await x.prepare(actions.remove, undefined, {product_catalog_id: '9001', scheduled_feed_id: '8001'}));
    assert.match(p.data.creative_impact.effect, /does not say that deleting the feed removes the products/);
    ok(await x.execute(p));
    assert.equal(ok(await x.verify(p)).data.status, 'verified');
    assert.equal(x.feeds[9001].size, 0);
    assert.deepEqual(
      actionContracts(registry)
        .filter(r => r.family === 'x_scheduled_feeds')
        .map(r => r.action)
        .sort(),
      Object.values(actions).sort(),
    );
  } finally {
    x.store.close();
  }
});
