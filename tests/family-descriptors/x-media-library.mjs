// x_media_library: DELETE /12/accounts/{account}/media_library/{media_key} (X Ads API v12, Media Library). X does not say
// what happens to cards that use a deleted item, so the decisive field is the cards that use the image: a card built on
// it after the review makes the family's own prerequisite refuse the deletion as the state is read again at execute.
import {account, credentials, missing, reply, suffix} from './_x.mjs';

const key = '3_100';

export default {
  family: 'x_media_library',
  risk: 'destructive',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {action: 'x_accounts_account_id_media_library_media_key_delete', params: {media_key: key}},
  seed: () => ({
    media: {
      media_key: key,
      media_type: 'IMAGE',
      media_status: 'TRANSCODE_COMPLETED',
      name: 'Hero',
      file_name: 'hero.jpg',
      tweeted: false,
      deleted: false,
    },
    cards: [{id: 'c1', card_uri: 'card://1', name: 'Other card', media_key: '3_200', deleted: false}],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, state, mode}) {
    const s = suffix(path);
    if (method === 'GET') {
      if (s === '') return reply({id: account, name: 'Account', deleted: false});
      if (s === '/media_library/' + key) return state.media ? reply(state.media) : missing();
      // Every card of the account, read for the image. Another page: X names the same cursor again.
      if (s === '/cards') return reply(state.cards, mode.paginate ? 'again' : null);
      return missing();
    }
    if (method === 'DELETE' && s === '/media_library/' + key) {
      // A partial answer: X answers with the image not marked deleted.
      if (mode.partial) return reply(state.media);
      state.media = {...state.media, deleted: true};
      return reply(state.media);
    }
  },
  decisive: {
    change: state =>
      state.cards.push({id: 'c2', card_uri: 'card://2', name: 'New card', media_key: key, deleted: false}),
    field: /cards/,
    refusal: {code: 'MEDIA_IN_USE', message: /Media 3_100 is used by card card:\/\/2/},
  },
};
