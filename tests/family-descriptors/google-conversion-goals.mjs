// google_conversion_goals: POST /v25/customers/{id}/customerConversionGoals:mutate (Google Ads API,
// CustomerConversionGoal) making the account's purchase goal non-biddable. The update overwrites the goal's
// `biddable`, which decides whether bidding of every campaign using account defaults optimizes for it, so its current
// value is the decisive field.
import * as g from './_google-ads.mjs';

const goal = g.resource('customerConversionGoals', 'PURCHASE~WEBSITE'),
  budget = g.resource('campaignBudgets', '10'),
  campaigns = [g.resource('campaigns', '100'), g.resource('campaigns', '101')];

export default {
  family: 'google_conversion_goals',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_customer_conversion_goal_mutate_customer_conversion_goals',
    payload: {operations: [{update: {resourceName: goal, biddable: false}, updateMask: 'biddable'}]},
  },
  seed: () => ({
    customer: [
      {
        id: '123',
        currencyCode: 'USD',
        timeZone: 'UTC',
        conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/123'},
      },
    ],
    customer_conversion_goal: [{resourceName: goal, category: 'PURCHASE', origin: 'WEBSITE', biddable: true}],
    campaign_conversion_goal: campaigns.map((campaign, i) => ({
      resourceName: g.resource('campaignConversionGoals', campaign.split('/').at(-1) + '~PURCHASE~WEBSITE'),
      campaign,
      category: 'PURCHASE',
      origin: 'WEBSITE',
      biddable: !i,
    })),
    conversion_goal_campaign_config: campaigns.map((campaign, i) => ({
      resourceName: g.resource('conversionGoalCampaignConfigs', campaign.split('/').at(-1)),
      campaign,
      goalConfigLevel: i ? 'CAMPAIGN' : 'CUSTOMER',
    })),
    custom_conversion_goal: [],
    campaign: campaigns.map((resourceName, i) => ({
      resourceName,
      name: 'Campaign ' + i,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
      campaignBudget: budget,
    })),
    campaign_budget: [{resourceName: budget, name: 'Budget', status: 'ENABLED', amountMicros: '30000000'}],
    conversion_action: ['900', '901'].map((id, i) => ({
      resourceName: g.resource('conversionActions', id),
      name: 'Action ' + id,
      status: 'ENABLED',
      type: 'WEBPAGE',
      category: 'PURCHASE',
      origin: 'WEBSITE',
      ownerCustomer: 'customers/123',
      primaryForGoal: !i,
      valueSettings: {defaultValue: 1, defaultCurrencyCode: 'USD', alwaysUseDefaultValue: false},
    })),
  }),
  paginatedCodes: ['CONVERSION_GOAL_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    // Google answers each query with the whole synthetic table; the family checks every row it relies on.
    if (g.isSearch(request)) return g.search(request, kind => state[kind]);
    if (path === '/v25/customers/123/customerConversionGoals:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const row = state.customer_conversion_goal.find(r => r.resourceName === op.update.resourceName);
        Object.assign(row, op.update);
        // Campaigns that use account defaults follow the account goal.
        for (const cg of state.campaign_conversion_goal)
          if (
            state.conversion_goal_campaign_config.some(
              c => c.campaign === cg.campaign && c.goalConfigLevel === 'CUSTOMER',
            )
          )
            cg.biddable = row.biddable;
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {change: state => (state.customer_conversion_goal[0].biddable = false), field: /biddable/},
};
