// snapchat_custom_conversions: DELETE /v1/custom_conversions/{custom_conversion_id} (Snapchat Marketing API v1,
// "Custom Conversions"). A conversion counts the pixel events its `rules` match, so the decisive field is the
// conversion's `rules` in "Get all Custom Conversions of a Pixel": a conversion redefined after the review is not the
// one the reviewer approved deleting.
import {failed, ok, page} from './_snapchat.mjs';

export default {
  family: 'snapchat_custom_conversions',
  risk: 'destructive',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  arguments: {
    action: 'snapchat_custom_conversions_custom_conversion_id_delete',
    ad_account_id: 'acct1',
    params: {custom_conversion_id: 'cc1'},
  },
  seed: () => ({
    pixels: [{id: 'px-1', ad_account_id: 'acct1', name: 'Site pixel', status: 'ACTIVE'}],
    conversions: {
      cc1: {
        id: 'cc1',
        pixel_id: 'px-1',
        name: 'Big baskets',
        event_type: 'PURCHASE',
        rules: [{key: 'price', operator: 'GREATER_THAN', values: ['100']}],
      },
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1/pixels')
      return page('pixels', 'pixel', state.pixels, mode.paginate, url);
    if (method === 'GET' && path === '/v1/pixels/px-1/custom_conversions')
      return page('custom_conversions', 'custom_conversion', Object.values(state.conversions), false, url);
    if (method === 'DELETE' && path === '/v1/custom_conversions/cc1') {
      if (mode.partial) return failed('custom_conversions');
      delete state.conversions.cc1;
      return ok({});
    }
  },
  decisive: {change: state => (state.conversions.cc1.rules[0].values = ['250']), field: /rules/},
};
