// google_youtube_uploads: POST /v25/customers/{id}/youTubeVideoUploads:remove (Google Ads API,
// YouTubeVideoUploadService.RemoveYouTubeVideoUpload). Removal deletes the video from YouTube; ads whose video assets
// point at it stop showing it. The review names those assets, so the video assets that reference the video
// (asset.youtube_video_asset.youtube_video_id) are the decisive field.
import * as g from './_google-ads.mjs';

const upload = g.resource('youTubeVideoUploads', '61'),
  video = 'abcDEF12345';

export default {
  family: 'google_youtube_uploads',
  risk: 'destructive',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_you_tube_video_upload_remove_you_tube_video_upload',
    payload: {resourceNames: [upload]},
  },
  seed: () => ({
    you_tube_video_upload: [
      {
        resourceName: upload,
        videoUploadId: '61',
        channelId: 'UCsynthetic',
        videoId: video,
        state: 'PROCESSED',
        videoPrivacy: 'UNLISTED',
      },
    ],
    asset: [],
  }),
  paginatedCodes: ['YOUTUBE_UPLOAD_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/youTubeVideoUploads:remove') {
      if (mode.partial) return g.partialFailure();
      state.you_tube_video_upload = state.you_tube_video_upload.filter(
        u => !body.resourceNames.includes(u.resourceName),
      );
      return {json: {resourceNames: body.resourceNames}};
    }
  },
  // A video asset created in the meantime now points at the video the removal deletes.
  decisive: {
    change: state =>
      state.asset.push({resourceName: g.resource('assets', '88'), youtubeVideoAsset: {youtubeVideoId: video}}),
    field: /assets/,
  },
};
