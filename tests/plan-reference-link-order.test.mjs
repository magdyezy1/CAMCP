import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Package r25-field3-refs, item 7 (the owner's second Google report of 2026-11-21, AMCP-04 F4-0, documentation only): the one-approval route without a
 * build. A plan replaces the placeholder text of an existing Performance Max asset group in place: one step creates the new text assets, and one link
 * step names them by reference and removes the placeholder links. The link step has 30 operations, so it is split into parts of 25 that run in order
 * under the one approval (src/write-groups.ts), and each part is judged on its own against the group's minimums. The guide says to put the removes BEFORE
 * the creates, and the creates of the minimum number of each removed type FIRST among them: then no part is left under a minimum. These tests prove it
 * on the real review, and prove what the guide warns of. No code changes in this item; every value is invented (customer 123).
 */
const group = at('assetGroups', '77'),
  campaign = at('campaigns', '10'),
  link = (asset, type) => at('assetGroupAssets', '77~' + asset + '~' + type);
let tenants = 0;

/** A Performance Max group whose links meet every minimum: the placeholder texts 3001 to 3006, a business name, the images and a logo. */
function account() {
  const f = googleReconcileFixture({tenant: 'plan-reference-link-order-' + ++tenants});
  f.row('campaign', {
    resource_name: campaign,
    name: 'Synthetic PMax',
    status: 'PAUSED',
    advertising_channel_type: 'PERFORMANCE_MAX',
    brand_guidelines_enabled: false,
  });
  f.row('asset_group', {
    resource_name: group,
    name: 'Synthetic group',
    status: 'PAUSED',
    campaign,
    final_urls: ['https://example.test/'],
  });
  // A text asset Google creates reads back as TEXT, and a link it creates is the advertiser's (the review counts only those).
  const pushAsset = f.db.asset.push,
    pushLink = f.db.asset_group_asset.push;
  f.db.asset.push = function (row) {
    if (row.text_asset) Object.assign(row, {type: 'TEXT', source: 'ADVERTISER'});
    return pushAsset.call(this, row);
  };
  f.db.asset_group_asset.push = function (row) {
    if (!row.source) row.source = 'ADVERTISER';
    return pushLink.call(this, row);
  };
  for (const [type, id] of placeholders.concat([
    ['BUSINESS_NAME', 3007],
    ['MARKETING_IMAGE', 9101],
    ['SQUARE_MARKETING_IMAGE', 9201],
    ['LOGO', 9501],
  ])) {
    const text = id < 4000;
    f.row('asset', {
      resource_name: at('assets', String(id)),
      type: text ? 'TEXT' : 'IMAGE',
      source: 'ADVERTISER',
      ...(text
        ? {text_asset: {text: 'Placeholder ' + id}}
        : {
            image_asset: {
              full_size: {width_pixels: '1200', height_pixels: type === 'MARKETING_IMAGE' ? '628' : '1200'},
            },
          }),
    });
    f.row('asset_group_asset', {
      resource_name: link(id, type),
      asset_group: group,
      asset: at('assets', String(id)),
      field_type: type,
      status: 'ENABLED',
      source: 'ADVERTISER',
    });
  }
  return f;
}
/** The placeholder text links of the group: three headlines, a long headline and two descriptions. */
const placeholders = [
  ['HEADLINE', 3001],
  ['HEADLINE', 3002],
  ['HEADLINE', 3003],
  ['LONG_HEADLINE', 3004],
  ['DESCRIPTION', 3005],
  ['DESCRIPTION', 3006],
];
const step = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
/** The new links in the order given, one new text asset each: the references are to the results of the step that creates them, in the same order. */
const creates = types =>
  types.map((type, i) => ({
    create: {asset_group: group, field_type: type, asset: {$ref: 'new_texts#/data/results/' + i + '/resourceName'}},
  }));
const removes = () => placeholders.map(([type, id]) => ({remove: link(id, type)}));
const times = (n, type) => Array(n).fill(type);
/** 24 new links, the first six being the minimum of each type the removes take (three headlines, a long headline, two descriptions). */
const newTypes = [
  ...times(3, 'HEADLINE'),
  'LONG_HEADLINE',
  ...times(2, 'DESCRIPTION'),
  ...times(9, 'HEADLINE'),
  ...times(3, 'LONG_HEADLINE'),
  ...times(3, 'DESCRIPTION'),
  ...times(3, 'HEADLINE'),
];
async function plan(f, linkOperations, types = newTypes) {
  const texts = step('new_texts', {
      action: 'google_ads_v23_asset_mutate_assets',
      payload: {operations: types.map((type, i) => ({create: {text_asset: {text: type + ' text ' + (i + 1)}}}))},
    }),
    links = step(
      'new_links',
      {action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets', payload: {operations: linkOperations}},
      ['new_texts'],
    ),
    created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Synthetic plan',
      brief: 'Synthetic.',
      steps: [texts, links],
    });
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
  const id = created.data.id,
    call = input => f.call('amcp_campaign', {id, ...input}),
    preview = await call({action: 'approve'});
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 600));
  const approved = await call({...preview.data.next_call.arguments, ...preview.data.next_call.add_after_user_approval});
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  const ran = await call({action: 'run'});
  assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 600));
  const got = await call({action: 'get', detail: 'full'});
  return {ran: ran.data, step: id2 => got.data.steps.find(s => s.id === id2)};
}

test('F4-0: a 30-operation link step, the removes first and the minimum creates first among the creates, passes every part’s minimums and replaces the placeholders in place', async () => {
  const f = account();
  try {
    const operations = [...removes(), ...creates(newTypes)];
    assert.equal(operations.length, 30);
    const done = await plan(f, operations);
    assert.equal(done.ran.run.stopped, 'complete', JSON.stringify(done.ran.run));
    // Two parts under one approval: the 25 first operations (the six removes and 19 creates), then the last five creates.
    assert.deepEqual(
      f.writes.filter(w => w.path.endsWith('assetGroupAssets:mutate')).map(w => w.body.operations.length),
      [25, 5],
    );
    assert.equal(done.step('new_links').status, 'verified');
    const now = f.db.asset_group_asset.filter(r => r.asset_group === group);
    assert.equal(now.length, 10 - 6 + 24, 'the placeholders are gone and the 24 new links are in');
    for (const [type, id] of placeholders) assert.ok(!now.some(r => r.resource_name === link(id, type)), String(id));
    // The group still meets every minimum with the new text.
    const count = type => now.filter(r => r.field_type === type).length;
    assert.ok(count('HEADLINE') >= 3 && count('LONG_HEADLINE') >= 1 && count('DESCRIPTION') >= 2);
  } finally {
    f.close();
  }
});

// What the guide warns of: the removes last. The second part holds five of the removes, and is judged against the group as it is read: the placeholders it
// removes would leave the group under its minimums, as the creates of the first part are not in the group yet. Nothing is sent for the link step.
test('F4-0: the same operations with the removes last are refused PMAX_ASSET_MINIMUMS when the step is prepared, and nothing is sent for it', async () => {
  const f = account();
  try {
    const done = await plan(f, [...creates(newTypes), ...removes()]);
    const failed = done.step('new_links');
    assert.equal(failed.status, 'failed');
    assertRefused({code: failed.error.code}, 'PMAX_ASSET_MINIMUMS');
    assert.deepEqual(failed.error.details.outside_range.map(r => r.field_type).sort(), [
      'DESCRIPTION',
      'HEADLINE',
      'LONG_HEADLINE',
    ]);
    assert.equal(f.writes.filter(w => w.path.endsWith('assetGroupAssets:mutate')).length, 0, 'no part was sent');
    assert.equal(f.db.asset_group_asset.filter(r => r.asset_group === group).length, 10, 'the group is as it was');
  } finally {
    f.close();
  }
});

// The condition the guide states: the first part must hold the minimum creates of each type it removes. Here the removes are first, but the first part's
// 19 creates are headlines and long headlines only, and the descriptions come in the second part: the first part removes both descriptions and adds none.
test('F4-0: the removes first but the descriptions left to the second part are refused PMAX_ASSET_MINIMUMS, and nothing is sent for the step', async () => {
  const f = account();
  try {
    const types = [...times(15, 'HEADLINE'), ...times(4, 'LONG_HEADLINE'), ...times(5, 'DESCRIPTION')];
    const done = await plan(f, [...removes(), ...creates(types)], types);
    const failed = done.step('new_links');
    assert.equal(failed.status, 'failed');
    assertRefused({code: failed.error.code}, 'PMAX_ASSET_MINIMUMS');
    assert.deepEqual(failed.error.details.outside_range, [{field_type: 'DESCRIPTION', min: 2, max: 5, found: 0}]);
    assert.equal(f.writes.filter(w => w.path.endsWith('assetGroupAssets:mutate')).length, 0, 'no part was sent');
  } finally {
    f.close();
  }
});
