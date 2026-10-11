// meta_customer_lists: POST /act_{id}/customaudiences with subtype CUSTOM (Meta Marketing API v26.0, Customer File
// Custom Audiences) creating an empty customer list. "The API does not allow you to create or change Custom Audiences
// if the terms have not been accepted", so the decisive field is the ad account's `tos_accepted.custom_audience_tos`:
// terms withdrawn after the review make the family's own prerequisite refuse the list as the state is read again.
// (Adding people needs the owner's personal-data policy and the people beside the arguments; the list creation is the
// family's state-dependent write the harness can drive.)
import {unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_customer_lists',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {
    action: 'meta_ad_account_id_customaudiences_create',
    payload: {name: 'Newsletter subscribers', subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY'},
  },
  seed: () => ({account: {id: 'act_123', account_id: '123', tos_accepted: {custom_audience_tos: 1}}, lists: []}),
  unpaginated: 'GET /act_{id}?fields=id,account_id,tos_accepted returns one ad account node; Meta pages only edges',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, state, mode}) {
    if (method === 'GET') return path === v + '/act_123' ? {json: state.account} : unsupported();
    if (method === 'POST' && path === v + '/act_123/customaudiences') {
      // A partial answer: Meta answers without the ID of a list.
      if (mode.partial) return {json: {}};
      state.lists.push('23850000000000001');
      return {json: {id: '23850000000000001'}};
    }
  },
  decisive: {
    change: state => (state.account.tos_accepted.custom_audience_tos = 0),
    field: /terms_accepted/,
    refusal: {code: 'PERSONAL_DATA_TERMS_NOT_ACCEPTED', message: /terms are not accepted/},
  },
};
