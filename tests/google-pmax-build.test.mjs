// CMP-07: a reviewed Performance Max build. Google requires a non-retail asset group and the links to its minimum
// assets in the same mutate request, which the all-or-nothing build provides. A synthetic customer answers every read
// and the one mutate; nothing reaches Google. A build with a missing or excess minimum is refused before any request,
// an existing asset of the wrong type is refused after the review reads it, and the campaign stays PAUSED.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertPmaxBuild, pmaxAssetRequirements} from '../dist/src/google-pmax-build.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {google, pmaxAdmin as admin, pmaxCustomer as setup} from './fixtures/google-pmax-data.mjs';
const text = (n, value) => ({
  asset_operation: {create: {resource_name: 'customers/123/assets/-' + n, text_asset: {text: value}}},
});
const link = (asset, field_type, group = 'customers/123/assetGroups/-20') => ({
  asset_group_asset_operation: {create: {asset_group: group, asset, field_type}},
});
function pmax({
  headlines = ['Acme', 'Acme widgets', 'Buy Acme'],
  longHeadlines = ['Widgets for every workshop'],
  descriptions = ['Widgets for all.', 'Fast delivery.'],
  images = ['customers/123/assets/501'],
  squares = ['customers/123/assets/502'],
  logos = ['customers/123/assets/503'],
  campaign = {},
  group = {},
} = {}) {
  const texts = [
    ...headlines.map(t => ['HEADLINE', t]),
    ...longHeadlines.map(t => ['LONG_HEADLINE', t]),
    ...descriptions.map(t => ['DESCRIPTION', t]),
    ['BUSINESS_NAME', 'Acme'],
  ];
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: 'customers/123/campaignBudgets/-1',
          name: 'PMax budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: 'customers/123/campaigns/-2',
          name: 'PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: 'customers/123/campaignBudgets/-1',
          maximize_conversions: {},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...campaign,
        },
      },
    },
    {
      campaign_criterion_operation: {
        create: {campaign: 'customers/123/campaigns/-2', location: {geo_target_constant: 'geoTargetConstants/2682'}},
      },
    },
    ...texts.map(([, t], i) => text(100 + i, t)),
    {
      asset_group_operation: {
        create: {
          resource_name: 'customers/123/assetGroups/-20',
          name: 'All products',
          campaign: 'customers/123/campaigns/-2',
          final_urls: ['https://example.test/'],
          status: 'ENABLED',
          ...group,
        },
      },
    },
    ...texts.map(([type], i) => link('customers/123/assets/-' + (100 + i), type)),
    ...images.map(a => link(a, 'MARKETING_IMAGE')),
    ...squares.map(a => link(a, 'SQUARE_MARKETING_IMAGE')),
    ...logos.map(a => link(a, 'LOGO')),
    {
      asset_group_signal_operation: {
        create: {asset_group: 'customers/123/assetGroups/-20', search_theme: {text: 'workshop widgets'}},
      },
    },
  ];
}

test('the pinned asset requirements are the reviewed fixture, field by field', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/google-pmax-asset-requirements.json', 'utf8'));
  assert.deepEqual(pmaxAssetRequirements.fields, fixture.fields);
  assert.deepEqual(pmaxAssetRequirements.combined, fixture.combined);
  assert.deepEqual(pmaxAssetRequirements.short_description, fixture.short_description);
  assert.equal(pmaxAssetRequirements.source, fixture.source);
});

// Google refuses an asset group without a short description (SHORT_DESCRIPTION_REQUIRED in the pinned v25 Discovery
// document): at least one DESCRIPTION of at most 60 characters. Regression: two 61-character descriptions passed the
// local check and were refused only by Google.
test('an asset group whose descriptions are all longer than 60 characters is refused before any request', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const long = n => 'Widgets for every workshop, delivered fast across the region ' + n,
    sixty = 'Widgets for every workshop, delivered fast across the regio';
  assert.equal([...long(1)].length, 62);
  const r = await x.prepare(pmax({descriptions: [long(1), long(2)]}));
  assertRefused(r, 'PMAX_ASSET_MINIMUMS', {writes: x.mutates.length});
  assert.match(r.error.message, /at least one description of at most 60 characters/);
  assert.deepEqual([r.error.details.field_type, r.error.details.short_max_length], ['DESCRIPTION', 60]);
  assert.deepEqual(r.error.details.lengths, [62, 62]);
  assert.equal(x.queries.length, 0, 'no reads');
  assert.equal(x.mutates.length, 0, 'no request');
  // One description of exactly 60 characters is a short description: the build reviews.
  assert.equal([...(sixty + 'n')].length, 60);
  const ok = await x.prepare(pmax({descriptions: [long(1), sixty + 'n']}));
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1500));
});

test('a whole Performance Max build is one review, one request and one read-back; the campaign stays PAUSED', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const review = await x.prepare(pmax());
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1500));
  assert.equal(x.mutates.length, 0);
  const impact = JSON.stringify(review.data);
  assert.match(impact, /"all_or_nothing":true/);
  assert.match(impact, /"asset_groups":\[\{"name":"All products"/);
  assert.match(impact, /"HEADLINE":3/);
  assert.ok(
    x.queries.some(q => q.startsWith('SELECT asset.resource_name, asset.type FROM asset WHERE')),
    'the existing images and logo are read before sending',
  );
  assert.equal(review.data.execute_requirements.spend_change_confirmed, true);
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.equal(x.mutates.length, 1, 'one request');
  const sent = x.mutates[0].mutate_operations;
  assert.equal(sent.find(o => o.campaign_operation).campaign_operation.create.status, 'PAUSED');
  assert.equal(sent.filter(o => o.asset_group_asset_operation).length, 10);
  const verified = await x.call('amcp_campaign', {action: 'verify', review_id: review.data.review_id});
  assert.equal(verified.success, true, JSON.stringify(verified).slice(0, 1500));
  assert.equal(verified.data.status, 'verified', JSON.stringify(verified.data).slice(0, 2000));
  assert.equal(verified.data.checks.length, sent.length);
  assert.ok(
    x.queries.some(q => /asset_group\.primary_status, asset_group\.ad_strength FROM asset_group WHERE/.test(q)),
    'the asset group is read back with Google’s status and ad strength',
  );
});

test('a missing or excess minimum, or an over-long text, is refused before any request', async t => {
  const x = setup();
  t.after(() => x.store.close());
  for (const [options, check] of [
    [{headlines: ['Acme', 'Buy Acme']}, d => d.outside_range.some(r => r.field_type === 'HEADLINE' && r.found === 2)],
    [{logos: []}, d => d.outside_range.some(r => r.field_type === 'LOGO' && r.found === 0)],
    [{descriptions: ['Only one.']}, d => d.outside_range.some(r => r.field_type === 'DESCRIPTION')],
    [{longHeadlines: []}, d => d.outside_range.some(r => r.field_type === 'LONG_HEADLINE')],
    [
      {images: Array.from({length: 21}, (_, i) => 'customers/123/assets/' + (600 + i))},
      d => d.outside_range.some(r => r.field_type === 'MARKETING_IMAGE' && r.found === 21),
    ],
    [{headlines: ['Acme', 'Acme widgets', 'A headline far longer than thirty characters']}, d => d.max_length === 30],
  ]) {
    const r = await x.prepare(pmax(options));
    assertRefused(r, 'PMAX_ASSET_MINIMUMS');
    assert.ok(check(r.error.details), JSON.stringify(r.error.details));
  }
  assert.equal(x.queries.length, 0, 'no reads');
  assert.equal(x.mutates.length, 0, 'no request');
});

test('an existing asset of another type, or one the account does not return, is refused after the review reads it', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const wrong = await x.prepare(pmax({images: ['customers/123/assets/504']}));
  assertRefused(wrong, 'PMAX_ASSET_TYPE_MISMATCH');
  assert.equal(wrong.error.details.asset, 'customers/123/assets/504');
  assert.equal(wrong.error.details.actual_type, 'TEXT');
  // An asset the account does not return fails the exact state read itself.
  assertRefused(await x.prepare(pmax({images: ['customers/123/assets/999']})), 'STATE_TARGET_MISMATCH');
  assert.equal(x.mutates.length, 0);
});

test('builds outside the Performance Max contract are refused before any request, naming the operation', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const base = pmax();
  const cases = [
    [pmax({campaign: {brand_guidelines_enabled: true}}), /brand_guidelines_enabled: false/],
    [
      pmax({campaign: {advertising_channel_type: 'SEARCH', manual_cpc: {}, maximize_conversions: undefined}}),
      /PERFORMANCE_MAX/,
    ],
    [pmax({group: {final_urls: ['http://example.test/']}}), /final_urls/],
    // R2.5 M3, G1 (package r25-m3-pmax): the case that stood here, an asset group under an existing campaign (campaigns/77), is no
    // longer outside the contract. It is judged once the review has read the campaign: tests/google-pmax-existing-campaign.test.ts.
    [
      [...base, link('customers/123/assets/501', 'MARKETING_IMAGE', 'customers/123/assetGroups/55')],
      /name an asset group the same build creates/,
    ],
    [
      [...base, {asset_operation: {create: {resource_name: 'customers/123/assets/-90', image_asset: {data: 'AA=='}}}}],
      /text assets only/,
    ],
    [[...base, link('customers/123/assets/501', 'AD_IMAGE')], /field types/],
    [[...base, link('customers/123/assets/501', 'MARKETING_IMAGE')], /linked twice/],
  ];
  for (const [operations, message] of cases) {
    const r = await x.prepare(operations);
    assertRefused(r, 'INVALID_GOOGLE_BUILD');
    assert.match(r.error.message, message, JSON.stringify(r.error).slice(0, 600));
  }
  assert.equal(x.queries.length, 0, 'no reads');
  assert.equal(x.mutates.length, 0);
});

test('an owner policy that forbids activation refuses the enabled asset group; a paused one passes', async t => {
  const x = setup();
  t.after(() => x.store.close());
  saveSpendPolicy(x.store, admin, {
    confirmed: true,
    gateway: google,
    account_id: '123',
    policy: {enforcement: 'block', allow_activation: false, allow_deletion: false},
  });
  const review = await x.prepare(pmax());
  const refused = review.success ? await x.execute(review) : review;
  assertRefused(refused, 'POLICY_ACTIVATION_FORBIDDEN');
  assert.equal(x.mutates.length, 0);
  const paused = await x.prepare(pmax({group: {status: 'PAUSED'}}));
  assert.equal(paused.success, true, JSON.stringify(paused).slice(0, 800));
});

// R2.5 M3, Q6 (the lead's decision of 2026-11-17): the pinned maxima follow Google's asset-requirements page as read again on
// 2026-11-17, in full and not through a summary. It allows up to 15 YOUTUBE_VIDEO per asset group; the 2026-10-08 transcription
// said 5, so a build Google accepts was refused here before any request. These run the build's own stateless rules.
const operationKinds = {
  campaign_budget_operation: 'campaignBudgets',
  campaign_operation: 'campaigns',
  campaign_criterion_operation: 'campaignCriteria',
  asset_operation: 'assets',
  asset_group_operation: 'assetGroups',
  asset_group_asset_operation: 'assetGroupAssets',
  asset_group_signal_operation: 'assetGroupSignals',
};
/** The build's own view of its operations (src/google-atomic-builds.ts pmaxOps), for the stateless rules. */
const buildOps = operations =>
  operations.map((raw, index) => {
    const key = Object.keys(raw)[0];
    return {
      index,
      kind: operationKinds[key],
      create: raw[key].create,
      ...(raw[key].create.resource_name ? {temp: raw[key].create.resource_name} : {}),
    };
  });
const videoLinks = n => Array.from({length: n}, (_, i) => link('customers/123/assets/' + (800 + i), 'YOUTUBE_VIDEO'));

test('a build links up to 15 videos, the most Google documents per asset group, and refuses a 16th', () => {
  assert.doesNotThrow(() => assertPmaxBuild(buildOps([...pmax(), ...videoLinks(15)])));
  assert.throws(
    () => assertPmaxBuild(buildOps([...pmax(), ...videoLinks(16)])),
    e =>
      assertRefused(e, 'PMAX_ASSET_MINIMUMS') &&
      e.details.outside_range.some(r => r.field_type === 'YOUTUBE_VIDEO' && r.max === 15 && r.found === 16),
  );
});

// R2.5 M3, G2 (the build side): TALL_PORTRAIT_MARKETING_IMAGE is a value of the pinned v25 AssetFieldType that a build refused as
// "not a Performance Max asset field type". Google's asset-requirements page (read 2026-11-17) gives it no count and no ratio,
// so a build accepts it as an image link that has no minimum and no place in the 20-image cap: counting too many would refuse
// a build Google accepts, counting too few risks only Google's own all-or-nothing refusal. Its ratio is UNVERIFIED (LV-14).
test('a build links tall portrait images: no minimum, outside the 20-image cap, and the asset must be an image', async t => {
  const assets = (from, n) => Array.from({length: n}, (_, i) => 'customers/123/assets/' + (from + i)),
    tall = n => assets(700, n).map(asset => link(asset, 'TALL_PORTRAIT_MARKETING_IMAGE')),
    portrait = asset => link(asset, 'PORTRAIT_MARKETING_IMAGE');
  // Twenty counted images (10 landscape, 9 square, 1 portrait) are at the cap; three tall portrait images do not count.
  const atCap = [...pmax({images: assets(600, 10), squares: assets(650, 9)}), portrait('customers/123/assets/660')];
  assert.doesNotThrow(() => assertPmaxBuild(buildOps(atCap)));
  assert.doesNotThrow(() => assertPmaxBuild(buildOps([...atCap, ...tall(3)])));
  // A 21st counted image is over the cap whatever tall portrait images the build has, and the count says 21, not 24.
  assert.throws(
    () => assertPmaxBuild(buildOps([...atCap, ...tall(3), portrait('customers/123/assets/661')])),
    e =>
      assertRefused(e, 'PMAX_ASSET_MINIMUMS') &&
      e.details.combined_over.length === 1 &&
      e.details.combined_over[0].found === 21 &&
      e.details.counts.TALL_PORTRAIT_MARKETING_IMAGE === 3,
  );
  // Through the review: an image links as tall portrait, a text asset does not, and nothing is sent either way.
  const x = setup();
  t.after(() => x.store.close());
  const ok = await x.prepare([...pmax(), link('customers/123/assets/501', 'TALL_PORTRAIT_MARKETING_IMAGE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  assert.match(JSON.stringify(ok.data), /"TALL_PORTRAIT_MARKETING_IMAGE":1/);
  const wrong = await x.prepare([...pmax(), link('customers/123/assets/504', 'TALL_PORTRAIT_MARKETING_IMAGE')]);
  assertRefused(wrong, 'PMAX_ASSET_TYPE_MISMATCH', {writes: x.mutates.length});
  assert.deepEqual([wrong.error.details.expected_type, wrong.error.details.actual_type], ['IMAGE', 'TEXT']);
  // Negative: another field type no asset group takes is still refused, naming the field types a build links.
  assert.throws(
    () => assertPmaxBuild(buildOps([...pmax(), link('customers/123/assets/501', 'AD_IMAGE')])),
    e => assertRefused(e, 'INVALID_GOOGLE_BUILD') && e.details.allowed.includes('TALL_PORTRAIT_MARKETING_IMAGE'),
  );
});

// R2.5 M3, L2-07 (package r25-m3-pmax): every refusal of the build's Performance Max rules names the operation it came from as
// `operation`, as its `field` already did, and carries the Google remedy that names the next call.
test('the refusals of a build’s Performance Max rules name their operation, and carry a remedy naming the next call', async t => {
  const x = setup();
  t.after(() => x.store.close());
  const indexOf = field => Number(/^mutate_operations\[(\d+)\]/.exec(field)[1]);
  const base = pmax();
  const textOp = {
    asset_operation: {create: {resource_name: 'customers/123/assets/-90', text_asset: {text: 'a\u0007b'}}},
  };
  const cases = [
    [[...base, textOp], 'INVALID_GOOGLE_BUILD'],
    [pmax({group: {final_urls: ['http://example.test/']}}), 'INVALID_GOOGLE_BUILD'],
    [pmax({group: {name: ' '}}), 'INVALID_GOOGLE_BUILD'],
    [pmax({campaign: {brand_guidelines_enabled: true}}), 'INVALID_GOOGLE_BUILD'],
    [
      pmax({campaign: {advertising_channel_type: 'SEARCH', manual_cpc: {}, maximize_conversions: undefined}}),
      'INVALID_GOOGLE_BUILD',
    ],
    [[...base, link('customers/123/assets/501', 'AD_IMAGE')], 'INVALID_GOOGLE_BUILD'],
    [[...base, link('customers/123/assets/501', 'MARKETING_IMAGE')], 'INVALID_GOOGLE_BUILD'],
    [
      [...base, link('customers/123/assets/501', 'MARKETING_IMAGE', 'customers/123/assetGroups/55')],
      'INVALID_GOOGLE_BUILD',
    ],
    [pmax({headlines: ['Acme', 'Buy Acme']}), 'PMAX_ASSET_MINIMUMS'],
    [
      pmax({headlines: ['Acme', 'Acme widgets', 'A headline far longer than thirty characters']}),
      'PMAX_ASSET_MINIMUMS',
    ],
  ];
  for (const [operations, code] of cases) {
    const r = await x.prepare(operations);
    assertRefused(r, code, {writes: x.mutates.length});
    assert.equal(typeof r.error.details.operation, 'number', JSON.stringify(r.error.details));
    if (r.error.details.field) assert.equal(r.error.details.operation, indexOf(r.error.details.field), r.error.message);
    assert.match(r.error.message, /^[A-Za-z]/);
  }
  // An existing asset of another type names the operation that links it, and the field that names the asset.
  const wrong = await x.prepare(pmax({images: ['customers/123/assets/504']}));
  assertRefused(wrong, 'PMAX_ASSET_TYPE_MISMATCH', {writes: x.mutates.length});
  const linking = JSON.parse(JSON.stringify(pmax({images: ['customers/123/assets/504']}))).findIndex(
    op => op.asset_group_asset_operation?.create.asset === 'customers/123/assets/504',
  );
  assert.equal(wrong.error.details.operation, linking);
  assert.equal(
    wrong.error.details.field,
    'mutate_operations[' + linking + '].asset_group_asset_operation.create.asset',
  );
  // The remedies.
  const minimums = await x.prepare(pmax({headlines: ['Acme', 'Buy Acme']}));
  assert.match(minimums.error.remedy.action, /^Nothing was sent to Google\./);
  assert.match(minimums.error.remedy.action, /details\.outside_range/);
  assert.match(minimums.error.remedy.action, /amcp_media/);
  assert.match(minimums.error.remedy.action, /amcp_write prepare/);
  assert.doesNotMatch(minimums.error.remedy.action, /preset/i, 'no amcp_media preset makes 1.91:1 until M10');
  assert.match(wrong.error.remedy.action, /details\.expected_type/);
  assert.match(wrong.error.remedy.action, /amcp_media/);
  assert.match(wrong.error.remedy.action, /amcp_write prepare/);
});
