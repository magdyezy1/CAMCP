// dv360_ad_assets: POST /v4/advertisers/{advertiserId}/adAssets (Display & Video 360 API v4, adAssets.create) for a
// YouTube video. The review decides against the advertiser's existing ad assets of that video (adAssets.list filtered
// by youtubeVideoAsset.youtubeVideoId: their IDs and `entityStatus`), so that list is the decisive field: an asset of the
// video whose status changed in DV360 after the review changes what the reviewed creation adds to. (An active asset of
// the video that appears after the review is refused at execute as CONFIGURATION_EXISTS, before the comparison.)
import {list, notFound, scopes} from './_dv360.mjs';

const asset = (id, video, entityStatus) => ({
  name: 'advertisers/123/adAssets/' + id,
  adAssetId: id,
  adAssetType: 'AD_ASSET_TYPE_YOUTUBE_VIDEO',
  youtubeVideoAsset: {youtubeVideoId: video},
  entityStatus,
});

export default {
  family: 'dv360_ad_assets',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_AD_ASSETS_CREATE',
    params: {advertiserId: '123'},
    body: {
      adAsset: {
        adAssetType: 'AD_ASSET_TYPE_YOUTUBE_VIDEO',
        youtubeVideoAsset: {youtubeVideoId: 'SYNTHETIC01'},
        syntheticContentAttestationStatus: 'NOT_SYNTHETIC',
      },
    },
  },
  seed: () => ({assets: {501: asset('501', 'SYNTHETIC01', 'ENTITY_STATUS_ARCHIVED')}, next: 900}),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123/adAssets') {
      const video = /youtubeVideoId="([^"]+)"/.exec(url.searchParams.get('filter') ?? '')?.[1];
      return list(
        'adAssets',
        Object.values(state.assets).filter(a => a.youtubeVideoAsset.youtubeVideoId === video),
        mode.paginate,
      );
    }
    const one = /^\/v4\/advertisers\/123\/adAssets\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && one && state.assets[one]) return {json: structuredClone(state.assets[one])};
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/adAssets') {
      // An unconfirmed answer: HTTP 200 naming no created asset.
      if (mode.partial) return {json: {}};
      const id = String(state.next++);
      state.assets[id] = {
        ...asset(id, body.adAsset.youtubeVideoAsset.youtubeVideoId, 'ENTITY_STATUS_ACTIVE'),
        syntheticContentAttestationStatus: body.adAsset.syntheticContentAttestationStatus,
      };
      return {json: structuredClone(state.assets[id])};
    }
  },
  decisive: {
    change: state => (state.assets[501].entityStatus = 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'),
    field: /assets|entityStatus/,
  },
};
