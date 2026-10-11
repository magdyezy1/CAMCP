// linkedin_audience_templates: POST /rest/adTargetTemplates/{id} PARTIAL_UPDATE {patch: {$set: {targetingCriteria}}}
// (LinkedIn Saved Audience Templates, li-lms-2026-09). The update replaces the template's complete targeting, so the
// decisive field is its current `targetingCriteria`: targeting changed in Campaign Manager after the review would be
// silently overwritten.
import {account, empty} from './_linkedin.mjs';

const facet = n => 'urn:li:adTargetingFacet:' + n;
const targeting = countries => ({
  include: {
    and: [
      {or: {[facet('locations')]: countries.map(c => 'urn:li:country:' + c)}},
      {or: {[facet('interfaceLocales')]: ['urn:li:locale:en_US']}},
    ],
  },
});
const template = (id, name, countries) => ({
  id,
  account,
  name,
  description: 'A synthetic saved audience',
  targetingCriteria: targeting(countries),
  approximateMemberCount: 1234,
});

export default {
  family: 'linkedin_audience_templates',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_ad_target_templates_template_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {template_id: '456'},
    payload: {patch: {$set: {targetingCriteria: targeting(['sa', 'ae'])}}},
  },
  seed: () => ({
    account: {id: 507, currency: 'SAR', status: 'ACTIVE', name: 'Brand KSA'},
    templates: [template(456, 'KSA audience', ['sa']), template(457, 'Gulf audience', ['ae', 'kw'])],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: structuredClone(state.account)};
      if (path === '/rest/adTargetTemplates') {
        const start = Number(url.searchParams.get('start') ?? 0),
          rows = state.templates.slice(start, start + 100);
        // Another page: LinkedIn counts one more template than any page returns.
        return {
          json: {
            elements: structuredClone(rows),
            paging: {start, count: 100, total: state.templates.length + (mode.paginate ? 1 : 0), links: []},
          },
        };
      }
      return undefined;
    }
    if (method === 'POST' && path === '/rest/adTargetTemplates/456') {
      // A partial answer: LinkedIn answers 200 with a body instead of 204, which confirms nothing.
      if (mode.partial) return {json: {status: 'PROCESSING'}};
      Object.assign(state.templates[0], body.patch.$set);
      return empty();
    }
  },
  paginatedCodes: ['LINKEDIN_TEMPLATE_STATE_UNVERIFIED'],
  decisive: {
    change: state => (state.templates[0].targetingCriteria = targeting(['sa', 'bh'])),
    field: /targetingCriteria/,
  },
};
