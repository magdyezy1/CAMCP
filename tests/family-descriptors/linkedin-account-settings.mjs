// linkedin_account_settings: POST /rest/adAccounts/{id} PARTIAL_UPDATE {patch: {$set: {name}}} (LinkedIn Create and
// Manage Ad Accounts, li-lms-2026-09). The partial update replaces the stored name, so the decisive field is the
// account's current `name`: a rename made in Campaign Manager after the review would be silently overwritten.
import {empty, restliError} from './_linkedin.mjs';

export default {
  family: 'linkedin_account_settings',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_accounts_ad_account_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {ad_account_id: '507'},
    payload: {patch: {$set: {name: 'Brand KSA 2027', notifiedOnEndOfCampaign: true}}},
  },
  seed: () => ({
    account: {
      id: 507,
      name: 'Brand KSA',
      status: 'ACTIVE',
      type: 'BUSINESS',
      currency: 'SAR',
      notifiedOnCampaignOptimization: true,
      notifiedOnEndOfCampaign: false,
      servingStatuses: ['RUNNABLE'],
    },
  }),
  unpaginated: 'GET /rest/adAccounts/{id} returns one account entity; LinkedIn pages only finder collections',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (path !== '/rest/adAccounts/507') return method === 'GET' ? restliError(404, 'Not found') : undefined;
    if (method === 'GET') return {json: structuredClone(state.account)};
    // A partial answer: LinkedIn answers 200 with a body instead of 204, which confirms nothing.
    if (mode.partial) return {json: {status: 'UNKNOWN'}};
    Object.assign(state.account, body.patch.$set);
    return empty();
  },
  decisive: {change: state => (state.account.name = 'Brand KSA (renamed in LinkedIn)'), field: /name/},
};
