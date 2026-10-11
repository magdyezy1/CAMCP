// x_custom_audiences: DELETE /12/accounts/{account}/custom_audiences/{id} (X Ads API v12, Custom Audiences). GET
// .../targeted lists the "line items and campaigns that target" the audience, and a line item would lose its audience,
// so the decisive field is what targets it: a line item that starts targeting the audience after the review makes the
// family's own prerequisite refuse the deletion as the state is read again at execute.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_custom_audiences',
  risk: 'destructive',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_custom_audiences_custom_audience_id_delete',
    params: {custom_audience_id: 'aud1'},
  },
  seed: () => ({
    audience: {
      id: 'aud1',
      name: 'Newsletter',
      description: null,
      audience_type: 'WEB',
      audience_size: null,
      targetable: false,
      is_owner: true,
      permission_level: 'READ_WRITE',
      deleted: false,
    },
    targeted: [],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/custom_audiences/aud1') return reply(state.audience);
      // What targets the audience. Another page: X names the same cursor again, which never completes.
      if (s === '/custom_audiences/aud1/targeted')
        return reply(
          state.targeted.length ? [{campaign_id: 'camp1', line_items: state.targeted.map(id => ({id}))}] : [],
          mode.paginate ? 'again' : null,
        );
      return missing();
    }
    if (method === 'DELETE' && s === '/custom_audiences/aud1') {
      // A partial answer: X answers with the audience not marked deleted.
      if (mode.partial) return reply(state.audience);
      state.audience = {...state.audience, deleted: true};
      return reply(state.audience);
    }
  },
  decisive: {
    change: state => state.targeted.push('line9'),
    field: /targetedBy/,
    refusal: {code: 'AUDIENCE_IN_USE', message: /targeted by line items line9/},
  },
};
