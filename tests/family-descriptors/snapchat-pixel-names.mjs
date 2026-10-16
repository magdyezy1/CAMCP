// snapchat_pixel_names: PUT /v1/adaccounts/{ad_account_id}/pixels (Snapchat Marketing API v1, "Snap Pixel": "Attributes
// that can be updated: name"). The decisive field is the pixel's current `name` in "Get all Pixels of an Ad Account",
// the value the rename overwrites: a rename made in Snapchat after the review must stop the reviewed one.
import {adAccount, failed, ok, page, rows} from './_snapchat.mjs';

export default {
  family: 'snapchat_pixel_names',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {
    action: 'snapchat_adaccounts_ad_account_id_pixels_update',
    ad_account_id: 'acct1',
    params: {ad_account_id: 'acct1'},
    payload: {pixels: [{id: 'px-1', name: 'Checkout pixel', ad_account_id: 'acct1'}]},
  },
  seed: () => ({pixels: {'px-1': {id: 'px-1', ad_account_id: 'acct1', name: 'Site pixel', status: 'ACTIVE'}}}),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1');
    if (method === 'GET' && path === '/v1/adaccounts/acct1/pixels')
      return page('pixels', 'pixel', Object.values(state.pixels), mode.paginate);
    if (method === 'PUT' && path === '/v1/adaccounts/acct1/pixels') {
      if (mode.partial) return failed('pixels', body.pixels);
      for (const x of body.pixels) state.pixels[x.id].name = x.name;
      return ok({
        pixels: rows(
          'pixel',
          body.pixels.map(x => state.pixels[x.id]),
        ),
      });
    }
  },
  decisive: {change: state => (state.pixels['px-1'].name = 'Renamed in Snapchat'), field: /px-1.*name/},
};
