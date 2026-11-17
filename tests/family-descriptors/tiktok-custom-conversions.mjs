// tiktok_custom_conversions: POST /v1.3/custom_conversion/create/ (API for Business v1.3, "Create a Custom
// Conversion") on an owned pixel. The conversion is defined on its event source, so the decisive field is that pixel
// as "Get pixels" names it (`pixel_name`, the identity the review shows): a pixel that is no longer the reviewed one
// must stop the creation. (Its ownership and events are checked again at execute and refused by the family itself.)
import {failed, ok} from './_tiktok.mjs';

const pixel = () => ({
  pixel_id: '7001',
  pixel_code: 'C7001',
  pixel_name: 'Store pixel',
  pixel_category: 'CUSTOMIZE_EVENTS',
  activity_status: 'ACTIVE',
  asset_ownership: {ownership_status: true},
  events: [{name: 'Complete Registration', event_type: 'ON_WEB_REGISTER', optimization_event: 'ON_WEB_REGISTER'}],
});

export default {
  family: 'tiktok_custom_conversions',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_custom_conversion_create',
    payload: {
      name: 'Signup thank you',
      event_source_type: 'PIXEL',
      event_source_id: '7001',
      optimization_event: 'ON_WEB_REGISTER',
      rules: [{parameter: 'URL', operator: 'CONTAIN', values: ['/thank-you']}],
    },
  },
  seed: () => ({pixels: {7001: pixel()}, conversions: []}),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/custom_conversion/create/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/pixel/list/')) {
      const list = state.pixels[q('pixel_id')] ? [structuredClone(state.pixels[q('pixel_id')])] : [];
      return ok({pixels: list, page_info: {page: 1, page_size: 10, total_number: list.length, total_page: 1}});
    }
    if (method === 'GET' && path.endsWith('/v1.3/custom_conversion/list/')) {
      const list = state.conversions.filter(c => c.event_source_id === q('event_source_id')).map(c => ({...c}));
      // Another page: TikTok declares more of the pixel's conversions than the page the review reads.
      return ok({
        list,
        page_info: {page: 1, page_size: 1000, total_number: list.length, total_page: mode.paginate ? 2 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/custom_conversion/create/')) {
      if (mode.partial) return failed('The pixel has too many custom conversions');
      const id = String(8800001 + state.conversions.length);
      state.conversions.push({...body, custom_conversion_id: id});
      return ok({custom_conversion_id: id});
    }
  },
  decisive: {change: state => (state.pixels[7001].pixel_name = 'Renamed pixel'), field: /pixel_name/},
};
