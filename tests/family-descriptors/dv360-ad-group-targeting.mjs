// dv360_ad_group_targeting: POST /v4/advertisers/{advertiserId}/adGroups:bulkEditAssignedTargetingOptions (Display &
// Video 360 API v4, Demand Gen ad group targeting) adding an age range to a paused and an active ad group. Age ranges
// add up to the audience an ad group reaches, so the decisive field is the ad groups' assigned AGE_RANGE options in
// adGroups.bulkListAssignedTargetingOptions: a range assigned in DV360 after the review changes who the reviewed edit
// lets the ad groups reach.
import {notFound, scopes} from './_dv360.mjs';

const type = 'TARGETING_TYPE_AGE_RANGE';
const option = (adGroup, id, ageRange) => ({
  name: 'advertisers/123/adGroups/' + adGroup + '/targetingTypes/' + type + '/assignedTargetingOptions/' + id,
  assignedTargetingOptionId: id,
  targetingType: type,
  inheritance: 'NOT_INHERITED',
  ageRangeDetails: {ageRange},
});
const lineItem = (id, entityStatus, geoLanguage) => ({
  name: 'advertisers/123/lineItems/' + id,
  advertiserId: '123',
  campaignId: '10',
  insertionOrderId: '20',
  lineItemId: id,
  displayName: 'Demand Gen ' + id,
  lineItemType: 'LINE_ITEM_TYPE_DEMAND_GEN',
  entityStatus,
  demandGenSettings: {geoLanguageTargetingEnabled: geoLanguage},
  bidStrategy: {demandGenBid: {type: 'DEMAND_GEN_BIDDING_STRATEGY_TYPE_MAXIMIZE_CLICKS'}},
});
const adGroup = (id, lineItemId, entityStatus) => ({
  name: 'advertisers/123/adGroups/' + id,
  advertiserId: '123',
  adGroupId: id,
  lineItemId,
  displayName: 'Group ' + id,
  adGroupFormat: 'AD_GROUP_FORMAT_DEMAND_GEN',
  entityStatus,
  adGroupInventoryControl: {adGroupInventoryStrategy: 'AD_GROUP_INVENTORY_STRATEGY_ALL_GOOGLE_INVENTORY'},
});

export default {
  family: 'dv360_ad_group_targeting',
  risk: 'activation',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_ADVERTISERS_AD_GROUPS_BULK_EDIT_ASSIGNED_TARGETING_OPTIONS',
    params: {advertiserId: '123'},
    body: {
      adGroupIds: ['901', '903'],
      createRequests: [
        {targetingType: type, assignedTargetingOptions: [{ageRangeDetails: {ageRange: 'AGE_RANGE_25_34'}}]},
      ],
    },
  },
  seed: () => ({
    advertiser: {
      name: 'advertisers/123',
      advertiserId: '123',
      displayName: 'Advertiser',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
      generalConfig: {currencyCode: 'USD'},
    },
    lineItems: {
      555: lineItem('555', 'ENTITY_STATUS_PAUSED', false),
      556: lineItem('556', 'ENTITY_STATUS_ACTIVE', true),
    },
    adGroups: {901: adGroup('901', '555', 'ENTITY_STATUS_PAUSED'), 903: adGroup('903', '556', 'ENTITY_STATUS_ACTIVE')},
    targeting: {901: [], 903: [option('903', '7001', 'AGE_RANGE_18_24')]},
    next: 7100,
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    const li = /^\/v4\/advertisers\/123\/lineItems\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && li && state.lineItems[li]) return {json: structuredClone(state.lineItems[li])};
    const group = /^\/v4\/advertisers\/123\/adGroups\/(\d+)$/.exec(path)?.[1];
    if (method === 'GET' && group && state.adGroups[group]) return {json: structuredClone(state.adGroups[group])};
    if (method === 'GET' && path === '/v4/advertisers/123/adGroups:bulkListAssignedTargetingOptions') {
      const types = [...String(url.searchParams.get('filter')).matchAll(/targetingType="([A-Z_]+)"/g)].map(m => m[1]),
        token = url.searchParams.get('pageToken');
      // Another page: DV360 names a next page token; on the next page it names the same token again, which the reader
      // refuses as a repeated page instead of reading its page bound.
      if (mode.paginate) return {json: token ? {nextPageToken: token} : {nextPageToken: '1'}};
      const rows = url.searchParams
        .getAll('adGroupIds')
        .flatMap(g =>
          (state.targeting[g] ?? [])
            .filter(o => types.includes(o.targetingType))
            .map(o => ({adGroupId: g, assignedTargetingOption: structuredClone(o)})),
        );
      return {json: rows.length ? {adGroupAssignedTargetingOptions: rows} : {}};
    }
    if (method === 'GET' && path === '/v4/advertisers/123/lineItems:bulkListAssignedTargetingOptions')
      return {json: {}};
    if (method === 'GET') return notFound();
    if (method === 'POST' && path === '/v4/advertisers/123/adGroups:bulkEditAssignedTargetingOptions') {
      // A partial answer: DV360 updates the first ad group and reports the second as failed.
      const failed = mode.partial ? body.adGroupIds.slice(1) : [];
      for (const g of body.adGroupIds.filter(g => !failed.includes(g)))
        for (const c of body.createRequests)
          for (const a of c.assignedTargetingOptions)
            state.targeting[g].push(option(g, String(state.next++), a.ageRangeDetails.ageRange));
      return {
        json: {
          updatedAdGroupIds: body.adGroupIds.filter(g => !failed.includes(g)),
          ...(failed.length ? {failedAdGroupIds: failed, errors: [{code: 3, message: 'Synthetic failure'}]} : {}),
        },
      };
    }
  },
  decisive: {
    change: state => state.targeting[903].push(option('903', '7002', 'AGE_RANGE_35_44')),
    field: /adGroupAssignedTargetingOptions/,
  },
};
