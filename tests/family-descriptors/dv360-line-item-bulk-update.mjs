// dv360_line_item_bulk_update: POST /v4/advertisers/{advertiserId}/lineItems:bulkUpdate (Display & Video 360 API v4,
// advertisers.lineItems.bulkUpdate) activating two paused line items. "An active line item spends only while its
// insertion order is active", so the decisive field is the insertion order's `entityStatus` in
// advertisers.insertionOrders.get: an order activated in DV360 after the review makes the reviewed activation spend at
// once instead of later.
import {notFound, scopes} from './_dv360.mjs';

const item = (id, name) => ({
  lineItemId: id,
  advertiserId: '123',
  campaignId: '21',
  insertionOrderId: '31',
  displayName: name,
  lineItemType: 'LINE_ITEM_TYPE_DISPLAY_DEFAULT',
  entityStatus: 'ENTITY_STATUS_PAUSED',
  containsEuPoliticalAds: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
});

export default {
  family: 'dv360_line_item_bulk_update',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_LINE_ITEMS_BULK_UPDATE',
    params: {advertiserId: '123'},
    body: {
      lineItemIds: ['41', '42'],
      targetLineItem: {entityStatus: 'ENTITY_STATUS_ACTIVE'},
      updateMask: 'entityStatus',
    },
  },
  seed: () => ({
    advertiser: {name: 'advertisers/123', advertiserId: '123', partnerId: '1'},
    order: {insertionOrderId: '31', advertiserId: '123', displayName: 'Q4', entityStatus: 'ENTITY_STATUS_PAUSED'},
    items: {41: item('41', 'Prospecting'), 42: item('42', 'Retargeting')},
  }),
  unpaginated: 'advertisers.get, lineItems.get and insertionOrders.get return one resource each; DV360 pages lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    const id = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && id && state.items[id]) return {json: structuredClone(state.items[id])};
    if (method === 'GET' && path === '/v4/advertisers/123/insertionOrders/31')
      return {json: structuredClone(state.order)};
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/lineItems:bulkUpdate') {
      // A partial answer: DV360 updates one line item and reports the other as failed.
      if (mode.partial) {
        Object.assign(state.items[41], body.targetLineItem);
        return {
          json: {updatedLineItemIds: ['41'], failedLineItemIds: ['42'], errors: [{code: 9, message: 'Synthetic'}]},
        };
      }
      for (const i of body.lineItemIds) Object.assign(state.items[i], body.targetLineItem);
      return {json: {updatedLineItemIds: body.lineItemIds}};
    }
  },
  decisive: {
    change: state => (state.order.entityStatus = 'ENTITY_STATUS_ACTIVE'),
    field: /insertionOrders.*entityStatus/,
  },
};
