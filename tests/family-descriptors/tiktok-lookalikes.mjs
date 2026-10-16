// tiktok_lookalikes: POST /v1.3/dmp/custom_audience/lookalike/create/ (API for Business v1.3, "Create a lookalike
// audience"). TikTok derives the lookalike from its seed audience, so the decisive field is the seed's `type` in "Get
// audience details", which the review shows: a seed that is no longer the reviewed kind of audience must stop the
// creation. (The seed's ownership, availability and minimum size are checked again at execute and refused by the
// family before the state comparison.)
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_lookalikes',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_dmp_custom_audience_lookalike_create',
    payload: {
      custom_audience_name: 'Buyers lookalike',
      lookalike_spec: {
        source_audience_id: '500',
        include_source: false,
        mobile_os: 'ALL',
        placements: ['TikTok'],
        location_ids: ['SA'],
        audience_size: 'NARROW',
      },
    },
  },
  seed: () => ({
    audiences: {
      500: {
        audience_id: '500',
        name: 'Buyers',
        type: 'Customer File',
        owner_id: '123',
        is_creator: true,
        is_valid: true,
        cover_num: 5000,
      },
    },
    created: [],
  }),
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/lookalike/create/'),
  provider({method, url, path, state, mode}) {
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
    if (method === 'POST' && path.endsWith('/v1.3/dmp/custom_audience/lookalike/create/')) {
      if (mode.partial) return failed('The seed audience is too small');
      const id = String(600 + state.created.length);
      state.created.push(id);
      return ok({custom_audience_id: id});
    }
  },
  decisive: {change: state => (state.audiences[500].type = 'Engagement'), field: /type/},
};
