// meta_value_rules: POST /{value_rule_set_id} (Meta Marketing API v26.0, Value Rules). An update sends the complete
// set and every ad set using it bids by it at once, so the decisive field is an existing rule's `adjust_value`, the bid
// adjustment the update replaces: a change made in Meta after the review would be silently overwritten.
import {decode, unsupported, v} from './_meta.mjs';

const criterion = {
  id: '9101',
  criteria_type: 'GENDER',
  operator: 'CONTAINS',
  criteria_values: ['FEMALE'],
  criteria_value_types: ['NONE'],
};

export default {
  family: 'meta_value_rules',
  risk: 'budget',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {
    action: 'meta_value_rule_set_id_update',
    params: {value_rule_set_id: '8101'},
    payload: {
      name: 'Value set',
      rules: [{id: '9001', name: 'Women', adjust_sign: 'INCREASE', adjust_value: 30, criterias: [criterion]}],
    },
  },
  seed: () => ({
    sets: [
      {
        id: '8101',
        name: 'Value set',
        rules: {
          data: [
            {
              id: '9001',
              name: 'Women',
              adjust_sign: 'INCREASE',
              adjust_value: 20,
              status: 'ACTIVE',
              criterias: {data: [criterion]},
            },
          ],
        },
      },
    ],
  }),
  // The account's value rule sets as a caller lists them, which shows AMCP the set this account owns.
  prime: ({call}) =>
    call('meta_native_action', {
      action: 'meta_ad_account_id_value_rule_set_get',
      account_id: '123',
      params: {fields: 'id,name,rules{id,name,adjust_sign,adjust_value,status,criterias}'},
    }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path !== v + '/act_123/value_rule_set') return unsupported();
      const sets = structuredClone(state.sets);
      // Another page of the set's rules: the set was returned incompletely.
      if (mode.paginate) sets[0].rules.paging = {cursors: {after: 'x'}, next: 'https://graph.facebook.com/x?after=x'};
      return {json: {data: sets}};
    }
    if (method === 'POST' && path === v + '/8101') {
      if (mode.partial) return {json: {success: false}};
      const b = decode(body);
      state.sets[0] = {
        id: '8101',
        name: b.name,
        rules: {
          data: b.rules.map(r => ({...r, status: 'ACTIVE', criterias: {data: r.criterias}})),
        },
      };
      return {json: {success: true}};
    }
  },
  decisive: {change: state => (state.sets[0].rules.data[0].adjust_value = 25), field: /adjust_value/},
};
