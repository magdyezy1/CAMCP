// google_smart_campaign_settings: POST /v25/customers/{id}/smartCampaignSettings:mutate (Google Ads API,
// SmartCampaignSetting). The update overwrites the setting's `final_url`, the landing page every ad of the Smart
// campaign leads to; the setting's current `final_url` is the decisive field.
import * as g from './_google-ads.mjs';

const setting = g.resource('smartCampaignSettings', '300'),
  campaign = g.resource('campaigns', '300');

export default {
  family: 'google_smart_campaign_settings',
  risk: 'settings',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_smart_campaign_setting_mutate_smart_campaign_settings',
    payload: {
      operations: [{update: {resourceName: setting, finalUrl: 'https://example.com/new'}, updateMask: 'finalUrl'}],
    },
  },
  seed: () => ({
    // Each result row joins the setting and its campaign.
    smart_campaign_setting: [
      {
        smartCampaignSetting: {
          resourceName: setting,
          campaign,
          phoneNumber: {phoneNumber: '+1 555 0100', countryCode: 'US'},
          finalUrl: 'https://example.com/old',
          advertisingLanguageCode: 'en',
          businessName: 'Synthetic Bakery',
        },
        campaign: {status: 'PAUSED', advertisingChannelType: 'SMART'},
      },
    ],
  }),
  paginatedCodes: ['SMART_CAMPAIGN_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/smartCampaignSettings:mutate') {
      if (mode.partial) return g.partialFailure();
      for (const op of body.operations) {
        const {resourceName, ...fields} = op.update;
        Object.assign(
          state.smart_campaign_setting.find(r => r.smartCampaignSetting.resourceName === resourceName)
            .smartCampaignSetting,
          fields,
        );
      }
      return {json: {results: body.operations.map(op => ({resourceName: op.update.resourceName}))}};
    }
  },
  decisive: {
    change: state => (state.smart_campaign_setting[0].smartCampaignSetting.finalUrl = 'https://example.com/other'),
    field: /finalUrl/,
  },
};
