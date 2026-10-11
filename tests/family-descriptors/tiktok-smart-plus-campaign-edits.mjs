// tiktok_smart_plus_campaign_edits: POST /v1.3/smart_plus/campaign/update/ (API for Business v1.3, "Update an upgraded
// Smart+ campaign"). The decisive field is the campaign's current `budget`: the edit overwrites it, and the owner's
// spending policy compares the new budget with it.
import {failed, filtered, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_campaign_edits',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_smart_plus_campaign_update', payload: {campaign_id: '80', budget: 600}},
  seed: () => ({
    campaigns: {
      80: {
        campaign_id: '80',
        campaign_name: 'CBO web',
        objective_type: 'WEB_CONVERSIONS',
        sales_destination: 'WEBSITE',
        budget_optimize_on: true,
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 500,
        operation_status: 'ENABLE',
      },
    },
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/campaign/get/'))
      return list(filtered(url, state.campaigns, 'campaign_ids'), mode.paginate);
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/campaign/update/')) {
      if (mode.partial) return failed('Budget below minimum');
      const {advertiser_id: _, campaign_id, ...changes} = body;
      state.campaigns[campaign_id] = {...state.campaigns[campaign_id], ...changes};
      return ok(structuredClone(state.campaigns[campaign_id]));
    }
  },
  decisive: {change: state => (state.campaigns[80].budget = 550), field: /budget/},
};
