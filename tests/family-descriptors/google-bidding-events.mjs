// google_bidding_events: POST /v25/customers/{id}/biddingSeasonalityAdjustments:mutate (Google Ads API,
// BiddingSeasonalityAdjustment). Smart Bidding scales its predicted conversion rate by the adjustment's
// `conversion_rate_modifier` during the event, so the update that overwrites it is decided by its current value.
import * as g from './_google-ads.mjs';

const campaign = g.resource('campaigns', '100'),
  budget = g.resource('campaignBudgets', '10'),
  name = g.resource('biddingSeasonalityAdjustments', '500');

export default {
  family: 'google_bidding_events',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_bidding_seasonality_adjustment_mutate_bidding_seasonality_adjustments',
    payload: {
      operations: [{update: {resourceName: name, conversionRateModifier: 1.8}, updateMask: 'conversionRateModifier'}],
    },
  },
  seed: () => ({
    customer: [{id: '123', currencyCode: 'EGP', timeZone: 'Africa/Cairo'}],
    campaign: [
      {
        resourceName: campaign,
        name: 'Campaign',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        biddingStrategyType: 'TARGET_CPA',
        campaignBudget: budget,
        targetCpa: {targetCpaMicros: '1000000'},
      },
    ],
    campaign_budget: [
      {resourceName: budget, name: 'Budget', status: 'ENABLED', amountMicros: '30000000', deliveryMethod: 'STANDARD'},
    ],
    bidding_strategy: [],
    bidding_seasonality_adjustment: [
      {
        resourceName: name,
        seasonalityAdjustmentId: '500',
        name: 'Sale',
        status: 'ENABLED',
        scope: 'CAMPAIGN',
        campaigns: [campaign],
        startDateTime: '2098-12-01 00:00:00',
        endDateTime: '2098-12-04 00:00:00',
        conversionRateModifier: 1.5,
      },
    ],
  }),
  paginatedCodes: ['BIDDING_EVENT_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/biddingSeasonalityAdjustments:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        Object.assign(
          state.bidding_seasonality_adjustment.find(e => e.resourceName === op.update.resourceName),
          op.update,
        );
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {
    change: state => (state.bidding_seasonality_adjustment[0].conversionRateModifier = 2),
    field: /conversionRateModifier/,
  },
};
