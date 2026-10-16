// google_shareable_previews: POST /v25/customers/{id}:generateShareablePreviews (Google Ads API,
// ShareablePreviewService). The links let anyone holding them view the asset group's ads, so the review freezes what
// is being shared: the asset group, its campaign and its destination. The asset group's `final_urls`, where the
// previewed ads lead, is the decisive field.
import * as g from './_google-ads.mjs';

const group = g.resource('assetGroups', '700'),
  campaign = g.resource('campaigns', '100');

export default {
  family: 'google_shareable_previews',
  risk: 'settings',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_shareable_preview_generate_shareable_previews',
    payload: {operation: {shareablePreviews: [{assetGroup: group, previewType: 'UI_PREVIEW'}]}},
  },
  seed: () => ({
    // The source read joins the asset group and its campaign.
    asset_group: [
      {
        assetGroup: {
          resourceName: group,
          id: '700',
          name: 'Retail group',
          status: 'PAUSED',
          campaign,
          finalUrls: ['https://example.com/shop'],
        },
        campaign: {
          resourceName: campaign,
          id: '100',
          name: 'Retail',
          status: 'PAUSED',
          advertisingChannelType: 'PERFORMANCE_MAX',
        },
      },
    ],
  }),
  paginatedCodes: ['PREVIEW_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123:generateShareablePreviews') {
      if (mode.partial) return g.partialFailure();
      return {
        json: {
          result: {
            previews: body.operation.shareablePreviews.map(p => ({
              assetGroup: p.assetGroup,
              uiPreviewResult: {shareablePreviewUrl: 'https://ads.google.com/aw/preview/synthetic'},
              expirationDateTime: '2099-01-01T00:00:00Z',
            })),
          },
        },
      };
    }
  },
  decisive: {
    change: state => (state.asset_group[0].assetGroup.finalUrls = ['https://example.com/other']),
    field: /finalUrls/,
  },
};
