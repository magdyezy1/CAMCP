// tiktok_custom_conversion_edits: POST /v1.3/custom_conversion/update/ (API for Business v1.3, "Update a Custom
// Conversion"), renaming a pixel's custom conversion. The decisive field is the conversion's current `name` in "Get
// Custom Conversions associated with an event source", the value the update overwrites.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_custom_conversion_edits',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_custom_conversion_update',
    payload: {advertiser_id: '123', custom_conversion_id: '880', name: 'Checkout v2'},
  },
  seed: () => ({
    pixels: [{pixel_id: '7001', pixel_name: 'Store pixel', pixel_code: 'CABC1'}],
    conversions: {
      7001: [
        {
          custom_conversion_id: '880',
          event_source_id: '7001',
          name: 'Checkout',
          description: 'Paid orders',
          optimization_event: 'COMPLETE_PAYMENT',
        },
      ],
    },
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/custom_conversion/update/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k),
      page = Number(q('page') ?? 1);
    if (method === 'GET' && path.endsWith('/v1.3/pixel/list/'))
      // Another page: TikTok declares more pixel pages (page_info.total_page) than one review reads.
      return ok({
        pixels: page === 1 ? structuredClone(state.pixels) : [],
        page_info: {page, page_size: 20, total_number: state.pixels.length, total_page: mode.paginate ? 99 : 1},
      });
    if (method === 'GET' && path.endsWith('/v1.3/custom_conversion/list/')) {
      const list = structuredClone(state.conversions[q('event_source_id')] ?? []);
      return ok({list, page_info: {page, page_size: 1000, total_number: list.length, total_page: 1}});
    }
    if (method === 'POST' && path.endsWith('/v1.3/custom_conversion/update/')) {
      if (mode.partial) return failed('Duplicate custom conversion name');
      for (const c of Object.values(state.conversions).flat())
        if (c.custom_conversion_id === body.custom_conversion_id) Object.assign(c, {name: body.name});
      return ok({});
    }
  },
  decisive: {change: state => (state.conversions[7001][0].name = 'Checkout (renamed in TikTok)'), field: /name/},
};
