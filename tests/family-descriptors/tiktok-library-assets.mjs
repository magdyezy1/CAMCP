// tiktok_library_assets: POST /v1.3/file/video/ad/update/ (API for Business v1.3, "Update the name of a video"). The
// decisive field is the video's current `file_name` in "Search for videos", the value the rename overwrites.
import {failed, ok} from './_tiktok.mjs';

export default {
  family: 'tiktok_library_assets',
  risk: 'settings',
  gateway: 'tiktok_native_action',
  account: '123',
  request: {
    action: 'tiktok_file_video_ad_update',
    payload: {advertiser_id: '123', video_id: 'v10033g50000abc', file_name: 'Spring hero 9x16'},
  },
  seed: () => ({videos: {v10033g50000abc: {video_id: 'v10033g50000abc', file_name: 'Spring hero'}}}),
  partialCodes: ['PLATFORM_ERROR', 'WRITE_REJECTED'],
  isWrite: ({method, path}) => method === 'POST' && path.endsWith('/v1.3/file/video/ad/update/'),
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path.endsWith('/v1.3/file/video/ad/search/')) {
      const ids = JSON.parse(url.searchParams.get('filtering')).video_ids,
        list = ids.filter(id => state.videos[id]).map(id => ({...state.videos[id]}));
      // Another page: TikTok declares more named videos than the one page the review reads.
      return ok({
        list,
        page_info: {page: 1, page_size: 100, total_number: list.length, total_page: mode.paginate ? 2 : 1},
      });
    }
    if (method === 'POST' && path.endsWith('/v1.3/file/video/ad/update/')) {
      if (mode.partial) return failed('Video name is invalid');
      state.videos[body.video_id].file_name = body.file_name;
      return ok({});
    }
  },
  decisive: {change: state => (state.videos.v10033g50000abc.file_name = 'Spring hero (final)'), field: /name/},
};
