// dv360_advertiser_settings: PATCH /v4/advertisers/{advertiserId}?updateMask=generalConfig.domainUrl (Display & Video
// 360 API v4, advertisers.patch; AdvertiserGeneralConfig.domainUrl is the advertiser's primary website). The decisive
// field is the advertiser's current `generalConfig.domainUrl` in advertisers.get, the value the patch overwrites: a
// website changed in DV360 after the review must stop the reviewed change.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_advertiser_settings',
  // Spend-affecting (the registry asks spendConfirmation), so it counts as money evidence (R1), not settings.
  risk: 'budget',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_PATCH',
    params: {advertiserId: '123', updateMask: 'generalConfig.domainUrl'},
    body: {generalConfig: {domainUrl: 'https://shop.example.com'}},
  },
  seed: () => ({
    advertiser: {
      name: 'advertisers/123',
      advertiserId: '123',
      partnerId: '1',
      displayName: 'Advertiser',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      generalConfig: {domainUrl: 'https://example.com', currencyCode: 'USD', timeZone: 'America/New_York'},
      servingConfig: {exemptTvFromViewabilityTargeting: false},
      integrationDetails: {integrationCode: 'OLD'},
      containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    },
  }),
  unpaginated: 'advertisers.get returns the one Advertiser resource; DV360 pages only list methods',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (method === 'GET') return notFound();
    if (method === 'PATCH' && path === '/v4/advertisers/123') {
      // An unconfirmed answer: HTTP 200 without the advertiser the patch named.
      if (mode.partial) return {json: {}};
      Object.assign(state.advertiser.generalConfig, body.generalConfig);
      return {json: structuredClone(state.advertiser)};
    }
  },
  decisive: {
    change: state => (state.advertiser.generalConfig.domainUrl = 'https://brand.example.com'),
    field: /domainUrl/,
  },
};
