// snapchat_media_copy: POST /v1/adaccounts/{ad_account_id}/media_copy (Snapchat Marketing API v1, "Media", Copy Media:
// "A copy keeps the name, type and download link under a new ID"; the request is not atomic). The decisive field is
// the source media's `name` in "Get a specific Media": the copy takes the name and file the source has when it is sent,
// so a source renamed after the review would copy something other than the reviewed media.
import {adAccount, ok, rows} from './_snapchat.mjs';

export default {
  family: 'snapchat_media_copy',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  connection: {accounts: ['acct1', 'acct2']},
  arguments: {
    action: 'snapchat_adaccounts_ad_account_id_media_copy_create',
    ad_account_id: 'acct1',
    params: {ad_account_id: 'acct1'},
    payload: {media_copy: [{source_media_id: 'm-src', source_ad_account_id: 'acct2'}]},
  },
  seed: () => ({
    media: {
      'm-src': {id: 'm-src', ad_account_id: 'acct2', name: 'Autumn hero', type: 'VIDEO', media_status: 'READY'},
    },
  }),
  unpaginated: 'GET /v1/adaccounts/{id} and GET /v1/media/{id} return one entity each; Snapchat pages collections',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const account = /^\/v1\/adaccounts\/(acct[12])$/.exec(path)?.[1];
    if (method === 'GET' && account) return adAccount(account);
    const media = /^\/v1\/media\/([\w-]+)$/.exec(path)?.[1];
    if (method === 'GET' && media && state.media[media]) return ok({media: rows('media', [state.media[media]])});
    if (method === 'POST' && path === '/v1/adaccounts/acct1/media_copy') {
      // A partial answer: Snapchat accepts the request but the copy itself fails.
      if (mode.partial)
        return ok({media: body.media_copy.map(() => ({sub_request_status: 'ERROR', sub_request_error_reason: 'x'}))});
      const copies = body.media_copy.map((c, i) => {
        const id = 'm-copy-' + (i + 1);
        return (state.media[id] = {...state.media[c.source_media_id], id, ad_account_id: 'acct1'});
      });
      return ok({media: rows('media', copies)});
    }
  },
  decisive: {change: state => (state.media['m-src'].name = 'Winter hero'), field: /m-src.*name/},
};
