// meta_labels: POST /{ad_label_id} (Meta Marketing API v26.0, Ad Label, Updating) renaming an account label. The update
// replaces the label's name wherever it is attached, so the decisive field is the label's current `name`: a rename made
// in Meta after the review would be silently overwritten.
import {decode, paged, unsupported, v} from './_meta.mjs';

const label = (id, name) => ({id, name, account: {id: 'act_123'}});

export default {
  family: 'meta_labels',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  owned: ['7001'],
  request: {action: 'meta_ad_label_id_update', path_params: {ad_label_id: '7001'}, payload: {name: 'Ramadan 2027'}},
  seed: () => ({labels: [label('7001', 'Ramadan'), label('7002', 'Evergreen'), label('7003', 'Brand')]}),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET' && path === v + '/act_123') return {json: {id: 'act_123', account_status: 1, currency: 'USD'}};
    // Every label of the account, read to its end in cursor pages. Another page: every page names one more.
    if (method === 'GET' && path === v + '/act_123/adlabels') return paged(state.labels, url, mode.paginate);
    if (method === 'POST' && path === v + '/7001') {
      // A partial answer: Meta reports the rename as not applied.
      if (mode.partial) return {json: {success: false}};
      state.labels[0].name = String(decode(body).name);
      return {json: {success: true}};
    }
    return unsupported();
  },
  paginatedCodes: ['META_LABEL_STATE_UNVERIFIED'],
  decisive: {change: state => (state.labels[0].name = 'Ramadan (renamed in Meta)'), field: /name/},
};
