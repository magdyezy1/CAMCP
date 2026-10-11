// meta_account_settings: POST /act_{id} (Meta Marketing API v26.0, Ad Account, Updating) renaming the ad account. The
// update replaces the stored value, so the decisive field is the account's current `name`: a rename made in Meta after
// the review would be silently overwritten.
import {decode, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_account_settings',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {action: 'meta_ad_account_id_create', payload: {name: 'Brand EU 2026'}},
  seed: () => ({
    account: {
      id: 'act_123',
      name: 'Brand EU',
      default_dsa_payor: 'Brand GmbH',
      default_dsa_beneficiary: 'Brand GmbH',
      is_notifications_enabled: true,
      account_status: 1,
    },
  }),
  unpaginated: 'GET /act_{id} returns one ad account node with the fields asked for; Meta pages only edges',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (path !== v + '/act_123') return unsupported();
    if (method === 'GET') return {json: structuredClone(state.account)};
    if (method === 'POST') {
      // A partial answer: Meta reports the update as not applied.
      if (mode.partial) return {json: {success: false}};
      Object.assign(state.account, decode(body));
      return {json: {success: true}};
    }
  },
  decisive: {change: state => (state.account.name = 'Brand EU (renamed in Meta)'), field: /name/},
};
