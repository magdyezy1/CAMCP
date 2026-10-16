// snapchat_nested_updates: PATCH /v1/campaigns/{campaign_id}/adsquads/{ad_squad_id} (Snapchat Marketing API v1, "Ad
// Squads", Update an Ad Squad with JSON Patch) raising the daily budget. The decisive field is the ad squad's current
// `daily_budget_micro` in "Get a specific Ad Squad", the amount the replacement overwrites and the spending review
// measures the change against: a budget changed in Snapchat after the review makes the reviewed change another one.
import {ok, rows} from './_snapchat.mjs';

/** One entity as Snapchat returns it from GET /v1/{collection}/{id}; `more` adds a next page link. */
const one = (collection, entity, row, more) =>
  ok({
    [collection]: rows(entity, [row]),
    ...(more ? {paging: {next_link: 'https://adsapi.snapchat.com/v1/' + collection + '?cursor=2'}} : {}),
  });

export default {
  family: 'snapchat_nested_updates',
  risk: 'budget',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  owned: ['campaigns/campaign1', 'adsquads/squad1'],
  request: {
    action: 'snapchat_adsquad_patch',
    path_params: {campaign_id: 'campaign1', ad_squad_id: 'squad1'},
    payload: [{op: 'replace', path: '/daily_budget_micro', value: 120000000}],
  },
  seed: () => ({
    account: {id: 'acct1', currency: 'SAR', timezone: 'Asia/Riyadh'},
    campaign: {
      id: 'campaign1',
      ad_account_id: 'acct1',
      name: 'Campaign',
      status: 'ACTIVE',
      buy_model: 'AUCTION',
      pacing_level: 'AD_SQUAD',
      start_time: '2026-01-01T00:00:00Z',
      daily_budget_micro: 900000000,
    },
    squad: {
      id: 'squad1',
      campaign_id: 'campaign1',
      name: 'Squad',
      status: 'PAUSED',
      type: 'SNAP_ADS',
      billing_event: 'IMPRESSION',
      optimization_goal: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITH_MAX_BID',
      bid_micro: 1000000,
      daily_budget_micro: 100000000,
      start_time: '2026-01-01T00:00:00Z',
      targeting: {geos: [{country_code: 'sa'}]},
      placement_v2: {config: 'AUTOMATIC'},
      pacing_type: 'STANDARD',
    },
  }),
  // Each state read is one entity; the reader still refuses an answer that declares another page.
  paginatedCodes: ['SNAPCHAT_UPDATE_STATE_UNVERIFIED'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1')
      return one('adaccounts', 'adaccount', state.account, mode.paginate);
    if (method === 'GET' && path === '/v1/campaigns/campaign1') return one('campaigns', 'campaign', state.campaign);
    if (method === 'GET' && path === '/v1/adsquads/squad1') return one('adsquads', 'adsquad', state.squad);
    if (method === 'PATCH' && path === '/v1/campaigns/campaign1/adsquads/squad1') {
      // A failed answer: the request is accepted but the ad squad row reports an error.
      if (mode.partial)
        return ok({adsquads: [{sub_request_status: 'ERROR', sub_request_error_reason: 'Budget below minimum'}]});
      for (const op of body) if (op.op !== 'test') state.squad[op.path.slice(1)] = op.value;
      return ok({adsquads: rows('adsquad', [state.squad])});
    }
  },
  decisive: {change: state => (state.squad.daily_budget_micro = 150000000), field: /daily_budget_micro/},
};
