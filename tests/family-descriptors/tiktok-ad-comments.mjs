// tiktok_ad_comments: POST /v1.3/comment/status/update/ (TikTok API for Business v1.3, official SDK
// comment_status_update.yml). The decisive field is each comment's current `status` (PUBLIC or HIDDEN), which the
// update overwrites; the review reads it from the comment list of the request's comment_scope.
import {ok, failed} from './_tiktok.mjs';

const date = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
export default {
  family: 'tiktok_ad_comments',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_comment_status_update',
    payload: {comment_ids: ['5001'], operation: 'HIDDEN'},
    comment_scope: {search_field: 'AD_ID', search_value: '9001', start_time: date(6), end_time: date(0)},
  },
  seed: () => ({
    comments: {5001: {comment_id: '5001', ad_id: '9001', advertiser_id: '123', status: 'PUBLIC', text: 'Synthetic'}},
  }),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/comment/status/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/comment/list/')) {
      const page = Number(url.searchParams.get('page')),
        rows = page === 1 ? Object.values(state.comments).map(c => structuredClone(c)) : [];
      // Another page beyond what one review reads: TikTok declares it with page_info.total_page.
      return ok({
        comments: rows,
        page_info: {page, page_size: 100, total_number: rows.length, total_page: mode.paginate ? 21 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/comment/status/update/')) {
      if (mode.partial) return failed('Comment status locked');
      for (const id of body.comment_ids) state.comments[id].status = body.operation;
      return ok({});
    }
  },
  decisive: {change: state => (state.comments[5001].status = 'HIDDEN'), field: /status/},
};
