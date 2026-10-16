// meta_pixels: POST /{ads_pixel_id} (Meta Marketing API v26.0, Ads Pixel, Updating) renaming a pixel the ad account
// lists. The update replaces the stored name, so the decisive field is the pixel's current `name`: a rename made in
// Meta after the review would be silently overwritten.
import {decode, paged, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_pixels',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {action: 'meta_pixel_id_update', params: {pixel_id: '700'}, payload: {name: 'Store pixel (Riyadh)'}},
  seed: () => ({
    pixels: [
      {id: '700', name: 'Store pixel', owner_business: {id: '900'}},
      {id: '701', name: 'Site pixel', owner_business: {id: '900'}},
      {id: '702', name: 'Partner pixel', owner_business: {id: '901'}},
    ],
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET' && path === v + '/act_123') return {json: {id: 'act_123', business: {id: '900'}}};
    // Every pixel the account lists, read to its end in cursor pages. Another page: every page names one more.
    if (method === 'GET' && path === v + '/act_123/adspixels') return paged(state.pixels, url, mode.paginate);
    if (method === 'POST' && path === v + '/700') {
      // A partial answer: Meta reports the rename as not applied.
      if (mode.partial) return {json: {success: false}};
      state.pixels[0].name = String(decode(body).name);
      return {json: {success: true}};
    }
    return unsupported();
  },
  decisive: {change: state => (state.pixels[0].name = 'Store pixel (renamed in Meta)'), field: /name/},
};
