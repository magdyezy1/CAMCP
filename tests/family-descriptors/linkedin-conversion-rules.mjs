// linkedin_conversion_rules: POST /rest/conversions/{id} PARTIAL_UPDATE (LinkedIn Conversion Tracking, li-lms-2026-09)
// shortening a rule's post-click attribution window. $set replaces the field whole and the change applies to every
// campaign using the rule, so the decisive field is the rule's current `postClickAttributionWindowSize`: a window
// changed in LinkedIn after the review would be silently replaced.
import {account, empty, restliError} from './_linkedin.mjs';

const campaign = 'urn:li:sponsoredCampaign:456';

export default {
  family: 'linkedin_conversion_rules',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_conversions_conversion_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {conversion_id: '789'},
    query: {account},
    payload: {patch: {$set: {postClickAttributionWindowSize: 7}}},
  },
  seed: () => ({
    rule: {
      id: 789,
      account,
      name: 'Purchase',
      type: 'PURCHASE',
      enabled: true,
      attributionType: 'LAST_TOUCH_BY_CAMPAIGN',
      postClickAttributionWindowSize: 30,
      viewThroughAttributionWindowSize: 7,
      valueType: 'DYNAMIC',
      campaigns: [campaign],
      associatedCampaigns: [{campaign, conversion: 'urn:lla:llaPartnerConversion:789', associatedAt: 1}],
    },
    campaign: {id: 456, account, name: 'Running campaign', status: 'ACTIVE'},
  }),
  unpaginated: 'the account, the named rule and each campaign it applies to are read by ID as single entities',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, currency: 'USD', status: 'ACTIVE', name: 'Account'}};
      if (path === '/rest/conversions/789') return {json: state.rule};
      if (path === '/rest/adAccounts/507/adCampaigns/456') return {json: state.campaign};
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/conversions/789') {
      // A partial answer: LinkedIn answers 200 with a body instead of the empty 204 a PARTIAL_UPDATE returns.
      if (mode.partial) return {json: {id: 789}};
      Object.assign(state.rule, body.patch.$set);
      return empty();
    }
  },
  decisive: {
    change: state => (state.rule.postClickAttributionWindowSize = 1),
    field: /postClickAttributionWindowSize/,
  },
};
