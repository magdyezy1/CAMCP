// tiktok_saved_audiences: POST /v1.3/dmp/saved_audience/create/ (API for Business v1.3, "Create a Saved Audience").
// The saved audience includes a custom audience, so the decisive field is that audience's size in "Get custom audience
// details" (`cover_num`, which the review keeps as whether it reaches TikTok's minimum of 100): an included audience
// that shrank below it after the review must stop the reviewed creation. (A change of its `is_valid` or `is_creator`
// is refused even earlier, by the ownership and availability checks that run again at execute.)
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_saved_audiences',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_dmp_saved_audience_create',
    payload: {
      saved_audience_name: 'Buyers KSA',
      location_ids: ['6252001'],
      age_groups: ['AGE_25_34'],
      audience_ids: ['500'],
    },
  },
  seed: () => ({
    audiences: {
      500: {
        audience_id: '500',
        name: 'Buyers',
        type: 'Customer File',
        is_creator: true,
        is_valid: true,
        cover_num: 5000,
      },
    },
    saved: [],
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/dmp/saved_audience/create/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/'))
      return ok({list: [{advertiser_id: '123', name: 'Advertiser', currency: 'SAR', timezone: 'Asia/Riyadh'}]});
    if (method === 'GET' && path.endsWith('/v1.3/dmp/custom_audience/get/')) {
      const ids = JSON.parse(url.searchParams.get('custom_audience_ids'));
      return ok({
        list: ids
          .filter(id => state.audiences[id])
          .map(id => ({audience_details: structuredClone(state.audiences[id]), audience_history: []})),
        // Another page: TikTok declares it with page_info.total_page.
        ...(mode.paginate ? {page_info: {page: 1, page_size: 1, total_number: 2, total_page: 2}} : {}),
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/dmp/saved_audience/create/')) {
      if (mode.partial) return failed('Saved audience limit reached');
      const id = String(9900001 + state.saved.length);
      state.saved.push({...body, saved_audience_id: id});
      return ok({saved_audience_id: id});
    }
  },
  decisive: {change: state => (state.audiences[500].cover_num = 40), field: /cover_at_least_100/},
};
