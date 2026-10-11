// snapchat_offer_disclaimers: POST /v1/adaccounts/{ad_account_id}/offer_disclaimers (Snapchat Marketing API v1, "Offer
// Disclaimers"; created and deleted, no update documented). The review decides against the account's disclaimers
// listed by "Get all Offer Disclaimers" (their names, which a new one must not repeat), so the decisive field is that
// list: a disclaimer created in Snapchat after the review changes what the reviewed creation adds to.
import {failed, ok, page, rows} from './_snapchat.mjs';

export default {
  family: 'snapchat_offer_disclaimers',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {
    action: 'snapchat_adaccounts_ad_account_id_offer_disclaimers_create',
    ad_account_id: 'acct1',
    params: {ad_account_id: 'acct1'},
    payload: {
      offer_disclaimers: [
        {
          name: 'APR terms',
          ad_account_id: 'acct1',
          disclaimer_render_type: 'STATIC',
          disclaimer_text: 'Representative 19.9% APR variable.',
        },
      ],
    },
  },
  seed: () => ({
    disclaimers: {
      'od-1': {
        id: 'od-1',
        ad_account_id: 'acct1',
        name: 'Lease terms',
        disclaimer_render_type: 'STATIC',
        disclaimer_text: 'Subject to status.',
      },
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1/offer_disclaimers')
      return page('offer_disclaimers', 'offer_disclaimer', Object.values(state.disclaimers), mode.paginate, url);
    if (method === 'POST' && path === '/v1/adaccounts/acct1/offer_disclaimers') {
      if (mode.partial) return failed('offer_disclaimers', body.offer_disclaimers);
      const created = body.offer_disclaimers.map((d, i) => {
        const id = 'od-' + (Object.keys(state.disclaimers).length + 1 + i);
        return (state.disclaimers[id] = {id, ...d});
      });
      return ok({offer_disclaimers: rows('offer_disclaimer', created)});
    }
  },
  decisive: {
    change: state =>
      (state.disclaimers['od-9'] = {
        id: 'od-9',
        ad_account_id: 'acct1',
        name: 'APR terms 2026',
        disclaimer_render_type: 'STATIC',
        disclaimer_text: 'Representative 21.9% APR variable.',
      }),
    field: /disclaimers/,
  },
};
