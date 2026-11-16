// reddit_classic, variant: PATCH /api/v3/campaigns/{id} naming a funding instrument (Reddit Ads API v3, Update Campaign), which
// the review reads as a REFERENCE (R2.5 M1, lead review S3-4). The campaign is paid from the instrument it names, so the
// decisive field is the instrument's `credit_limit`, the most the campaign can spend before it stops running; its meter
// (`billable_amount`, the instrument's outstanding debt) and its computed servable state change with every day the account
// spends, and are no change. The family's own descriptor (../reddit-classic.mjs) covers the ad group update; this variant runs
// the same conformance checks for the shape that names a funding instrument, and never stands in for that descriptor.
const account = 'a2_111';

export default {
  family: 'reddit_classic',
  risk: 'budget',
  gateway: 'reddit_native_action',
  account,
  connection: {scopes: ['adsread', 'adsedit'], userAgent: 'server:amcp-tests:0.1.0 (local mock)'},
  owned: ['campaigns/300'],
  arguments: {
    operation: 'reddit_campaign_ops',
    arguments: {
      action: 'UPDATE_CAMPAIGN',
      account_id: account,
      params: {campaign_id: '300'},
      payload: {data: {funding_instrument_id: 'fi_1'}},
    },
  },
  seed: () => ({
    '/api/v3/campaigns/300': {
      id: '300',
      ad_account_id: account,
      name: 'Campaign',
      configured_status: 'PAUSED',
      funding_instrument_id: 'fi_0',
    },
    instrument: {
      id: 'fi_1',
      ad_account_id: account,
      name: 'Synthetic card',
      currency: 'USD',
      credit_limit: 5000000000,
      billable_amount: 120000,
      start_time: '2026-11-01T00:00:00Z',
      end_time: null,
      is_servable: true,
      reasons_not_servable: [],
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/api/v3/ad_accounts/' + account) return {json: {data: {id: account, name: 'Account'}}};
      if (path === '/api/v3/ad_accounts/' + account + '/funding_instruments') {
        if (url.searchParams.get('funding_instrument_ids') !== state.instrument.id) return {json: {data: []}};
        return {json: {data: [structuredClone(state.instrument)], request_id: 'r'}};
      }
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
  decisive: {change: state => (state.instrument.credit_limit = 1000), field: /credit_limit/},
};
