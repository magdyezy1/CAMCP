// tiktok_pixels: POST /v1.3/pixel/update/ (API for Business v1.3, renaming a pixel; fields from TikTok's Business API
// SDK pixel_update.yml). The decisive field is the pixel's current `pixel_name` in "Get pixels", the value the rename
// overwrites: a rename made in TikTok after the review must stop the reviewed one.
import {failed, ok} from './_tiktok.mjs';

const owned = {ownership_status: true, asset_relation_status: 'OWNER'};

export default {
  family: 'tiktok_pixels',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_pixel_update', payload: {advertiser_id: '123', pixel_id: '7002', pixel_name: 'Content'}},
  seed: () => ({
    pixels: [
      {pixel_id: '7001', pixel_name: 'Store pixel', pixel_code: 'CABC1', asset_ownership: owned},
      {pixel_id: '7002', pixel_name: 'Blog pixel', pixel_code: 'CABC2', asset_ownership: owned},
    ],
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/pixel/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/pixel/list/')) {
      const page = Number(url.searchParams.get('page') ?? 1);
      // Another page: TikTok declares more pages (page_info.total_page) than one review reads.
      return ok({
        pixels: page === 1 ? structuredClone(state.pixels) : [],
        page_info: {page, page_size: 20, total_number: state.pixels.length, total_page: mode.paginate ? 99 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/pixel/update/')) {
      if (mode.partial) return failed('Pixel name is invalid');
      state.pixels.find(p => p.pixel_id === body.pixel_id).pixel_name = body.pixel_name;
      return ok({});
    }
  },
  decisive: {change: state => (state.pixels[1].pixel_name = 'Renamed in TikTok'), field: /pixel_name/},
};
