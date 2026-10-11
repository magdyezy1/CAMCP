// google_bid_modifiers: POST /v25/customers/{id}/adGroupBidModifiers:mutate (Google Ads API, AdGroupBidModifier).
// The update overwrites the criterion's `bid_modifier`, the multiplier applied to every bid of the ad group for that
// device, so the decisive field is the modifier's current `bidModifier`.
import * as g from './_google-ads.mjs';

const group = g.resource('adGroups', '200'),
  campaign = g.resource('campaigns', '100'),
  budget = g.resource('campaignBudgets', '10'),
  name = g.resource('adGroupBidModifiers', '200~500');

export default {
  family: 'google_bid_modifiers',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_ad_group_bid_modifier_mutate_ad_group_bid_modifiers',
    payload: {operations: [{update: {resourceName: name, bidModifier: 1.3}, updateMask: 'bidModifier'}]},
  },
  seed: () => ({
    ad_group: [
      {
        resourceName: group,
        campaign,
        name: 'Group',
        status: 'PAUSED',
        type: 'SEARCH_STANDARD',
        cpcBidMicros: '1000000',
      },
    ],
    campaign: [
      {
        resourceName: campaign,
        name: 'Campaign',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        biddingStrategyType: 'MANUAL_CPC',
        campaignBudget: budget,
      },
    ],
    campaign_budget: [
      {
        resourceName: budget,
        name: 'Budget',
        status: 'ENABLED',
        amountMicros: '30000000',
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    ],
    ad_group_bid_modifier: [
      {
        resourceName: name,
        adGroup: group,
        baseAdGroup: group,
        criterionId: '500',
        bidModifier: 1.2,
        bidModifierSource: 'AD_GROUP',
        device: {type: 'MOBILE'},
      },
    ],
  }),
  // The family names its own refusal for a repeated page token.
  paginatedCodes: ['BID_MODIFIER_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.search(request, kind => state[kind]);
    if (path === '/v25/customers/123/adGroupBidModifiers:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const row = state.ad_group_bid_modifier.find(m => m.resourceName === op.update.resourceName);
        Object.assign(row, op.update);
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {change: state => (state.ad_group_bid_modifier[0].bidModifier = 1.5), field: /bidModifier/},
};
