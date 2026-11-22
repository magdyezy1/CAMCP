// tiktok_tt_video_authorizations: POST /v1.3/tt_video/authorize/ (API for Business v1.3, "Apply an authorization code"): the creator's code
// binds a Spark Ads post to the advertiser, and the answer has no data. The review keeps only the digest of the code, so execute takes
// the code again (`execute`), and the post is read back from "Get Spark Ad posts", whose rows carry each post's code. The decisive state is
// whether the code is already among the advertiser's authorized posts: a code applied after the review is refused by the family's own
// rule (the prerequisites are checked on the state read at execute, before it is compared).
import {failed, ok} from './_tiktok.mjs';

const code = '#ZmFrZS1hdXRoLWNvZGUtZGVzY3JpcHRvcg==';
const row = (item, auth = '#another-creators-code', status = 'AUTHORIZED') => ({
  user_info: {tiktok_name: 'creator', identity_id: 'ac-9', identity_type: 'AUTH_CODE'},
  item_info: {item_id: item, item_type: 'VIDEO', status: 'HESITATE_RECOMMEND', auth_code: auth, text: 'Synthetic post'},
  auth_info: {ad_auth_status: status, auth_start_time: '2026-11-20 00:00:00', auth_end_time: '2027-11-20 00:00:00'},
});

export default {
  family: 'tiktok_tt_video_authorizations',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {action: 'tiktok_tt_video_authorize_apply', payload: {auth_code: code}},
  execute: {arguments: {action: 'tiktok_tt_video_authorize_apply', account_id: '123', payload: {auth_code: code}}},
  seed: () => ({posts: [row('7000000000000000001')]}),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/tt_video/authorize/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/tt_video/list/')) {
      const page = Number(url.searchParams.get('page') ?? 1),
        size = Number(url.searchParams.get('page_size') ?? 20);
      // `mode.paginate` asks for another page: the answer declares a second page, and the next one reads page 1 again.
      return ok({
        list: state.posts.slice((page - 1) * size, page * size).map(r => structuredClone(r)),
        page_info: {
          page: mode.paginate ? 1 : page,
          page_size: size,
          total_number: state.posts.length + (mode.paginate ? 100 : 0),
          total_page: mode.paginate ? 2 : Math.max(1, Math.ceil(state.posts.length / size)),
        },
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/tt_video/authorize/')) {
      if (mode.partial) return failed('Invalid authorization code');
      state.posts.push(row('7000000000000000002', body.auth_code.replaceAll('%2B', '+')));
      return ok({});
    }
  },
  decisive: {
    change: state => state.posts.push(row('7000000000000000003', code)),
    refusal: {code: 'INVALID_TIKTOK_TT_VIDEO_AUTHORIZATION', message: /already applied/},
  },
};
