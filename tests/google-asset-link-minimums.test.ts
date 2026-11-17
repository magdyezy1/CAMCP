import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertRefused} from './helpers/assert-refused.js';

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

test('another person’s link added between prepare and execute gives STATE_CHANGED, and nothing is sent', async t => {
  const x = pmaxRetailWorld({campaign: nonRetail()});
  t.after(() => x.close());
  x.addGroup({id: '102', links: minimumLinks});
  const ok = await x.prepareLinks([link(3009, 'HEADLINE')]);
  assert.equal(ok.success, true, JSON.stringify(ok).slice(0, 1200));
  x.db.asset_group_asset.push(advertiser(3010, 'HEADLINE'));
  assertRefused(await x.execute(ok), 'STATE_CHANGED', {writes: x.log.mutates.length});
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

test('the precheck costs one read of the live links at prepare and one at execute, and joins the state the review hashes', async t => {
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
  assert.match(live, /asset\.image_asset\.full_size\.width_pixels/);
  assert.match(live, /asset\.image_asset\.full_size\.height_pixels/);
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
