// x_targeting_batch: POST /12/batch/accounts/{account}/targeting_criteria (X Ads API v12, Targeting Criteria batch)
// adding a location to a paused line item. X applies the batch to the line item's targeting as it stands, so the decisive
// field is the line item's current targeting criteria: a criterion added in X after the review would combine with the
// reviewed one into an audience the owner never saw.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const criterion = (id, type, value) => ({
  id,
  account_id: account,
  line_item_id: 'line1',
  targeting_type: type,
  targeting_value: value,
  operator_type: 'EQ',
  deleted: false,
});

export default {
  family: 'x_targeting_batch',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_batch_accounts_account_id_targeting_criteria_post',
    payload: [
      {
        operation_type: 'Create',
        params: {line_item_id: 'line1', targeting_type: 'LOCATION', targeting_value: '06ef846bfc783874'},
      },
    ],
  },
  seed: () => ({
    next: 1,
    line: {id: 'line1', account_id: account, campaign_id: 'camp1', entity_status: 'PAUSED', deleted: false},
    campaign: {id: 'camp1', account_id: account, entity_status: 'ACTIVE', currency: 'SAR', deleted: false},
    criteria: [criterion('tc1', 'LANGUAGE', 'ar')],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', currency: 'SAR', deleted: false});
      if (s === '/line_items/line1') return reply(state.line);
      if (s === '/campaigns/camp1') return reply(state.campaign);
      // The line item's criteria. Another page: X names the same cursor again, which never completes.
      if (s === '/targeting_criteria') return reply(state.criteria, mode.paginate ? 'again' : null);
      return missing();
    }
    if (method === 'POST' && path === '/12/batch/accounts/' + account + '/targeting_criteria') {
      const rows = body.map(o => criterion('tcn' + state.next++, o.params.targeting_type, o.params.targeting_value));
      const answer = {
        data: structuredClone(rows),
        request: body.map(o => ({operation_type: o.operation_type, params: {...o.params, account_id: account}})),
      };
      // A partial answer: X names an item error beside the batch.
      if (mode.partial) return {json: {...answer, operation_errors: [[{code: 'INVALID_TARGETING_VALUE'}]]}};
      state.criteria.push(...rows);
      return {json: answer};
    }
  },
  paginatedCodes: ['X_TARGETING_STATE_UNVERIFIED', 'INCOMPLETE_STATE'],
  decisive: {change: state => state.criteria.push(criterion('tc2', 'GENDER', '1')), field: /criteria/},
};
