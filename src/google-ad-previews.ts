import type {AdPreviewHooks, AdPreviewRoute} from './provider-adapter.js';

/**
 * Google Ads' part of amcp_ad_previews (src/ad-previews.ts; registered as the `previews` hooks of src/google-ads-adapter.ts):
 * it has no preview AMCP reads. Google creates a shareable preview with generateShareablePreviews, which AMCP reviews as
 * a write, so the answer names the amcp_write call that prepares it. Since v25 an asset group is named by its resource,
 * and every preview states its type.
 */
export const googleAdPreviews: AdPreviewHooks = Object.freeze({
  platform: 'google_ads',
  explain({account, connection, wanted}: AdPreviewRoute) {
    const customer = 'customers/' + account.replaceAll('-', ''),
      targets = (wanted ?? []).map(id =>
        id.includes('/adGroupAds/')
          ? {adGroupAd: id, previewType: 'YOUTUBE_LIVE_PREVIEW'}
          : {assetGroup: /^\d+$/.test(id) ? customer + '/assetGroups/' + id : id, previewType: 'UI_PREVIEW'},
      );
    return {
      preview_route: 'reviewed_write',
      explanation:
        'Google Ads creates shareable preview links with generateShareablePreviews, which AMCP reviews like any other write. Prepare it with the call below, review it, then execute it.',
      next_call: {
        tool: 'amcp_write',
        arguments: {
          action: 'prepare',
          gateway: 'google_ads_native_action',
          ...(connection ? {connection_id: connection} : {}),
          arguments: {
            action: 'GENERATE_SHAREABLE_PREVIEWS',
            account_id: account,
            payload: {
              operation: {
                shareablePreviews: targets.length
                  ? targets
                  : [{assetGroup: customer + '/assetGroups/ASSET_GROUP_ID', previewType: 'UI_PREVIEW'}],
              },
            },
          },
        },
      },
      ...(targets.length
        ? {}
        : {
            next_step:
              'Replace ASSET_GROUP_ID with a Performance Max asset group ID, or pass adGroupAds resource names (customers/…/adGroupAds/…~…) of video ads in ad_ids.',
          }),
    };
  },
});
