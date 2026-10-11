// apple_entities: PUT https://api.ads.apple.com/v1/keywords/{id} (Apple Ads Platform API v1, Keyword update). The
// update overwrites the keyword's `bid`, the maximum cost per tap Apple charges for it; the keyword's current `bid` is
// the decisive field (the review shows the bid being replaced and the spend limits compare against it).
const origin = 'https://api.ads.apple.com',
  keyword = '/v1/keywords/900';

export default {
  family: 'apple_entities',
  risk: 'budget',
  gateway: 'apple_ads_native_action',
  account: '77',
  connection: {scopes: ['searchadsorg']},
  request: {
    action: 'apple_ads_v1_keyword_update',
    path_params: {id: '900'},
    payload: {bid: {amount: '1.60', currency: 'USD'}},
  },
  seed: () => ({
    '/v1/ad-accounts/77': {id: 77, orgId: 5, name: 'Synthetic 77', currency: 'USD'},
    [keyword]: {
      id: 900,
      adAccountId: 77,
      adGroupId: 201,
      text: 'budget planner',
      matchType: 'EXACT',
      bid: {amount: '1.50', currency: 'USD'},
      status: 'PAUSED',
      deleted: false,
    },
  }),
  unpaginated:
    'GET /v1/keywords/{id} and GET /v1/ad-accounts/{id} each return one resource under `result`; Apple pages only find and list calls',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== origin || !state[path]) return;
    if (method === 'GET') return {json: {result: state[path]}};
    if (method === 'PUT' && path === keyword) {
      // A partial answer: Apple answers with an error beside the keyword.
      if (mode.partial) return {json: {result: state[path], error: {code: 'INVALID', message: 'Synthetic failure'}}};
      Object.assign(state[path], body);
      return {json: {result: state[path]}};
    }
  },
  decisive: {change: state => (state[keyword].bid = {amount: '1.55', currency: 'USD'}), field: /bid/},
};
