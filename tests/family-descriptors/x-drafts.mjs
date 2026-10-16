// x_drafts: PUT /12/accounts/{account}/draft_tweets/{id} (X Ads API v12, Draft Tweets) rewriting a saved draft's text. The
// update replaces the text, so the decisive field is the draft's current `text`: a draft edited in X after the review
// would be silently overwritten.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const user = '2244994945',
  draft = '1300000000000000100';

export default {
  family: 'x_drafts',
  risk: 'settings',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_draft_tweets_draft_tweet_id_put',
    params: {draft_tweet_id: draft},
    payload: {text: 'Autumn sale: two days left'},
  },
  seed: () => ({
    draft: {
      id: draft,
      user_id: user,
      text: 'Autumn sale starts soon',
      nullcast: true,
      name: 'Autumn',
      card_uri: null,
      media_keys: [],
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      // The account's promotable users. Another page: X names the same cursor again, which never completes.
      if (s === '/promotable_users')
        return reply(
          [{id: 'pu1', user_id: user, promotable_user_type: 'FULL', deleted: false}],
          mode.paginate ? 'again' : null,
        );
      if (s === '/draft_tweets/' + draft) return reply(state.draft);
      return missing();
    }
    if (method === 'PUT' && s === '/draft_tweets/' + draft) {
      // A partial answer: X returns the draft as another author's.
      if (mode.partial) return reply({...state.draft, ...body, user_id: '999'});
      Object.assign(state.draft, body);
      return reply(state.draft);
    }
  },
  paginatedCodes: ['X_CREATIVE_STATE_UNVERIFIED', 'X_DRAFT_STATE_UNVERIFIED', 'INCOMPLETE_STATE'],
  decisive: {change: state => (state.draft.text = 'Autumn sale starts Monday'), field: /text/},
};
