// linkedin_dsc_edits: POST /rest/posts/{post URN} PARTIAL_UPDATE {patch: {$set: {commentary}}} (LinkedIn Posts API,
// li-lms-2026-09) on a Direct Sponsored Content post AMCP created. $set replaces the text that every creative
// sponsoring the post shows, so the decisive field is the post's current `commentary`: text edited in LinkedIn after the
// review would be silently overwritten.
import {account, empty, restliError} from './_linkedin.mjs';

const urn = 'urn:li:ugcPost:900',
  org = 'urn:li:organization:500';

export default {
  family: 'linkedin_dsc_edits',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {
    scopes: ['rw_ads', 'w_organization_social', 'r_organization_social'],
    resourceBindings: [{accountId: '507', pathPrefix: '/rest/organizations/500'}],
  },
  request: {
    action: 'linkedin_rest_posts_ugc_post_urn_post',
    api_version: '202609',
    path_params: {ugc_post_urn: urn},
    restli_method: 'PARTIAL_UPDATE',
    payload: {patch: {$set: {commentary: 'Autumn launch, now live'}}},
  },
  // The post AMCP created and verified for this login and account, as its creation records it.
  setup: ({store, actor, login}) =>
    store.putDocument(actor.tenantId, 'linkedin_post', login.id + '/' + urn, {
      account_id: '507',
      connection_id: login.id,
      author: org,
      post_id: urn,
      verified_at: Date.now(),
    }),
  seed: () => ({
    post: {
      id: urn,
      author: org,
      commentary: 'Autumn launch',
      visibility: 'PUBLIC',
      lifecycleState: 'PUBLISHED',
      contentLandingPage: 'https://example.com/autumn',
      contentCallToActionLabel: 'LEARN_MORE',
      adContext: {dscAdAccount: account, dscStatus: 'ACTIVE'},
    },
    creatives: [
      {
        id: 'urn:li:sponsoredCreative:700',
        intendedStatus: 'ACTIVE',
        campaign: 'urn:li:sponsoredCampaign:600',
        content: {reference: urn},
      },
    ],
  }),
  isWrite: ({method}) => method === 'POST' || method === 'DELETE',
  provider({method, path, body, state, mode}) {
    const post = decodeURIComponent(path) === '/rest/posts/' + urn;
    if (method === 'GET') {
      if (post) return {json: state.post};
      // The creatives that sponsor the post. Another page: LinkedIn names a nextPageToken on every page, whatever its
      // size, so the review must follow it (and refuse once it reads more than it can hold) rather than stop early.
      if (path === '/rest/adAccounts/507/creatives')
        return {
          json: {elements: structuredClone(state.creatives), metadata: mode.paginate ? {nextPageToken: 'n'} : {}},
        };
      return restliError(404, 'Not found');
    }
    if (method === 'POST' && post) {
      // A failed answer: LinkedIn refuses the edit.
      if (mode.partial) return restliError(422, 'Post cannot be updated');
      Object.assign(state.post, body.patch.$set);
      return empty();
    }
  },
  partialCodes: ['UPSTREAM_ERROR', 'WRITE_PARTIAL_OR_FAILED', 'WRITE_OUTCOME_UNCERTAIN'],
  decisive: {change: state => (state.post.commentary = 'Autumn launch (edited in LinkedIn)'), field: /commentary/},
};
