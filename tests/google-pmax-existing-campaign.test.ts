import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {saveSpendPolicy} from '../src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.js';

/**
 * R2.5 M3, G1 (package r25-m3-pmax): a build adds a Performance Max asset group, its text assets and all its links under an
 * EXISTING campaign, in one reviewed request. Until now it refused any asset group whose campaign the build did not create
 * (INVALID_GOOGLE_BUILD, "only under a Performance Max campaign the same build creates"), so a retail launch made the group,
 * its assets and its links in separate reviews. The campaign's channel, brand-guideline mode and Merchant Center account are
 * read with the build's other existing parents, and the counts are judged in that mode. A group under a campaign the build
 * creates keeps its old rules (tests/google-pmax-build.test.mjs).
 *
 * Owner decisions that bind these tests (round 2.5, 2026-11-15): safety stays (the minimum counts, the short description,
 * existing assets read and type-checked, the spend confirmation, allow_activation, all or nothing). Q1 (whether an ENABLED
 * group may start under a serving campaign) is package r25-m3-targeting's: nothing here pins it, so the tests use a PAUSED
 * group under an ENABLED campaign and an ENABLED group under a PAUSED one.
 *
 * The synthetic customer is tests/fixtures/google-pmax-retail-build.mjs (a plain module the M3 merge's journey J10 reuses).
 * A test compiled from TypeScript lives in dist/tests, so it loads the fixture by its path from the repository root, as
 * tests/deployment-smoke.test.ts loads deploy/smoke-api.mjs.
 */
const fixture: any = await import(pathToFileURL(resolve('tests/fixtures/google-pmax-retail-build.mjs')).href),
  reconcile: any = await import(pathToFileURL(resolve('tests/helpers/google-reconcile-fixture.mjs')).href);
const {
  pmaxRetailWorld,
  campaignRow,
  existingAssets,
  j10Build,
  withoutFieldTypes,
  groupOnly,
  linkOperation,
  at,
  assetName,
} = fixture;
const group = at('assetGroups', '-1'),
  existingCampaign = at('campaigns', '900');

before(() => {
  process.env.AMCP_WRITE_RECONCILE_DELAY_MS = '0';
  process.env.AMCP_WRITE_RECONCILE_ROUND_MS = '0';
});
after(() => {
  delete process.env.AMCP_WRITE_RECONCILE_DELAY_MS;
  delete process.env.AMCP_WRITE_RECONCILE_ROUND_MS;
});

test('the J10 build without its tree, under an existing PAUSED retail campaign, is one review, one mutate and one read-back', async t => {
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  const review = await x.prepareBuild(j10Build());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.equal(x.log.mutates.length, 0, 'prepare sends nothing');
  const impact = JSON.stringify(review.data);
  assert.match(impact, /"all_or_nothing":true/);
  assert.match(impact, /"asset_groups":\[\{"name":"DNU group"/);
  // The tall portrait image (G2) is one of the 19 existing assets it links.
  assert.match(impact, /"TALL_PORTRAIT_MARKETING_IMAGE":1/);
  assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
  // The campaign's channel, brand-guideline mode and Merchant Center account are read with the build's existing parents.
  const campaignRead = x.log.queries.find((q: string) => / FROM campaign WHERE campaign\.resource_name IN /.test(q));
  assert.ok(campaignRead, 'the existing campaign is read');
  for (const field of ['advertising_channel_type', 'brand_guidelines_enabled', 'shopping_setting.merchant_id'])
    assert.match(campaignRead, new RegExp('campaign\\.' + field.replace('.', '\\.')));
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.log.mutates.length, 1, 'one request');
  const sent = x.log.mutates[0].mutate_operations;
  assert.equal(sent.length, 66);
  assert.equal(sent.filter((o: any) => o.asset_operation).length, 23);
  assert.equal(sent.filter((o: any) => o.asset_group_asset_operation).length, 42);
  assert.equal(sent[0].asset_group_operation.create.campaign, existingCampaign);
  assert.equal(sent[0].asset_group_operation.create.status, 'PAUSED');
  // J10's build is two MCP calls (prepare, execute) and 8 provider requests: at prepare the customer, the campaign, the existing
  // assets and the lookup of the named asset group that the M2 reconcile freezes; at execute the same three reads again; the one
  // mutate. The read-back of the 66 created resources is the separate verify call below, one read after another: batching them
  // is L2-11, which M5 owns and must lower (QUESTIONS Q1, the lead's decision of 2026-11-17).
  const searches = () => x.log.requests.filter((r: any) => r.path.endsWith(':search')).length;
  assert.deepEqual({mcp: x.calls(), reads: searches(), mutates: x.log.mutates.length}, {mcp: 2, reads: 7, mutates: 1});
  const verified = await x.verify(review);
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 1500));
  assert.equal(verified.data.checks.length, 66);
  assert.deepEqual({mcp: x.calls(), reads: searches()}, {mcp: 3, reads: 73}, 'verify reads each of the 66 resources');
  assert.ok(
    x.log.queries.some((q: string) =>
      /asset_group\.primary_status, asset_group\.ad_strength FROM asset_group WHERE/.test(q),
    ),
    'the asset group is read back with Google’s status and ad strength',
  );
});

test('the same build written in camelCase, as the White Friday report sent it, is judged and sent the same way', async t => {
  // The shared builder reads the operations in snake_case whatever spelling the caller used (snakeKeys in
  // src/google-atomic-builds.ts), so the existing-campaign path must not depend on it: same review, same one request, and a
  // refusal that names the same field path (a snake_case path, as in the brief).
  const camel = (value: any): any =>
    Array.isArray(value)
      ? value.map(camel)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value).map(([key, inner]) => [
              key.replace(/_([a-z])/g, (_: string, letter: string) => letter.toUpperCase()),
              camel(inner),
            ]),
          )
        : value;
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  const review = await x.prepare(x.buildAction, {mutateOperations: camel(j10Build())});
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.match(JSON.stringify(review.data), /"asset_groups":\[\{"name":"DNU group"/);
  assert.equal(x.log.mutates.length, 0, 'prepare sends nothing');
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.log.mutates.length, 1, 'one request');
  assert.equal(x.log.mutates[0].mutate_operations.length, 66);
  assert.equal(x.log.mutates[0].mutate_operations[0].asset_group_operation.create.campaign, existingCampaign);
  const search = pmaxRetailWorld({campaign: campaignRow({advertising_channel_type: 'SEARCH'})});
  t.after(() => search.close());
  const refused = await search.prepare(search.buildAction, {mutateOperations: camel(j10Build())});
  assertRefused(refused, 'INVALID_GOOGLE_BUILD', {writes: search.log.mutates.length});
  assert.deepEqual(
    [refused.error.details.operation, refused.error.details.field, refused.error.details.channel],
    [0, 'mutate_operations[0].asset_group_operation.create.campaign', 'SEARCH'],
    JSON.stringify(refused.error),
  );
});

test('an asset group under an existing campaign that is not Performance Max, or not live, is refused naming its operation', async t => {
  for (const [row, channel, status] of [
    [campaignRow({advertising_channel_type: 'SEARCH'}), 'SEARCH', 'PAUSED'],
    [campaignRow({advertising_channel_type: 'DEMAND_GEN'}), 'DEMAND_GEN', 'PAUSED'],
    [campaignRow({status: 'REMOVED'}), 'PERFORMANCE_MAX', 'REMOVED'],
  ]) {
    const x = pmaxRetailWorld({campaign: row});
    t.after(() => x.close());
    const r = await x.prepareBuild(j10Build());
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {writes: x.log.mutates.length});
    assert.deepEqual(
      [r.error.details.operation, r.error.details.field, r.error.details.channel],
      [0, 'mutate_operations[0].asset_group_operation.create.campaign', channel],
      JSON.stringify(r.error),
    );
    assert.equal(r.error.details.status, status);
    assert.match(r.error.message, /^mutate_operations\[0\]: /);
  }
});

test('an asset group under an existing campaign the account does not return is refused after the review reads it', async t => {
  const x = pmaxRetailWorld({campaign: null});
  t.after(() => x.close());
  // This is the case that used to be refused before any read (campaigns/77): the review now reads the campaign, finds none, and sends nothing.
  assertRefused(await x.prepareBuild(j10Build()), 'STATE_NOT_FOUND', {writes: x.log.mutates.length});
  assert.ok(
    x.log.queries.some((q: string) => / FROM campaign WHERE /.test(q)),
    'the campaign was read',
  );
});
test('a missing minimum under an existing campaign is refused naming its field type, for a retail and a non-retail campaign', async t => {
  for (const campaign of [campaignRow(), campaignRow({shopping_setting: undefined})]) {
    const x = pmaxRetailWorld({campaign});
    t.after(() => x.close());
    for (const [types, found] of [
      [['HEADLINE'], 'HEADLINE'],
      [['SQUARE_MARKETING_IMAGE'], 'SQUARE_MARKETING_IMAGE'],
      [['LOGO', 'BUSINESS_NAME'], 'LOGO'],
    ]) {
      const r = await x.prepareBuild(withoutFieldTypes(j10Build(), types));
      assertRefused(r, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
      assert.equal(r.error.details.operation, 0);
      assert.equal(r.error.details.asset_group, group);
      assert.ok(
        r.error.details.outside_range.some((o: any) => o.field_type === found && o.found === 0 && o.min >= 1),
        JSON.stringify(r.error.details.outside_range),
      );
      assert.ok(Array.isArray(r.error.details.outside_range));
    }
  }
});

test('in a brand-guideline campaign the group needs no BUSINESS_NAME or LOGO, which the same build lacks with brand guidelines off', async t => {
  const without = ['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO'];
  const on = pmaxRetailWorld({campaign: campaignRow({brand_guidelines_enabled: true})});
  t.after(() => on.close());
  const ok = await on.prepareBuild(withoutFieldTypes(j10Build(), without));
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  // A non-retail campaign needs them as well: brand guidelines are what lifts the minimums, not retail.
  for (const shopping of [{merchant_id: '5550100'}, undefined]) {
    const off = pmaxRetailWorld({campaign: campaignRow({shopping_setting: shopping})});
    t.after(() => off.close());
    const refused = await off.prepareBuild(withoutFieldTypes(j10Build(), without));
    assertRefused(refused, 'PMAX_ASSET_MINIMUMS', {writes: off.log.mutates.length});
    const missing = refused.error.details.outside_range.map((o: any) => o.field_type).sort();
    assert.deepEqual(missing, ['BUSINESS_NAME', 'LOGO'], JSON.stringify(refused.error.details));
  }
  // The other minimums stay with brand guidelines on.
  const stillShort = await on.prepareBuild(withoutFieldTypes(j10Build(), [...without, 'HEADLINE']));
  assertRefused(stillShort, 'PMAX_ASSET_MINIMUMS', {writes: on.log.mutates.length});
  assert.deepEqual(
    stillShort.error.details.outside_range.map((o: any) => o.field_type),
    ['HEADLINE'],
  );
});

test('in a brand-guideline campaign a build must not link BUSINESS_NAME, LOGO or LANDSCAPE_LOGO to the asset group: they are the campaign’s own', async t => {
  // Round 2, S3-1. With brand guidelines on, Google wants these three linked to the campaign (a CampaignAsset), and refuses them on
  // an asset group (AssetLinkError.BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL). A build counts a maximum of 0 for them there: the
  // J10 build links one business name, one logo and two landscape logos, so it is refused, naming each.
  const on = pmaxRetailWorld({campaign: campaignRow({brand_guidelines_enabled: true})});
  t.after(() => on.close());
  const refused = await on.prepareBuild(j10Build());
  assertRefused(refused, 'PMAX_ASSET_MINIMUMS', {writes: on.log.mutates.length});
  assert.deepEqual(refused.error.details.outside_range, [
    {field_type: 'BUSINESS_NAME', min: 0, max: 0, found: 1},
    {field_type: 'LOGO', min: 0, max: 0, found: 1},
    {field_type: 'LANDSCAPE_LOGO', min: 0, max: 0, found: 2},
  ]);
  assert.match(refused.error.message, /BUSINESS_NAME, LOGO and LANDSCAPE_LOGO/);
  assert.match(refused.error.message, /belong to the campaign/);
  // Negative: the same build without the three is the one the test above accepts; with brand guidelines off it is accepted as is.
  const off = pmaxRetailWorld();
  t.after(() => off.close());
  assert.equal((await off.prepareBuild(j10Build())).success, true);
});

test('a retail campaign accepts a group with no asset, because Google generates the minimum set; a group with any link meets every minimum', async t => {
  const retail = pmaxRetailWorld();
  t.after(() => retail.close());
  const empty = await retail.prepareBuild(groupOnly());
  assert.equal(empty.success, true, JSON.stringify(empty).slice(0, 1200));
  const done = await retail.execute(empty);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
  assert.equal(retail.log.mutates.length, 1);
  assert.equal(retail.log.mutates[0].mutate_operations.length, 1);
  // One link makes it a group with custom assets: every minimum is due (Google's retail caution).
  const sent = retail.log.mutates.length,
    oneLink = await retail.prepareBuild([...groupOnly(), linkOperation(assetName(9101), 'MARKETING_IMAGE')]);
  assertRefused(oneLink, 'PMAX_ASSET_MINIMUMS', {writes: () => retail.log.mutates.length - sent});
  assert.ok(oneLink.error.details.outside_range.some((o: any) => o.field_type === 'HEADLINE' && o.found === 0));
  // Negative: a campaign that is not retail gets no such allowance.
  const plain = pmaxRetailWorld({campaign: campaignRow({shopping_setting: undefined})});
  t.after(() => plain.close());
  const refused = await plain.prepareBuild(groupOnly());
  assertRefused(refused, 'PMAX_ASSET_MINIMUMS', {writes: plain.log.mutates.length});
  assert.equal(refused.error.details.outside_range.length, 7, JSON.stringify(refused.error.details.outside_range));
});

test('a PAUSED group under an ENABLED campaign is accepted, and an ENABLED group under a PAUSED one needs allow_activation', async t => {
  const live = pmaxRetailWorld({campaign: campaignRow({status: 'ENABLED'})});
  t.after(() => live.close());
  const paused = await live.prepareBuild(j10Build({status: 'PAUSED'}));
  assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 1200));
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  saveSpendPolicy(x.store, x.owner, {
    confirmed: true,
    gateway: 'google_ads_native_action',
    account_id: '123',
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });
  const review = await x.prepareBuild(j10Build({status: 'ENABLED'}));
  const refused = review.success ? await x.execute(review) : review;
  assertRefused(refused, 'POLICY_ACTIVATION_FORBIDDEN', {writes: x.log.mutates.length});
  // The same build with a PAUSED group passes the owner's policy.
  const ok = await x.prepareBuild(j10Build({status: 'PAUSED'}));
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
});

test('the rules without state still apply to a group under an existing campaign, before any read', async t => {
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  const change = (mutate: (create: any) => void) => {
    const operations = j10Build();
    mutate(operations[0].asset_group_operation.create);
    return operations;
  };
  const cases: [any[], RegExp][] = [
    [change(c => (c.final_urls = ['http://example.com/'])), /final_urls/],
    [change(c => (c.name = '  ')), /name the asset group/],
    [change(c => delete c.resource_name).slice(0, 1), /needs a temporary resource_name/],
    [change(c => delete c.resource_name), /no earlier operation of this build creates/],
    [
      [...j10Build(), linkOperation(assetName(9102), 'MARKETING_IMAGE', at('assetGroups', '55'))],
      /name an asset group the same build creates/,
    ],
    [[...j10Build(), linkOperation(assetName(9101), 'MARKETING_IMAGE')], /linked twice/],
  ];
  for (const [operations, message] of cases) {
    const r = await x.prepareBuild(operations);
    assertRefused(r, 'INVALID_GOOGLE_BUILD', {message});
  }
  // The short description: every description over 60 characters is refused here too, as for a campaign the build creates.
  const long = j10Build().map((op: any) =>
    op.asset_operation?.create.text_asset.text.startsWith('DNU description')
      ? {asset_operation: {create: {...op.asset_operation.create, text_asset: {text: 'D'.repeat(70)}}}}
      : op,
  );
  const short = await x.prepareBuild(long);
  assertRefused(short, 'PMAX_ASSET_MINIMUMS');
  assert.deepEqual([short.error.details.field_type, short.error.details.short_max_length], ['DESCRIPTION', 60]);
  assert.equal(x.log.requests.length, 0, 'no read, no request');
});

test('an existing asset of another type is still refused, and the build stays all or nothing and needs the spend confirmation', async t => {
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  // 9901 is a text asset: it cannot be a marketing image.
  const wrong = j10Build().map((op: any) =>
    op.asset_group_asset_operation?.create.asset === assetName(9101)
      ? linkOperation(assetName(9901), 'MARKETING_IMAGE')
      : op,
  );
  const mismatch = await x.prepareBuild(wrong);
  assertRefused(mismatch, 'PMAX_ASSET_TYPE_MISMATCH', {writes: x.log.mutates.length});
  assert.deepEqual(
    [mismatch.error.details.asset, mismatch.error.details.expected_type, mismatch.error.details.actual_type],
    [assetName(9901), 'IMAGE', 'TEXT'],
  );
  assertRefused(await x.prepareBuild(j10Build(), {partial_failure: true}), 'INVALID_GOOGLE_BUILD', {
    message: /all or nothing/,
  });
  const review = await x.prepareBuild(j10Build());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1200));
  assertRefused(await x.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: x.log.mutates.length});
});

test('a lost build under an existing campaign is found by the M2 lookup as the group under that campaign, and no other', async () => {
  for (const applied of [true, false]) {
    const f = reconcile.googleReconcileFixture();
    try {
      f.row('campaign', campaignRow());
      f.row('campaign', campaignRow({resource_name: at('campaigns', '901'), name: 'DNU other PMax'}));
      for (const asset of existingAssets) f.row('asset', asset);
      // A group of the same name under ANOTHER campaign: it is not this build's.
      f.row('asset_group', {
        resource_name: at('assetGroups', '77'),
        name: 'DNU group',
        status: 'PAUSED',
        campaign: at('campaigns', '901'),
      });
      const {id, refused} = await f.lose(
        'google_ads_v23_google_ads_mutate',
        {mutate_operations: j10Build()},
        {applied},
      );
      assert.equal(refused.error.code, 'WRITE_OUTCOME_UNCERTAIN', JSON.stringify(refused).slice(0, 500));
      const sent = f.writes.length,
        r = await f.call('amcp_write', {action: 'reconcile', review_id: id});
      assert.equal(r.data.contract, 'create', JSON.stringify(r.data).slice(0, 600));
      assert.equal(f.writes.length, sent, 'reconcile reads only');
      const lookup = f.queries.find((q: string) => / FROM asset_group WHERE asset_group\.name IN /.test(q));
      assert.match(lookup, new RegExp("asset_group\\.campaign IN \\('" + existingCampaign + "'\\)"));
      if (applied) {
        const created = f.db.asset_group.find((g: any) => g.campaign === existingCampaign);
        assert.equal(r.data.classification, 'appears_applied', JSON.stringify(r.data).slice(0, 600));
        assert.deepEqual(r.data.observed_ids, [created.resource_name]);
      } else {
        assert.equal(r.data.classification, 'appears_not_applied', JSON.stringify(r.data).slice(0, 600));
        assert.equal(r.data.reason, 'not_found');
      }
    } finally {
      f.close();
    }
  }
});
