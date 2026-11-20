// google_listing_groups, the Standard Shopping shape (R2.5 M3, G5 route B): POST /v25/customers/{id}/adGroupCriteria:mutate that
// creates a listing group (Google Ads API, AdGroupCriterion.listing_group). The family serves it beside the Performance Max
// filters of tests/family-descriptors/google-listing-groups.mjs: a tree decides which Merchant Center products an ad group
// advertises and what each product group bids, a new node is only valid against the tree it is added to, and the review shows
// the resulting tree. The nodes of the current tree are the decisive field.
import * as g from '../_google-ads.mjs';

const adGroup = g.resource('adGroups', '700'),
  campaign = g.resource('campaigns', '100'),
  node = id => g.resource('adGroupCriteria', '700~' + id),
  brand = value => ({productBrand: value === undefined ? {} : {value}});

const criterion = (id, type, parent, caseValue, extra = {}) => ({
  resourceName: node(id),
  adGroup,
  criterionId: id,
  type: 'LISTING_GROUP',
  status: 'ENABLED',
  listingGroup: {type, ...(parent ? {parentAdGroupCriterion: node(parent), caseValue} : {})},
  ...extra,
});

export default {
  family: 'google_listing_groups',
  risk: 'activation',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_ad_group_criterion_mutate_ad_group_criteria',
    payload: {
      operations: [
        {remove: node('3')},
        {
          create: {
            adGroup,
            negative: true,
            listingGroup: {type: 'UNIT', parentAdGroupCriterion: node('1'), caseValue: brand('zeta')},
          },
        },
        {
          create: {
            adGroup,
            cpcBidMicros: '700000',
            listingGroup: {type: 'UNIT', parentAdGroupCriterion: node('1'), caseValue: brand()},
          },
        },
      ],
    },
  },
  seed: () => ({
    // The ad group read joins the ad group and its campaign.
    ad_group: [
      {
        adGroup: {resourceName: adGroup, status: 'PAUSED', type: 'SHOPPING_PRODUCT_ADS', campaign},
        campaign: {status: 'PAUSED', advertisingChannelType: 'SHOPPING', shoppingSetting: {merchantId: '4242'}},
      },
    ],
    ad_group_criterion: [
      criterion('1', 'SUBDIVISION'),
      criterion('2', 'UNIT', '1', brand('acme'), {cpcBidMicros: '1500000'}),
      criterion('3', 'UNIT', '1', brand(), {cpcBidMicros: '600000'}),
    ],
    next: 10,
  }),
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/adGroupCriteria:mutate') {
      if (mode.partial) return g.partialFailure();
      const results = body.operations.map(op => {
        if (op.remove) {
          state.ad_group_criterion = state.ad_group_criterion.filter(row => row.resourceName !== op.remove);
          return {resourceName: op.remove};
        }
        const id = String(state.next++),
          row = {
            ...criterion(id, op.create.listingGroup.type),
            ...(op.create.negative ? {negative: true} : {}),
            ...(op.create.cpcBidMicros ? {cpcBidMicros: op.create.cpcBidMicros} : {}),
            listingGroup: op.create.listingGroup,
          };
        state.ad_group_criterion.push(row);
        return {resourceName: row.resourceName};
      });
      return {json: {results}};
    }
  },
  // The "acme" unit was excluded in the meantime: the tree the review showed no longer exists.
  decisive: {
    change: state => (state.ad_group_criterion[1].negative = true),
    field: /nodes/,
  },
};
