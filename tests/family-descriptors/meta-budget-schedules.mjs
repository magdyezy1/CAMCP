// meta_budget_schedules: POST /{campaign_id}/budget_schedules (Meta Marketing API v26.0). The decisive field is the
// campaign's `daily_budget`: a scheduled ABSOLUTE increase is measured against it (the review's peak and extra spend)
// and Meta caps a period at eight times it.
const hour = 3600,
  // Three days ahead at 06:00 Riyadh time, so the six-hour period stays inside one local day.
  startAt = Math.floor(Date.now() / 1000 / 86400) * 86400 + 3 * 86400 + 3 * hour,
  iso = s => new Date(s * 1000).toISOString().replace('.000Z', '+0000');

export default {
  family: 'meta_budget_schedules',
  risk: 'budget',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  spendPolicy: {enforcement: 'block', max_budget_native: 100000},
  request: {
    action: 'meta_campaign_id_budget_schedules_create',
    params: {campaign_id: '111'},
    payload: {budget_value: 20, budget_value_type: 'ABSOLUTE', time_start: startAt, time_end: startAt + 6 * hour},
  },
  seed: () => ({
    account: {
      id: 'act_123',
      currency: 'USD',
      timezone_name: 'Asia/Riyadh',
      capabilities: ['CAN_USE_BUDGET_SCHEDULING_API'],
    },
    campaigns: {111: {id: '111', account_id: '123', name: 'Always on', daily_budget: '10000', status: 'ACTIVE'}},
    schedules: {111: []},
  }),
  prime: ({call}) =>
    call('meta_native_action', {
      action: 'meta_ad_account_id_campaigns_get',
      account_id: '123',
      params: {fields: 'id,name'},
    }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/v26.0/act_123/campaigns')
        return {json: {data: Object.values(state.campaigns).map(c => ({id: c.id, name: c.name}))}};
      if (path === '/v26.0/act_123') return {json: state.account};
      const list = /^\/v26\.0\/(\d+)\/budget_schedules$/.exec(path);
      if (list)
        return {
          json: {
            data: state.schedules[list[1]].map(p => ({...p, time_start: iso(p.time_start), time_end: iso(p.time_end)})),
            ...(mode.paginate
              ? {paging: {next: 'https://graph.facebook.com/v26.0/' + list[1] + '/budget_schedules?after=x'}}
              : {}),
          },
        };
      const node = /^\/v26\.0\/(\d+)$/.exec(path);
      if (node && state.campaigns[node[1]]) return {json: state.campaigns[node[1]]};
      return {json: {error: {message: 'Unsupported get request', code: 100, error_subcode: 33}}, status: 400};
    }
    const target = /^\/v26\.0\/(\d+)\/budget_schedules$/.exec(path)?.[1];
    if (method === 'POST' && target) {
      // A partial answer: Meta accepted the call but returned no schedule ID.
      if (mode.partial) return {json: {}};
      const id = String(9000 + state.schedules[target].length);
      state.schedules[target].push({
        id,
        budget_value: Number(body.budget_value),
        budget_value_type: body.budget_value_type,
        recurrence_type: 'ONE_TIME',
        time_start: Number(body.time_start),
        time_end: Number(body.time_end),
      });
      return {json: {id}};
    }
  },
  decisive: {change: state => (state.campaigns[111].daily_budget = '12000'), field: /daily_budget/},
};
