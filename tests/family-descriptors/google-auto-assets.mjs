// google_auto_assets: POST /v25/customers/{id}:removeCampaignAutomaticallyCreatedAsset (Google Ads API,
// AutomaticallyCreatedAssetRemovalService) removing one automatically created image from a campaign. The decisive
// field is the owning campaign's current `status`: the review shows whether the removal changes what serves, so a
// campaign paused or enabled in Google Ads after the review must stop it. (A link already removed in Google Ads is
// refused first, as STATE_NOT_FOUND.)
import * as g from './_google-ads.mjs';

const campaign = g.resource('campaigns', '7'),
  asset = g.resource('assets', '4');

export default {
  family: 'google_auto_assets',
  risk: 'destructive',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_automatically_created_asset_removal_remove_campaign_automatically_created_asset',
    payload: {operations: [{campaign, asset, fieldType: 'MARKETING_IMAGE'}], partialFailure: false},
  },
  seed: () => ({
    customer: [{resourceName: 'customers/123', id: '123'}],
    campaign: [{resourceName: campaign, status: 'ENABLED'}],
    campaign_asset: [{campaign, asset, fieldType: 'MARKETING_IMAGE', status: 'ENABLED'}],
  }),
  paginatedCodes: ['AUTO_ASSET_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123:removeCampaignAutomaticallyCreatedAsset') {
      if (mode.partial) return {json: {partialFailureError: {code: 3, message: 'One removal failed'}}};
      for (const op of body.operations)
        state.campaign_asset = state.campaign_asset.filter(
          l => !(l.campaign === op.campaign && l.asset === op.asset && l.fieldType === op.fieldType),
        );
      return {json: {}};
    }
  },
  decisive: {change: state => (state.campaign[0].status = 'PAUSED'), field: /status/},
};
