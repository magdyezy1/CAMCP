// dv360_demand_gen_ad_groups: PATCH /v4/advertisers/{advertiserId}/adGroups/{adGroupId}?updateMask=bidStrategy (Display
// & Video 360 API v4, advertisers.adGroups.patch) raising a Demand Gen ad group's target CPA. The decisive field is the
// ad group's current `bidStrategy.demandGenBid.value` in advertisers.adGroups.get, the bid the patch overwrites and the
// spending review measures the change against: a bid changed in DV360 after the review makes the reviewed change
// another one.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_demand_gen_ad_groups',
  risk: 'budget',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_AD_GROUPS_PATCH',
    params: {advertiserId: '123', adGroupId: '61', updateMask: 'bidStrategy'},
    body: {bidStrategy: {demandGenBid: {value: '2500000'}}},
  },
  seed: () => ({
    advertiser: {
      name: 'advertisers/123',
      advertiserId: '123',
      partnerId: '1',
      generalConfig: {currencyCode: 'USD', domainUrl: 'https://example.com'},
    },
    lineItem: {
      lineItemId: '41',
      advertiserId: '123',
      insertionOrderId: '31',
      displayName: 'Demand Gen',
      lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_TARGET_CPA', value: '2000000'}},
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
      bidStrategy: {demandGenBid: {value: '2000000'}},
    },
  }),
  unpaginated: 'advertisers.get, adGroups.get and lineItems.get return one resource each; DV360 pages only lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (method === 'GET' && path === '/v4/advertisers/123/adGroups/61') return {json: structuredClone(state.adGroup)};
    if (method === 'GET' && path === '/v4/advertisers/123/lineItems/41') return {json: structuredClone(state.lineItem)};
    if (method === 'GET') return notFound();
    if (method === 'PATCH' && path === '/v4/advertisers/123/adGroups/61') {
      // An unconfirmed answer: HTTP 200 naming no ad group.
      if (mode.partial) return {json: {}};
      Object.assign(state.adGroup, body);
      return {json: structuredClone(state.adGroup)};
    }
  },
  decisive: {change: state => (state.adGroup.bidStrategy.demandGenBid.value = '2200000'), field: /bidValue/},
};
