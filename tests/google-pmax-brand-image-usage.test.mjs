import test from 'node:test';
import assert from 'node:assert/strict';
import {googleImageUsageFixture} from './fixtures/google-image-usage-data.mjs';
import {metaAssetUsageFixture} from './fixtures/meta-asset-usage-data.mjs';
import {workflowOutcome} from '../dist/src/workflow-outcomes.js';
const fixture = t => googleImageUsageFixture(t, {referenceView: 'performance_max_brand'}),
  input = {reference_view: 'performance_max_brand'};
const ok = out => {
  assert.equal(out.success, true, JSON.stringify(out));
  return out.data;
};

test('Google image handoffs carry only qualified exact views and bounded numeric limits on the original asset', () => {
  const asset = 'original?&reference_view=all',
    base = {
      record_kind: 'native_asset_references',
      asset_id: asset,
      platform: 'google_ads',
      reference_view: 'performance_max_brand',
      qualified_view: 'campaign_asset',
      complete: true,
      selected_limit: 200,
    };
  const out = workflowOutcome('amcp_media', base),
    url = new URL(out.website_path, 'https://synthetic.invalid');
  assert.equal(url.pathname, '/media');
  assert.equal(url.searchParams.get('asset_id'), asset);
  assert.equal(url.searchParams.get('reference_view'), 'performance_max_brand');
  assert.equal(url.searchParams.get('reference_limit'), '200');
  assert.equal([...url.searchParams].length, 3);
  for (const change of [
    {platform: 'meta'},
    {complete: false},
    {reference_view: 'all'},
    {qualified_view: 'asset_group_asset'},
    {selected_limit: 0},
    {selected_limit: 1001},
    {selected_limit: '200'},
  ]) {
    const refused = new URL(
      workflowOutcome('amcp_media', {...base, ...change}).website_path,
      'https://synthetic.invalid',
    );
    assert.equal(refused.searchParams.get('asset_id'), asset);
    assert.equal(refused.searchParams.has('reference_view'), false);
    assert.equal(refused.searchParams.has('reference_limit'), false);
  }
});

test('explicit Performance Max campaign-logo reads preserve exact campaign identities and separate link configuration from serving', async t => {
  const f = fixture(t);
  f.rows[0].campaignAsset.status = 'PAUSED';
  const r = ok(await f.call(input));
  assert.equal(r.rows[0].campaign_id, '9007199254740993');
  assert.equal(r.rows[0].campaign_resource_name, 'customers/100/campaigns/9007199254740993');
  assert.equal(r.rows[0].link_status, 'PAUSED');
  assert.equal(r.rows[0].campaign_status, 'PAUSED');
  assert.equal(r.rows[0].brand_guidelines_enabled, true);
  assert.equal(r.rows[0].asset_group_id, undefined);
  assert.equal(r.examined_asset_groups, undefined);
  assert.match(f.requests[2].query, /campaign.brand_guidelines_enabled = TRUE/);
  assert.match(f.requests[2].query, /campaign.advertising_channel_type = 'PERFORMANCE_MAX'/);
  assert.equal(r.rows[0].media_id, 'customers/100/assets/700');
  assert.equal(r.rows[0].ad_id, undefined);
  assert.equal(r.reference_view, 'performance_max_brand');
  assert.equal(r.qualified_view, 'campaign_asset');
  assert.equal(r.examined_campaigns, 1);
  assert.equal(r.examined_ads, undefined);
  assert.equal(r.examined_links, 1);
  assert.equal(r.complete, true);
  assert.equal(r.collection.requests, 6);
  assert.equal(r.source_references.length, 6);
  assert.match(r.meaning, /Brand guidelines must be explicitly enabled/);
  assert.match(r.meaning, /not individual ads/);
  assert.ok(f.requests.every(x => !/(?:metrics\.|primary_status|final_urls|pageSize|page_size)/.test(x.query)));
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|source_url|accessToken|access_token/);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(r.provider_mutations, 0);
  assert.equal(r.saved_snapshot, false);
});

test('removed, missing native status and non-image roles stay separate from current configured campaign-logo links', async t => {
  const f = fixture(t);
  f.rows.push(
    f.brandRow('2'),
    f.brandRow('3'),
    f.brandRow('4', 'HEADLINE'),
    f.brandRow('5'),
    f.brandRow('6', 'MARKETING_IMAGE'),
  );
  f.rows[1].campaignAsset.status = 'REMOVED';
  delete f.rows[2].campaignAsset.status;
  f.rows[4].campaignAsset.fieldType = 'UNSPECIFIED';
  const r = ok(await f.call(input));
  assert.equal(r.rows.length, 1);
  assert.equal(r.removed_links, 1);
  assert.equal(r.unresolved_links, 4);
  assert.equal(r.examined_links, 6);
});

test('Campaign logo roles and native ordering preserve complete exact campaign-level references', async t => {
  const f = fixture(t);
  f.rows.push(f.brandRow('9007199254740993', 'LANDSCAPE_LOGO'));
  f.setHook(({resource, pass, body}) => {
    if (resource === 'campaign_asset' && pass === 2) body.results.reverse();
    return body;
  });
  const r = ok(await f.call(input));
  assert.equal(r.rows.length, 2);
  assert.equal(r.examined_campaigns, 1);
  assert.equal(r.examined_links, 2);
});

test('foreign or removed campaign hierarchy, non-PMax modes, malformed source fields and repeated links refuse disclosure', async t => {
  for (const variation of [
    'customer',
    'group',
    'brand_disabled',
    'asset',
    'mode',
    'brand_missing',
    'brand_string',
    'campaign_removed',
    'duplicate',
    'numeric',
    'name',
    'private',
    'enum',
  ]) {
    const f = fixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'campaign_asset') {
        const r = body.results[0];
        if (variation === 'customer') r.campaign.resourceName = 'customers/200/campaigns/10';
        if (variation === 'group') r.campaignAsset.campaign = 'customers/100/campaigns/2';
        if (variation === 'brand_disabled') r.campaign.brandGuidelinesEnabled = false;
        if (variation === 'asset') r.campaignAsset.asset = 'customers/100/assets/701';
        if (variation === 'mode') r.campaign.advertisingChannelType = 'SEARCH';
        if (variation === 'brand_missing') delete r.campaign.brandGuidelinesEnabled;
        if (variation === 'brand_string') r.campaign.brandGuidelinesEnabled = 'true';
        if (variation === 'campaign_removed') r.campaign.status = 'REMOVED';
        if (variation === 'duplicate') {
          body.results.push(structuredClone(r));
          body.totalResultsCount = '2';
        }
        if (variation === 'numeric') r.campaign.id = 9007199254740992;
        if (variation === 'name') r.campaign.name = 'x'.repeat(513);
        if (variation === 'private') r.campaign.finalUrls = ['PRIVATE-SOURCE'];
        if (variation === 'enum') r.campaignAsset.status = 'ACTIVE';
      }
      return body;
    });
    const out = await f.call(input);
    assert.equal(out.success, false, variation);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|Native <brand|source_references/);
  }
});

test('Campaign-logo native link changes and current key/login/source withdrawal cannot disclose a stale configured collection', async t => {
  for (const variation of ['link', 'key', 'credential', 'asset', 'scope', 'metadata']) {
    const f = fixture(t);
    f.setHook(({resource, pass, body}) => {
      if (resource === 'campaign_asset') {
        if (variation === 'link' && pass === 2) body.results[0].campaignAsset.status = 'PAUSED';
        if (variation === 'key') f.store.revokeKey(f.key);
        if (variation === 'credential')
          f.store.putConnection(f.admin, f.connection, {accessToken: 'rotated', developerToken: 'synthetic'});
        if (variation === 'asset')
          f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-143', {...f.asset, sha256: 'c'.repeat(64)});
        if (variation === 'scope')
          f.store.putConnection(
            f.admin,
            {...f.connection, scopes: []},
            {accessToken: 'synthetic', developerToken: 'synthetic'},
          );
        if (variation === 'metadata')
          f.store.putDocument(f.actor.tenantId, 'creative_metadata', 'asset-143', {name: 'Changed', tags: []});
      }
      return body;
    });
    const r = await f.call(input);
    assert.equal(r.success, false, variation);
    assert.equal(f.requests.length, variation === 'link' ? 6 : 3);
    assert.doesNotMatch(JSON.stringify(r), /Native <brand|source_references/);
  }
});

test('Campaign-logo explicit collection bounds, count gaps and nonterminal pages withhold partial inventories', async t => {
  for (const variation of ['rows', 'count', 'gap', 'cursor', 'bytes']) {
    const f = fixture(t);
    f.setHook(({resource, body}) => {
      if (resource === 'campaign_asset') {
        if (variation === 'rows') {
          body.results.push(f.brandRow('2'));
          body.totalResultsCount = '2';
        }
        if (variation === 'count') body.totalResultsCount = '1001';
        if (variation === 'gap') body.totalResultsCount = '2';
        if (variation === 'cursor') body.nextPageToken = 'PRIVATE-CURSOR';
        if (variation === 'bytes') body.results[0].campaign.name = 'x'.repeat(4200000);
      }
      return body;
    });
    const r = await f.call({...input, limit: variation === 'rows' ? 1 : 50});
    assert.equal(r.success, false, variation);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE-|source_references/);
  }
});

test('a complete 1000-link campaign-logo selection and empty selected view do not imply other association absence', async t => {
  const f = fixture(t);
  f.rows.splice(0, 1, ...Array.from({length: 1000}, (_, i) => f.brandRow(String(i + 1))));
  const r = ok(await f.call({...input, limit: 1000}));
  assert.equal(r.rows.length, 1000);
  assert.equal(r.collection.rows, 2004);
  assert.match(f.requests[2].query, /LIMIT 1001$/);
  const empty = googleImageUsageFixture(t, {referenceView: 'performance_max_brand', rows: []});
  const out = ok(await empty.call(input));
  assert.equal(out.complete, true);
  assert.equal(out.examined_campaigns, 0);
  assert.match(out.meaning, /complete all-format absence/);
});

test('default Google ad links remain opt-in separate and invalid view selectors refuse before egress', async t => {
  const f = googleImageUsageFixture(t),
    r = ok(await f.call());
  assert.equal(r.reference_view, 'ad_images');
  assert.equal(r.qualified_view, 'ad_group_ad_asset_view');
  const before = f.requests.length;
  assert.equal((await f.call({reference_view: 'all'})).success, false);
  assert.equal(f.requests.length, before);
  assert.ok(f.requests.every(x => x.resource !== 'campaign_asset'));
  assert.equal(r.rows[0].ad_id, '9007199254740993');
  const meta = metaAssetUsageFixture(t);
  assert.equal((await meta.call({reference_view: 'performance_max_brand'})).success, false);
  assert.equal(meta.requests.length, 0);
});
