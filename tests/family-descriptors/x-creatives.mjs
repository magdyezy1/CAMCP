// x_creatives: POST /12/accounts/{account}/promoted_tweets (X Ads API v12, Promoted Tweets) promoting a nullcast Tweet
// under a line item. X creates the promotion ACTIVE, so it serves as soon as its line item and campaign do: the decisive
// field is the line item's `entity_status`, and a line item activated in X after the review would start spending on
// an ad the owner reviewed as staged.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const user = '2244994945',
  tweet = '1300000000000000001';

export default {
  family: 'x_creatives',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {action: 'x_accounts_account_id_promoted_tweets_post', payload: {line_item_id: 'line1', tweet_ids: tweet}},
  seed: () => ({
    line: {id: 'line1', campaign_id: 'campaign1', entity_status: 'PAUSED'},
    campaign: {id: 'campaign1', entity_status: 'ACTIVE'},
    tweet: {
      id_str: tweet,
      full_text: 'Reviewed text',
      name: 'Reviewed Tweet',
      card_uri: null,
      nullcast: true,
      user: {id_str: user},
      entities: {urls: []},
    },
    promoted: [],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Synthetic account', currency: 'USD'});
      // The account's promotable users. Another page: X names the same cursor again, which never completes.
      if (s === '/promotable_users')
        return reply([{user_id: user, promotable_user_type: 'FULL'}], mode.paginate ? 'again' : null);
      if (s === '/line_items/line1') return reply(state.line);
      if (s === '/campaigns/campaign1') return reply(state.campaign);
      if (s === '/tweets')
        return reply(url.searchParams.get('tweet_ids').split(',').includes(tweet) ? [state.tweet] : []);
      return missing();
    }
    if (method === 'POST' && s === '/promoted_tweets') {
      const rows = body.tweet_ids.split(',').map((id, i) => ({
        id: 'promo' + (state.promoted.length + i + 1),
        line_item_id: body.line_item_id,
        tweet_id: id,
        // A partial answer: X returns the association PAUSED, which is not the promotion that was reviewed.
        entity_status: mode.partial ? 'PAUSED' : 'ACTIVE',
        approval_status: 'ACCEPTED',
        deleted: false,
      }));
      if (!mode.partial) state.promoted.push(...rows);
      return reply(rows);
    }
  },
  paginatedCodes: ['X_CREATIVE_STATE_UNVERIFIED', 'INCOMPLETE_STATE'],
  decisive: {change: state => (state.line.entity_status = 'ACTIVE'), field: /entity_status/},
};
