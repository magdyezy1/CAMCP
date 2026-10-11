// apple_campaigns: PUT https://api.ads.apple.com/v1/campaigns/{id} (Apple Ads Platform API v1, Campaign update). The
// update enables a paused campaign, which starts spending its daily budget at once; the review states the campaign is
// paused, so the campaign's current `status` is the decisive field (a campaign enabled in the meantime is no longer
// the one reviewed).
const origin = 'https://api.ads.apple.com',
  campaign = '/v1/campaigns/5';

export default {
  family: 'apple_campaigns',
  risk: 'activation',
  gateway: 'apple_ads_native_action',
  account: '77',
  connection: {scopes: ['searchadsorg']},
  request: {action: 'apple_ads_v1_campaign_update', path_params: {id: '5'}, payload: {status: 'ENABLED'}},
  seed: () => ({
    campaign: {
      id: 5,
      adAccountId: 77,
      name: 'Synthetic',
      status: 'PAUSED',
      dailyBudget: {amount: '10', currency: 'USD'},
    },
  }),
  unpaginated: 'GET /v1/campaigns/{id} returns one campaign under `result`; Apple pages only find and list calls',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== origin || path !== campaign) return;
    if (method === 'GET') return {json: {result: state.campaign}};
    if (method === 'PUT') {
      // A partial answer: Apple answers without the campaign it changed.
      if (mode.partial) return {json: {result: null}};
      Object.assign(state.campaign, body);
      return {json: {result: state.campaign}};
    }
  },
  decisive: {change: state => (state.campaign.status = 'ENABLED'), field: /status/},
};
