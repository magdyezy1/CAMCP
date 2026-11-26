import test from 'node:test';
import assert from 'node:assert/strict';
import {googleImageUsageFixture} from './fixtures/google-image-usage-data.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};

test('Google original image links preserve complete native identities, independent statuses and reader authority', async t => {
  const f = googleImageUsageFixture(t),
    before = f.store.documents(f.actor.tenantId, 'workspace_asset').length;
  const view = ok(await f.service.call('amcp_media', {action: 'asset', asset_id: 'asset-143'}, f.actor));
  assert.equal(view.native_usage_supported, true);
  assert.equal(view.native_usage_kind, 'google_image_links');
  const result = ok(await f.call());
  assert.equal(result.rows[0].ad_id, '9007199254740993');
  assert.equal(result.rows[0].ad_resource_name, 'customers/100/adGroupAds/20~9007199254740993');
  assert.equal(result.rows[0].media_id, 'customers/100/assets/700');
  assert.equal(result.rows[0].field_type, 'MARKETING_IMAGE');
  assert.equal(result.rows[0].link_enabled, true);
  assert.equal(result.rows[0].configured_status, 'PAUSED');
  assert.equal(result.complete, true);
  assert.equal(result.has_more, false);
  assert.equal(result.next_cursor, null);
  assert.equal(result.examined_links, 1);
  assert.equal(result.unresolved_links, 0);
  assert.equal(result.removed_links, 0);
  assert.equal(result.collection.requests, 6);
  assert.equal(result.source_references.length, 6);
  assert.match(result.meaning, /Responsive Display, Performance Max/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE-|source_url|accessToken|access_token|developerToken|provider_response/,
  );
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'report_snapshot').length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'workspace_asset').length, before);
  assert.equal(result.provider_mutations, 0);
  assert.equal(result.saved_snapshot, false);
});

test('omitted flags and unsupported types stay unresolved while explicit removed links are counted separately', async t => {
  const f = googleImageUsageFixture(t);
  f.rows.push(f.row('2'), f.row('3'), f.row('4'), f.row('5'), f.row('6', 'HEADLINE'));
  delete f.rows[1].adGroupAdAssetView.enabled;
  f.rows[2].adGroupAdAssetView.enabled = false;
  f.rows[3].adGroupAd.ad.type = 'RESPONSIVE_DISPLAY_AD';
  f.rows[4].adGroupAdAssetView.fieldType = 'UNKNOWN';
  const r = ok(await f.call());
  assert.equal(r.rows.length, 1);
  assert.equal(r.examined_links, 6);
  assert.equal(r.unresolved_links, 4);
  assert.equal(r.removed_links, 1);
  assert.equal(r.examined_ads, 6);
});

test('multiple selected roles for one exact ad remain distinct and native reordering does not invalidate evidence', async t => {
  const f = googleImageUsageFixture(t);
  f.rows.push(f.row('9007199254740993', 'SQUARE_MARKETING_IMAGE'));
  f.setHook(({resource, pass, body}) => {
    if (resource === 'ad_group_ad_asset_view' && pass === 2) body.results.reverse();
    return body;
  });
  const r = ok(await f.call());
  assert.equal(r.rows.length, 2);
  assert.equal(r.examined_ads, 1);
  assert.equal(r.examined_links, 2);
});

test('unqualified Google receipts and caller-supplied scope or continuations refuse before native requests', async t => {
  for (const variation of [
    'video',
    'asset',
    'hash',
    'account',
    'scope',
    'cursor',
    'foreign',
    'invalid_limit',
    'extra_scope',
  ]) {
    const f = googleImageUsageFixture(t);
    let extra = {};
    if (variation === 'video') f.asset.media_type = 'video';
    if (variation === 'asset') f.asset.media_id = '700';
    if (variation === 'hash') f.asset.sha256 = '';
    if (variation === 'account') f.asset.media_id = 'customers/200/assets/700';
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-143', f.asset);
    if (variation === 'scope')
      f.store.putConnection(
        f.admin,
        {...f.connection, scopes: []},
        {accessToken: 'synthetic', developerToken: 'synthetic'},
      );
    if (variation === 'cursor') extra.cursor = 'opaque';
    if (variation === 'foreign') extra.asset_id = 'foreign';
    if (variation === 'invalid_limit') extra.limit = 1001;
    if (variation === 'extra_scope') extra.account_id = '200';
    const r = await f.call(extra);
    assert.equal(r.success, false, variation);
    assert.equal(f.requests.length, 0, variation);
  }
});

test('inexact native hierarchy, duplicate links, malformed types and unselected data refuse the entire collection', async t => {
  for (const variation of [
    'customer',
    'manager',
    'missing_manager',
    'asset',
    'type',
    'ad',
    'numeric_id',
    'campaign',
    'group',
    'role',
    'enabled',
    'removed',
    'duplicate',
    'private',
    'unsafe_name',
  ]) {
    const f = googleImageUsageFixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'customer') {
        if (variation === 'customer') body.results[0].customer.id = '200';
        if (variation === 'manager') body.results[0].customer.manager = true;
        if (variation === 'missing_manager') delete body.results[0].customer.manager;
      }
      if (resource === 'asset') {
        if (variation === 'asset') body.results[0].asset.resourceName = 'customers/100/assets/701';
        if (variation === 'type') body.results[0].asset.type = 'YOUTUBE_VIDEO';
      }
      if (resource === 'ad_group_ad_asset_view') {
        const row = body.results[0];
        if (variation === 'ad') row.adGroupAdAssetView.adGroupAd = 'customers/200/adGroupAds/20~2';
        if (variation === 'numeric_id') row.adGroupAd.ad.id = 9007199254740992;
        if (variation === 'campaign') row.adGroup.campaign = 'customers/100/campaigns/11';
        if (variation === 'group') row.adGroupAd.adGroup = 'customers/100/adGroups/21';
        if (variation === 'role') row.adGroupAdAssetView.fieldType = 'UNQUALIFIED';
        if (variation === 'enabled') row.adGroupAdAssetView.enabled = 'true';
        if (variation === 'removed') row.adGroupAd.status = 'REMOVED';
        if (variation === 'duplicate') {
          body.results.push(structuredClone(row));
          body.totalResultsCount = '2';
        }
        if (variation === 'private') row.adGroupAd.ad.description = 'PRIVATE-DATA';
        if (variation === 'unsafe_name') row.adGroupAd.ad.name = 'unpaired\ud800';
      }
      return body;
    });
    const out = await f.call();
    assert.equal(out.success, false, variation);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|Native <img|source_references|customers\/200/);
  }
});

// r25-mf-goals (2026-11-25): Google returns the resource name of the FROM resource whether or not the query selects it, so a live
// customer row holds `resourceName` beside the two selected fields. It is the upload customer's own name, or the row is refused.
test('the upload customer row stays exact beside its resource name: another customer, a malformed name or an unselected field refuses the collection', async t => {
  const served = [],
    live = googleImageUsageFixture(t);
  live.setHook(({resource, body}) => {
    if (resource === 'customer') served.push(Object.keys(body.results[0].customer));
    return body;
  });
  assert.equal(ok(await live.call()).complete, true, 'the control: the live shape is accepted');
  assert.equal(served.length, 2, 'both passes read the customer');
  assert.ok(
    served.every(keys => keys.includes('resourceName')),
    'and each answer carried its name',
  );
  for (const customer of [
    {resourceName: 'customers/200'},
    {resourceName: ''},
    {resourceName: 100},
    {resourceName: null},
    {descriptiveName: 'PRIVATE-NAME'},
    {currencyCode: 'USD'},
  ]) {
    const f = googleImageUsageFixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'customer') Object.assign(body.results[0].customer, customer);
      return body;
    });
    const out = await f.call();
    assertRefused(out, 'ASSET_USAGE_INVALID_RESPONSE');
    assert.equal(f.requests.length, 1, JSON.stringify(customer) + ': nothing is read after the refused customer');
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|source_references|customers\/200/);
  }
});

test('changed repeated native links or bracketed asset/customer observations cannot return complete evidence', async t => {
  for (const variation of ['link', 'asset', 'customer']) {
    const f = googleImageUsageFixture(t);
    f.setHook(({resource, pass, body}) => {
      if (pass === 2 && resource === 'ad_group_ad_asset_view' && variation === 'link')
        body.results[0].adGroupAdAssetView.enabled = false;
      if (pass === 2 && resource === 'asset' && variation === 'asset') body.results[0].asset.type = 'TEXT';
      if (pass === 2 && resource === 'customer' && variation === 'customer') body.results[0].customer.manager = true;
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false, variation);
    assert.doesNotMatch(JSON.stringify(r), /source_references|Native <img/);
  }
});

test('current key, permission, credential and original image metadata withdrawal stops follow-up reads', async t => {
  for (const variation of ['key', 'scope', 'credential', 'asset', 'metadata']) {
    const f = googleImageUsageFixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'ad_group_ad_asset_view') {
        if (variation === 'key') f.store.revokeKey(f.key);
        if (variation === 'scope')
          f.store.putConnection(
            f.admin,
            {...f.connection, scopes: []},
            {accessToken: 'synthetic', developerToken: 'synthetic'},
          );
        if (variation === 'credential')
          f.store.putConnection(f.admin, f.connection, {accessToken: 'rotated', developerToken: 'synthetic'});
        if (variation === 'asset')
          f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-143', {...f.asset, sha256: 'c'.repeat(64)});
        if (variation === 'metadata')
          f.store.putDocument(f.actor.tenantId, 'creative_metadata', 'asset-143', {name: 'Changed', tags: []});
      }
      return body;
    });
    const r = await f.call();
    assert.equal(r.success, false, variation);
    assert.equal(f.requests.length, 3, variation);
    assert.doesNotMatch(JSON.stringify(r), /source_references|Native <img|PRIVATE-/);
  }
});

test('complete collection limits, nonterminal pages and result count gaps refuse partial inventories', async t => {
  for (const variation of ['overflow', 'count_overflow', 'gap', 'page', 'oversize']) {
    const f = googleImageUsageFixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'ad_group_ad_asset_view') {
        if (variation === 'overflow') {
          body.results.push(f.row('2'));
          body.totalResultsCount = '2';
        }
        if (variation === 'count_overflow') body.totalResultsCount = '1001';
        if (variation === 'gap') body.totalResultsCount = '2';
        if (variation === 'page') body.nextPageToken = 'PRIVATE-NATIVE-TOKEN';
        if (variation === 'oversize') body.results[0].adGroupAd.ad.name = 'x'.repeat(4200000);
      }
      return body;
    });
    const r = await f.call({limit: variation === 'overflow' ? 1 : 50});
    assert.equal(r.success, false, variation);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|source_references|Native <img/);
  }
});

test('explicit 1000-link bounded selection and an empty supported view retain separate completeness limits', async t => {
  const f = googleImageUsageFixture(t);
  f.rows.splice(0, 1, ...Array.from({length: 1000}, (_, i) => f.row(String(i + 1))));
  const r = ok(await f.call({limit: 1000}));
  assert.equal(r.rows.length, 1000);
  assert.equal(r.collection.rows, 2004);
  assert.equal(r.selected_limit, 1000);
  assert.match(f.requests[2].query, /LIMIT 1001$/);
  assert.ok(f.requests.every(x => !/page_size|pageSize|metrics\./.test(x.query)));
  const empty = googleImageUsageFixture(t, {rows: []}),
    out = ok(await empty.call());
  assert.equal(out.rows.length, 0);
  assert.equal(out.complete, true);
  assert.match(out.meaning, /complete all-format absence/);
});

test('native transient retries consume the shared budget and do not change upload or write authority', async t => {
  const f = googleImageUsageFixture(t);
  f.setHook(({resource, pass, body}) =>
    resource === 'ad_group_ad_asset_view' && pass === 1 ? new Response('temporary', {status: 503}) : body,
  );
  const r = ok(await f.call());
  assert.equal(r.collection.requests, 7);
  assert.equal(f.requests.length, 7);
  assert.equal(r.rows.length, 1);
  assert.equal(r.provider_mutations, 0);
});
