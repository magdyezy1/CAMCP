// google_portfolio_strategies: POST /v25/customers/{id}/biddingStrategies:mutate (Google Ads API, BiddingStrategy).
// The update overwrites the portfolio's `target_cpa.target_cpa_micros`, the cost per acquisition Smart Bidding aims
// for in every campaign that uses the portfolio; the portfolio's current target is the decisive field.
import * as g from './_google-ads.mjs';

const portfolio = g.resource('biddingStrategies', '55'),
  campaign = g.resource('campaigns', '100'),
  budget = g.resource('campaignBudgets', '10');

export default {
  family: 'google_portfolio_strategies',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_bidding_strategy_mutate_bidding_strategies',
    payload: {
      operations: [
        {
          update: {resourceName: portfolio, targetCpa: {targetCpaMicros: '20000000'}},
          updateMask: 'targetCpa.targetCpaMicros',
        },
      ],
    },
  },
  seed: () => ({
    bidding_strategy: [
      {
        resourceName: portfolio,
        id: '55',
        name: 'Client CPA',
        status: 'ENABLED',
        type: 'TARGET_CPA',
        targetCpa: {targetCpaMicros: '15000000'},
        campaignCount: '1',
        nonRemovedCampaignCount: '1',
      },
    ],
    campaign: [
      {
        resourceName: campaign,
        name: 'Campaign',
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        biddingStrategyType: 'TARGET_CPA',
        biddingStrategy: portfolio,
        campaignBudget: budget,
      },
    ],
    campaign_budget: [
      {
        resourceName: budget,
        name: 'Budget',
        status: 'ENABLED',
        amountMicros: '50000000',
        explicitlyShared: false,
        deliveryMethod: 'STANDARD',
        period: 'DAILY',
      },
    ],
  }),
  paginatedCodes: ['PORTFOLIO_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/biddingStrategies:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const row = state.bidding_strategy.find(s => s.resourceName === op.update.resourceName);
        row.targetCpa = {...row.targetCpa, ...op.update.targetCpa};
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {
    change: state => (state.bidding_strategy[0].targetCpa.targetCpaMicros = '17000000'),
    field: /targetCpa/,
  },
};
