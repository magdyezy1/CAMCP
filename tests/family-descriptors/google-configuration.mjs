// google_configuration: POST /v25/customers/{id}/conversionValueRules:mutate (Google Ads API, ConversionValueRule), the
// configuration route that changes what value-based bidding optimizes for. The update overwrites the rule's
// `action` (operation and value), so the decisive field is the rule's current `action.value`.
import * as g from './_google-ads.mjs';

const rule = g.resource('conversionValueRules', '910');

export default {
  family: 'google_configuration',
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_conversion_value_rule_mutate_conversion_value_rules',
    payload: {
      operations: [
        {
          update: {resourceName: rule, action: {operation: 'ADD', value: 10}},
          updateMask: 'action',
        },
      ],
    },
  },
  seed: () => ({
    conversion_value_rule: [
      {
        resourceName: rule,
        action: {operation: 'ADD', value: 5},
        deviceCondition: {deviceTypes: ['DESKTOP']},
        status: 'ENABLED',
      },
    ],
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/conversionValueRules:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations)
        Object.assign(state.conversion_value_rule.find(r => r.resourceName === op.update.resourceName).action, {
          ...op.update.action,
        });
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {change: state => (state.conversion_value_rule[0].action.value = 7), field: /action/},
};
