// dv360_custom_bidding: PATCH /v4/customBiddingAlgorithms/{id}?updateMask=displayName (Display & Video 360 API v4,
// customBiddingAlgorithms.patch; the owner advertiser rides in the body). The decisive field is the algorithm's current
// `displayName` in customBiddingAlgorithms.get (read with the advertiser as accessor), the value the rename overwrites:
// a rename made in DV360 after the review must stop the reviewed one.
import {notFound, scopes} from './_dv360.mjs';

export default {
  family: 'dv360_custom_bidding',
  risk: 'settings',
  gateway: 'dv360_native_action',
  account: '123',
  connection: {scopes},
  arguments: {
    action: 'DV360_CUSTOM_BIDDING_ALGORITHMS_PATCH',
    params: {customBiddingAlgorithmId: '801', updateMask: 'displayName'},
    body: {advertiserId: '123', displayName: 'Conversions model v2'},
  },
  seed: () => ({
    advertiser: {name: 'advertisers/123', advertiserId: '123', partnerId: '1', entityStatus: 'ENTITY_STATUS_ACTIVE'},
    algorithm: {
      name: 'customBiddingAlgorithms/801',
      customBiddingAlgorithmId: '801',
      advertiserId: '123',
      displayName: 'Conversions model',
      customBiddingAlgorithmType: 'SCRIPT_BASED',
      entityStatus: 'ENTITY_STATUS_ACTIVE',
    },
  }),
  unpaginated: 'advertisers.get and customBiddingAlgorithms.get return one resource each; DV360 pages only lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v4/advertisers/123') return {json: structuredClone(state.advertiser)};
    if (
      method === 'GET' &&
      path === '/v4/customBiddingAlgorithms/801' &&
      url.searchParams.get('advertiserId') === '123'
    )
      return {json: structuredClone(state.algorithm)};
    if (method === 'GET') return notFound();
    if (method === 'PATCH' && path === '/v4/customBiddingAlgorithms/801') {
      // An unconfirmed answer: HTTP 200 naming no algorithm.
      if (mode.partial) return {json: {}};
      state.algorithm.displayName = body.displayName;
      return {json: structuredClone(state.algorithm)};
    }
  },
  decisive: {change: state => (state.algorithm.displayName = 'Renamed in DV360'), field: /displayName/},
};
