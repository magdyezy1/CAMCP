// tiktok_negative_keywords, variant: POST /v1.3/search_ad/negative_keyword/add/ at the account level, `object_type: ADVERTISER` (API for Business
// v1.3, "Create negative keywords": ADVERTISER is the ad account, and object_ids holds its ID). R2.5 M4, package r25-m4-search2, item 4. The family
// serves it beside the campaign and ad group levels of tests/family-descriptors/tiktok-negative-keywords.mjs: the review reads the advertiser and the
// account's whole list, and the add is measured against that list, so the decisive field is the list in "Get negative keywords" (`keywords`): a
// keyword added in TikTok after the review changes what the reviewed add leaves in place. This variant runs the same conformance checks for
// that shape, and never stands in for the family's own descriptor.
import {failed, ok} from '../_tiktok.mjs';

export default {
  family: 'tiktok_negative_keywords',
  // Spend-affecting (the registry asks spendConfirmation for a removal or a rename), so it counts as money evidence (R1), not settings.
  risk: 'budget',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_search_ad_negative_keyword_add',
    payload: {advertiser_id: '123', object_type: 'ADVERTISER', object_ids: ['123'], keywords: [{name: 'free'}]},
  },
  seed: () => ({
    advertiser: {
      advertiser_id: '123',
      name: 'Advertiser',
      status: 'STATUS_ENABLE',
      currency: 'USD',
      timezone: 'Asia/Riyadh',
      country: 'SA',
    },
    lists: {'ADVERTISER:123': [{keyword_id: '9000', name: 'cheap', match_type: 'BROAD_WORD'}]},
    next: 10000,
  }),
  // A list longer than one review reads is refused as too large; TikTok pages it by page_info.total_page.
  paginatedCodes: ['STATE_TOO_LARGE', 'INCOMPLETE_STATE'],
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/search_ad/negative_keyword/add/'),
  provider({method, url, path, body, state, mode}) {
    const q = k => url.searchParams.get(k);
    if (method === 'GET' && path.endsWith('/v1.3/advertiser/info/')) return ok({list: [{...state.advertiser}]});
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
      state.lists['ADVERTISER:123'].push({keyword_id: '7777', name: 'added elsewhere', match_type: 'BROAD_WORD'}),
    field: /keyword/,
  },
};
