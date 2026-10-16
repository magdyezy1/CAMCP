// linkedin_conversion_links: PUT /rest/campaignConversions/(campaign:...,conversion:...) (LinkedIn Conversion Tracking,
// li-lms-2026-09) associating a conversion rule with a running campaign. The association changes how the campaign's
// conversions are credited and optimized, so the decisive field is the rule's `attributionType`: a rule re-attributed in
// LinkedIn after the review would be linked with an attribution the owner never saw.
import {account} from './_linkedin.mjs';

const campaign = 'urn:li:sponsoredCampaign:456',
  conversion = 'urn:lla:llaPartnerConversion:789',
  key = '(campaign:' + campaign + ',conversion:' + conversion + ')';

export default {
  family: 'linkedin_conversion_links',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_campaign_conversions_campaign_conversion_id_put',
    path_params: {campaign_conversion_id: key},
    payload: {campaign, conversion},
  },
  seed: () => ({
    campaign: {id: 456, account, name: 'Selected campaign', status: 'ACTIVE'},
    conversion: {
      id: 789,
      account,
      name: 'Purchase',
      type: 'PURCHASE',
      enabled: true,
      attributionType: 'LAST_TOUCH_BY_CAMPAIGN',
    },
    members: [],
  }),
  isWrite: ({method}) => method === 'PUT' || method === 'DELETE',
  provider({method, path, url, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, currency: 'USD', status: 'ACTIVE', name: 'Account'}};
      if (path === '/rest/adAccounts/507/adCampaigns/456') return {json: state.campaign};
      if (path === '/rest/conversions/789') return {json: state.conversion};
      if (path === '/rest/campaignConversions') {
        const start = Number(url.searchParams.get('start')),
          rows = state.members.slice(start, start + 100);
        // Another page: LinkedIn counts more associations than any page returns.
        return {
          json: {
            elements: rows,
            paging: {start, count: 100, total: state.members.length + (mode.paginate ? 1 : 0), links: []},
          },
        };
      }
      return undefined;
    }
    if (method === 'PUT' && path.startsWith('/rest/campaignConversions/')) {
      // A partial answer: LinkedIn answers 200 with an empty object instead of 204, which confirms nothing.
      if (mode.partial) return {json: {}};
      state.members.push({campaign, conversion});
      return new Response(null, {status: 204});
    }
  },
  paginatedCodes: ['CONVERSION_LINK_STATE_UNVERIFIED', 'INCOMPLETE_STATE'],
  decisive: {
    change: state => (state.conversion.attributionType = 'LAST_TOUCH_BY_CONVERSION'),
    field: /attributionType/,
  },
};
