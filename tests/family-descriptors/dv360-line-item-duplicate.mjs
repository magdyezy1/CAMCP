// dv360_line_item_duplicate: POST /v4/advertisers/{advertiserId}/lineItems/{lineItemId}:duplicate (Display & Video 360
// API v4, advertisers.lineItems.duplicate; the copy is made from the source's current settings in its insertion order).
// The decisive field is the source line item's `entityStatus` in advertisers.lineItems.get: a source paused or
// activated in DV360 after the review is not the line item the reviewer approved copying.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_line_item_duplicate',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_LINE_ITEMS_DUPLICATE',
    params: {advertiserId: '123', lineItemId: '41'},
    body: {targetDisplayName: 'Prospecting copy', containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'},
  },
  seed: () => ({
    advertiser: {name: 'advertisers/123', advertiserId: '123', partnerId: '1'},
    order: {insertionOrderId: '31', advertiserId: '123', displayName: 'Q4', entityStatus: 'ENTITY_STATUS_ACTIVE'},
    items: {
      41: {
        lineItemId: '41',
        advertiserId: '123',
        campaignId: '21',
        insertionOrderId: '31',
        displayName: 'Prospecting',
        lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
        entityStatus: 'ENTITY_STATUS_ACTIVE',
        containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    },
    next: 90,
  }),
  unpaginated: 'advertisers.get, lineItems.get and insertionOrders.get return one resource each; DV360 pages lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    const item = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && item && state.items[item]) return {json: structuredClone(state.items[item])};
    if (method === 'GET' && path === '/v4/advertisers/123/insertionOrders/31')
      return {json: structuredClone(state.order)};
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/lineItems/41:duplicate') {
      // An unconfirmed answer: HTTP 200 naming no copy.
      if (mode.partial) return {json: {}};
      const id = String(state.next++);
      state.items[id] = {
        ...state.items[41],
        lineItemId: id,
        displayName: body.targetDisplayName,
        containsEuPoliticalAds: body.containsEuPoliticalAds,
        entityStatus: 'ENTITY_STATUS_DRAFT',
      };
      return {json: {duplicateLineItemId: id}};
    }
  },
  decisive: {change: state => (state.items[41].entityStatus = 'ENTITY_STATUS_PAUSED'), field: /entityStatus/},
};
