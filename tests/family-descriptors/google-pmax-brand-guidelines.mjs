// google_pmax_brand_guidelines: POST /v25/customers/{id}/campaigns:enablePMaxBrandGuidelines (Google Ads API,
// CampaignService.EnablePMaxBrandGuidelines). Enabling brand guidelines cannot be undone and changes the brand assets
// of the campaign at once if it serves; the review states whether it serves from the campaign's `status`, the decisive
// field (a paused campaign enabled in the meantime would show the new brand assets the moment this is sent).
import * as g from './_google-ads.mjs';

const campaign = g.resource('campaigns', '100'),
  name = g.resource('assets', '1'),
  logo = g.resource('assets', '2');

export default {
  family: 'google_pmax_brand_guidelines',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_campaign_enable_p_max_brand_guidelines',
    payload: {
      operations: [
        {
          campaign,
          autoPopulateBrandAssets: false,
          brandAssets: {businessNameAsset: name, logoAsset: [logo]},
          mainColor: '#112233',
          accentColor: '#445566',
        },
      ],
    },
  },
  seed: () => ({
    campaign: [
      {
        resourceName: campaign,
        name: 'Retail',
        status: 'PAUSED',
        advertisingChannelType: 'PERFORMANCE_MAX',
        brandGuidelinesEnabled: false,
      },
    ],
    asset: [
      {resourceName: name, type: 'TEXT', textAsset: {text: 'Synthetic Bakery'}},
      {resourceName: logo, type: 'IMAGE', imageAsset: {fullSize: {widthPixels: '256', heightPixels: '256'}}},
    ],
    campaign_asset: [],
  }),
  paginatedCodes: ['BRAND_GUIDELINES_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/campaigns:enablePMaxBrandGuidelines') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        Object.assign(
          state.campaign.find(c => c.resourceName === op.campaign),
          {brandGuidelinesEnabled: true, brandGuidelines: {mainColor: op.mainColor, accentColor: op.accentColor}},
        );
        for (const [fieldType, asset] of [
          ['BUSINESS_NAME', op.brandAssets.businessNameAsset],
          ...op.brandAssets.logoAsset.map(a => ['LOGO', a]),
        ])
          state.campaign_asset.push({
            resourceName: g.resource('campaignAssets', '100~' + asset.split('/').at(-1) + '~' + fieldType),
            campaign: op.campaign,
            asset,
            fieldType,
            status: 'ENABLED',
          });
      }
      return {json: {results: body.operations.map(op => ({campaign: op.campaign}))}};
    }
  },
  decisive: {change: state => (state.campaign[0].status = 'ENABLED'), field: /status/},
};
