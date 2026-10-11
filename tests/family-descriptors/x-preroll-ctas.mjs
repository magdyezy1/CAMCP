// x_preroll_ctas: PUT /12/accounts/{account}/preroll_call_to_actions/{id} (X Ads API v12, Preroll Call To Actions)
// pointing the button of an active pre-roll line item at another URL. Viewers who click go to that URL at once, and the
// update replaces it, so the decisive field is the button's current `call_to_action_url`: a URL changed in X after the
// review would be silently overwritten.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_preroll_ctas',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_preroll_call_to_actions_preroll_call_to_action_id_put',
    params: {preroll_call_to_action_id: 'cta1'},
    payload: {call_to_action_url: 'https://shop.example.test/autumn'},
  },
  seed: () => ({
    line: {id: 'pre', campaign_id: 'camp1', name: 'Pre-roll', objective: 'PREROLL_VIEWS', entity_status: 'ACTIVE'},
    campaign: {id: 'camp1', entity_status: 'ACTIVE', deleted: false},
    cta: {
      id: 'cta1',
      line_item_id: 'pre',
      call_to_action: 'VISIT_SITE',
      call_to_action_url: 'https://shop.example.test/summer',
      deleted: false,
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/preroll_call_to_actions/cta1') return reply(state.cta);
      if (s === '/line_items/pre') return reply(state.line);
      if (s === '/campaigns/camp1') return reply(state.campaign);
      // The line item's calls to action, read in one page. Another page: X names a cursor.
      if (s === '/preroll_call_to_actions') return reply([state.cta], mode.paginate ? 'more' : null);
      return missing();
    }
    if (method === 'PUT' && s === '/preroll_call_to_actions/cta1') {
      // A partial answer: X echoes the button with its old URL.
      if (mode.partial) return reply(state.cta);
      Object.assign(state.cta, body);
      return reply(state.cta);
    }
  },
  decisive: {
    change: state => (state.cta.call_to_action_url = 'https://shop.example.test/sale'),
    field: /url/,
  },
};
