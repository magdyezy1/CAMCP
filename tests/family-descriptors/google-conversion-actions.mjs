// google_conversion_actions: POST /v25/customers/{id}/conversionActions:mutate (Google Ads API, ConversionAction). The
// update overwrites the action's `value_settings.default_value`, the value Google records for a conversion without one,
// which value-based bidding of the campaigns using the action optimizes; its current value is the decisive field.
import * as g from './_google-ads.mjs';

const action = g.resource('conversionActions', '900'),
  budget = g.resource('campaignBudgets', '10'),
  campaigns = ['100', '101'];

export default {
  family: 'google_conversion_actions',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_conversion_action_mutate_conversion_actions',
    payload: {
      operations: [
        {update: {resourceName: action, valueSettings: {defaultValue: 25}}, updateMask: 'valueSettings.defaultValue'},
      ],
      partialFailure: false,
      validateOnly: false,
    },
  },
  seed: () => ({
    customer: [
      {
        id: '123',
        currencyCode: 'SAR',
        timeZone: 'Asia/Riyadh',
        conversionTrackingSetting: {googleAdsConversionCustomer: 'customers/123'},
      },
    ],
    conversion_action: [
      {
        resourceName: action,
        id: '900',
        name: 'Purchase',
        status: 'ENABLED',
        type: 'WEBPAGE',
        category: 'PURCHASE',
        origin: 'WEBSITE',
        ownerCustomer: 'customers/123',
        primaryForGoal: true,
        countingType: 'ONE_PER_CLICK',
        clickThroughLookbackWindowDays: '30',
        viewThroughLookbackWindowDays: '1',
        valueSettings: {defaultValue: 0, defaultCurrencyCode: 'SAR', alwaysUseDefaultValue: false},
        attributionModelSettings: {attributionModel: 'GOOGLE_ADS_LAST_CLICK'},
      },
    ],
    customer_conversion_goal: [
      {
        resourceName: g.resource('customerConversionGoals', 'PURCHASE~WEBSITE'),
        category: 'PURCHASE',
        origin: 'WEBSITE',
        biddable: true,
      },
    ],
    campaign_conversion_goal: campaigns.map(id => ({
      resourceName: g.resource('campaignConversionGoals', id + '~PURCHASE~WEBSITE'),
      campaign: g.resource('campaigns', id),
      category: 'PURCHASE',
      origin: 'WEBSITE',
      biddable: true,
    })),
    conversion_goal_campaign_config: campaigns.map(id => ({
      resourceName: g.resource('conversionGoalCampaignConfigs', id),
      campaign: g.resource('campaigns', id),
      goalConfigLevel: 'CUSTOMER',
    })),
    custom_conversion_goal: [],
    campaign: campaigns.map(id => ({
      resourceName: g.resource('campaigns', id),
      name: 'Campaign ' + id,
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
      campaignBudget: budget,
    })),
    campaign_budget: [{resourceName: budget, name: 'Budget', status: 'ENABLED', amountMicros: '50000000'}],
    bidding_strategy: [],
  }),
  paginatedCodes: ['CONVERSION_GOAL_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    // Google answers each query with the synthetic table, applying the query's channel and status conditions.
    if (g.isSearch(request))
      return g.search(request, kind => {
        const query = body.query;
        let rows = state[kind] ?? [];
        if (query.includes("advertising_channel_type = 'MULTI_CHANNEL'"))
          rows = rows.filter(r => r.advertisingChannelType === 'MULTI_CHANNEL');
        else if (query.includes("advertising_channel_type != 'MULTI_CHANNEL'"))
          rows = rows.filter(r => r.advertisingChannelType !== 'MULTI_CHANNEL');
        if (kind === 'conversion_action' && query.includes("!= 'REMOVED'"))
          rows = rows.filter(r => r.status !== 'REMOVED');
        return rows;
      });
    if (path === '/v25/customers/123/conversionActions:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const row = state.conversion_action.find(a => a.resourceName === op.update.resourceName);
        row.valueSettings = {...row.valueSettings, ...op.update.valueSettings};
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {
    change: state => (state.conversion_action[0].valueSettings.defaultValue = 50),
    field: /valueSettings|defaultValue/,
  },
};
