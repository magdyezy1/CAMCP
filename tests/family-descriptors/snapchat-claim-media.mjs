// snapchat_claim_media: POST /v1/adaccounts/{ad_account_id}/claim_media_by_snap_reference?snap_id= (Snapchat Marketing
// API v1, "Claim Media": "Callers must have permissions to both the target ad account and Snap"). The claimed media
// joins the ad account's library, owned through the account's `organization_id` in "Get a specific Ad Account", so that
// is the decisive field: an account moved to another organization after the review would hand the Snap to it.
import {adAccount, ok} from './_snapchat.mjs';

export default {
  family: 'snapchat_claim_media',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {
    action: 'snapchat_adaccounts_ad_account_id_claim_media_by_snap_reference_create',
    ad_account_id: 'acct1',
    params: {ad_account_id: 'acct1'},
    query: {snap_id: 'snap_ref_0123456789abcdef'},
  },
  seed: () => ({organization: 'org-1', media: {}}),
  unpaginated: 'GET /v1/adaccounts/{ad_account_id} returns the one ad account; Snapchat pages only collections',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1', state.organization);
    const media = /^\/v1\/media\/([\w-]+)$/.exec(path)?.[1];
    if (method === 'GET' && media && state.media[media])
      return ok({media: [{sub_request_status: 'SUCCESS', media: structuredClone(state.media[media])}]});
    if (method === 'POST' && path === '/v1/adaccounts/acct1/claim_media_by_snap_reference') {
      // A failed claim: Snap refuses it (no access to the Snap's profile) and names no media.
      if (mode.partial) return {json: {request_status: 'ERROR', request_id: 'r', display_message: 'No access'}};
      const id = 'media-' + url.searchParams.get('snap_id').slice(-4);
      state.media[id] = {id, ad_account_id: 'acct1', media_status: 'PENDING_UPLOAD'};
      return ok({media_entity_id: id});
    }
  },
  decisive: {change: state => (state.organization = 'org-2'), field: /organization_id/},
};
