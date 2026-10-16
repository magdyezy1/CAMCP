// Shared synthetic Google answers for the Data Manager descriptors (not a descriptor itself): the Google Ads API state
// reads of the list or conversion action, and the Data Manager API writes and request status. A write answers with a
// request ID; the status of that request counts every record of the last batch. A partial answer names no request.
import * as g from './_google-ads.mjs';

export const origin = 'https://datamanager.googleapis.com';
export const connection = {
  scopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager'],
};
/** The uploader's confirmations for people in Saudi Arabia (personal-data policy). */
export const confirmations = {
  countries: ['SA'],
  consent_confirmed: true,
  platform_terms_confirmed: true,
  pdpl: {consent: true, transfer_abroad: true, withdrawal_removal: true},
};
/** Google consent for everyone in an upload, from the consent the people gave. */
export const consent = {ad_user_data: 'GRANTED', ad_personalization: 'DENIED'};
/** The owner turns personal data on for the account before anything is prepared. */
export const prime = ({call, connectionId}) =>
  call('amcp_workspace', {
    action: 'enable_personal_data',
    connection_id: connectionId,
    account_id: g.account,
    confirmed: true,
  });
export const isWrite = ({method, url}) => url.origin === origin && method === 'POST';
/** Answers the Google Ads state reads from `state[kind]` and the Data Manager writes and status reads. */
export function provider(request, list) {
  const {method, url, path, body, state, mode} = request;
  if (g.isSearch(request))
    // The reads select by ID (`WHERE user_list.id = 42`), so the row is chosen by its numeric ID.
    return g.search(request, kind => {
      const id = new RegExp(kind + '\\.id = (\\d+)').exec(body.query)?.[1];
      return (state[kind] ?? []).filter(row => id === undefined || row.id === id);
    });
  if (url.origin !== origin) return;
  if (method === 'GET' && path === '/v1/requestStatus:retrieve') {
    const last = state.sent.at(-1);
    return {
      json: {
        requestStatusPerDestination: [
          {destination: last.destinations[0], requestStatus: 'SUCCESS', ...list.counts(last)},
        ],
      },
    };
  }
  if (method === 'POST' && path === list.path) {
    // Google accepted the request but the answer names no request: nothing proves what it received.
    if (mode.partial) return {json: {}};
    state.sent.push(body);
    return {json: {requestId: 'synthetic-' + state.sent.length}};
  }
}
