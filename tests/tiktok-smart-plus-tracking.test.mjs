import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {editsFixture, post, config, gateway, TIKTOK} from './fixtures/tiktok-smart-plus-edits.mjs';
import {tiktokSmartPlusAdProjection} from '../dist/src/tiktok-smart-plus-ads.js';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {spendConfirmationError} from '../dist/src/preflight.js';

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
const fieldsOf = r => r.error.details.violations.map(v => v.field);

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
    // The Spark-only check of the edit contract stays: an uploaded-video ad under a custom identity can only be renamed (QUESTIONS L14;
    // since r25-m4b-smartpush an upload under a TikTok account is an ad of uploads, which is edited).
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

test('"none" reads the same however TikTok writes it: restating "0" verifies when the read-back says null or 0, and a pixel read as a number is the pixel sent', async () => {
  for (const [none, name] of [
    [null, 'null'],
    [0, 'the number 0'],
    ['0', 'the text "0"'],
  ]) {
    const f = editsFixture();
    try {
      const p = await f.prepared({
        smart_plus_ad_id: '5200',
        ad_configuration: config(tracking({tracking_pixel_id: '0'})),
      });
      assert.equal((await f.execute(p.data.review_id)).success, true, name);
      f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = none;
      assert.equal((await f.verify(p.data.review_id)).data.status, 'verified', name);
    } finally {
      f.store.close();
    }
  }
  const f = editsFixture();
  try {
    const p = await f.prepared(pixelEdit('5200', '7001'));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = 7001;
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified', 'a pixel read as a number');
  } finally {
    f.store.close();
  }
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

// S3-6 (the lead's review): the exemption of the ad edit family from the field-name match for spend (src/spend-effects.ts) was total, so a later
// package that added a key named for a budget, a bid or spend to the contract would have passed both gates with no test failing. It is for the one
// name it was made for, brand_safety_postbid_partner ("postbid" is no bid): it holds only for a plan that carries that key and no other budget,
// bid or spend name; any other name asks for spend_change_confirmed, as for every other family, and a plan without the key is judged by the whole
// rule. The plans below are synthetic, built over compiled ones: the contract would refuse most of these keys before this rule is asked.
const spendPlan = payload =>
  new Compiler(new Registry()).compile(
    gateway,
    {action: 'tiktok_smart_plus_ad_update', account_id: '123', payload, dry_run: true},
    {mode: 'strict', flags: {}},
  );
/** `plan` with `value` set at `path` of its body. */
const over = (plan, path, value) => {
  const body = structuredClone(plan.body);
  let at = body;
  for (const key of path.slice(0, -1)) at = at[key];
  at[path.at(-1)] = value;
  return {...plan, body};
};

test('S3-6: the exemption from the spend field-name match is for brand_safety_postbid_partner alone: any other budget, bid or spend name in the plan still asks', () => {
  const plan = spendPlan({
    smart_plus_ad_id: '5200',
    ad_configuration: config(tracking({brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '7001'})),
  });
  assert.equal(spendConfirmationError(plan), undefined, 'the one name it is for asks for nothing');
  for (const [name, synthetic] of [
    ['a bid in the configuration', over(plan, ['ad_configuration', 'bid_price'], 5)],
    ['a bid in the tracking', over(plan, ['ad_configuration', 'tracking_info', 'bid_price'], 5)],
    ['a conversion bid at the top', over(plan, ['conversion_bid_price'], 5)],
    ['a budget at the top', over(plan, ['budget'], 100)],
    ['a budget in the configuration', over(plan, ['ad_configuration', 'daily_budget'], 100)],
    ['a spend name', over(plan, ['ad_configuration', 'spend_limit'], 100)],
    [
      'a bid beside the partner',
      over(plan, ['ad_configuration', 'tracking_info', 'viewability_postbid_partner'], 'IAS'),
    ],
  ]) {
    const refusal = spendConfirmationError(synthetic);
    assert.ok(refusal, name + ' asks for the confirmation');
    assertRefused(refusal, 'SPEND_CONFIRMATION_REQUIRED', {message: /spend_change_confirmed/});
  }
  // A plan that carries no partner is judged by the whole rule, as for every family: a rename asks for nothing, a name or an active status asks.
  const plain = spendPlan({smart_plus_ad_id: '5200', ad_name: 'Renamed'});
  assert.equal(spendConfirmationError(plain), undefined);
  for (const [name, synthetic] of [
    ['a bid', over(plain, ['bid_price'], 5)],
    ['an active status', over(plain, ['operation_status'], 'ENABLE')],
  ])
    assertRefused(spendConfirmationError(synthetic), 'SPEND_CONFIRMATION_REQUIRED', {
      message: /spend_change_confirmed/,
    });
});

test('S3-6: the words the family’s exemption reads as a spend name are the words of the spend rule', () => {
  // The family cannot import src/spend-effects.ts (it imports the family registry: the architecture ratchet refuses the cycle), so it holds a
  // copy of the words; this keeps the two the same, so that the rule cannot widen without the exemption widening with it.
  const words = file =>
    /const spendWords = (\/[^/\n]+\/i);/.exec(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'))?.[1];
  assert.equal(words('spend-effects.ts'), '/budget|bid|spend/i');
  assert.equal(words('tiktok-smart-plus-ad-updates.ts'), words('spend-effects.ts'));
});

// ---- A website ad's pixel (M4 LV-20 (b), settled 2026-11-21; r25-field3-livefix, item 4) ---------------------------------------------------------------
// TikTok applies an ad-level pixel only to Instant Form lead ads and app promotion ads. The live check LV-20 (b) sent a pixel edit of a website Smart+ ad
// as a probe (r25-m4-smartedits, QUESTIONS L19): TikTok answered code 0 and kept "0", and only the read-back caught it. An edit that names a pixel for a
// website ad is now refused before any write, with the sentence below; the Instant Form ad's pixel is the documented scenario and is not.
const websiteSentence =
  /^TikTok applies an ad-level pixel only to Instant Form lead ads and app promotion ads: on a website ad it accepts tracking_pixel_id and keeps "0"/;
/** A website ad restates its UTM parameters, as every edit of its configuration must. */
const websiteEdit = (id, pixel) => pixelEdit(id, pixel, {utm_params: [{key: 'utm_source', value: 'tiktok'}]});

test('an edit that names a pixel for a website ad is refused before any write, with the sentence that TikTok applies an ad-level pixel only to Instant Form and app ads, and the Instant Form ad is not refused', async () => {
  const f = editsFixture();
  try {
    // 5101 is in a CONVERT ad group with a pixel of its own, 5100 in a CLICK one with none: both are website ads.
    for (const [id, pixel] of [
      ['5101', '7001'],
      ['5100', '7001'],
      ['5100', '7002'],
    ]) {
      const r = await f.prepare(websiteEdit(id, pixel));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, field, id + ' ' + pixel);
      assert.match(r.error.message, websiteSentence, id + ' ' + pixel);
      assert.match(r.error.message, /set pixel_id on a CONVERT ad group\. Nothing was sent/, id + ' ' + pixel);
    }
    assert.equal(f.writes.length, 0, 'no write was sent');
    // The Instant Form case is the documented one: it prepares, and its review carries no note.
    const form = await f.prepared(pixelEdit('5200', '7001'));
    assert.equal(form.data.creative_impact.note, undefined);
    assert.deepEqual(form.data.creative_impact.tracking_pixel, {pixel_id: '7001', name: 'Site pixel', owned: true});
    // An edit of a website ad that names no pixel is not touched by the rule.
    assert.equal((await f.prepared({smart_plus_ad_id: '5101', ad_name: 'Renamed'})).success, true);
  } finally {
    f.store.close();
  }
});

test('the refusal is made before TikTok is asked, whatever TikTok would answer: a fixture that stores, drops or refuses the pixel is never reached', async () => {
  for (const behaviour of ['stored', 'dropped', 'refused']) {
    const f = editsFixture();
    try {
      f.behaviour.pixel = behaviour;
      assertRefused(await f.prepare(websiteEdit('5101', '7001')), 'INVALID_TIKTOK_SMART_PLUS_AD', {
        writes: () => f.writes.length,
      });
      assert.equal(f.writes.length, 0, behaviour);
    } finally {
      f.store.close();
    }
  }
});

test('a website ad group of a catalog campaign keeps the refusal it had, a created website ad with a pixel is refused as before, and a pixel the list does not return keeps its own refusal', async () => {
  const f = editsFixture();
  try {
    // An ad group of a catalog campaign (305) is not a qualified website ad group: the sentence that names the documented scenarios.
    const catalog = await f.prepare(websiteEdit('5305', '7001'));
    assertRefused(catalog, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(catalog.error.message, /app promotion ads and for Instant Form lead generation ads/);
    // A website ad created with a pixel of its own is refused, as before (the pixel is its ad group's).
    assertRefused(
      await f.prepare(website({}, tracking({tracking_pixel_id: '7001'})), {}, create),
      'INVALID_TIKTOK_SMART_PLUS_AD',
      {writes: () => f.writes.length},
    );
    // The pixel list is read, so a pixel that is not returned is refused by the state check itself, as it was.
    assertRefused(await f.prepare(websiteEdit('5100', '7009')), 'STATE_TARGET_MISMATCH');
  } finally {
    f.store.close();
  }
});

// The lead's review of this package (S3-2) and the lead's decision: a website ad that already holds a pixel (one attached in TikTok's UI, as the White Friday ad had one)
// must keep its configuration editable. A `tracking_pixel_id` equal to the pixel the ad holds is a restatement, not a pixel edit: it is accepted (the pixel list is still
// read and checked, the ad group's pixel is not asked, since the ad's is not its ad group's), and the read-back must still show it. Any other pixel is refused with the
// sentence above, and leaving the held pixel out is refused as before.
test('a website ad that already holds a pixel stays editable: restating the pixel it holds is accepted, leaving it out and naming another are refused', async () => {
  const f = editsFixture();
  try {
    // A pixel attached in TikTok's UI: 7002, which is not its ad group's (the group 300 has 7001).
    f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id = '7002';
    const left = await f.prepare({
      smart_plus_ad_id: '5101',
      ad_configuration: config({utm_params: [{key: 'utm_source', value: 'tiktok'}]}),
    });
    assertRefused(left, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(left.error.message, /could clear it/);
    // Another pixel, even its ad group's own, is a pixel edit of a website ad.
    const other = await f.prepare(websiteEdit('5101', '7001'));
    assertRefused(other, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(other.error.message, websiteSentence);
    // The pixel it holds, restated unchanged: accepted, and the review says so.
    const p = await f.prepared(websiteEdit('5101', '7002'));
    assert.deepEqual(p.data.creative_impact.tracking_pixel, {
      pixel_id: '7002',
      name: 'Second pixel',
      owned: true,
      restated_unchanged: true,
      meaning: restatedMeaning,
    });
    assert.equal(f.writes.length, 0, 'nothing is sent by the prepare');
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x));
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].ad_configuration.tracking_info, {tracking_pixel_id: '7002'});
    const v = await f.verify(p.data.review_id);
    assert.equal(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id, '7002');
  } finally {
    f.store.close();
  }
});

const restatedMeaning =
  'The ad already holds this pixel, and the edit restates it unchanged. TikTok keeps "0" on a website ad when a pixel is sent to it, so the read-back must still show this pixel: a read-back that shows "0" is never reported as a success.';

test('a restated pixel that TikTok does not keep is never reported as a success: the read-back must still show the pixel the ad held', async () => {
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id = '7002';
    f.behaviour.pixel = 'dropped';
    const p = await f.prepared(websiteEdit('5101', '7002'));
    const x = await f.execute(p.data.review_id);
    assert.equal(x.success, true, JSON.stringify(x));
    // The write was accepted and the ad now reads "0": the verification names the pixel as the field that disagrees, and is not `verified`.
    const v = await f.verify(p.data.review_id);
    assert.notEqual(v.data.status, 'verified', JSON.stringify(v));
    assert.equal(v.data.status, 'inconclusive', JSON.stringify(v));
    assert.deepEqual(v.data.checks[0].changed_fields, ['/ad_configuration/tracking_info/tracking_pixel_id']);
    assert.equal(f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id, '0');
  } finally {
    f.store.close();
  }
});

test('a restated pixel is still checked against the pixel list, and a pixel that is not the held one is refused whoever holds what: the ad that holds none, a catalog ad group, an unbound or unlisted pixel', async () => {
  // The held pixel is read from the list like any named pixel: one the advertiser no longer has is refused, whether it is unlisted or unbound.
  for (const [held, code, message] of [
    ['7006', 'INVALID_TIKTOK_SMART_PLUS_AD', /Pixel 7006 has been unbound/],
    ['7009', 'STATE_TARGET_MISMATCH', /State read did not return every exact requested target/],
  ]) {
    const f = editsFixture();
    try {
      f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id = held;
      const r = await f.prepare(websiteEdit('5101', held));
      assertRefused(r, code, {writes: () => f.writes.length});
      assert.match(r.error.message, message, held);
    } finally {
      f.store.close();
    }
  }
  // An ad that holds none ("0") names a new pixel: refused. A catalog ad group's ad keeps its refusal even for the pixel it holds.
  const g = editsFixture();
  try {
    assertRefused(await g.prepare(websiteEdit('5101', '7002')), 'INVALID_TIKTOK_SMART_PLUS_AD', {
      writes: () => g.writes.length,
    });
    g.ads[5305].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    const catalog = await g.prepare(websiteEdit('5305', '7001'));
    assertRefused(catalog, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => g.writes.length});
    assert.match(catalog.error.message, /app promotion ads and for Instant Form lead generation ads/);
  } finally {
    g.store.close();
  }
});

// ---- The ad_configuration patch (QUESTIONS L4 (a)) -----------------------------------------------------------------------------------
// A new payload field of tiktok_smart_plus_ad_update, ad_configuration_patch, holds any subset of the qualified keys. TikTok documents the
// update as incremental and says nothing of whether the keys of ad_configuration are merged or replaced, so AMCP never sends a partial
// configuration: it merges the patch into the ad's current configuration at prepare and hands the whole configuration back in
// details.fix, with the call that prepares it (details.next_call). The second prepare is an ordinary full edit.
const merge = patch => ({smart_plus_ad_id: '5101', ad_configuration_patch: patch});
/** What AMCP merges from ad 5101 as the fixture reads it: the keys of the read, nothing added. */
const as5101 = (extra = {}) => ({
  call_to_action_id: '700',
  creative_auto_add_toggle: false,
  creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
  utm_params: [{key: 'utm_source', value: 'tiktok'}],
  tracking_info: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'},
  product_specific_type: 'UNSET',
  dark_post_status: 'ON',
  ...extra,
});
/** The call a refusal with details.fix hands back, made on the connection of the first one (the hook is given none). */
const nextCall = (f, r) =>
  f.call(r.error.details.next_call.tool, {...r.error.details.next_call.arguments, connection_id: TIKTOK});
const patchField = 'ad_configuration_patch';

test('a patch of only tracking_info that names a pixel for a website ad is refused as the edit it becomes is, with nothing handed back and nothing sent', async () => {
  const f = editsFixture();
  try {
    const r = await f.prepare(merge({tracking_info: {tracking_pixel_id: '7001'}}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, field);
    assert.match(r.error.message, websiteSentence);
    assert.equal(r.error.details.fix, undefined, 'nothing is handed back that its next call would refuse');
    assert.equal(f.writes.length, 0);
    // The patch of an Instant Form ad that names a pixel is merged and handed back (the test of the Instant Form patch below).
  } finally {
    f.store.close();
  }
});
// S3-5 and S4-6 (the lead's review): details.fix is not recover_step's patch (whose pointers start at a step's arguments and name fields the step
// already has, and whose null sets the field), as the comment of the hand-back said. Its pointers are into the payload of this edit, for a caller
// that applies them itself, and the answer says so; next_call says what it leaves out (the options of the call) and how a plan step is corrected.
test('S3-5: the fix names its frame, applying it to the payload gives the payload of the next call, and next_call says what it leaves out', async () => {
  const f = editsFixture();
  try {
    const payload = {
      smart_plus_ad_id: '5200',
      ad_name: 'Renamed',
      ad_configuration_patch: {tracking_info: {tracking_pixel_id: '7001'}},
    };
    const r = await f.prepare(payload);
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    const d = r.error.details;
    assert.equal(d.fix_base, 'payload');
    // The caller sets each field a pointer names, and a null value removes it: the result is the payload of the next call.
    const applied = structuredClone(payload);
    for (const {path, value} of d.fix) {
      assert.match(path, /^\/[a-z_]+$/, 'a pointer to a field of the payload, not of a step');
      if (value === null) delete applied[path.slice(1)];
      else applied[path.slice(1)] = value;
    }
    assert.deepEqual(applied, d.next_call.arguments.arguments.payload);
    const meaning = d.next_call.meaning;
    for (const part of [
      /as an amcp_write prepare/,
      /none of the options of this call/,
      /connection_id/,
      /creative_edit_confirmed/,
      /details\.fix_base/,
      /not a recover_step patch/,
      /recover_step with arguments equal to next_call\.arguments\.arguments/,
    ])
      assert.match(meaning, part);
  } finally {
    f.store.close();
  }
});

test('the patch of an Instant Form ad is merged the same way, and the other fields of the call go on to the next call', async () => {
  const f = editsFixture();
  try {
    const r = await f.prepare({
      smart_plus_ad_id: '5200',
      ad_name: 'Renamed lead spark',
      ad_configuration_patch: {tracking_info: {tracking_pixel_id: '7001'}},
    });
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    const merged = {
      call_to_action_id: '700',
      creative_auto_add_toggle: false,
      creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
      tracking_info: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '7001'},
      product_specific_type: 'UNSET',
      dark_post_status: 'ON',
    };
    assert.deepEqual(r.error.details.fix[0], {path: '/ad_configuration', value: merged});
    assert.deepEqual(r.error.details.next_call.arguments.arguments.payload, {
      smart_plus_ad_id: '5200',
      ad_name: 'Renamed lead spark',
      ad_configuration: merged,
    });
    const p = await nextCall(f, r);
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 500));
    assert.equal(p.data.creative_impact.note, undefined, 'the documented case');
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('the patch reads the same pixel and ad group as the edit would, so a fix is never handed back that the edit would refuse', async () => {
  const f = editsFixture();
  try {
    assert.deepEqual(
      (
        await f.prepare({
          smart_plus_ad_id: '5211',
          ad_configuration_patch: {tracking_info: {tracking_pixel_id: '7001'}},
        })
      ).error.details.field,
      field,
      'the ad group 311 has the pixel 7002',
    );
    for (const [id, pixel, code] of [
      ['5213', '7001', 'INVALID_TIKTOK_SMART_PLUS_AD'],
      ['5200', '7006', 'INVALID_TIKTOK_SMART_PLUS_AD'],
      ['5200', '7009', 'STATE_TARGET_MISMATCH'],
    ])
      assertRefused(
        await f.prepare({smart_plus_ad_id: id, ad_configuration_patch: {tracking_info: {tracking_pixel_id: pixel}}}),
        code,
        {writes: () => f.writes.length},
      );
    // A patch that names no pixel reads no pixel list and no ad group.
    const before = f.requests.length;
    const free = await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(free.error.details.field, patchField);
    assert.equal(
      f.requests.slice(before).some(r => r.includes('/pixel/list/') || r.includes('/adgroup/get/')),
      false,
    );
    assert.equal(free.error.details.fix[0].value.creative_auto_add_toggle, true);
  } finally {
    f.store.close();
  }
});

// S3-1 (the lead's review, probe P1): a patch carries the pixel and the CTA the ad holds, so the whole edit that is its next call judges
// both, against the pixel list, the ad's ad group and the CTA portfolio. The review read none of them for a patch that names neither, and a
// patch was handed back whose next call was refused. The reads follow the ad now, and the patch is refused with the edit's own sentence.
const heldPixels = [
  ['5213', '7001', 'INVALID_TIKTOK_SMART_PLUS_AD', /app promotion ads and for Instant Form lead generation ads/],
  ['5300', '7001', 'INVALID_TIKTOK_SMART_PLUS_AD', /app promotion ads and for Instant Form lead generation ads/],
  ['5200', '7006', 'INVALID_TIKTOK_SMART_PLUS_AD', /Pixel 7006 has been unbound/],
  ['5211', '7001', 'INVALID_TIKTOK_SMART_PLUS_AD', /Ad group 311 uses pixel 7002; the ad’s pixel must match it/],
  // The pixel list does not return it: the read of the pixel is refused by the state check itself, with its own sentence.
  ['5200', '7009', 'STATE_TARGET_MISMATCH', /State read did not return every exact requested target/],
];

test('a patch over an ad that holds a pixel is refused when the edit it becomes would be, with the same sentence and nothing handed back', async () => {
  for (const [id, pixel, code, message] of heldPixels) {
    const f = editsFixture();
    try {
      f.ads[id].ad_configuration.tracking_info.tracking_pixel_id = pixel;
      const patch = await f.prepare({smart_plus_ad_id: id, ad_configuration_patch: {creative_auto_add_toggle: true}});
      assertRefused(patch, code, {writes: () => f.writes.length});
      assert.equal(patch.error.details?.fix, undefined, id + ' ' + pixel + ': nothing is handed back');
      assert.match(patch.error.message, message, id + ' ' + pixel);
      // The whole edit that restates the pixel the ad holds is the call the patch would have handed back: the same answer.
      const edit = await f.prepare({
        smart_plus_ad_id: id,
        ad_configuration: config({
          creative_auto_add_toggle: true,
          tracking_info: {tracking_pixel_id: pixel},
          ...(id === '5300' ? {utm_params: [{key: 'utm_source', value: 'tiktok'}]} : {}),
        }),
      });
      assertRefused(edit, code, {writes: () => f.writes.length});
      assert.equal(patch.error.message, edit.error.message, id + ' ' + pixel);
    } finally {
      f.store.close();
    }
  }
});

test('a patch over a website ad that holds a pixel is merged with the pixel it holds and handed back, and its next call restates it; a patch that names another pixel is refused', async () => {
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.tracking_info.tracking_pixel_id = '7002';
    // A patch of another key: the merge carries the held pixel, which is a restatement, so the whole edit is handed back (the White Friday ad's case).
    const r = await f.prepare(merge({creative_auto_add_toggle: true}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, patchField);
    assert.equal(r.error.details.fix[0].value.tracking_info.tracking_pixel_id, '7002');
    const p = await nextCall(f, r);
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 500));
    assert.equal(p.data.creative_impact.tracking_pixel.restated_unchanged, true);
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].ad_configuration.creative_auto_add_toggle, true);
    assert.equal(
      f.writes[0].ad_configuration.tracking_info.tracking_pixel_id,
      '7002',
      'the pixel it holds goes back unchanged',
    );
    // A patch that names another pixel for it is the edit of a website ad's pixel: refused with the sentence, nothing handed back.
    const other = await f.prepare(merge({tracking_info: {tracking_pixel_id: '7001'}}));
    assertRefused(other, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length - 1});
    assert.match(other.error.message, websiteSentence);
    assert.equal(other.error.details.fix, undefined);
  } finally {
    f.store.close();
  }
});

test('the pixel an ad holds is read when a patch leaves it, and the one a patch names is the only one read when it names one', async () => {
  const f = editsFixture();
  try {
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    let from = f.requests.length;
    const held = await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(held.error.details.field, patchField, 'a pixel the ad group accepts is handed back');
    assert.equal(held.error.details.fix[0].value.tracking_info.tracking_pixel_id, '7001');
    assert.deepEqual(
      f.requests.slice(from).filter(r => r.includes('/pixel/list/') || r.includes('/adgroup/get/')),
      ['GET /v1.3/pixel/list/ 7001', 'GET /v1.3/smart_plus/adgroup/get/'],
    );
    from = f.requests.length;
    await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {tracking_info: {tracking_pixel_id: '7002'}}});
    assert.deepEqual(
      f.requests.slice(from).filter(r => r.includes('/pixel/list/')),
      ['GET /v1.3/pixel/list/ 7002'],
      'the pixel the patch names, not the one the ad holds',
    );
    // An ad that holds no pixel ("0") reads neither, as before.
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '0';
    from = f.requests.length;
    await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(
      f.requests.slice(from).some(r => r.includes('/pixel/list/') || r.includes('/adgroup/get/')),
      false,
    );
  } finally {
    f.store.close();
  }
});

test('a patch that leaves the CTA is judged by the ad’s own CTA portfolio, as the whole edit that restates it is', async () => {
  const f = editsFixture();
  try {
    // A display card as the ad's own CTA, as an ad made in TikTok's UI can have.
    f.ads[5101].ad_configuration.call_to_action_id = '701';
    const patch = await f.prepare(merge({creative_auto_add_toggle: true}));
    assertRefused(patch, 'INVALID_TIKTOK_CTA_PORTFOLIO', {writes: () => f.writes.length});
    assert.equal(patch.error.details.fix, undefined);
    const edit = await f.prepare({
      smart_plus_ad_id: '5101',
      ad_configuration: config({
        call_to_action_id: '701',
        creative_auto_add_toggle: true,
        utm_params: [{key: 'utm_source', value: 'tiktok'}],
      }),
    });
    assertRefused(edit, 'INVALID_TIKTOK_CTA_PORTFOLIO', {writes: () => f.writes.length});
    assert.equal(patch.error.message, edit.error.message);
    // A patch that names a CTA is judged by that one: the ad's own card does not count against it.
    const named = await f.prepare(merge({call_to_action_id: '700'}));
    assert.equal(named.error.details.field, patchField);
    assert.equal(named.error.details.fix[0].value.call_to_action_id, '700');
  } finally {
    f.store.close();
  }
});

test('an ad an ordinary patch is handed back for is prepared by its next call: the reads of the patch and of the edit agree', async () => {
  const f = editsFixture();
  try {
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    const r = await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(r.error.details.field, patchField);
    const p = await nextCall(f, r);
    assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal(f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id, '7001');
  } finally {
    f.store.close();
  }
});

test('an ad as TikTok returns a UI-made one: the null entries of its list are dropped, and what the read leaves out must be named by the patch', async () => {
  const f = editsFixture();
  try {
    // 5400 reads no creative_auto_add_toggle and a list padded with null, and carries catalog_creative_toggle false, its documented default
    // (S3-8: "Create an Upgraded Smart+ Ad", read 2026-11-21), which is let go: only the switch the read leaves out is refused.
    const missing = await f.prepare({
      smart_plus_ad_id: '5400',
      ad_configuration_patch: {call_to_action_id: '700'},
    });
    assertRefused(missing, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(missing.error.details.violations, undefined, 'one rule, one sentence');
    assert.equal(missing.error.details.field, 'ad_configuration_patch.creative_auto_add_toggle');
    assert.match(missing.error.message, /reads no creative_auto_add_toggle/);
    // Named by the patch, it is merged, and the list loses its null entries.
    const named = await f.prepare({
      smart_plus_ad_id: '5400',
      ad_configuration_patch: {creative_auto_add_toggle: true},
    });
    assert.equal(named.error.details.field, patchField);
    assert.deepEqual(named.error.details.fix[0].value, {
      call_to_action_id: '700',
      creative_auto_add_toggle: true,
      creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY'],
      utm_params: [{key: 'utm_source', value: 'tiktok'}],
      tracking_info: {brand_safety_postbid_partner: 'UNSET', tracking_pixel_id: '0'},
      product_specific_type: 'UNSET',
      dark_post_status: 'ON',
    });
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

// S3-2 (the lead's review, probe P5): the merge drops the null entries TikTok pads the enhancement list with, so the list the next call sends has
// none, and a read-back that is padded again (as the reference ad's read was) compared unequal: a false mismatch on every UI-made ad. The
// projection both sides go through keeps the entries that are not null.
test('S3-2: a list TikTok pads with null verifies against the list that was sent, and a different entry is still a mismatch', async () => {
  const projected = tiktokSmartPlusAdProjection({
    ad_configuration: {creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', null, 'MUSIC_REFRESH', null]},
  });
  assert.deepEqual(projected.ad_configuration.creative_auto_enhancement_strategy_list, [
    'MUSIC_REFRESH',
    'VIDEO_QUALITY',
  ]);
  for (const [read, verified] of [
    [['VIDEO_QUALITY', null, null], true],
    // The padding is the only thing let go: another entry is a difference.
    [['IMAGE_QUALITY', null, null], false],
  ]) {
    const f = editsFixture();
    try {
      const r = await f.prepare({smart_plus_ad_id: '5400', ad_configuration_patch: {creative_auto_add_toggle: true}});
      assert.equal(r.error.details.field, patchField);
      assert.deepEqual(r.error.details.fix[0].value.creative_auto_enhancement_strategy_list, ['VIDEO_QUALITY']);
      const p = await nextCall(f, r);
      assert.equal(p.success, true, JSON.stringify(p.error ?? p.data).slice(0, 400));
      assert.equal((await f.execute(p.data.review_id)).success, true);
      // TikTok reads the list padded again.
      f.ads[5400].ad_configuration.creative_auto_enhancement_strategy_list = read;
      const v = await f.verify(p.data.review_id);
      if (verified) assert.equal(v.data.status, 'verified', JSON.stringify(v).slice(0, 600));
      else assert.notEqual(v.data.status, 'verified', JSON.stringify(read));
    } finally {
      f.store.close();
    }
  }
});

test('a key of the read that the merge cannot restate refuses the patch, naming it: a value other than the default, an unknown key with a value, and every empty one is let go', async () => {
  const cases = [
    ['product_specific_type ALL', c => (c.product_specific_type = 'ALL'), 'ad_configuration.product_specific_type'],
    ['dark_post_status OFF', c => (c.dark_post_status = 'OFF'), 'ad_configuration.dark_post_status'],
    [
      'a viewability partner',
      c => (c.tracking_info.viewability_postbid_partner = 'DOUBLE_VERIFY'),
      'ad_configuration.tracking_info.viewability_postbid_partner',
    ],
    [
      'a tracking URL',
      c => (c.tracking_info.click_tracking_url = 'https://track.example.test/c'),
      'ad_configuration.tracking_info.click_tracking_url',
    ],
    ['an end card call to action', c => (c.end_card_cta = {type: 'CUSTOM'}), 'ad_configuration.end_card_cta'],
    // S3-8: only a catalog toggle that is on; false is its documented default.
    [
      'catalog_creative_toggle true',
      c => (c.catalog_creative_toggle = true),
      'ad_configuration.catalog_creative_toggle',
    ],
  ];
  for (const [name, change, expected] of cases) {
    const f = editsFixture();
    try {
      change(f.ads[5101].ad_configuration);
      const r = await f.prepare(merge({tracking_info: {tracking_pixel_id: '7001'}}));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, expected, name);
      assert.equal(r.error.details.fix, undefined, name + ': nothing to send is handed back');
    } finally {
      f.store.close();
    }
  }
  // Keys that read as not set are let go: nothing is lost by a configuration that leaves them out. A catalog toggle that reads false
  // is not set either (S3-8): it is TikTok's default, and it is valid only with a catalog campaign, so it is not carried.
  const f = editsFixture();
  try {
    Object.assign(f.ads[5101].ad_configuration, {
      end_card_cta: {},
      deeplink_utm_params: [],
      auto_disclaimer_types: [],
      note: null,
      label: '',
      catalog_creative_toggle: false,
    });
    Object.assign(f.ads[5101].ad_configuration.tracking_info, {
      viewability_postbid_partner: 'UNSET',
      impression_tracking_url: '',
    });
    const r = await f.prepare(merge({creative_auto_add_toggle: true}));
    assert.equal(r.error.details.field, patchField, JSON.stringify(r.error).slice(0, 400));
    assert.deepEqual(r.error.details.fix[0].value, as5101({creative_auto_add_toggle: true}));
  } finally {
    f.store.close();
  }
});

test('the merged configuration never drops utm_params or a pixel the ad has, and a patch cannot clear one', async () => {
  const f = editsFixture();
  try {
    const toggled = await f.prepare(merge({creative_auto_add_toggle: true}));
    assert.deepEqual(toggled.error.details.fix[0].value, as5101({creative_auto_add_toggle: true}));
    f.ads[5200].ad_configuration.tracking_info.tracking_pixel_id = '7001';
    const kept = await f.prepare({smart_plus_ad_id: '5200', ad_configuration_patch: {creative_auto_add_toggle: true}});
    assert.equal(kept.error.details.fix[0].value.tracking_info.tracking_pixel_id, '7001');
    // A patch that names "0" over a pixel would clear it: refused, as a restated configuration without it is.
    const cleared = await f.prepare({
      smart_plus_ad_id: '5200',
      ad_configuration_patch: {tracking_info: {tracking_pixel_id: '0'}},
    });
    assertRefused(cleared, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(cleared.error.details.field, 'ad_configuration.tracking_info');
    assert.equal(cleared.error.details.fix, undefined);
    // Another pixel is an edit of it, and is merged.
    const other = await f.prepare({
      smart_plus_ad_id: '5200',
      ad_configuration_patch: {tracking_info: {tracking_pixel_id: '7002'}},
    });
    assert.equal(other.error.details.fix[0].value.tracking_info.tracking_pixel_id, '7002');
    assert.equal(f.writes.length, 0);
  } finally {
    f.store.close();
  }
});

test('a patch is checked as the edit it becomes: a display card as CTA, a TRANSLATE_AND_DUB change and UTM parameters the landing page does not carry are refused', async () => {
  const f = editsFixture();
  try {
    assertRefused(await f.prepare(merge({call_to_action_id: '701'})), 'INVALID_TIKTOK_CTA_PORTFOLIO', {
      writes: () => f.writes.length,
    });
    const dub = await f.prepare(
      merge({creative_auto_enhancement_strategy_list: ['VIDEO_QUALITY', 'TRANSLATE_AND_DUB']}),
    );
    assertRefused(dub, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(dub.error.message, /TRANSLATE_AND_DUB cannot be added or removed/);
    const utm = await f.prepare(merge({utm_params: [{key: 'utm_source', value: 'other'}]}));
    assertRefused(utm, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(utm.error.message, /utm_params only record/);
    // Each patch is judged by the CTA it ends with (S3-1): the one it names (the first patch), or, when it leaves the CTA, the ad's own
    // (the two others), which the review now reads.
    assert.equal(f.requests.filter(r => r.includes('/creative/portfolio/get/')).length, 3);
    // Each rule of a patch that breaks several is listed, with the patch's own field.
    const several = await f.prepare(merge({creative_auto_add_toggle: 'yes', surprise: 1}));
    assertRefused(several, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.deepEqual(fieldsOf(several), [
      'ad_configuration_patch.surprise',
      'ad_configuration_patch.creative_auto_add_toggle',
    ]);
    // OFF is a Push's choice (r25-m4b-smartpush; it was one more violation in the list above, refused whatever the ad): a patch names no
    // creatives, so the shape cannot tell the kind of ad, and an ad of posts refuses it once the ad is read, as the configuration it becomes.
    const off = await f.prepare(merge({dark_post_status: 'OFF'}));
    assertRefused(off, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(off.error.details.field, 'ad_configuration.dark_post_status');
    assert.match(off.error.message, /Set dark_post_status to ON or leave it out/);
  } finally {
    f.store.close();
  }
});

test('a malformed patch, and a patch beside ad_configuration, are refused before any request, and so is a patch of an ad this contract only renames', async () => {
  const f = editsFixture();
  try {
    for (const [name, payload, expected] of [
      [
        'both',
        {
          smart_plus_ad_id: '5101',
          ad_configuration: config(),
          ad_configuration_patch: {creative_auto_add_toggle: true},
        },
        patchField,
      ],
      ['empty', merge({}), patchField],
      ['a list', merge([{creative_auto_add_toggle: true}]), patchField],
      ['text', merge('on'), patchField],
      ['null', merge(null), patchField],
      ['an unknown key', merge({surprise: 1}), 'ad_configuration_patch.surprise'],
      [
        'an unqualified tracking key',
        merge({tracking_info: {tracking_app_id: '5000'}}),
        'ad_configuration_patch.tracking_info.tracking_app_id',
      ],
      [
        'a pixel that is no ID',
        merge({tracking_info: {tracking_pixel_id: 'C7001'}}),
        'ad_configuration_patch.tracking_info.tracking_pixel_id',
      ],
      ['a product mode', merge({product_info_enabled: 'NON_CATALOG'}), 'ad_configuration_patch.product_info_enabled'],
      ['a CTA that is no ID', merge({call_to_action_id: 'x'}), 'ad_configuration_patch.call_to_action_id'],
      [
        'an unknown enhancement',
        merge({creative_auto_enhancement_strategy_list: ['AI_AVATAR']}),
        'ad_configuration_patch.creative_auto_enhancement_strategy_list',
      ],
    ]) {
      const r = await f.prepare(JSON.parse(JSON.stringify(payload)));
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, expected, name);
      assert.equal(r.error.details.fix, undefined, name);
    }
    assert.equal(f.requests.length, 0, 'every one was refused before any request');
    // The Spark-only check stays: an uploaded-video ad under a custom identity can only be renamed (an upload under a TikTok account is
    // edited since r25-m4b-smartpush).
    const upload = await f.prepare({
      smart_plus_ad_id: '5102',
      ad_configuration_patch: {creative_auto_add_toggle: true},
    });
    assertRefused(upload, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.match(upload.error.message, /only its name can be edited/);
    // Inspect shows the contract supports a patch, and reads nothing.
    const before = f.requests.length;
    const i = await f.call('amcp_write', {
      action: 'inspect',
      gateway,
      connection_id: TIKTOK,
      arguments: f.args(merge({creative_auto_add_toggle: true})),
    });
    assert.equal(i.data.review_contract_supported, true, JSON.stringify(i).slice(0, 400));
    assert.equal(f.requests.length, before);
  } finally {
    f.store.close();
  }
});

test('the remedy of a patch that was merged says that nothing was sent and what to do, and a refusal of one rule keeps the remedy of its code', async () => {
  const f = editsFixture();
  try {
    const merged = await f.prepare(merge({creative_auto_add_toggle: true}));
    assert.match(merged.error.next_action, /^Nothing was sent\. AMCP merged the change into the ad’s current settings/);
    assert.equal(merged.error.remedy.category, 'request');
    assert.equal(merged.error.remedy.mutation_retry_safe, false);
    const malformed = await f.prepare(merge({surprise: 1}));
    assert.match(malformed.error.next_action, /^Correct the argument the message names/);
  } finally {
    f.store.close();
  }
});

// ---- S4-1 (the lead's review of r25-field-tiktok): an edit over product information that is on ---------------------------------------
// UNSET switches product information off, so an edit that restated it over an ad whose mode is on was refused (r25-field-tiktok). An edit
// that left the key out could clear it as well, because TikTok documents the update as incremental and nothing says whether the keys of
// ad_configuration are merged or replaced: any edit of ad_configuration of an ad whose mode is defined and not UNSET is refused, whether or
// not it names the key. An ad that reads UNSET, or no mode, is edited as before.
const restated = {
  smart_plus_ad_id: '5101',
  ad_configuration: config({utm_params: [{key: 'utm_source', value: 'tiktok'}]}),
};

test('an edit that leaves out product_info_enabled is refused when the ad’s product information is on, at review and again at execution', async () => {
  for (const mode of ['NON_CATALOG', 'CATALOG']) {
    const f = editsFixture();
    try {
      f.ads[5101].ad_configuration.product_info_enabled = mode;
      const r = await f.prepare(restated);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, 'ad_configuration.product_info_enabled', mode);
      assert.match(r.error.message, new RegExp('product information on \\(' + mode + '\\)'), mode);
      // The sentence is the one the explicit UNSET has always had.
      const explicit = await f.prepare({
        ...restated,
        ad_configuration: config({...restated.ad_configuration, product_info_enabled: 'UNSET'}),
      });
      assert.equal(explicit.error.message, r.error.message);
      // The ad's mode is UNSET at review and on at execution: refused before anything is sent, whatever the state check would say.
      f.ads[5101].ad_configuration.product_info_enabled = 'UNSET';
      const p = await f.prepared(restated);
      f.ads[5101].ad_configuration.product_info_enabled = mode;
      assertRefused(await f.execute(p.data.review_id), 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    } finally {
      f.store.close();
    }
  }
});

test('an edit of an ad whose product information is UNSET, or whose read has no mode, is prepared, executed and verified as before; an edit that names no configuration is no concern of it', async () => {
  for (const mode of [undefined, 'UNSET']) {
    const f = editsFixture();
    try {
      if (mode === undefined) delete f.ads[5101].ad_configuration.product_info_enabled;
      else f.ads[5101].ad_configuration.product_info_enabled = mode;
      const p = await f.prepared(restated);
      assert.equal((await f.execute(p.data.review_id)).success, true, String(mode));
      assert.equal((await f.verify(p.data.review_id)).data.status, 'verified', String(mode));
    } finally {
      f.store.close();
    }
  }
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.product_info_enabled = 'NON_CATALOG';
    // A rename, and the posts of the ad, say nothing of its configuration.
    assert.equal((await f.prepare({smart_plus_ad_id: '5101', ad_name: 'Renamed'})).success, true);
    assert.equal(
      (await f.prepare({smart_plus_ad_id: '5101', creative_list: [post('9001'), post('9003')]})).success,
      true,
    );
  } finally {
    f.store.close();
  }
});

test('a patch of an ad whose product information is on is refused with the same sentence, and hands nothing back', async () => {
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.product_info_enabled = 'NON_CATALOG';
    const r = await f.prepare(merge({creative_auto_add_toggle: true}));
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.equal(r.error.details.field, 'ad_configuration.product_info_enabled');
    assert.match(r.error.message, /product information on \(NON_CATALOG\)/);
    assert.equal(r.error.details.fix, undefined);
  } finally {
    f.store.close();
  }
});

// ---- S2-1 (the lead's review of r25-m4-smartedits): a full edit over settings AMCP cannot restate ----------------------------------
// TikTok documents the update as incremental and says nothing of whether the keys of ad_configuration are merged or replaced, so a full
// ad_configuration that leaves out a setting of the ad could clear it. The contract cannot send most settings a read returns (the other
// values of the two defaults, the tracking URLs and partners, an end card call to action (`end_card_cta`, not the end_card_list of
// r25-m4b-endcards, which is a key of its own), a catalog toggle that is on), so an ad that holds one is not
// edited here at all, through the whole configuration or through a patch: the same sentence, at review and again at execution. Probe P2
// of the review: under replace semantics each of the six was gone after a full edit that only changed a switch. S4-5: a mode or setting
// that reads null or empty is not set, here as in the merge.
/** A full edit of one switch, leaving tracking_info and the defaults out, as a caller that restates only what it knows would. */
const switchEdit = () => ({
  smart_plus_ad_id: '5101',
  ad_configuration: config({creative_auto_add_toggle: true, utm_params: [{key: 'utm_source', value: 'tiktok'}]}),
});
const cannotRestate = [
  [
    'dark_post_status OFF',
    c => (c.dark_post_status = 'OFF'),
    'ad_configuration.dark_post_status',
    /has dark_post_status OFF, which an ad_configuration sent from here cannot restate: only ON is qualified/,
  ],
  [
    'product_specific_type ALL',
    c => (c.product_specific_type = 'ALL'),
    'ad_configuration.product_specific_type',
    /has product_specific_type ALL, which an ad_configuration sent from here cannot restate: only UNSET is qualified/,
  ],
  [
    'a click tracking URL',
    c => (c.tracking_info.click_tracking_url = 'https://track.example.test/c'),
    'ad_configuration.tracking_info.click_tracking_url',
    /has tracking_info\.click_tracking_url in its ad_configuration, and AMCP does not restate it/,
  ],
  [
    'a viewability partner',
    c => (c.tracking_info.viewability_postbid_partner = 'IAS'),
    'ad_configuration.tracking_info.viewability_postbid_partner',
    /has tracking_info\.viewability_postbid_partner in its ad_configuration/,
  ],
  [
    'catalog_creative_toggle true',
    c => (c.catalog_creative_toggle = true),
    'ad_configuration.catalog_creative_toggle',
    /has catalog_creative_toggle in its ad_configuration/,
  ],
  [
    'an end card call to action',
    c => (c.end_card_cta = {type: 'CUSTOM'}),
    'ad_configuration.end_card_cta',
    /has end_card_cta in its ad_configuration/,
  ],
];

test('a full ad_configuration edit is refused when the ad holds a setting AMCP cannot restate, and the patch gives the same answer', async () => {
  for (const [name, change, expected, message] of cannotRestate) {
    const f = editsFixture();
    try {
      change(f.ads[5101].ad_configuration);
      const r = await f.prepare(switchEdit());
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, expected, name);
      assert.match(r.error.message, message, name);
      assert.match(r.error.message, /this ad’s ad_configuration is not edited here/, name);
      assert.equal(r.error.details.fix, undefined, name + ': there is nothing to send');
      // The patch refuses the same key with the same sentence: neither route sends a configuration that could clear it.
      const patch = await f.prepare(merge({creative_auto_add_toggle: true}));
      assertRefused(patch, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(patch.error.message, r.error.message, name);
      assert.equal(patch.error.details.field, expected, name);
      // An Instant Form ad is judged by the same rule.
      change(f.ads[5200].ad_configuration);
      const lead = await f.prepare({
        smart_plus_ad_id: '5200',
        ad_configuration: config({creative_auto_add_toggle: true}),
      });
      assertRefused(lead, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(lead.error.details.field, expected, name + ' (Instant Form ad)');
    } finally {
      f.store.close();
    }
  }
});

test('the refusal is made again at execution: a setting that appeared after the review is not cleared, and nothing is sent', async () => {
  for (const [name, change, expected] of cannotRestate) {
    const f = editsFixture();
    try {
      // TikTok replaces the keys it is not sent: the harm P2 showed, which the refusal must prevent.
      f.behaviour.update = 'replace';
      const p = await f.prepared(switchEdit());
      change(f.ads[5101].ad_configuration);
      const r = await f.execute(p.data.review_id);
      assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(r.error.details.field, expected, name);
    } finally {
      f.store.close();
    }
  }
});

test('a refusal names every setting that cannot be restated, not the first alone', async () => {
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.dark_post_status = 'OFF';
    f.ads[5101].ad_configuration.tracking_info.click_tracking_url = 'https://track.example.test/c';
    f.ads[5101].ad_configuration.end_card_cta = {type: 'CUSTOM'};
    const r = await f.prepare(switchEdit());
    assertRefused(r, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
    assert.deepEqual(fieldsOf(r), [
      'ad_configuration.dark_post_status',
      'ad_configuration.end_card_cta',
      'ad_configuration.tracking_info.click_tracking_url',
    ]);
    assert.equal(r.error.details.field, 'ad_configuration.dark_post_status');
    assert.equal(r.error.details.violations_count, 3);
  } finally {
    f.store.close();
  }
});

test('a full edit that restates everything the ad reads is prepared, executed and verified whether TikTok merges or replaces, and so is one that leaves the defaults out', async () => {
  for (const update of ['merge', 'replace']) {
    const f = editsFixture();
    try {
      f.behaviour.update = update;
      // The whole read, copied (its defaults and the pixel "0" included), with the switch changed.
      const read = structuredClone(f.ads[5101].ad_configuration);
      const copied = await f.prepared({
        smart_plus_ad_id: '5101',
        ad_configuration: {...read, creative_auto_add_toggle: true},
      });
      assert.equal((await f.execute(copied.data.review_id)).success, true, update);
      assert.equal((await f.verify(copied.data.review_id)).data.status, 'verified', update);
      assert.equal(f.ads[5101].ad_configuration.creative_auto_add_toggle, true, update);
      // The defaults are what TikTok reads when a key is left out, so leaving them out clears nothing.
      const lean = await f.prepared({...switchEdit(), ad_configuration: config({utm_params: read.utm_params})});
      assert.equal((await f.execute(lean.data.review_id)).success, true, update);
      assert.equal(f.writes.length, 2);
    } finally {
      f.store.close();
    }
  }
});

test('the reference ad of a UI-made campaign is edited in full too: a catalog toggle that reads false is let go, and a list without its null padding is sent', async () => {
  const f = editsFixture();
  try {
    // 5400 reads no creative_auto_add_toggle, a list padded with null and catalog_creative_toggle false: the edit names the switch and the list.
    const p = await f.prepared({
      smart_plus_ad_id: '5400',
      ad_configuration: config({creative_auto_add_toggle: true, utm_params: [{key: 'utm_source', value: 'tiktok'}]}),
    });
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(Object.hasOwn(f.writes[0].ad_configuration, 'catalog_creative_toggle'), false);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
  } finally {
    f.store.close();
  }
});

test('settings that read as not set are let go by a full edit, as the merge lets them go', async () => {
  const f = editsFixture();
  try {
    Object.assign(f.ads[5101].ad_configuration, {
      end_card_cta: {},
      deeplink_utm_params: [],
      auto_disclaimer_types: [],
      note: null,
      label: '',
    });
    Object.assign(f.ads[5101].ad_configuration.tracking_info, {
      viewability_postbid_partner: 'UNSET',
      impression_tracking_url: '',
    });
    const p = await f.prepared(switchEdit());
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes.length, 1);
  } finally {
    f.store.close();
  }
});

test('S4-5: a product information mode that reads null or empty is no mode, for a full edit and for a patch alike', async () => {
  for (const mode of [null, '']) {
    const f = editsFixture();
    try {
      f.ads[5101].ad_configuration.product_info_enabled = mode;
      const edit = await f.prepare(switchEdit());
      assert.equal(edit.success, true, JSON.stringify(mode) + ': ' + JSON.stringify(edit.error ?? '').slice(0, 300));
      const patch = await f.prepare(merge({creative_auto_add_toggle: true}));
      assert.equal(patch.error.details.field, patchField, JSON.stringify(mode));
      assert.equal(
        Object.hasOwn(patch.error.details.fix[0].value, 'product_info_enabled'),
        false,
        JSON.stringify(mode),
      );
    } finally {
      f.store.close();
    }
  }
});

// ---- S3-8 (the lead's review): catalog_creative_toggle -------------------------------------------------------------------------------
// "Create an Upgraded Smart+ Ad" (read by the lead on 2026-11-21): a boolean, "Whether to enable auto-selection of creatives from your
// catalog", "Valid only when catalog_enabled is true at the campaign level", default false. So false is what an ad without a catalog reads,
// and a body copied from a read passes with it; true is outside the qualified contract (catalogs are), whichever route names it, and an ad
// that reads true is not edited here (the S2-1 list). A read false is not set: the merge lets it go and does not carry it.
const toggled = value => ({
  smart_plus_ad_id: '5101',
  ad_configuration: config({utm_params: [{key: 'utm_source', value: 'tiktok'}], catalog_creative_toggle: value}),
});

test('catalog_creative_toggle true is refused with its own field by an edit, a patch and a create, before any request; false is accepted by all three', async () => {
  const f = editsFixture();
  try {
    for (const value of [true, 'false', 'true', 0, null]) {
      const label = JSON.stringify(value);
      const edit = await f.prepare(toggled(value));
      assertRefused(edit, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(edit.error.details.field, 'ad_configuration.catalog_creative_toggle', label);
      assert.match(
        edit.error.message,
        /^Set catalog_creative_toggle to false or leave it out: false is its default, and catalogs are outside the qualified Smart\+ Spark Ad contract/,
        label,
      );
      const patch = await f.prepare(merge({catalog_creative_toggle: value}));
      assertRefused(patch, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(patch.error.details.field, 'ad_configuration_patch.catalog_creative_toggle', label);
      const created = await f.prepare(lead({}, {catalog_creative_toggle: value}), {}, create);
      assertRefused(created, 'INVALID_TIKTOK_SMART_PLUS_AD', {writes: () => f.writes.length});
      assert.equal(created.error.details.field, 'ad_configuration.catalog_creative_toggle', label);
    }
    assert.equal(f.requests.length, 0, 'every one was refused before any request');
    // False is TikTok's default: an edit that carries it, as a body copied from a read does, is prepared, sent and verified.
    const p = await f.prepared(toggled(false));
    assert.equal((await f.execute(p.data.review_id)).success, true);
    assert.equal(f.writes[0].ad_configuration.catalog_creative_toggle, false);
    assert.equal((await f.verify(p.data.review_id)).data.status, 'verified');
    assert.equal((await f.prepare(lead({}, {catalog_creative_toggle: false}), {}, create)).success, true);
    // A patch that names it hands it back as named, and the next call is an ordinary edit.
    const patch = await f.prepare(merge({catalog_creative_toggle: false}));
    assert.equal(patch.error.details.field, patchField);
    assert.equal(patch.error.details.fix[0].value.catalog_creative_toggle, false);
    assert.equal((await nextCall(f, patch)).success, true);
  } finally {
    f.store.close();
  }
});

test('an ad that reads catalog_creative_toggle false is edited as one that reads none: a full edit is prepared, and a patch does not carry it', async () => {
  const f = editsFixture();
  try {
    f.ads[5101].ad_configuration.catalog_creative_toggle = false;
    const edit = await f.prepared(switchEdit());
    assert.equal((await f.execute(edit.data.review_id)).success, true);
    assert.equal(Object.hasOwn(f.writes[0].ad_configuration, 'catalog_creative_toggle'), false);
    const patch = await f.prepare(merge({creative_auto_add_toggle: true}));
    assert.equal(patch.error.details.field, patchField);
    assert.equal(Object.hasOwn(patch.error.details.fix[0].value, 'catalog_creative_toggle'), false);
    // A UI-made ad reads it with the switch it leaves out: only that switch is refused, and naming it is enough.
    const ui = await f.prepare({
      smart_plus_ad_id: '5400',
      ad_configuration_patch: {creative_auto_add_toggle: true},
    });
    assert.equal(ui.error.details.field, patchField);
    assert.equal(Object.hasOwn(ui.error.details.fix[0].value, 'catalog_creative_toggle'), false);
  } finally {
    f.store.close();
  }
});
