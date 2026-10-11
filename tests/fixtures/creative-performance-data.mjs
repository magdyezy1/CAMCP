export const creativePerformanceCases = [
  {
    platform: 'google_ads',
    gateway: 'google_ads_native_action',
    preset: 'google_ad',
    grain: 'ad group × ad × day',
    account: '100',
    action: 'google_ads_v23_ad_group_ad_mutate_ad_group_ads',
    ad: 'customers/100/adGroupAds/200~9007199254740993',
    other: 'customers/100/adGroupAds/201~9007199254740993',
  },
  {
    platform: 'snapchat',
    gateway: 'snapchat_native_action',
    preset: 'snapchat_ad',
    grain: 'ad × day',
    account: '11111111-1111-1111-1111-111111111111',
    action: 'snapchat_ad_create',
    ad: '22222222-2222-2222-2222-222222222222',
    other: '33333333-3333-3333-3333-333333333333',
  },
  {
    platform: 'tiktok',
    gateway: 'tiktok_native_action',
    preset: 'tiktok_ad',
    grain: 'ad × day',
    account: '100',
    action: 'tiktok_ad_create',
    ad: '9007199254740993',
    other: '9007199254740995',
  },
  // MED-04 C: a verified LinkedIn creative-creation step joins its creative × day snapshot by the exact URN.
  {
    platform: 'linkedin',
    gateway: 'linkedin_native_action',
    preset: 'linkedin_creative',
    grain: 'creative × day',
    account: '100',
    action: 'linkedin_rest_ad_accounts_ad_account_id_creatives_post',
    ad: 'urn:li:sponsoredCreative:9007199254740993',
    other: 'urn:li:sponsoredCreative:9007199254740995',
  },
];
export function seedCreativePerformance(store, actor, spec, suffix = '') {
  const connection = {
    id: spec.platform + '-login' + suffix,
    tenantId: actor.tenantId,
    gateway: spec.gateway,
    accounts: [spec.account],
    writeAccounts: [spec.account],
    enabled: true,
    label: 'Synthetic ' + spec.platform + ' login',
    scopes: [],
  };
  store.putConnection({...actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
  const assetId = 'asset-' + spec.platform + suffix,
    planId = 'plan-' + spec.platform + suffix,
    reportId = 'report-' + spec.platform + suffix;
  const scope = {gateway: spec.gateway, account_id: spec.account, connection_id: connection.id};
  const put = (kind, id, value) => store.putDocument(actor.tenantId, kind, id, value);
  put('workspace_asset', assetId, {
    platform: spec.platform,
    account_id: spec.account,
    connection_id: connection.id,
    media_id: 'synthetic-media-' + spec.platform,
    name: 'Synthetic ' + spec.platform + ' original',
    sha256: 'a'.repeat(64),
    media_type: 'image',
    mime_type: 'image/png',
  });
  const steps = [
    {
      ...scope,
      id: 'upload',
      kind: 'media',
      arguments: {platform: spec.platform},
      review_id: assetId,
      status: 'verified',
      result: {media_id: 'synthetic-media-' + spec.platform},
    },
    {
      ...scope,
      id: 'ad',
      kind: 'write',
      arguments: {action: spec.action, payload: {asset: {$ref: 'upload#/media_id'}}},
      status: 'verified',
      verification: {verified_resources: [{resource_id: spec.ad}]},
    },
    {
      ...scope,
      id: 'unrelated',
      kind: 'write',
      arguments: {action: spec.action},
      depends_on: ['upload'],
      status: 'verified',
      verification: {verified_resources: [{resource_id: spec.other}]},
    },
  ];
  put('campaign_run', planId, {user_id: actor.userId, name: 'Synthetic ' + spec.platform + ' plan', steps});
  const report = {
    ...scope,
    preset: spec.preset,
    grain: spec.grain,
    source: 'provider_read',
    source_hash: 'b'.repeat(64),
    captured_at: Date.now(),
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      conversion_definition:
        spec.platform === 'snapchat'
          ? 'conversion_purchases'
          : spec.platform === 'tiktok'
            ? 'conversion'
            : spec.platform === 'linkedin'
              ? 'externalWebsiteConversions'
              : 'metrics.conversions',
      attribution: 'Synthetic declared native definition',
      complete: true,
      source_name: 'Synthetic ' + spec.platform + ' ad evidence',
    },
    rows: [
      {
        entity_id: spec.ad,
        entity_name: 'Exact linked ad',
        date: '2026-09-01',
        spend: '12.500001',
        impressions: '9007199254740993',
        clicks: '10',
        conversions: null,
        conversion_value: null,
      },
      {
        entity_id: spec.ad,
        entity_name: 'Exact linked ad',
        date: '2026-09-02',
        spend: '0',
        impressions: '0',
        clicks: '0',
        conversions: '0',
      },
      {entity_id: spec.other, entity_name: 'Other ad', date: '2026-09-01', spend: '999'},
    ],
  };
  put('decision_report', reportId, report);
  return {connection, scope, assetId, planId, reportId, steps, report, put};
}
