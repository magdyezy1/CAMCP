// tiktok_tt_video_unbinds: POST /v1.3/tt_video/unbind/ (API for Business v1.3, "Unbind a Spark Ad post"): removes a post whose authorization
// has expired or been revoked from the advertiser's authorized posts, and the answer has no data. It is destructive. The review reads the
// post's row in "Get Spark Ad posts" and the advertiser's Upgraded Smart+ ads that name the post; the decisive field is the post's
// authorization status, which the review shows and the unbind depends on (EXPIRED and CANCEL are the ended ones).
import {failed, ok} from './_tiktok.mjs';

const row = (item, status = 'EXPIRED') => ({
  user_info: {tiktok_name: 'creator', identity_id: 'ac-9', identity_type: 'AUTH_CODE'},
  item_info: {
    item_id: item,
    item_type: 'VIDEO',
    status: 'HESITATE_RECOMMEND',
    auth_code: '#' + item,
    text: 'Synthetic post',
  },
  auth_info: {ad_auth_status: status, auth_start_time: '2026-11-20 00:00:00', auth_end_time: '2026-11-21 00:00:00'},
});
/** A page of `rows`; `paginate` asks for another page, and the next answer reads page 1 again. */
const page = (url, rows, mode) => {
  const number = Number(url.searchParams.get('page') ?? 1),
    size = Number(url.searchParams.get('page_size') ?? 20);
  return ok({
    list: rows.slice((number - 1) * size, number * size).map(r => structuredClone(r)),
    page_info: {
      page: mode.paginate ? 1 : number,
      page_size: size,
      total_number: rows.length + (mode.paginate ? 100 : 0),
      total_page: mode.paginate ? 2 : Math.max(1, Math.ceil(rows.length / size)),
    },
  });
};

export default {
  family: 'tiktok_tt_video_unbinds',
  risk: 'destructive',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_tt_video_unbind', payload: {item_id: '7000000000000000001'}},
  seed: () => ({posts: [row('7000000000000000001')], ads: []}),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/tt_video/unbind/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/tt_video/list/')) return page(url, state.posts, mode);
    if (method === 'GET' && path.endsWith('/v1.3/smart_plus/ad/get/')) return page(url, state.ads, mode);
    if (method === 'POST' && path.endsWith('/v1.3/tt_video/unbind/')) {
      if (mode.partial) return failed('The authorization is still in effect');
      state.posts = state.posts.filter(r => r.item_info.item_id !== body.item_id);
      return ok({});
    }
  },
  decisive: {change: state => (state.posts[0].auth_info.ad_auth_status = 'CANCEL'), field: /ad_auth_status/},
};
