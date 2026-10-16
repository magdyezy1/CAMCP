// dv360_line_item_targeting: POST /v4/advertisers/{advertiserId}/lineItems:bulkEditAssignedTargetingOptions (Display &
// Video 360 API v4; deletes, then creates, each line item atomically) moving two line items from one country to another.
// Where a line item serves is its GEO_REGION targeting, so the decisive field is the line items' assigned GEO_REGION
// options in lineItems.bulkListAssignedTargetingOptions: a region assigned in DV360 after the review would stay beside
// the reviewed one and widen where the line items spend.
import {notFound, scopes} from './_dv360.mjs';

const type = 'TARGETING_TYPE_GEO_REGION';
const option = (lineItem, id) => ({
  name: 'advertisers/123/lineItems/' + lineItem + '/targetingTypes/' + type + '/assignedTargetingOptions/' + id,
  assignedTargetingOptionId: id,
  targetingType: type,
  inheritance: 'NOT_INHERITED',
  geoRegionDetails: {targetingOptionId: id, displayName: 'Region ' + id, geoRegionType: 'GEO_REGION_TYPE_COUNTRY'},
});
const lineItem = (id, entityStatus, lineItemType = 'LINE_ITEM_TYPE_DISPLAY_DEFAULT') => ({
  name: 'advertisers/123/lineItems/' + id,
  advertiserId: '123',
  campaignId: '10',
  insertionOrderId: '20',
  lineItemId: id,
  displayName: 'Line ' + id,
  lineItemType,
  entityStatus,
});

export default {
  family: 'dv360_line_item_targeting',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_LINE_ITEMS_BULK_EDIT_ASSIGNED_TARGETING_OPTIONS',
    params: {advertiserId: '123'},
    body: {
      lineItemIds: ['456', '457'],
      deleteRequests: [{targetingType: type, assignedTargetingOptionIds: ['2840']}],
      createRequests: [
        {targetingType: type, assignedTargetingOptions: [{geoRegionDetails: {targetingOptionId: '2826'}}]},
      ],
    },
  },
  seed: () => ({
    lineItems: {456: lineItem('456', 'ENTITY_STATUS_PAUSED'), 457: lineItem('457', 'ENTITY_STATUS_ACTIVE')},
    targeting: {456: [option('456', '2840')], 457: [option('457', '2840')]},
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    const li = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && li && state.lineItems[li]) return {json: structuredClone(state.lineItems[li])};
    if (method === 'GET' && path === '/v4/advertisers/123/lineItems:bulkListAssignedTargetingOptions') {
      const ids = url.searchParams.getAll('lineItemIds'),
        types = [...String(url.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m => m[1]),
        token = url.searchParams.get('pageToken');
      // Another page: DV360 names a next page token; on the next page it names the same token again, which the reader
      // refuses as a repeated page instead of reading its page bound.
      if (mode.paginate) return {json: token ? {nextPageToken: token} : {nextPageToken: '1'}};
      const rows = ids.flatMap(l =>
        (state.targeting[l] ?? [])
          .filter(o => types.includes(o.targetingType))
          .map(o => ({lineItemId: l, assignedTargetingOption: structuredClone(o)})),
      );
      return {json: rows.length ? {lineItemAssignedTargetingOptions: rows} : {}};
    }
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/lineItems:bulkEditAssignedTargetingOptions') {
      const updated = [],
        failed = [];
      for (const l of body.lineItemIds) {
        // A partial answer: DV360 updates the first line item and reports the second as failed.
        if (mode.partial && l === '457') {
          failed.push(l);
          continue;
        }
        const removed = body.deleteRequests.flatMap(d => d.assignedTargetingOptionIds);
        state.targeting[l] = [
          ...state.targeting[l].filter(o => !removed.includes(o.assignedTargetingOptionId)),
          ...body.createRequests.flatMap(c =>
            c.assignedTargetingOptions.map(a => option(l, a.geoRegionDetails.targetingOptionId)),
          ),
        ];
        updated.push(l);
      }
      return {
        json: {
          ...(updated.length ? {updatedLineItemIds: updated} : {}),
          ...(failed.length ? {failedLineItemIds: failed, errors: [{code: 3, message: 'Synthetic failure'}]} : {}),
        },
      };
    }
  },
  decisive: {
    change: state => state.targeting[457].push(option('457', '2250')),
    field: /lineItemAssignedTargetingOptions/,
  },
};
