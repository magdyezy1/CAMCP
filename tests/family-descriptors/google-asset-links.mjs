// google_asset_links: POST /v25/customers/{id}/campaignAssets:mutate (Google Ads API, CampaignAsset) enabling a paused
// sitelink association. The decisive field is the association's current `status`, the serving state the update
// changes: an association enabled or removed in Google Ads after the review must stop the reviewed one.
import * as g from './_google-ads.mjs';

const campaign = g.resource('campaigns', '100'),
  asset = g.resource('assets', '200'),
  link = g.resource('campaignAssets', '100~200~SITELINK');

export default {
  family: 'google_asset_links',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
    payload: {
      operations: [{update: {resourceName: link, status: 'ENABLED'}, updateMask: 'status'}],
      partialFailure: false,
    },
  },
  seed: () => ({
    campaign: [
      {
        resourceName: campaign,
        name: 'Campaign',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: g.resource('campaignBudgets', '10'),
      },
    ],
    asset: [
      {
        resourceName: asset,
        type: 'SITELINK',
        source: 'ADVERTISER',
        finalUrls: ['https://example.test/sitelink'],
        sitelinkAsset: {linkText: 'Sitelink', description1: 'First line', description2: 'Second line'},
      },
    ],
    campaign_asset: [{resourceName: link, campaign, asset, fieldType: 'SITELINK', status: 'PAUSED'}],
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/campaignAssets:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        Object.assign(
          state.campaign_asset.find(row => row.resourceName === op.update.resourceName),
          op.update,
        );
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {change: state => (state.campaign_asset[0].status = 'ENABLED'), field: /status/},
};
