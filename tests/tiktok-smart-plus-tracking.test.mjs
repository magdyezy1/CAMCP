import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {editsFixture, post, config, gateway, TIKTOK} from './fixtures/tiktok-smart-plus-edits.mjs';

/**
 * T5 (r25-m4-smartedits): the tracking pixel of an Upgraded Smart+ ad, `ad_configuration.tracking_info.tracking_pixel_id`. TikTok's
 * "Create an Upgraded Smart+ Ad" and "Update an Upgraded Smart+ Ad" (read 2026-11-20, impl/r25-m4-DOCS-EVIDENCE.md section 3) say it
 * is valid only for app promotion ads (APP_INSTALL, APP_RETARGETING) and for lead generation ads whose ad group does not send
 * people to an external website (the Instant Form), and that it must match the ad group's own pixel_id when the group has one. A
 * website, Sales or Traffic ad is in no scenario: its pixel is its ad group's (CONVERT goal). AMCP qualifies the Instant Form case:
 * the pixel is read from the advertiser's pixel list, must be returned and not unbound, a shared pixel is reported, and a restated
 * configuration never drops a pixel the ad has. `"0"` is how TikTok reads an ad with no pixel (the reads of 2026-11-21).
 */
const lead = (extra = {}, configuration = {}) => ({
  advertiser_id: '123',
  adgroup_id: '310',
  ad_name: 'Lead spark',
  operation_status: 'DISABLE',
  creative_list: [post('9001')],
  page_list: [{page_id: '7700149'}],
  ad_configuration: config(configuration),
  ...extra,
});
const website = (extra = {}, configuration = {}) => ({
  advertiser_id: '123',
  adgroup_id: '304',
  ad_name: 'Website spark',
  operation_status: 'DISABLE',
  creative_list: [post('9001')],
  landing_page_url_list: [{landing_page_url: 'https://shop.example.test/sale'}],
  ad_configuration: config(configuration),
  ...extra,
});
const tracking = info => ({tracking_info: info});
/** An edit of an ad's configuration that sets its pixel. */
const pixelEdit = (id, pixel, extra = {}) => ({
  smart_plus_ad_id: id,
  ad_configuration: config({...tracking({tracking_pixel_id: pixel}), ...extra}),
});
const field = 'ad_configuration.tracking_info.tracking_pixel_id';
const create = 'tiktok_smart_plus_ad_create';
const pathsOf = p => p.data.state_reads.map(r => r.path);

test('an Instant Form lead ad edit sets its pixel: the pixel and the ad group are read, it is sent once and verifies, although TikTok returns more tracking_info keys', async () => {
  const f = editsFixture();
  try {
    const p = await f.prepared(pixelEdit('5200', '7001'));
    assert.deepEqual(pathsOf(p), [
      '/v1.3/smart_plus/ad/get/',
      '/v1.3/creative/portfolio/get/',
      '/v1.3/pixel/list/',
      '/v1.3/smart_plus/adgroup/get/',
    ]);
    const impact = p.data.creative_impact;
    assert.equal(impact.may_affect_serving, false, 'a pixel changes measurement, not spend');
    assert.deepEqual(impact.tracking_pixel, {pixel_id: '7001', name: 'Site pixel', owned: true});
    assert.deepEqual(impact.changes.ad_configuration.tracking_info, {
      before: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'},
      after: {tracking_pixel_id: '7001'},
    });
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x));
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].ad_configuration.tracking_info, {tracking_pixel_id: '7001'});
    // TikTok returns more keys of tracking_info than were sent: the read-back is compared on the keys that were sent.
    f.behaviour.extras = {viewability_postbid_partner: 'UNSET', tracking_message_event_set_id: '0'};
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id, '7001');
    assert.equal((await f.execute(p.data.review_id)).data.replayed, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('an Instant Form lead ad create carries the pixel the same way: read, checked, created once and verified', async () => {
  const f = editsFixture();
  try {
    const p = await f.prepared(lead({}, tracking({tracking_pixel_id: '7001'})), {}, create);
    assert.ok(pathsOf(p).includes('/v1.3/pixel/list/'), pathsOf(p).join());
    assert.deepEqual(p.data.creative_impact.tracking_pixel, {pixel_id: '7001', name: 'Site pixel', owned: true});
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.deepEqual(f.writes[0].ad_configuration.tracking_info, {tracking_pixel_id: '7001'});
    f.behaviour.extras = {viewability_postbid_partner: 'UNSET'};
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    // A create that names no pixel reads no pixel list, as before.
    const plain = await f.prepared(lead({ad_name: 'No pixel'}), {}, create);
    assert.equal(pathsOf(plain).includes('/v1.3/pixel/list/'), false);
    assert.equal(plain.data.creative_impact.tracking_pixel, undefined);
  } finally {
    f.store.close();
  }
});

test('the ad group decides: a pixel of its own must match the ad pixel, "0" or none accepts any, for an edit and a create', async () => {
  const f = editsFixture();
  try {
    // Ad group 311 has the pixel 7002.
    const other = await f.prepare(pixelEdit('5211', '7001'));
    assertRefused(other, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(other.error.details.field, field);
    assert.match(other.error.message, /Ad group 311 .*7002.*must match/);
    assert.equal((await f.prepare(pixelEdit('5211', '7002'))).success, true);
    const create311 = await f.prepare(lead({adgroup_id: '311'}, tracking({tracking_pixel_id: '7001'})), {}, create);
    assertRefused(create311, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(create311.error.details.field, field);
    // Ad group 312 reads the pixel "0", and 310 none at all: both accept any pixel the advertiser has.
    for (const group of ['312', '310'])
      assert.equal(
        (await f.prepare(lead({adgroup_id: group}, tracking({tracking_pixel_id: '7001'})), {}, create)).success,
        true,
        group,
      );
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a pixel the list does not return is STATE_TARGET_MISMATCH, an unbound one is refused, and a shared one is accepted and reported', async () => {
  const f = editsFixture();
  try {
    assertRefused(await f.prepare(pixelEdit('5200', '7009')), 'STATE_TARGET_MISMATCH', {writes: () => f.writes.length});
    const unbound = await f.prepare(pixelEdit('5200', '7006'));
    assertRefused(unbound, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(unbound.error.details.field, field);
    assert.match(unbound.error.message, /Pixel 7006 has been unbound/);
    const shared = await f.prepared(pixelEdit('5200', '7005'));
    assert.deepEqual(shared.data.creative_impact.tracking_pixel, {
      pixel_id: '7005',
      name: 'Agency pixel',
      owned: false,
    });
    assertRefused(
      await f.prepare(lead({}, tracking({tracking_pixel_id: '7009'})), {}, create),
      'STATE_TARGET_MISMATCH',
    );
    assertRefused(
      await f.prepare(lead({}, tracking({tracking_pixel_id: '7006'})), {}, create),
      'INVALID_TIKTOK_SMART_PLUS_AD',
    );
    // The pixel is read again at execution: unbound since the review, it is refused and nothing is sent.
    f.pixels[7005].asset_ownership.asset_relation_status = 'UNBOUND';
    assertRefused(await f.execute(shared.data.review_id), ['INVALID_TIKTOK_SMART_PLUS_AD', 'STATE_CHANGED'], {
      writes: () => f.writes.length,
    });
  } finally {
    f.store.close();
  }
});

test('every tracking_info key but the pixel is refused with its own field, before any request; so is a pixel that is no ID', async () => {
  const f = editsFixture();
  try {
    // The nine keys of TikTok's update page (and the two more of its create page): none of them is qualified.
    const unqualified = {
      viewability_postbid_partner: 'DOUBLE_VERIFY',
      viewability_vast_url: 'https://track.example.test/v.xml',
      brand_safety_postbid_partner: 'IAS',
      brand_safety_vast_url: 'https://track.example.test/b.xml',
      impression_tracking_url: 'https://track.example.test/i',
      click_tracking_url: 'https://track.example.test/c',
      tracking_app_id: '5000',
      tracking_offline_event_set_ids: ['6000'],
      tracking_message_event_set_id: '6001',
      app_tracking_info_list: [{app_type: 'APP_ANDROID', app_id: '5000'}],
      surprise: 'x',
    };
    for (const [name, value] of Object.entries(unqualified)) {
      const r = await f.prepare(pixelEdit('5200', '7001', tracking({[name]: value, tracking_pixel_id: '7001'})));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.tracking_info.' + name, name);
      const created = await f.prepare(lead({}, tracking({[name]: value})), {}, create);
      assertRefused(created, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(created.error.details.field, 'ad_configuration.tracking_info.' + name, name);
    }
    for (const [name, info, expected] of [
      ['a list', ['7001'], 'ad_configuration.tracking_info'],
      ['text', 'on', 'ad_configuration.tracking_info'],
      ['null', null, 'ad_configuration.tracking_info'],
      ['a number', {tracking_pixel_id: 7001}, field],
      ['a code', {tracking_pixel_id: 'C7001'}, field],
      ['a leading zero', {tracking_pixel_id: '07001'}, field],
      ['empty', {tracking_pixel_id: ''}, field],
      ['null pixel', {tracking_pixel_id: null}, field],
      ['a list of pixels', {tracking_pixel_id: ['7001']}, field],
    ]) {
      const r = await f.prepare({smart_plus_ad_id: '5200', ad_configuration: config({tracking_info: info})});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, expected, name);
    }
    assert.equal(f.requests.length, 0, 'every one was refused before any request');
    // TikTok's read-back default of the partner, and "0", are accepted, so that a configuration copied from a read passes.
    const copied = await f.prepare({
      smart_plus_ad_id: '5200',
      ad_configuration: config(tracking({brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'})),
    });
    assert.equal(copied.success, true, JSON.stringify(copied.error ?? copied.data).slice(0, 400));
  } finally {
    f.store.close();
  }
});

test('an ad group that is not an Instant Form lead group refuses an edit of the pixel, naming the documented scenarios', async () => {
  const f = editsFixture();
  try {
    // 5213 is in a lead group that sends people to an external website, 5300 in an app install group.
    for (const id of ['5213', '5300']) {
      // A website ad restates its UTM parameters, as every edit of its configuration must.
      const r = await f.prepare(
        pixelEdit(id, '7001', id === '5300' ? {utm_params: [{key: 'utm_source', value: 'tiktok'}]} : {}),
      );
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, id);
      assert.match(r.error.message, /app promotion.*Instant Form lead generation/, id);
    }
    // The Spark-only check of the edit contract stays: an uploaded-video ad can only be renamed (QUESTIONS L14).
    const upload = await f.prepare(pixelEdit('5102', '7001'));
    assertRefused(upload, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(upload.error.message, /only its name can be edited/);
    // A lead ad whose read carries no landing page list at all is an Instant Form ad too (it must not crash the review).
    assert.equal((await f.prepare(pixelEdit('5201', '7001'))).success, true);
  } finally {
    f.store.close();
  }
});

test('a website ad takes no pixel of its own at creation: the pixel is its ad group’s; "0" is still accepted', async () => {
  const f = editsFixture();
  try {
    const r = await f.prepare(website({}, tracking({tracking_pixel_id: '7001'})), {}, create);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, field);
    assert.match(r.error.message, /its pixel is the ad group’s/);
    const none = await f.prepare(
      website({}, tracking({brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'})),
      {},
      create,
    );
    assert.equal(none.success, true, JSON.stringify(none.error ?? none.data).slice(0, 400));
  } finally {
    f.store.close();
  }
});

test('an edit never drops the pixel an ad has: refused at review, and again at execution when the pixel appeared after it', async () => {
  const f = editsFixture();
  try {
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    const dropped = await f.prepare({smart_plus_ad_id: '5200', ad_configuration: config()});
    assertRefused(dropped, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(dropped.error.details.field, 'ad_configuration.tracking_info');
    assert.match(dropped.error.message, /^Restate tracking_info: ad 5200 has a tracking pixel/);
    // Naming no pixel, or "0", would clear it as well; naming a pixel (the same or another) is an edit of it.
    for (const info of [{}, {tracking_pixel_id: '0'}, {brand_safety_postbid_partner: 'UNSET'}]) {
      const r = await f.prepare({smart_plus_ad_id: '5200', ad_configuration: config(tracking(info))});
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.tracking_info', JSON.stringify(info));
    }
    assert.equal((await f.prepare(pixelEdit('5200', '7001'))).success, true);
    assert.equal((await f.prepare(pixelEdit('5200', '7002'))).success, true);
    // "0" reads as no pixel: an ad with none may restate its configuration without tracking_info, or with "0".
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '0';
    const free = await f.prepared({smart_plus_ad_id: '5200', ad_configuration: config()});
    assert.equal((await f.prepare(pixelEdit('5200', '0'))).success, true);
    // A pixel attached after the review: the guard refuses at execution, before the change of state is even compared.
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    assertRefused(await f.execute(free.data.review_id), 'INVALID_TIKTOK_SMART_PLUS_AD', {
      writes: () => f.writes.length,
    });
  } finally {
    f.store.close();
  }
});

test('property: no edit AMCP sends lacks a pixel the ad has, whether TikTok merges or replaces the keys it is not sent', async () => {
  const currents = [undefined, '0', '7001', '7002'],
    edits = {
      omitted: undefined,
      'empty tracking_info': {},
      'no pixel named': {brand_safety_postbid_partner: 'UNSET'},
      'pixel 0': {tracking_pixel_id: '0'},
      'pixel 7001': {tracking_pixel_id: '7001'},
      'pixel 7002': {tracking_pixel_id: '7002'},
    };
  let sent = 0,
    refused = 0;
  for (const update of ['merge', 'replace'])
    for (const current of currents)
      for (const [name, info] of Object.entries(edits)) {
        const f = editsFixture();
        try {
          f.behaviour.update = update;
          if (current === undefined) delete f.ads[5200].ad_configuration.tracking_info;
          else f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = current;
          const had = current !== undefined && current !== '0',
            label = update + ' / current ' + current + ' / ' + name;
          const p = await f.prepare({
            smart_plus_ad_id: '5200',
            ad_configuration: config(info === undefined ? {} : tracking(info)),
          });
          if (!p.success) {
            assertRefused(p, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
            refused++;
            continue;
          }
          assert.equal((await f.execute(p.data.review_id)).success, true, label);
          sent++;
          const pixel = f.writes[0].ad_configuration.tracking_info?.tracking_pixel_id;
          if (had) assert.ok(pixel !== undefined && pixel !== '0', 'the edit sent no pixel: ' + label);
          const now = f.ads[5200].ad_configuration.tracking_info?.tracking_pixel_id;
          if (had) assert.ok(now !== undefined && now !== '0', 'the ad lost its pixel: ' + label);
          assert.equal((await f.verify(p.data.review_id)).data.status, 'verified', label);
        } finally {
          f.store.close();
        }
      }
  // Every edit of an ad with a pixel that leaves it out is refused (2 worlds x 2 pixels x 4 edits); the other 32 are sent.
  assert.deepEqual([refused, sent], [16, 32]);
});

test('inspect of a pixel edit makes no request, and says the contract supports it', async () => {
  const f = editsFixture();
  try {
    const r = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(pixelEdit('5200', '7001')),
    });
    assert.equal(r.data.review_contract_supported, true, JSON.stringify(r).slice(0, 400));
    const bad = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(pixelEdit('5200', 'C7001')),
    });
    assert.equal(bad.data.review_contract_supported, false);
    assert.equal(bad.data.error.code, 'INVALID_TIKTOK_SMART_PLUS_AD');
    assert.equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

test('an Instant Form ad is edited by its name and its configuration only: not its posts, not a landing page, and no UTM parameters', async () => {
  const f = editsFixture();
  try {
    for (const [name, payload, message] of [
      [
        'posts',
        {smart_plus_ad_id: '5200', creative_list: [post('9001'), post('9003')]},
        /collects leads with an Instant Form/,
      ],
      [
        'a landing page',
        {smart_plus_ad_id: '5200', landing_page_url_list: [{landing_page_url: 'https://shop.example.test/'}]},
        /collects leads with an Instant Form/,
      ],
      [
        'UTM parameters',
        {smart_plus_ad_id: '5200', ad_configuration: config({utm_params: [{key: 'utm_source', value: 'tiktok'}]})},
        /Instant Form ads have no landing page/,
      ],
    ]) {
      const r = await f.prepare(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.match(r.error.message, message, name);
    }
    const renamed = await f.prepared({smart_plus_ad_id: '5200', ad_name: 'Renamed lead spark'});
    assert.equal((await f.execute(renamed.data.review_id)).success, true);
    assert.equal((await f.verify(renamed.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('a pixel edit that restates brand_safety_postbid_partner is no spend change, and the contract still refuses every field that would be', async () => {
  const f = editsFixture();
  try {
    // "postbid" is no bid: TikTok returns the partner with every ad, and the field-name match for spend (src/spend-effects.ts) read it
    // as one, asking a measurement edit for spend_change_confirmed. The family is exempt from that match because its contract admits
    // no budget, bid, schedule or status field at all, which is what the loop below pins.
    const p = await f.prepared({
      smart_plus_ad_id: '5200',
      ad_configuration: config(tracking({brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '7001'})),
    });
    assert.equal(p.data.creative_impact.may_affect_serving, false);
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x.error ?? x.data).slice(0, 400));
    assert.equal(f.writes.length, 1);
    for (const [name, payload, expected] of [
      ['budget', {smart_plus_ad_id: '5200', budget: 100}, 'budget'],
      ['bid', {smart_plus_ad_id: '5200', bid_price: 2}, 'bid_price'],
      ['conversion bid', {smart_plus_ad_id: '5200', conversion_bid_price: 2}, 'conversion_bid_price'],
      ['end time', {smart_plus_ad_id: '5200', schedule_end_time: '2030-01-01 00:00:00'}, 'schedule_end_time'],
      ['dayparting', {smart_plus_ad_id: '5200', dayparting: '1'.repeat(336)}, 'dayparting'],
      ['status', {smart_plus_ad_id: '5200', operation_status: 'ENABLE'}, 'operation_status'],
      [
        'a budget in the configuration',
        {smart_plus_ad_id: '5200', ad_configuration: config({budget: 5})},
        'ad_configuration.budget',
      ],
      [
        'a bid in the tracking',
        {smart_plus_ad_id: '5200', ad_configuration: config(tracking({tracking_pixel_id: '7001', bid_price: 5}))},
        'ad_configuration.tracking_info.bid_price',
      ],
    ]) {
      const r = await f.prepare(payload);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - 1});
      assert.equal(r.error.details.field, expected, name);
    }
  } finally {
    f.store.close();
  }
});
