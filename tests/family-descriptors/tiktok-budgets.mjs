// tiktok_budgets: POST /v1.3/adgroup/budget/update/ (TikTok API for Business v1.3). The decisive field is the ad
// group's current `budget`, which the update overwrites and the owner's spending policy compares against.
const page = (list, more) => ({
  page: 1,
  page_size: 100,
  total_number: list.length + (more ? 100 : 0),
  total_page: more ? 2 : 1,
});
export default {
  family: 'tiktok_budgets',
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_adgroup_budget_update', payload: {budget: [{adgroup_id: '700', budget: 1200}]}},
  seed: () => ({
    groups: {
      700: {
        adgroup_id: '700',
        campaign_id: '70',
        advertiser_id: '123',
        adgroup_name: 'Lifetime A',
        budget_mode: 'BUDGET_MODE_TOTAL',
        budget: 1000,
        scheduled_budget: 0,
        campaign_automation_type: 'MANUAL',
        operation_status: 'DISABLE',
      },
    },
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/adgroup/budget/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/adgroup/get/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).adgroup_ids,
        list = ids.filter(id => state.groups[id]).map(id => ({...state.groups[id]}));
      return {json: {code: 0, message: 'OK', request_id: 'r', data: {list, page_info: page(list, mode.paginate)}}};
    }
    if (method === 'POST' && path.endsWith('/v1.3/adgroup/budget/update/')) {
      if (mode.partial) return {json: {code: 40002, message: 'Budget locked', request_id: 'r', data: {}}};
      for (const r of body.budget) state.groups[r.adgroup_id] = {...state.groups[r.adgroup_id], budget: r.budget};
      return {json: {code: 0, message: 'OK', request_id: 'r', data: {}}};
    }
  },
  decisive: {change: state => (state.groups[700].budget = 1100), field: /budget/},
};
