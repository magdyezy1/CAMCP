// dv360_inventory_source_groups: POST /v4/inventorySourceGroups/{id}/assignedInventorySources:bulkEdit (Display & Video
// 360 API v4, inventorySourceGroups.assignedInventorySources.bulkEdit; deletes the listed assignments, then creates the
// new ones). Line items that target the group buy from its inventory sources, so the decisive field is the group's
// assignments in assignedInventorySources.list: a source assigned or removed in DV360 after the review changes the set
// the reviewed edit produces.
import {list, notFound, scopes} from './_dv360.mjs';

const prefix = 'inventorySourceGroups/501/assignedInventorySources/';
const assignment = (id, source) => ({
  name: prefix + id,
  assignedInventorySourceId: id,
  inventorySourceId: source,
});
const source = id => ({
  name: 'inventorySources/' + id,
  inventorySourceId: id,
  displayName: 'Deal ' + id,
  inventorySourceType: 'INVENTORY_SOURCE_TYPE_PRIVATE',
  dealId: 'deal-' + id,
  status: {entityStatus: 'ENTITY_STATUS_ACTIVE'},
});

export default {
  family: 'dv360_inventory_source_groups',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_INVENTORY_SOURCE_GROUPS_ASSIGNED_INVENTORY_SOURCES_BULK_EDIT',
    params: {inventorySourceGroupId: '501'},
    body: {
      advertiserId: '123',
      deletedAssignedInventorySources: ['12'],
      createdAssignedInventorySources: [{inventorySourceId: '303'}],
    },
  },
  seed: () => ({
    advertiser: {name: 'advertisers/123', advertiserId: '123', partnerId: '1'},
    group: {name: 'inventorySourceGroups/501', inventorySourceGroupId: '501', displayName: 'Premium deals'},
    assigned: [assignment('11', '301'), assignment('12', '302')],
    sources: [source('301'), source('302'), source('303')],
    next: 20,
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.searchParams.has('partnerId')) return notFound();
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (method === 'GET' && path === '/v4/inventorySourceGroups/501') return {json: structuredClone(state.group)};
    // The reader follows the assignment pages; here every page after the first names the token it was read with
    // again, which the reader refuses as a repeated page instead of reading its 50-page bound.
    if (method === 'GET' && path === '/v4/inventorySourceGroups/501/assignedInventorySources')
      return mode.paginate && url.searchParams.has('pageToken')
        ? {json: {nextPageToken: url.searchParams.get('pageToken')}}
        : list('assignedInventorySources', state.assigned, mode.paginate, url);
    if (method === 'GET' && path === '/v4/inventorySources') return list('inventorySources', state.sources);
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/inventorySourceGroups/501/assignedInventorySources:bulkEdit') {
      // An unconfirmed answer: HTTP 200 naming none of the created assignments.
      if (mode.partial) return {json: {}};
      const created = body.createdAssignedInventorySources.map(c =>
        assignment(String(state.next++), c.inventorySourceId),
      );
      state.assigned = [
        ...state.assigned.filter(a => !body.deletedAssignedInventorySources.includes(a.assignedInventorySourceId)),
        ...created,
      ];
      return {json: {assignedInventorySources: created}};
    }
  },
  decisive: {change: state => state.assigned.push(assignment('13', '305')), field: /assigned/},
};
