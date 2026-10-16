// meta_ad_videos: DELETE /act_{id}/advideos?video_id= (Meta Marketing API v26.0, Ad Account Advideos, Deleting), which
// "dissociate[s] a Video from an AdAccount". Meta does not say what becomes of creatives that use the video, so the
// decisive field is the account's creatives that name it: a creative built on the video after the review makes the
// family's own prerequisite refuse the removal as the state is read again at execute.
import {paged as page, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_ad_videos',
  risk: 'destructive',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management']},
  request: {action: 'meta_ad_account_id_advideos_delete', params: {video_id: '7001'}},
  seed: () => ({
    videos: [
      {id: '7001', title: 'clip 1', created_time: '2026-09-01'},
      {id: '7002', title: 'clip 2', created_time: '2026-09-02'},
      {id: '7003', title: 'clip 3', created_time: '2026-09-03'},
    ],
    creatives: [
      {id: '801', name: 'story', status: 'ACTIVE', object_story_spec: {page_id: '500', video_data: {video_id: '7002'}}},
      {id: '802', name: 'old', status: 'DELETED', object_story_spec: {page_id: '500', video_data: {video_id: '7001'}}},
      {
        id: '803',
        name: 'image',
        status: 'ACTIVE',
        object_story_spec: {page_id: '500', link_data: {link: 'https://e.com'}},
      },
    ],
  }),
  isWrite: ({method}) => method === 'DELETE',
  provider({method, path, url, state, mode}) {
    // Both lists are read to their end in pages. Another page: every page names one more, past the review's bound.
    if (method === 'GET' && path === v + '/act_123/advideos') return page(state.videos, url, mode.paginate);
    if (method === 'GET' && path === v + '/act_123/adcreatives') return page(state.creatives, url, mode.paginate);
    if (method === 'DELETE' && path === v + '/act_123/advideos') {
      // A partial answer: Meta reports the removal as not done.
      if (mode.partial) return {json: {success: false}};
      state.videos = state.videos.filter(x => x.id !== url.searchParams.get('video_id'));
      return {json: {success: true}};
    }
    return unsupported();
  },
  decisive: {
    change: state =>
      state.creatives.push({id: '804', name: 'new', status: 'ACTIVE', asset_feed_spec: {videos: [{video_id: 7001}]}}),
    field: /used_by/,
    refusal: {code: 'MEDIA_IN_USE', message: /Video 7001 is used by 1 creative/},
  },
};
