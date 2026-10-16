// tiktok_identities: POST /v1.3/identity/create/ (API for Business v1.3, "Create an identity") with an avatar from
// the advertiser's library. The identity shows that image, so the decisive field is the image's `signature` in "Get info
// about images" (the file's digest): an avatar replaced under the same ID after the review is not the reviewed one.
// (Its square shape is checked again at execute and refused by the family itself.)
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_identities',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_identity_create', payload: {display_name: 'Store', image_uri: 'ad-site-i18n-sg/avatar1'}},
  seed: () => ({
    images: {
      'ad-site-i18n-sg/avatar1': {
        image_id: 'ad-site-i18n-sg/avatar1',
        width: 400,
        height: 400,
        signature: 'b1946ac92492d2347c6235b4d2611184',
        image_url: 'https://example.invalid/signed',
      },
    },
    identities: 0,
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/identity/create/'),
  provider({method, url, path, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/'))
      return ok({list: [{advertiser_id: '123', name: 'Advertiser', currency: 'SAR', timezone: 'Asia/Riyadh'}]});
    if (method === 'GET' && path.endsWith('/v1.3/file/image/ad/info/')) {
      const ids = JSON.parse(url.searchParams.get('image_ids'));
      return ok({
        list: ids.filter(id => state.images[id]).map(id => ({...state.images[id]})),
        // Another page: TikTok declares it with page_info.total_page.
        ...(mode.paginate ? {page_info: {page: 1, page_size: 1, total_number: 2, total_page: 2}} : {}),
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/identity/create/')) {
      if (mode.partial) return failed('Display name is not allowed');
      return ok({identity_id: 'ident-' + ++state.identities});
    }
  },
  decisive: {
    change: state => (state.images['ad-site-i18n-sg/avatar1'].signature = '7d793037a0760186574b0282f2f435e7'),
    field: /signature/,
  },
};
