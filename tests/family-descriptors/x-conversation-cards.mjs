// x_conversation_cards: POST /12/accounts/{account}/cards/image_conversation (X Ads API v12, Image Conversation Cards).
// The card shows an image from the account's media library, so the decisive field is that media item: an image deleted
// from the library after the review makes the family's own prerequisite refuse the card as the state is read again at
// execute.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

export default {
  family: 'x_conversation_cards',
  risk: 'settings',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_accounts_account_id_cards_image_conversation_post',
    payload: {
      name: 'Moon card',
      media_key: '3_100',
      first_cta: '#moon',
      first_cta_tweet: 'Stars tonight',
      thank_you_text: 'Thanks',
      title: 'Full moon',
    },
  },
  seed: () => ({
    next: 1,
    library: {'3_100': {media_key: '3_100', media_type: 'IMAGE', media_status: 'TRANSCODE_COMPLETED', deleted: false}},
    cards: {},
  }),
  unpaginated: 'the account, each media item and the card are read by key as one entity each',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    const s = suffix(path);
    let m;
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if ((m = /^\/media_library\/(\w+)$/.exec(s ?? '')))
        return state.library[m[1]] ? reply(state.library[m[1]]) : missing();
      if ((m = /^\/cards\/image_conversation\/(\w+)$/.exec(s ?? '')))
        return state.cards[m[1]] ? reply(state.cards[m[1]]) : missing();
      return missing();
    }
    if (method === 'POST' && s === '/cards/image_conversation') {
      const id = '5a' + state.next++,
        row = {...body, id, card_uri: 'card://9583976650157' + state.next, deleted: false};
      state.cards[id] = row;
      // A partial answer: X returns the card without its card URI.
      return reply(mode.partial ? {...row, card_uri: null} : row);
    }
  },
  decisive: {
    change: state => (state.library['3_100'].deleted = true),
    field: /media/,
    refusal: {code: 'STATE_NOT_FOUND', message: /Media 3_100 \(.+\) is not in the media library/},
  },
};
