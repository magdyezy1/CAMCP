// reddit_creatives: PATCH /api/v3/posts/{post_id} (Reddit Ads API v3, Update Post) turning comments on for a post used
// by ads. The update changes the post wherever it serves, so the decisive field is the post's current `allow_comments`,
// the value the update overwrites; a setting changed in Reddit after the review must stop the reviewed change.
const account = 'a2_111',
  profile = {id: '123', reddit_user_id: 't2_abc', name: 'Example', business_id: '11111111-1111-4111-8111-111111111111'};

export default {
  family: 'reddit_creatives',
  risk: 'activation',
  gateway: 'reddit_native_action',
  account,
  connection: {scopes: ['adsread', 'adsedit'], userAgent: 'server:amcp-tests:0.1.0 (local mock)'},
  owned: ['posts/t3_abc'],
  arguments: {
    operation: 'reddit_post_ops',
    arguments: {
      action: 'UPDATE_POST',
      account_id: account,
      params: {post_id: 't3_abc'},
      payload: {data: {allow_comments: true}},
    },
  },
  seed: () => ({
    '/api/v3/posts/t3_abc': {
      id: 't3_abc',
      profile_id: 't2_abc',
      allow_comments: false,
      type: 'TEXT',
      headline: 'Current headline',
      body: 'Current body',
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET') {
      if (path === '/api/v3/ad_accounts/' + account) return {json: {data: {id: account, name: 'Account'}}};
      if (path === '/api/v3/ad_accounts/' + account + '/profiles')
        return {json: {data: [structuredClone(profile)], pagination: {next_url: null}}};
      if (!state[path]) return undefined;
      return {
        json: {
          data: structuredClone(state[path]),
          request_id: 'r',
          // Another page: Reddit names it with pagination.next_url.
          ...(mode.paginate ? {pagination: {next_url: 'https://ads-api.reddit.com' + path + '?page.token=x'}} : {}),
        },
      };
    }
    if (method === 'PATCH' && state[path]) {
      // A partial answer: the receipt names another author than the post's.
      if (mode.partial) return {json: {data: {...state[path], ...body.data, profile_id: 't2_foreign'}}};
      state[path] = {...state[path], ...body.data};
      return {json: {data: structuredClone(state[path])}};
    }
  },
  decisive: {change: state => (state['/api/v3/posts/t3_abc'].allow_comments = true), field: /allow_comments/},
};
