// tiktok_negative_keywords: POST /v1.3/search_ad/negative_keyword/add/ (API for Business v1.3, "Add negative keywords"
// to a search ad group). Replies carry no keyword IDs and the add is measured against the ad group's whole list, so the
// decisive field is that list in "Get negative keywords" (`keywords`): a keyword added in TikTok after the review
// changes what the reviewed add leaves in place.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_negative_keywords',
  // Spend-affecting (the registry asks spendConfirmation), so it counts as money evidence (R1), not settings.
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_search_ad_negative_keyword_add',
    payload: {advertiser_id: '123', object_type: 'ADGROUP', object_ids: ['301'], keywords: [{name: 'free'}]},
  },
  seed: () => ({
    adgroups: {
      301: {
        adgroup_id: '301',
        campaign_id: '201',
        adgroup_name: 'Search on',
        search_result_enabled: true,
        operation_status: 'ENABLE',
      },
    },
    lists: {'ADGROUP:301': [{keyword_id: '9000', name: 'cheap', match_type: 'BROAD_WORD'}]},
    next: 10000,
  }),
  // A list longer than one review reads is refused as too large; TikTok pages it by page_info.total_page.
  paginatedCodes: ['STATE_TOO_LARGE', 'INCOMPLETE_STATE'],
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/search_ad/negative_keyword/add/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/adgroup/get/')) {
      const ids = JSON.parse(q('filtering')).adgroup_ids,
        list = ids.filter(id => state.adgroups[id]).map(id => ({advertiser_id: '123', ...state.adgroups[id]}));
      return ok({list, page_info: {page: 1, page_size: 100, total_number: list.length, total_page: 1}});
    }
    if (method === 'GET' && path.endsWith('/v1.3/search_ad/negative_keyword/get/')) {
      const list = state.lists[q('object_type') + ':' + q('object_id')] ?? [],
        page = Number(q('page')),
        size = Number(q('page_size'));
      return ok({
        keywords: structuredClone(list.slice((page - 1) * size, page * size)),
        page_info: {
          page,
          page_size: size,
          total_number: list.length,
          total_page: mode.paginate ? 201 : Math.max(1, Math.ceil(list.length / size)),
        },
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/search_ad/negative_keyword/add/')) {
      if (mode.partial) return failed('Keyword limit reached');
      for (const id of body.object_ids)
        for (const w of body.keywords)
          state.lists[body.object_type + ':' + id].push({
            keyword_id: String(state.next++),
            name: w.name,
            match_type: w.match_type ?? 'BROAD_WORD',
          });
      return ok({});
    }
  },
  decisive: {
    change: state =>
      state.lists['ADGROUP:301'].push({keyword_id: '7777', name: 'added elsewhere', match_type: 'BROAD_WORD'}),
    field: /keyword/,
  },
};
