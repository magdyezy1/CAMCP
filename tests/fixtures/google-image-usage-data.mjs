import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

export function googleImageUsageFixture(t, options = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 143).toString('base64')),
    key = store.createKey({tenantId: 'synthetic-google-image-usage', userId: 'reader', role: 'reader'}),
    actor = store.authenticate(key),
    admin = {...actor, role: 'admin'},
    connection = {
      id: '14300000-0000-4000-8000-000000000001',
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['100'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Google',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    asset = {
      platform: 'google_ads',
      account_id: '100',
      connection_id: connection.id,
      media_id: 'customers/100/assets/700',
      media_type: 'image',
      name: 'Original <image>',
      sha256: 'b'.repeat(64),
      source: 'amcp_upload',
      source_url: 'PRIVATE-SOURCE',
      ready: true,
      ...options.asset,
    };
  t.after(() => store.close());
  store.putConnection(admin, connection, {accessToken: 'synthetic', developerToken: 'synthetic'});
  store.putDocument(actor.tenantId, 'workspace_asset', 'asset-143', asset);
  const row = (id = '9007199254740993', role = 'MARKETING_IMAGE') => ({
    adGroupAdAssetView: {
      asset: 'customers/100/assets/700',
      adGroupAd: 'customers/100/adGroupAds/20~' + id,
      fieldType: role,
      enabled: true,
    },
    campaign: {id: '10', resourceName: 'customers/100/campaigns/10', status: 'PAUSED'},
    adGroup: {
      id: '20',
      resourceName: 'customers/100/adGroups/20',
      campaign: 'customers/100/campaigns/10',
      status: 'ENABLED',
    },
    adGroupAd: {
      resourceName: 'customers/100/adGroupAds/20~' + id,
      adGroup: 'customers/100/adGroups/20',
      status: 'PAUSED',
      ad: {
        id,
        resourceName: 'customers/100/ads/' + id,
        name: 'Native <img onerror=bad>',
        type: 'DEMAND_GEN_MULTI_ASSET_AD',
      },
    },
  });
  const pmaxRow = (id = '9007199254740993', role = 'MARKETING_IMAGE') => ({
    assetGroupAsset: {
      assetGroup: 'customers/100/assetGroups/' + id,
      asset: 'customers/100/assets/700',
      fieldType: role,
      status: 'ENABLED',
    },
    assetGroup: {
      id,
      resourceName: 'customers/100/assetGroups/' + id,
      name: 'Native <image group>',
      campaign: 'customers/100/campaigns/10',
      status: 'PAUSED',
    },
    campaign: {
      id: '10',
      resourceName: 'customers/100/campaigns/10',
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
    },
  });
  const brandRow = (id = '9007199254740993', role = 'LOGO') => ({
    campaignAsset: {
      campaign: 'customers/100/campaigns/' + id,
      asset: 'customers/100/assets/700',
      fieldType: role,
      status: 'ENABLED',
    },
    campaign: {
      id,
      resourceName: 'customers/100/campaigns/' + id,
      name: 'Native <brand campaign>',
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      brandGuidelinesEnabled: true,
    },
  });
  const rows = options.rows ?? [
      options.referenceView === 'performance_max_brand'
        ? brandRow()
        : options.referenceView === 'performance_max'
          ? pmaxRow()
          : row(),
    ],
    requests = [],
    passes = new Map();
  let hook = ({body}) => body;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(String(raw)),
        request = JSON.parse(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(url.origin, 'https://googleads.googleapis.com');
      assert.equal(url.pathname, '/v25/customers/100/googleAds:search');
      const resource = / FROM (\w+)/.exec(request.query)?.[1];
      if (
        ![
          'customer',
          'asset',
          'ad_group_ad_asset_view',
          ...(options.referenceView === 'performance_max' ? ['asset_group_asset'] : []),
          ...(options.referenceView === 'performance_max_brand' ? ['campaign_asset'] : []),
        ].includes(resource)
      )
        throw Error('Only synthetic selected-account image reference reads are permitted');
      requests.push({resource, query: request.query, path: url.pathname});
      const pass = (passes.get(resource) ?? 0) + 1;
      passes.set(resource, pass);
      // The customer row is shaped like a live answer (r25-mf-goals, 2026-11-25): Google returns the resource name of the FROM
      // resource whether or not the query selects it. The view and link rows are not: UNVERIFIED for those resources.
      const selected =
          resource === 'customer'
            ? [{customer: {resourceName: 'customers/100', id: '100', manager: false}}]
            : resource === 'asset'
              ? [{asset: {id: '700', resourceName: 'customers/100/assets/700', type: 'IMAGE'}}]
              : structuredClone(rows),
        body = {results: selected, totalResultsCount: String(selected.length)};
      const out = await hook({resource, request, pass, body, store, actor, admin, connection, asset});
      return out instanceof Response ? out : Response.json(out ?? body);
    }),
    undefined,
    {allowWrites: options.allowWrites ?? false},
  );
  const input = {action: 'asset_usage', asset_id: 'asset-143', limit: 50};
  return {
    store,
    key,
    actor,
    admin,
    connection,
    asset,
    service,
    requests,
    rows,
    row,
    pmaxRow,
    brandRow,
    input,
    call: (extra = {}, user = actor) => service.call('amcp_media', {...input, ...extra}, user),
    setHook: value => {
      hook = value;
    },
  };
}
