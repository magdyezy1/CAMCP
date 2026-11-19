import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertRefused} from './helpers/assert-refused.js';
import {googleAssetGroupLinkState} from '../src/google-asset-links.js';

/**
 * R2.5 M3, G3 (package r25-m3-pmax): the precheck of an asset group's images and minimums in a one-service link review
 * (google_ads_v23_asset_group_asset_mutate_asset_group_assets). A link set without a 1.91:1 marketing image passed AMCP and was
 * refused by Google at execute (NOT_ENOUGH_MARKETING_IMAGE_ASSET): the review was spent for nothing. Prepare now reads the
 * campaign's channel, brand-guideline mode and Merchant Center account with the group, and the group's live advertiser links,
 * and refuses a review that would leave the group below a minimum (PMAX_ASSET_MINIMUMS), or link an image whose shape is
 * not its field type's (INVALID_ASSET_LINK). It never refuses on a maximum: the pinned maximums may be stale (Q6), and a check
 * of them on every link review would be a new gate built on a stale pin. The 1.91:1 preset of amcp_media is M10, so no message
 * names a preset.
 *
 * The synthetic customer is tests/fixtures/google-pmax-retail-build.mjs, loaded by its path as the other test file of this
 * package does (a test compiled from TypeScript lives in dist/tests).
 */
const fixture: any = await import(pathToFileURL(resolve('tests/fixtures/google-pmax-retail-build.mjs')).href);
const {pmaxRetailWorld, campaignRow, minimumLinks, assetName, at, ids} = fixture;
const group = at('assetGroups', '102');
const link = (asset: number, fieldType: string) => ({create: {assetGroup: group, asset: assetName(asset), fieldType}});
const linkName = (asset: number, fieldType: string) => at('assetGroupAssets', '102~' + asset + '~' + fieldType);
const remove = (asset: number, fieldType: string) => ({remove: linkName(asset, fieldType)});
const advertiser = (asset: number, fieldType: string) => ({
  resource_name: linkName(asset, fieldType),
  asset_group: group,
  asset: assetName(asset),
  field_type: fieldType,
  status: 'ENABLED',
  source: 'ADVERTISER',
});
/** The read of the live links of the groups a review targets (src/google-asset-links.ts). */
const liveLinks = (queries: string[]) =>
  queries.filter(q => /FROM asset_group_asset WHERE asset_group_asset\.asset_group IN /.test(q));
const nonRetail = () => campaignRow({shopping_setting: undefined});
const copy = (from: number, n: number) => ids.copy.slice(from, from + n) as number[];

test('the WF26 link set, 18 links and no 1.91:1 image, is refused at prepare with the 1.91:1 sentence and no request', async t => {
  // A retail group (a Merchant Center account is linked) of a brand-guideline campaign, so the business name and logo are the
  // campaign's and only the marketing image is short. The group has no advertiser link yet.
  const x = pmaxRetailWorld({campaign: campaignRow({brand_guidelines_enabled: true})});
  t.after(() => x.close());
  x.addGroup({id: '102'});
  const links = [
    ...copy(0, 11).map(id => link(id, 'HEADLINE')),
    ...copy(11, 3).map(id => link(id, 'LONG_HEADLINE')),
    ...copy(14, 2).map(id => link(id, 'DESCRIPTION')),
    link(ids.square[0], 'SQUARE_MARKETING_IMAGE'),
    link(ids.cta[0], 'CALL_TO_ACTION_SELECTION'),
  ];
  assert.equal(links.length, 18);
  const r = await x.prepareLinks(links);
  assertRefused(r, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  assert.match(r.error.message, /1\.91:1/);
  assert.match(r.error.message, /1200 x 628/);
  assert.match(r.error.message, /MARKETING_IMAGE/);
  assert.doesNotMatch(r.error.message, /preset/i, 'no amcp_media preset makes 1.91:1 until M10');
  assert.deepEqual(r.error.details.outside_range, [{field_type: 'MARKETING_IMAGE', min: 1, max: 20, found: 0}]);
  assert.equal(r.error.details.asset_group, group);
  assert.equal(r.error.details.counts.HEADLINE, 11);
  assert.equal(r.error.details.counts.MARKETING_IMAGE, undefined);
  assert.match(r.error.details.source, /performance-max\/asset-requirements$/);
  assert.match(r.error.remedy.action, /amcp_media/);
  assert.equal(x.log.mutates.length, 0, 'zero mutate requests');
  // With one 1200 x 628 image linked as MARKETING_IMAGE in the same review, it prepares, executes and verifies.
  const ok = await x.prepareLinks([...links, link(ids.landscape[0], 'MARKETING_IMAGE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  const done = await x.execute(ok);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
  assert.equal(x.log.mutates.length, 1);
  assert.equal((await x.verify(ok)).data.status, 'verified');
});

test('a review that leaves a group below a minimum is refused, whether it adds or removes', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: [...minimumLinks, ['HEADLINE', 3008]]});
  // The group holds 4 headlines: one removal leaves the minimum, two leave 2.
  const fine = await x.prepareLinks([remove(3008, 'HEADLINE')]);
  assert.equal(fine.success, true, JSON.stringify(fine).slice(0, 1200));
  const short = await x.prepareLinks([remove(3008, 'HEADLINE'), remove(3003, 'HEADLINE')]);
  assertRefused(short, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  assert.deepEqual(short.error.details.outside_range, [{field_type: 'HEADLINE', min: 3, max: 15, found: 2}]);
  assert.equal(short.error.details.counts.HEADLINE, 2);
  assert.doesNotMatch(short.error.message, /1\.91:1/, 'the 1.91:1 sentence is for a missing marketing image only');
  // Removing the one logo, the one business name or the only marketing image of a group that is not retail is refused too.
  for (const [asset, type] of [
    [9501, 'LOGO'],
    [3007, 'BUSINESS_NAME'],
    [9101, 'MARKETING_IMAGE'],
  ] as const) {
    const r = await x.prepareLinks([remove(asset, type)]);
    assertRefused(r, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
    assert.deepEqual(
      r.error.details.outside_range.map((o: any) => o.field_type),
      [type],
    );
  }
  assert.match(
    (await x.prepareLinks([remove(9101, 'MARKETING_IMAGE')])).error.message,
    /1\.91:1/,
    'a missing marketing image says so',
  );
});

test('a retail group with no advertiser link afterwards is accepted, one with some links meets every minimum', async t => {
  const retail = pmaxRetailWorld();
  t.after(() => retail.close());
  retail.addGroup({
    id: '102',
    links: [
      ['HEADLINE', 3001],
      ['HEADLINE', 3002],
    ],
  });
  // Removing both leaves no advertiser link: Google generates the minimum set, so the group is accepted.
  const empty = await retail.prepareLinks([remove(3001, 'HEADLINE'), remove(3002, 'HEADLINE')]);
  assert.equal(empty.success, true, JSON.stringify(empty).slice(0, 1200));
  // Removing one leaves a group with custom assets and not all minimums.
  const one = await retail.prepareLinks([remove(3001, 'HEADLINE')]);
  assertRefused(one, 'PMAX_ASSET_MINIMUMS', {writes: retail.log.mutates.length});
  // Negative: a group that is not retail is never accepted without its minimums, so emptying it is refused.
  const plain = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => plain.close());
  plain.addGroup({
    id: '102',
    links: [
      ['HEADLINE', 3001],
      ['HEADLINE', 3002],
    ],
  });
  const emptied = await plain.prepareLinks([remove(3001, 'HEADLINE'), remove(3002, 'HEADLINE')]);
  assertRefused(emptied, 'PMAX_ASSET_MINIMUMS', {writes: plain.log.mutates.length});
});

test('a retail group with no final URL is refused at its first custom link, before the minimums; with a final URL, or with links already, it is not', async t => {
  // Round 2, S4-5 (part 1). Google's retail page: a retail asset group may be left without custom assets, but "if you link custom
  // assets (other than HTML5 MEDIA_BUNDLE assets), you must set at least one final_urls on the AssetGroup and provide all minimum
  // required assets (including campaign-level brand assets if brand guidelines are enabled) in a single atomic request". The review
  // reads the group's final URLs with the group, and refuses the first custom links of a retail group that has none.
  const full = minimumLinks.map(([type, id]: [string, number]) => link(id, type));
  const without = pmaxRetailWorld();
  t.after(() => without.close());
  without.addGroup({id: '102', finalUrls: null});
  const refused = await without.prepareLinks(full);
  assertRefused(refused, 'INVALID_ASSET_PARENT', {writes: without.log.mutates.length});
  assert.deepEqual(
    [refused.error.details.operation, refused.error.details.field, refused.error.details.resource_name],
    [0, 'operations[0].create.assetGroup', group],
  );
  assert.match(refused.error.message, /no final URL/);
  assert.match(refused.error.message, /google_ads_v23_google_ads_mutate/);
  // The read of the group asks for its final URLs.
  const groupRead = without.log.queries.find((q: string) => / FROM asset_group WHERE /.test(q));
  assert.match(groupRead, /asset_group\.final_urls/);
  // The final URL is judged before the minimums: two headlines alone are refused for the missing URL.
  assertRefused(await without.prepareLinks([link(3001, 'HEADLINE'), link(3002, 'HEADLINE')]), 'INVALID_ASSET_PARENT', {
    writes: without.log.mutates.length,
  });
  // With a final URL the same review prepares (the minimums are all there).
  const withUrl = pmaxRetailWorld();
  t.after(() => withUrl.close());
  withUrl.addGroup({id: '102'});
  const ok = await withUrl.prepareLinks(full);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  // Negatives. A group that is not retail is not judged by the retail page's rule. A retail group that already holds custom links
  // is not getting its first ones. A review that only removes links links nothing.
  const plain = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => plain.close());
  plain.addGroup({id: '102', links: minimumLinks, finalUrls: null});
  assert.equal((await plain.prepareLinks([link(3009, 'HEADLINE')])).success, true);
  const holding = pmaxRetailWorld();
  t.after(() => holding.close());
  holding.addGroup({id: '102', links: minimumLinks, finalUrls: null});
  assert.equal((await holding.prepareLinks([link(3009, 'HEADLINE')])).success, true);
  const removing = pmaxRetailWorld();
  t.after(() => removing.close());
  removing.addGroup({id: '102', links: [['HEADLINE', 3001]], finalUrls: null});
  assert.equal((await removing.prepareLinks([remove(3001, 'HEADLINE')])).success, true);
});

test('a retail group whose only links are of a type with no minimum is still a group with links', async t => {
  // The state caps the counts of the types that have a minimum, so a link of another type (a video) is in no count: whether any
  // advertiser link would remain is kept apart (round 2, S1-1), and the retail rule reads that.
  const x = pmaxRetailWorld();
  t.after(() => x.close());
  for (const id of [9990, 9991])
    x.google.row('asset', {
      resource_name: assetName(id),
      type: 'YOUTUBE_VIDEO',
      source: 'ADVERTISER',
      name: 'DNU video ' + id,
    });
  x.addGroup({
    id: '102',
    links: [
      ['YOUTUBE_VIDEO', 9990],
      ['YOUTUBE_VIDEO', 9991],
    ],
  });
  // One video remains: custom assets without the minimums, which Google leaves unsupported on a retail group.
  const one = await x.prepareLinks([remove(9990, 'YOUTUBE_VIDEO')]);
  assertRefused(one, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  // Both go: no advertiser link remains, Google generates the minimum set, the group is accepted.
  const none = await x.prepareLinks([remove(9990, 'YOUTUBE_VIDEO'), remove(9991, 'YOUTUBE_VIDEO')]);
  assert.equal(none.success, true, JSON.stringify(none).slice(0, 1200));
});

test('brand guidelines lift the business name and logo minimums, and only those', async t => {
  const without = minimumLinks.filter((l: any) => !['BUSINESS_NAME', 'LOGO'].includes(l[0]));
  const on = pmaxRetailWorld({campaign: campaignRow({shopping_setting: undefined, brand_guidelines_enabled: true})});
  t.after(() => on.close());
  on.addGroup({id: '102', links: without});
  const ok = await on.prepareLinks([link(3008, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  const off = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => off.close());
  off.addGroup({id: '102', links: without});
  const refused = await off.prepareLinks([link(3008, 'HEADLINE')]);
  assertRefused(refused, 'PMAX_ASSET_MINIMUMS', {writes: off.log.mutates.length});
  assert.deepEqual(refused.error.details.outside_range.map((o: any) => o.field_type).sort(), ['BUSINESS_NAME', 'LOGO']);
  // The other minimums stay with brand guidelines on.
  const short = pmaxRetailWorld({campaign: campaignRow({shopping_setting: undefined, brand_guidelines_enabled: true})});
  t.after(() => short.close());
  // A group that lost one of its three headlines stays short when the review adds something else.
  short.addGroup({id: '102', links: without.filter((l: any) => l[1] !== 3003)});
  const stillShort = await short.prepareLinks([link(3009, 'DESCRIPTION')]);
  assertRefused(stillShort, 'PMAX_ASSET_MINIMUMS', {writes: short.log.mutates.length});
  assert.deepEqual(
    stillShort.error.details.outside_range.map((o: any) => o.field_type),
    ['HEADLINE'],
  );
});

test('with brand guidelines on, the business name and logos are the campaign’s: linking one to an asset group is refused at prepare, removing one is allowed', async t => {
  // Round 2, S3-1. Google refuses a BUSINESS_NAME, LOGO or LANDSCAPE_LOGO linked to an asset group when its campaign has brand
  // guidelines on (AssetLinkError.BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL: they "must be linked using CampaignAsset instead of
  // AssetGroupAsset"). The review that creates one is refused before it is spent, naming the operation, the field and the campaign
  // level; a link the group already holds, from before, can still be taken off.
  const without = minimumLinks.filter((l: any) => !['BUSINESS_NAME', 'LOGO'].includes(l[0]));
  const on = pmaxRetailWorld({campaign: campaignRow({shopping_setting: undefined, brand_guidelines_enabled: true})});
  t.after(() => on.close());
  on.addGroup({id: '102', links: without});
  const cases: [number, string][] = [
    [3030, 'BUSINESS_NAME'],
    [ids.logo[0], 'LOGO'],
    [ids.landscapeLogo[0], 'LANDSCAPE_LOGO'],
    // A logo of the wrong shape is refused for its level first: the level is the more basic fault.
    [ids.landscapeLogo[1], 'LOGO'],
  ];
  for (const [asset, fieldType] of cases) {
    const r = await on.prepareLinks([link(asset, fieldType)]);
    assertRefused(r, 'INVALID_ASSET_LINK', {writes: on.log.mutates.length});
    assert.equal(r.error.details.operation, 0);
    assert.equal(r.error.details.field, 'operations[0].create.fieldType');
    assert.equal(r.error.details.field_type, fieldType);
    assert.match(r.error.message, /BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL/);
    assert.match(r.error.message, /google_ads_v23_campaign_asset_mutate_campaign_assets/);
  }
  // It names the operation of the request, wherever it is.
  const second = await on.prepareLinks([link(3009, 'HEADLINE'), link(ids.logo[0], 'LOGO')]);
  assertRefused(second, 'INVALID_ASSET_LINK', {writes: on.log.mutates.length});
  assert.equal(second.error.details.operation, 1);
  assert.equal(second.error.details.field, 'operations[1].create.fieldType');
  // Negative: a link the group holds from before can be removed, and the other field types still link.
  const legacy = pmaxRetailWorld({
    campaign: campaignRow({shopping_setting: undefined, brand_guidelines_enabled: true}),
  });
  t.after(() => legacy.close());
  legacy.addGroup({id: '102', links: minimumLinks});
  const removed = await legacy.prepareLinks([remove(3007, 'BUSINESS_NAME'), remove(9501, 'LOGO')]);
  assert.equal(removed.success, true, JSON.stringify(removed).slice(0, 1200));
  assert.equal((await legacy.prepareLinks([link(3009, 'HEADLINE')])).success, true);
  // Negative: with brand guidelines off the same field types are the group's own and are accepted.
  const off = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => off.close());
  off.addGroup({id: '102', links: minimumLinks});
  for (const [asset, fieldType] of [
    [3030, 'BUSINESS_NAME'],
    [ids.square[4], 'LOGO'],
    [ids.landscapeLogo[0], 'LANDSCAPE_LOGO'],
  ] as [number, string][]) {
    const r = await off.prepareLinks([link(asset, fieldType)]);
    assert.equal(r.success, true, fieldType + ' ' + JSON.stringify(r).slice(0, 600));
  }
});

test('automatic links neither count towards a minimum nor change the review’s state', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  const automatic = [
    ['HEADLINE', 3020],
    ['HEADLINE', 3021],
    ['HEADLINE', 3022],
  ];
  x.addGroup({id: '102', links: minimumLinks, automatic});
  // Three automatic headlines do not rescue a group whose advertiser headlines would fall to two.
  const short = await x.prepareLinks([remove(3003, 'HEADLINE')]);
  assertRefused(short, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  assert.equal(short.error.details.counts.HEADLINE, 2);
  // A review that stands is not changed by Google's own rows changing between prepare and execute.
  const ok = await x.prepareLinks([link(3009, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  x.db.asset_group_asset.push({...advertiser(3023, 'HEADLINE'), source: 'AUTOMATICALLY_CREATED'});
  x.db.asset_group_asset.splice(
    x.db.asset_group_asset.findIndex((r: any) => r.resource_name === linkName(3020, 'HEADLINE')),
    1,
  );
  const done = await x.execute(ok);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
  assert.equal(x.log.mutates.length, 1);
});

test('another person’s link added above a minimum between prepare and execute does not change the state: the review executes', async t => {
  // Round 2, S1-1 (the lead's option A). The state of the live links holds only what the verdict depends on: each count capped at
  // its minimum, and whether any advertiser link would remain. A link added to a group that already meets its minimums, or a
  // link whose status changes, changes none of it. Before, the state held every link with its status and the pixel size of its
  // image, so this was STATE_CHANGED: the review of the first part of a long request changed the group the next part had read.
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  const ok = await x.prepareLinks([link(3009, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  x.db.asset_group_asset.push(advertiser(3010, 'HEADLINE'));
  x.db.asset_group_asset.find((r: any) => r.resource_name === linkName(3001, 'HEADLINE')).status = 'PAUSED';
  const done = await x.execute(ok);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1200));
  assert.equal(x.log.mutates.length, 1);
});

test('another person’s removal that leaves a type below its minimum between prepare and execute is refused, and nothing is sent', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  // The review only adds a description: valid on the group it read.
  const ok = await x.prepareLinks([link(3024, 'DESCRIPTION')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  // Someone removes one of the group's three headlines: it holds two, which Google refuses.
  x.db.asset_group_asset.splice(
    x.db.asset_group_asset.findIndex((r: any) => r.resource_name === linkName(3003, 'HEADLINE')),
    1,
  );
  const refused = await x.execute(ok);
  assertRefused(refused, ['PMAX_ASSET_MINIMUMS', 'STATE_CHANGED'], {writes: x.log.mutates.length});
  assert.equal(
    refused.error.code,
    'PMAX_ASSET_MINIMUMS',
    'the minimums are judged again at execute, before the hash is compared',
  );
  assert.deepEqual(refused.error.details.outside_range, [{field_type: 'HEADLINE', min: 3, max: 15, found: 2}]);
});

test('a request of 27 links to one asset group, split 25 and 2 under one approval, sends both parts', async t => {
  // Round 2, S1-1. Write groups split a request of more than 25 records into parts that are ordinary reviews, prepared together
  // and executed in order under one approval. Each part hashes its own state, so a part must not see the links the part before it
  // adds as a change: with the state of before round 2, part 2 was STATE_CHANGED after part 1 had been applied (half applied).
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  // Within the pinned maximums: 15 headlines, 5 long headlines, 5 descriptions, 5 marketing and 5 square marketing images.
  const operations = [
    ...copy(7, 12).map(id => link(id, 'HEADLINE')),
    ...copy(19, 4).map(id => link(id, 'LONG_HEADLINE')),
    ...copy(23, 3).map(id => link(id, 'DESCRIPTION')),
    ...ids.landscape.slice(1).map((id: number) => link(id, 'MARKETING_IMAGE')),
    ...ids.square.slice(1).map((id: number) => link(id, 'SQUARE_MARKETING_IMAGE')),
  ];
  assert.equal(operations.length, 27);
  const review = await x.prepareLinks(operations);
  assert.equal(review.success, true, JSON.stringify(review).slice(0, 1200));
  assert.equal(review.data.parts.length, 2, 'two parts under one approval');
  const done = await x.execute(review);
  assert.equal(done.success, true, JSON.stringify(done).slice(0, 1500));
  assert.deepEqual(
    x.log.mutates.map((m: any) => m.operations.length),
    [25, 2],
    'both parts are sent',
  );
  assert.equal(x.db.asset_group_asset.filter((r: any) => r.asset_group === group).length, minimumLinks.length + 27);
});

test('the minimums are judged again at execute, on the state read then, and nothing is sent', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({
    id: '102',
    links: [
      ['HEADLINE', 3001],
      ['HEADLINE', 3002],
      ['HEADLINE', 3003],
      ...minimumLinks.filter((l: any) => l[0] !== 'HEADLINE'),
    ],
  });
  // At prepare the group holds three headlines and this review adds a fourth: valid.
  const ok = await x.prepareLinks([link(3009, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  // Before it is executed, someone removes two headlines: the group the review would leave holds two, which Google refuses.
  for (const asset of [3001, 3002])
    x.db.asset_group_asset.splice(
      x.db.asset_group_asset.findIndex((r: any) => r.resource_name === linkName(asset, 'HEADLINE')),
      1,
    );
  const refused = await x.execute(ok);
  assertRefused(refused, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  assert.deepEqual(refused.error.details.outside_range, [{field_type: 'HEADLINE', min: 3, max: 15, found: 2}]);
});
test('the image a review links must have the shape of its field type, within a wide tolerance; tall portrait has no ratio check', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  const size = (id: number, width: number, height: number) =>
    x.google.row('asset', {
      resource_name: assetName(id),
      type: 'IMAGE',
      source: 'ADVERTISER',
      image_asset: {full_size: {width_pixels: String(width), height_pixels: String(height)}},
    });
  size(9950, 1200, 627);
  size(9951, 1200, 630);
  size(9952, 1200, 600);
  x.addGroup({id: '102', links: minimumLinks});
  const cases: [number, string, string | undefined][] = [
    // asset, field type, the expected ratio when it is refused
    [ids.landscape[1], 'MARKETING_IMAGE', undefined],
    [9950, 'MARKETING_IMAGE', undefined],
    [9951, 'MARKETING_IMAGE', undefined],
    [9952, 'MARKETING_IMAGE', '1.91:1'],
    [ids.wide[0], 'MARKETING_IMAGE', '1.91:1'],
    [ids.square[1], 'MARKETING_IMAGE', '1.91:1'],
    [ids.square[2], 'SQUARE_MARKETING_IMAGE', undefined],
    [ids.landscape[2], 'SQUARE_MARKETING_IMAGE', '1:1'],
    [ids.portrait[0], 'PORTRAIT_MARKETING_IMAGE', undefined],
    [ids.square[3], 'PORTRAIT_MARKETING_IMAGE', '4:5'],
    [ids.square[4], 'LOGO', undefined],
    [ids.landscapeLogo[0], 'LOGO', '1:1'],
    [ids.landscapeLogo[0], 'LANDSCAPE_LOGO', undefined],
    [ids.logo[0], 'LANDSCAPE_LOGO', '4:1'],
    [ids.wide[0], 'TALL_PORTRAIT_MARKETING_IMAGE', undefined],
  ];
  for (const [asset, fieldType, refused] of cases) {
    const r = await x.prepareLinks([link(asset, fieldType)]);
    if (refused === undefined)
      assert.equal(r.success, true, fieldType + ' ' + asset + ' ' + JSON.stringify(r).slice(0, 600));
    else {
      assertRefused(r, 'INVALID_ASSET_LINK', {writes: x.log.mutates.length});
      assert.equal(r.error.details.operation, 0);
      assert.equal(r.error.details.field, 'operations[0].create.asset');
      assert.equal(r.error.details.field_type, fieldType);
      assert.equal(r.error.details.expected_ratio, refused);
      assert.equal(typeof r.error.details.width_pixels, 'number');
      assert.equal(typeof r.error.details.height_pixels, 'number');
      assert.match(r.error.remedy.action, /details\.expected_ratio/);
    }
  }
  // The 16:9 image refused as a marketing image names its size.
  const wide = await x.prepareLinks([link(ids.wide[0], 'MARKETING_IMAGE')]);
  assert.deepEqual([wide.error.details.width_pixels, wide.error.details.height_pixels], [1920, 1080]);
  // An image Google has not measured (no pixel size) is not judged here: Google decides, as before.
  x.google.row('asset', {resource_name: assetName(9953), type: 'IMAGE', source: 'ADVERTISER'});
  assert.equal((await x.prepareLinks([link(9953, 'MARKETING_IMAGE')])).success, true);
});

test('a review whose read of the live links is paged is refused: an unread page may hold the missing link', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  x.state.page = /FROM asset_group_asset WHERE asset_group_asset\.asset_group IN /;
  assertRefused(await x.prepareLinks([link(3009, 'HEADLINE')]), 'INCOMPLETE_STATE', {writes: x.log.mutates.length});
});

test('the precheck never refuses on a maximum: a group above a pinned maximum prepares', async t => {
  // Negative test of the lead's decision (2026-11-17): the pinned maximums may be stale, so a link review is judged on minimums only.
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  // 20 more headlines: 23 in all, above the pinned maximum of 15. A build would refuse that count; a link review does not.
  const many = await x.prepareLinks(copy(7, 20).map(id => link(id, 'HEADLINE')));
  assert.equal(many.success, true, JSON.stringify(many).slice(0, 1200));
  // Nor are the videos, the combined image cap or the logo cap judged.
  const images = await x.prepareLinks([
    ...ids.landscape.slice(1).map((id: number) => link(id, 'MARKETING_IMAGE')),
    ...ids.square.slice(1).map((id: number) => link(id, 'SQUARE_MARKETING_IMAGE')),
    ...ids.portrait.map((id: number) => link(id, 'PORTRAIT_MARKETING_IMAGE')),
    ...ids.landscapeLogo.map((id: number) => link(id, 'LANDSCAPE_LOGO')),
  ]);
  assert.equal(images.success, true, JSON.stringify(images).slice(0, 1200));
});

test('a review that only changes link statuses does not change what the group holds, so it is not judged', async t => {
  // The group already holds fewer assets than a valid group (someone else's doing): pausing one link neither causes that nor
  // makes it worse, so this review is not refused for it. Adding or removing a link in the same group still is.
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({
    id: '102',
    links: [
      ['HEADLINE', 3001],
      ['HEADLINE', 3002],
    ],
  });
  const pause = await x.prepareLinks([
    {update: {resourceName: linkName(3001, 'HEADLINE'), status: 'PAUSED'}, updateMask: 'status'},
  ]);
  assert.equal(pause.success, true, JSON.stringify(pause).slice(0, 1200));
  assertRefused(await x.prepareLinks([link(3003, 'HEADLINE')]), 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
});
test('a group whose campaign the read does not show is not judged: no new gate on what is unknown', async t => {
  const x = pmaxRetailWorld({campaign: null});
  t.after(() => x.close());
  x.addGroup({id: '102'});
  const r = await x.prepareLinks([link(3001, 'HEADLINE'), link(3002, 'HEADLINE')]);
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1200));
});

test('the precheck costs one read of the live links at prepare and one at execute, and the read asks for no pixel size', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  const ok = await x.prepareLinks([link(3009, 'HEADLINE'), link(3010, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  assert.equal(liveLinks(x.log.queries).length, 1, 'one read at prepare, for every group the review targets');
  const campaignRead = x.log.queries.find((q: string) => / FROM asset_group WHERE /.test(q));
  for (const field of ['advertising_channel_type', 'brand_guidelines_enabled', 'shopping_setting.merchant_id'])
    assert.match(campaignRead, new RegExp('campaign\\.' + field.replace('.', '\\.')));
  const live = liveLinks(x.log.queries)[0]!;
  for (const field of ['resource_name', 'asset', 'field_type', 'status', 'source'])
    assert.match(live, new RegExp('asset_group_asset\\.' + field));
  // Round 2, S1-1: the ratio check uses the images the review itself links (read as assets), and the state no longer keeps the
  // pixel sizes of the links the group holds, so this read does not select them.
  assert.doesNotMatch(live, /image_asset/);
  assert.match(live, /asset_group_asset\.status IN \('ENABLED', 'PAUSED'\)/);
  // At prepare: the links by name (the creates), the group with its campaign, the text assets, and the live links: 4 searches,
  // one more than before this package. Execute reads the same four again, then sends the one mutate.
  const searches = () => x.log.requests.filter((r: any) => r.path.endsWith(':search')).length;
  assert.equal(searches(), 4, 'searches at prepare');
  assert.equal((await x.execute(ok)).success, true);
  assert.equal(liveLinks(x.log.queries).length, 2, 'one read at execute');
  assert.equal(searches(), 8, 'searches after execute');
  assert.equal(x.log.mutates.length, 1);
});

test('a review that targets two asset groups reads their live links once and judges each group on its own', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: [...minimumLinks, ['HEADLINE', 3008]]});
  x.addGroup({id: '103', links: minimumLinks});
  const other = (asset: number, fieldType: string) => ({
    remove: at('assetGroupAssets', '103~' + asset + '~' + fieldType),
  });
  // The first group loses its extra headline and is still valid; the second loses one of its three and is not.
  const short = await x.prepareLinks([remove(3008, 'HEADLINE'), other(3003, 'HEADLINE')]);
  assertRefused(short, 'PMAX_ASSET_MINIMUMS', {writes: x.log.mutates.length});
  assert.equal(short.error.details.asset_group, at('assetGroups', '103'));
  assert.deepEqual(short.error.details.outside_range, [{field_type: 'HEADLINE', min: 3, max: 15, found: 2}]);
  // One read of the live links answers for both groups, however many a review names.
  assert.equal(liveLinks(x.log.queries).length, 1);
  assert.match(
    liveLinks(x.log.queries)[0]!,
    /asset_group IN \('customers\/123\/assetGroups\/102', 'customers\/123\/assetGroups\/103'\)/,
  );
  // Valid for both: it prepares.
  const ok = await x.prepareLinks([
    remove(3008, 'HEADLINE'),
    link(3009, 'HEADLINE'),
    other(3003, 'HEADLINE'),
    {create: {assetGroup: at('assetGroups', '103'), asset: assetName(3010), fieldType: 'HEADLINE'}},
  ]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
});

test('the state of an asset group’s live links caps each count at its minimum and keeps no link, status or size', () => {
  // Round 2, S1-1. For each group and each field type that has a minimum: min(advertiser links this review does not remove, the
  // minimum with brand guidelines off); and whether any advertiser link would remain, for the retail rule. Google's automatic
  // links are not the advertiser's. A count below its minimum is not capped, so a refusal reports it exactly.
  const row = (asset: number, fieldType: string, source = 'ADVERTISER', status = 'ENABLED') => ({
    assetGroupAsset: {resourceName: linkName(asset, fieldType), asset: assetName(asset), fieldType, status, source},
  });
  const read: any = {
    accountId: '123',
    googleAssetGroupLinkState: {groups: [group], removed: [linkName(3003, 'HEADLINE')]},
  };
  const rows = [
    ...copy(0, 5).map(id => row(id, 'HEADLINE')), // five headlines; this review removes one, four remain: capped at the minimum, 3
    row(3010, 'LONG_HEADLINE'),
    row(3011, 'DESCRIPTION', 'ADVERTISER', 'PAUSED'), // one of the two descriptions: below its minimum, not capped; PAUSED counts
    row(3012, 'DESCRIPTION', 'AUTOMATICALLY_CREATED'), // Google's own: not the advertiser's
    row(9101, 'MARKETING_IMAGE'),
    row(9601, 'LANDSCAPE_LOGO'), // a type with no minimum: no entry of its own, but it is a link that remains
  ];
  assert.deepEqual(googleAssetGroupLinkState(read, {results: rows} as any), {
    asset_group_link_counts: [
      {
        asset_group: group,
        counts: {
          HEADLINE: 3,
          LONG_HEADLINE: 1,
          DESCRIPTION: 1,
          BUSINESS_NAME: 0,
          MARKETING_IMAGE: 1,
          SQUARE_MARKETING_IMAGE: 0,
          LOGO: 0,
        },
        has_other_links: true,
      },
    ],
  });
  // Nothing of a link, its status or its image size is kept: the same counts come from other links of the same types.
  const other = [
    ...copy(10, 9).map(id => row(id, 'HEADLINE', 'ADVERTISER', 'PAUSED')),
    row(3020, 'LONG_HEADLINE'),
    row(3021, 'LONG_HEADLINE'),
    row(3022, 'DESCRIPTION'),
    row(3023, 'MARKETING_IMAGE'),
    row(3024, 'MARKETING_IMAGE'),
    row(9602, 'LOGO'),
  ];
  const kept = googleAssetGroupLinkState(read, {results: other} as any) as any;
  assert.deepEqual(kept.asset_group_link_counts[0].counts, {
    HEADLINE: 3,
    LONG_HEADLINE: 1,
    DESCRIPTION: 1,
    BUSINESS_NAME: 0,
    MARKETING_IMAGE: 1,
    SQUARE_MARKETING_IMAGE: 0,
    LOGO: 1,
  });
  assert.doesNotMatch(JSON.stringify(kept), /ENABLED|PAUSED|width|height|assets\//);
  // No advertiser link would remain: only Google's automatic links, or only the link this review removes.
  const nothing: any = {
    accountId: '123',
    googleAssetGroupLinkState: {groups: [group], removed: [linkName(3001, 'HEADLINE')]},
  };
  for (const results of [[row(3001, 'HEADLINE')], [row(3030, 'HEADLINE', 'AUTOMATICALLY_CREATED')], []])
    assert.equal(
      (googleAssetGroupLinkState(nothing, {results} as any) as any).asset_group_link_counts[0].has_other_links,
      false,
    );
  // A state that was projected already, as a frozen review carries it at execute, stays as it is.
  const frozen = {asset_group_link_counts: [{asset_group: group, counts: {HEADLINE: 2}, has_other_links: true}]};
  assert.deepEqual(googleAssetGroupLinkState(nothing, frozen as any), frozen);
});
