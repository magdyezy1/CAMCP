// dv360_demand_gen_ads: PATCH /v4/advertisers/{advertiserId}/adGroupAds/{adGroupAdId}?updateMask=entityStatus (Display &
// Video 360 API v4, advertisers.adGroupAds.patch) activating a paused Demand Gen image ad. "An ad serves only while it,
// its ad group and its line item are active", so the decisive field is the ad group's `entityStatus` in
// advertisers.adGroups.get: an ad group activated in DV360 after the review makes the reviewed activation serve at once.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_demand_gen_ads',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_AD_GROUP_ADS_PATCH',
    params: {advertiserId: '123', adGroupAdId: '71', updateMask: 'entityStatus'},
    body: {entityStatus: 'ENTITY_STATUS_ACTIVE'},
  },
  seed: () => ({
    advertiser: {
      name: 'advertisers/123',
      advertiserId: '123',
      partnerId: '1',
      generalConfig: {currencyCode: 'USD', domainUrl: 'https://example.com'},
      defaultBusinessName: 'Example',
      defaultLogoAssetId: '501',
    },
    lineItem: {
      lineItemId: '41',
      advertiserId: '123',
      insertionOrderId: '31',
      displayName: 'Demand Gen',
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CONVERSIONS'}},
    },
    adGroup: {
      name: 'advertisers/123/adGroups/61',
      advertiserId: '123',
      adGroupId: '61',
      lineItemId: '41',
      displayName: 'Shoppers',
      adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
    },
    ad: {
      name: 'advertisers/123/adGroupAds/71',
      advertiserId: '123',
      adGroupAdId: '71',
      adGroupId: '61',
      displayName: 'Autumn image',
      entityStatus: 'ENTITY_STATUS_PAUSED',
      demandGenImageAd: {
        finalUrl: 'https://example.com/autumn',
        headline: 'Autumn sale',
        description: 'Up to 30% off',
        businessName: 'Example',
        callToAction: 'SHOP_NOW',
        marketingImages: [{assetId: '601'}],
        squareMarketingImages: [{assetId: '602'}],
        logoImages: [{assetId: '603'}],
      },
    },
  }),
  unpaginated: 'advertisers.get, adGroupAds.get, adGroups.get and lineItems.get return one resource each',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (method === 'GET' && path === '/v4/advertisers/123/adGroupAds/71') return {json: structuredClone(state.ad)};
    if (method === 'GET' && path === '/v4/advertisers/123/adGroups/61') return {json: structuredClone(state.adGroup)};
    if (method === 'GET' && path === '/v4/advertisers/123/lineItems/41') return {json: structuredClone(state.lineItem)};
    if (method === 'GET') return notFound();
    if (method === 'PATCH' && path === '/v4/advertisers/123/adGroupAds/71') {
      // An unconfirmed answer: HTTP 200 naming no ad.
      if (mode.partial) return {json: {}};
      Object.assign(state.ad, body);
      return {json: structuredClone(state.ad)};
    }
  },
  decisive: {
    change: state => (state.adGroup.entityStatus = 'ENTITY_STATUS_ACTIVE'),
    field: /adGroup\b.*entityStatus/,
  },
};
