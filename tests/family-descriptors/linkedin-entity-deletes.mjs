// linkedin_entity_deletes: DELETE /rest/adAccounts/{id}/adCampaignGroups?ids=List(...) BATCH_DELETE (LinkedIn Create and
// Manage Campaign Groups, li-lms-2026-09), which deletes DRAFT campaign groups. The reference does not say what deleting
// a group does to its campaigns, so the decisive field is the campaigns each group holds: a campaign created in a group
// after the review makes the family's own prerequisite refuse the deletion as the state is read again at execute.
// The paginated-snapshot check guards a defect it found: a campaign search page that listed no campaign but named
// another page read as a group without campaigns.
import {account, empty, restliError} from './_linkedin.mjs';

const group = id => 'urn:li:sponsoredCampaignGroup:' + id;

export default {
  family: 'linkedin_entity_deletes',
  risk: 'destructive',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaign_groups_delete',
    restli_method: 'BATCH_DELETE',
    query: {ids: ['801', '802']},
  },
  seed: () => ({
    groups: {
      801: {id: 801, account, name: 'Spring draft', status: 'DRAFT', test: false},
      802: {id: 802, account, name: 'Summer draft', status: 'DRAFT', test: false},
    },
    campaigns: [{id: 601, account, campaignGroup: group(804), status: 'ACTIVE'}],
  }),
  isWrite: ({method}) => method === 'DELETE',
  provider({method, path, url, state, mode}) {
    let m;
    if (method === 'GET' && (m = /^\/rest\/adAccounts\/507\/adCampaignGroups\/(\d+)$/.exec(path)))
      return state.groups[m[1]] ? {json: structuredClone(state.groups[m[1]])} : restliError(404, 'Not found');
    if (method === 'GET' && path === '/rest/adAccounts/507/adCampaigns') {
      // The group's first campaign (pageSize 1). Another page: a short page that lists none yet names a next page.
      const g = /sponsoredCampaignGroup:(\d+)/.exec(url.searchParams.get('search'))[1],
        rows = state.campaigns.filter(c => c.campaignGroup === group(g));
      return {
        json: {
          elements: mode.paginate ? [] : structuredClone(rows.slice(0, 1)),
          metadata: {nextPageToken: mode.paginate || rows.length > 1 ? 'next' : null},
        },
      };
    }
    if (method === 'DELETE' && path === '/rest/adAccounts/507/adCampaignGroups') {
      const ids = /^List\((.*)\)$/.exec(url.searchParams.get('ids'))[1].split(',');
      // A partial answer: LinkedIn deletes the first group and reports an error for the second.
      if (mode.partial) {
        delete state.groups[ids[0]];
        return {
          json: {results: {[ids[0]]: {status: 204}}, errors: {[ids[1]]: {status: 400, message: 'Not deletable'}}},
        };
      }
      for (const id of ids) delete state.groups[id];
      return empty();
    }
  },
  decisive: {
    change: state => state.campaigns.push({id: 602, account, campaignGroup: group(802), status: 'DRAFT'}),
    field: /firstCampaign/,
    refusal: {
      code: 'INVALID_LINKEDIN_BATCH_DELETE',
      message: /Campaign group 802 still has campaigns \(urn:li:sponsoredCampaign:602\)/,
    },
  },
};
