// meta_lookalikes: POST /act_{id}/customaudiences with subtype LOOKALIKE (Meta Marketing API v26.0, Lookalike
// Audiences) from an owned seed audience. Meta builds the lookalike from the seed as it is when the request arrives, and
// refuses flagged seeds, so the decisive field is the seed's `operation_status`: a seed whose status changed in Meta
// after the review is no longer the seed the owner chose.
import {decode, unsupported, v} from './_meta.mjs';

const fields = (row, url) =>
  Object.fromEntries(
    (url.searchParams.get('fields') ?? '')
      .split(',')
      .filter(f => row[f] !== undefined)
      .map(f => [f, row[f]]),
  );

export default {
  family: 'meta_lookalikes',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  owned: ['8001'],
  request: {
    action: 'meta_ad_account_id_customaudiences_create',
    payload: {
      name: 'Buyers lookalike SA 5%',
      subtype: 'LOOKALIKE',
      origin_audience_id: '8001',
      lookalike_spec: {ratio: 0.05, country: 'SA'},
    },
  },
  seed: () => ({
    account: {id: 'act_123', account_status: 1, currency: 'SAR'},
    audiences: {
      8001: {
        id: '8001',
        account_id: '123',
        name: 'Buyers',
        subtype: 'CUSTOM',
        operation_status: {code: 200, description: 'Normal'},
      },
    },
  }),
  unpaginated: 'GET /act_{id} and GET /{custom_audience_id} return one node each; Meta pages only edges',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: fields(state.account, url)};
      const row = state.audiences[path.slice(v.length + 1)];
      return row ? {json: fields(row, url)} : unsupported();
    }
    if (method === 'POST' && path === v + '/act_123/customaudiences') {
      // A partial answer: Meta answers without the new audience's ID.
      if (mode.partial) return {json: {}};
      const b = decode(body);
      state.audiences[8101] = {
        id: '8101',
        account_id: '123',
        name: b.name,
        subtype: 'LOOKALIKE',
        lookalike_spec: {...b.lookalike_spec, origin: [{id: b.origin_audience_id, type: 'custom_audience'}]},
      };
      return {json: {id: '8101'}};
    }
    return unsupported();
  },
  decisive: {
    change: state => (state.audiences[8001].operation_status = {code: 300, description: 'Audience too small'}),
    field: /operation_status/,
  },
};
