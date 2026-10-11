// linkedin_third_party_tracking: POST /rest/thirdPartyTrackingTags (LinkedIn Third-Party Tracking, li-lms-2026-09) adding
// a DoubleClick click tag to a sponsored creative. A second identical tag would make DoubleClick count every click twice,
// so the decisive field is the creative's tracking tags: the same tag added in Campaign Manager after the review makes
// the family's own prerequisite refuse the creation as the state is read again at execute.
import {account, restliError} from './_linkedin.mjs';

const creative = 'urn:li:sponsoredCreative:901',
  url = 'https://ad.doubleclick.net/ddm/trackclk/N1234.5678/B1;dc_trk_aid=1;dc_trk_cid=2';

export default {
  family: 'linkedin_third_party_tracking',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_third_party_tracking_tags_post',
    payload: {entity: creative, event: 'CLICK', platform: 'DOUBLECLICK', trackingUrl: url},
  },
  seed: () => ({
    next: 70,
    creative: {id: creative, account, campaign: 'urn:li:sponsoredCampaign:601', intendedStatus: 'ACTIVE', name: 'Ad'},
    tags: [
      {
        id: 60,
        account,
        entity: creative,
        event: 'IMPRESSION',
        platform: 'DOUBLECLICK',
        trackingUrl: 'https://ad.doubleclick.net/ddm/trackimp/N1234.5678/B1',
      },
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (decodeURIComponent(path) === '/rest/adAccounts/507/creatives/' + creative)
        return {json: structuredClone(state.creative)};
      // The creative's tags. Another page: LinkedIn counts more tags than the page lists.
      if (path === '/rest/thirdPartyTrackingTags')
        return {
          json: {
            elements: structuredClone(state.tags),
            paging: {start: 0, count: 100, links: [], ...(mode.paginate ? {total: state.tags.length + 1} : {})},
          },
        };
      const tag = state.tags.find(t => path === '/rest/thirdPartyTrackingTags/' + t.id);
      return tag ? {json: structuredClone(tag)} : restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/thirdPartyTrackingTags') {
      const id = state.next++;
      state.tags.push({...body, id, account});
      // A partial answer: LinkedIn's receipt names no numeric tag ID.
      return new Response(null, {status: 201, headers: {'x-restli-id': mode.partial ? 'pending' : String(id)}});
    }
  },
  decisive: {
    change: state =>
      state.tags.push({id: 61, account, entity: creative, event: 'CLICK', platform: 'DOUBLECLICK', trackingUrl: url}),
    field: /tags/,
    refusal: {code: 'CONFIGURATION_EXISTS', message: /already has this CLICK tag as tracking tag 61/},
  },
};
