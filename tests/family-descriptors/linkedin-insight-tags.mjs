// linkedin_insight_tags: POST /rest/insightTags/{id} PARTIAL_UPDATE {patch: {$set: {firstPartyTrackingEnabled}}}
// (LinkedIn Conversion Tracking, li-lms-2026-09). The setting "will propagate to all the accounts with the same Insight
// Tag", so the decisive field is the tag's `sponsoredAccounts`: an account that starts sharing the tag after the review
// would have its tracking changed without the owner having seen it.
import {account, empty, restliError} from './_linkedin.mjs';

export default {
  family: 'linkedin_insight_tags',
  risk: 'settings',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {scopes: ['rw_ads']},
  request: {
    action: 'linkedin_rest_insight_tags_insight_tag_id_post',
    restli_method: 'PARTIAL_UPDATE',
    path_params: {insight_tag_id: '100'},
    payload: {patch: {$set: {firstPartyTrackingEnabled: false}}},
  },
  seed: () => ({
    tag: {id: 100, sponsoredAccounts: [account, 'urn:li:sponsoredAccount:508'], firstPartyTrackingEnabled: true},
  }),
  unpaginated:
    'the account and the tag are read by ID, and the Insight Tag and permission finders are filtered to the one tag ' +
    'of the account and its permission',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    const page = rows => ({json: {elements: structuredClone(rows), paging: {count: 10, start: 0, links: []}}});
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, status: 'ACTIVE', currency: 'SAR'}};
      if (path === '/rest/insightTags') return page([state.tag]);
      if (path === '/rest/insightTags/100') return {json: structuredClone(state.tag)};
      if (path === '/rest/insightTagsPermission')
        return page([{insightTag: 'urn:li:insightTag:100', accessRole: 'FULL'}]);
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/insightTags/100') {
      // A failed answer: LinkedIn refuses the update.
      if (mode.partial) return restliError(400, 'Insight Tag is not in an updatable state');
      Object.assign(state.tag, body.patch.$set);
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {
    change: state => state.tag.sponsoredAccounts.push('urn:li:sponsoredAccount:509'),
    field: /accounts/,
  },
};
