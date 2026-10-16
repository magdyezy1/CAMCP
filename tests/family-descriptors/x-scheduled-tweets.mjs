// x_scheduled_tweets: DELETE /12/accounts/{account}/scheduled_tweets/{id} (X Ads API v12, Scheduled Tweets) removing a
// scheduled Tweet before X publishes it. Line items that schedule its promotion would then have nothing to promote, so
// the decisive field is the line items that promote it: a promotion scheduled in X after the review would be emptied
// without the owner having seen it.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const user = '2244994945',
  tweet = '1400000000000000001';

export default {
  family: 'x_scheduled_tweets',
  risk: 'destructive',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_scheduled_tweets_scheduled_tweet_id_delete',
    params: {scheduled_tweet_id: tweet},
  },
  seed: () => ({
    tweet: {
      id_str: tweet,
      user_id: user,
      text: 'Launch day',
      nullcast: true,
      media_keys: [],
      scheduled_at: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 19) + 'Z',
      scheduled_status: 'SCHEDULED',
      tweet_id: null,
      completed_at: null,
      deleted: false,
    },
    promoted: [{id: 'spt1', line_item_id: 'line1', scheduled_tweet_id: '1400000000000000999', deleted: false}],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/scheduled_tweets/' + tweet) return state.tweet ? reply(state.tweet) : missing();
      if (s === '/promotable_users')
        return reply([{id: 'pu1', user_id: user, promotable_user_type: 'FULL', deleted: false}]);
      // The account's scheduled promotions. Another page: X names the same cursor again, which never completes.
      if (s === '/scheduled_promoted_tweets') return reply(state.promoted, mode.paginate ? 'again' : null);
      return missing();
    }
    if (method === 'DELETE' && s === '/scheduled_tweets/' + tweet) {
      // A partial answer: X answers with another scheduled Tweet's identity.
      if (mode.partial) return reply({...state.tweet, id_str: '1400000000000000999'});
      const gone = state.tweet;
      state.tweet = undefined;
      return reply(gone);
    }
  },
  decisive: {
    change: state =>
      state.promoted.push({id: 'spt2', line_item_id: 'line2', scheduled_tweet_id: tweet, deleted: false}),
    field: /promotedIn/,
  },
};
