// linkedin_dsc: POST /rest/posts (LinkedIn Posts API, li-lms-2026-09) creating a Direct Sponsored Content post, PUBLISHED
// without feed distribution, around one video. LinkedIn serves the post with the video as it is when the post is made,
// so the decisive field is the video's `status`: a video no longer AVAILABLE after the review makes the family's own
// prerequisite refuse the post as the state is read again at execute.
import {account, restliError} from './_linkedin.mjs';

const video = 'urn:li:video:456',
  organization = 'urn:li:organization:500';

export default {
  family: 'linkedin_dsc',
  risk: 'activation',
  gateway: 'linkedin_native_action',
  account: '507',
  connection: {
    scopes: ['rw_ads', 'w_organization_social', 'r_organization_social'],
    // An administrator bound the organization to the account; account access alone does not establish Page access.
    resourceBindings: [{accountId: '507', pathPrefix: '/rest/organizations/500'}],
  },
  request: {
    action: 'linkedin_rest_posts_post',
    api_version: '202609',
    payload: {
      author: organization,
      commentary: 'Synthetic sponsored update',
      visibility: 'PUBLIC',
      distribution: {feedDistribution: 'NONE', targetEntities: [], thirdPartyDistributionChannels: []},
      content: {media: {id: video, title: 'Product clip'}},
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: true,
      adContext: {dscAdAccount: account, dscStatus: 'ACTIVE'},
    },
  },
  // The video was imported and verified with this login and account.
  setup: ({store, actor, login}) =>
    store.putDocument(actor.tenantId, 'workspace_asset', 'media-receipt', {
      connection_id: login.id,
      account_id: '507',
      platform: 'linkedin',
      media_id: video,
      status_source: 'provider',
      ready: true,
      owner_urn: organization,
    }),
  seed: () => ({
    video: {id: video, owner: organization, status: 'AVAILABLE', mediaLibraryMetadata: {associatedAccount: account}},
    posts: {},
  }),
  unpaginated:
    'GET /rest/adAccounts/{id} and GET /rest/videos/{urn} return one entity each; LinkedIn pages only finders',
  isWrite: ({method}) => method === 'POST',
  provider({method, path, body, state, mode}) {
    const decoded = decodeURIComponent(path);
    if (method === 'GET') {
      if (path === '/rest/adAccounts/507') return {json: {id: 507, name: 'Brand KSA', status: 'ACTIVE'}};
      if (decoded === '/rest/videos/' + video) return {json: structuredClone(state.video)};
      const post = state.posts[decoded.slice('/rest/posts/'.length)];
      return post ? {json: structuredClone(post)} : restliError(404, 'Not found');
    }
    if (method === 'POST' && path === '/rest/posts') {
      state.posts['urn:li:ugcPost:900'] = {...body, id: 'urn:li:ugcPost:900'};
      // A partial answer: LinkedIn's receipt names something other than a post.
      const receipt = mode.partial ? 'urn:li:sponsoredCreative:901' : 'urn:li:ugcPost:900';
      return new Response(null, {status: 201, headers: {'x-restli-id': receipt}});
    }
  },
  decisive: {
    change: state => (state.video.status = 'PROCESSING'),
    field: /status/,
    refusal: {code: 'LINKEDIN_MEDIA_NOT_READY', message: /must be AVAILABLE/},
  },
};
