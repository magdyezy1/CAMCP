// tiktok_smart_plus_budgets: POST /v1.3/smart_plus/adgroup/budget/update/. The decisive field is the Smart+ ad group's
// current `budget`, which the update overwrites and the spending policy compares against.
import {failed, filtered, list, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_smart_plus_budgets',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_smart_plus_adgroup_budget_update',
    payload: {budget: [{adgroup_id: '400', budget: 120}]},
  },
  seed: () => ({
    groups: {
      400: {
        adgroup_id: '400',
        adgroup_name: 'Smart+ daily',
        campaign_id: '40',
        budget_mode: 'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
        budget: 100,
        operation_status: 'ENABLE',
      },
    },
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/budget/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/adgroup/get/'))
      return list(filtered(url, state.groups, 'adgroup_ids'), mode.paginate);
    if (method === 'POST' && path.endsWith('/v1.3/smart_plus/adgroup/budget/update/')) {
      if (mode.partial) return failed('Budget below minimum');
      for (const r of body.budget) state.groups[r.adgroup_id].budget = r.budget;
      return ok({});
    }
  },
  decisive: {change: state => (state.groups[400].budget = 110), field: /budget/},
};
