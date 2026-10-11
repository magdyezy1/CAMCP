// reddit_classic: PATCH /api/v3/ad_groups/{id} (Reddit Ads API v3). The decisive field is the ad group's current
// `bid_value`, which the update overwrites and the owner's spending policy compares against.
export default {
  family: 'reddit_classic',
  risk: 'budget',
  gateway: 'reddit_native_action',
  account: 'a2_111',
  connection: {scopes: ['adsread', 'adsedit'], userAgent: 'server:amcp-tests:0.1.0 (local mock)'},
  owned: ['ad_groups/200'],
  arguments: {
    operation: 'reddit_campaign_ops',
    arguments: {
      action: 'UPDATE_AD_GROUP',
      account_id: 'a2_111',
      params: {ad_group_id: '200'},
      payload: {data: {bid_value: 1200000}},
    },
  },
  seed: () => ({
    '/api/v3/ad_groups/200': {
      id: '200',
      ad_account_id: 'a2_111',
      campaign_id: '100',
      name: 'Group',
      configured_status: 'PAUSED',
      bid_strategy: 'MANUAL_BIDDING',
      bid_type: 'CPC',
      bid_value: 1000000,
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/api/v3/ad_accounts/a2_111') return {json: {data: {id: 'a2_111', name: 'Account'}}};
      if (!state[path]) return undefined;
      return {
        json: {
          data: structuredClone(state[path]),
          request_id: 'r',
          // Another page: Reddit names it with pagination.next_url.
          ...(mode.paginate ? {pagination: {next_url: 'https://ads-api.reddit.com' + path + '?page.token=x'}} : {}),
        },
      };
    }
    if (method === 'PATCH' && state[path]) {
      // A partial answer: the receipt names another ad account.
      if (mode.partial) return {json: {data: {...state[path], ...body.data, ad_account_id: 'a2_999'}}};
      state[path] = {...state[path], ...body.data};
      return {json: {data: structuredClone(state[path])}};
    }
  },
  decisive: {change: state => (state['/api/v3/ad_groups/200'].bid_value = 1100000), field: /bid_value/},
};
