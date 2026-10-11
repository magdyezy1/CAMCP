// meta_ad_rules: POST /{ad_rule_id} (Meta Marketing API v26.0, Ad Rules Engine) enabling a CHANGE_BUDGET rule. The
// decisive field is the rule's `execution_spec` change_spec `limit`, the upper bound Meta documents for the budget the
// enabled rule may set ("acts as an upper limit" for increases): the review's worst case is measured against it.
const rule = () => ({
  id: '701',
  account_id: '123',
  name: 'Raise budget when cheap',
  status: 'DISABLED',
  evaluation_spec: {
    evaluation_type: 'SCHEDULE',
    filters: [
      {field: 'entity_type', value: 'ADSET', operator: 'EQUAL'},
      {field: 'id', value: [201], operator: 'IN'},
      {field: 'time_preset', value: 'LAST_7_DAYS', operator: 'EQUAL'},
    ],
  },
  execution_spec: {
    execution_type: 'CHANGE_BUDGET',
    execution_options: [
      {field: 'change_spec', value: {amount: 20, unit: 'PERCENTAGE', limit: 9000}, operator: 'EQUAL'},
    ],
  },
  schedule_spec: {schedule_type: 'DAILY'},
});
/** Meta form fields arrive as text; JSON-valued fields are decoded as Meta decodes them. */
const decode = body =>
  Object.fromEntries(
    Object.entries(body ?? {}).map(([k, v]) => {
      try {
        return [k, JSON.parse(v)];
      } catch {
        return [k, v];
      }
    }),
  );

export default {
  family: 'meta_ad_rules',
  risk: 'activation',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  spendPolicy: {enforcement: 'block', max_budget_native: 20000},
  request: {action: 'meta_ad_rule_id_update', params: {ad_rule_id: '701'}, payload: {status: 'ENABLED'}},
  seed: () => ({
    rules: {701: rule()},
    objects: {
      201: {id: '201', account_id: '123', name: 'Riyadh', status: 'ACTIVE', daily_budget: '5000', bid_amount: '200'},
    },
  }),
  unpaginated: 'GET /{ad_rule_id} and GET /{adset_id} return one node each; Meta pages only edge collections',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const node = /^\/v26\.0\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET') {
      if (path === '/v26.0/act_123') return {json: {id: 'act_123', account_id: '123', currency: 'SAR'}};
      if (node && state.objects[node]) return {json: structuredClone(state.objects[node])};
      if (node && state.rules[node]) return {json: structuredClone(state.rules[node])};
      return {json: {error: {message: 'Unsupported get request.', code: 100, error_subcode: 33}}, status: 400};
    }
    if (method === 'POST' && node && state.rules[node]) {
      if (mode.partial) return {json: {success: false}};
      Object.assign(state.rules[node], decode(body));
      return {json: {success: true}};
    }
  },
  decisive: {
    change: state => (state.rules[701].execution_spec.execution_options[0].value.limit = 15000),
    field: /execution_spec|change_spec|limit/,
  },
};
