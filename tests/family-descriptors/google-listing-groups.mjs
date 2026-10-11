// google_listing_groups: POST /v25/customers/{id}/assetGroupListingGroupFilters:mutate (Google Ads API,
// AssetGroupListingGroupFilter). A listing group tree decides which Merchant Center products a Performance Max asset
// group advertises; a new node is only valid against the tree it is added to (one "Other" node per subdivision, units
// as leaves), and the review shows the resulting tree. The current tree's nodes are the decisive field.
import * as g from './_google-ads.mjs';

const group = g.resource('assetGroups', '700'),
  campaign = g.resource('campaigns', '100'),
  node = id => g.resource('assetGroupListingGroupFilters', '700~' + id),
  brand = value => ({productBrand: value === undefined ? {} : {value}});

const filter = (id, type, parent, caseValue) => ({
  resourceName: node(id),
  assetGroup: group,
  id,
  type,
  listingSource: 'SHOPPING',
  ...(parent ? {parentListingGroupFilter: node(parent), caseValue} : {}),
});

export default {
  family: 'google_listing_groups',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_asset_group_listing_group_filter_mutate_asset_group_listing_group_filters',
    payload: {
      operations: [
        {
          create: {
            assetGroup: group,
            type: 'UNIT_EXCLUDED',
            listingSource: 'SHOPPING',
            parentListingGroupFilter: node('1'),
            caseValue: brand('zeta'),
          },
        },
      ],
    },
  },
  seed: () => ({
    // The asset group read joins the asset group and its campaign.
    asset_group: [
      {
        assetGroup: {resourceName: group, status: 'PAUSED', campaign},
        campaign: {
          resourceName: campaign,
          status: 'PAUSED',
          advertisingChannelType: 'PERFORMANCE_MAX',
          shoppingSetting: {merchantId: '4242'},
        },
      },
    ],
    asset_group_listing_group_filter: [
      filter('1', 'SUBDIVISION'),
      filter('2', 'UNIT_INCLUDED', '1', brand('acme')),
      filter('3', 'UNIT_INCLUDED', '1', brand()),
    ],
    next: 10,
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/assetGroupListingGroupFilters:mutate') {
      if (mode.partial) return g.partialFailure();
      const results = body.operations.map(({create}) => {
        const id = String(state.next++),
          row = {...create, resourceName: node(id), id};
        state.asset_group_listing_group_filter.push(row);
        return {resourceName: row.resourceName};
      });
      return {json: {results}};
    }
  },
  // The "acme" unit was excluded in the meantime: the tree the review showed no longer exists.
  decisive: {
    change: state => (state.asset_group_listing_group_filter[1].type = 'UNIT_EXCLUDED'),
    field: /nodes/,
  },
};
