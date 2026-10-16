// google_customer_settings: POST /v25/customers/{id}:mutate (Google Ads API, CustomerService.MutateCustomer) widening
// the account's video brand safety suitability. The update overwrites the customer's
// `video_brand_safety_suitability`, the inventory tier every video campaign of the account may serve on (wider
// inventory can raise delivery and spend), so its current value is the decisive field.
import * as g from './_google-ads.mjs';

export default {
  family: 'google_customer_settings',
  // Spend-affecting (the registry asks spendConfirmation), so it counts as money evidence (R1), not settings.
  risk: 'budget',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_customer_mutate_customer',
    payload: {
      operation: {
        update: {resourceName: 'customers/123', videoBrandSafetySuitability: 'EXPANDED_INVENTORY'},
        updateMask: 'videoBrandSafetySuitability',
      },
    },
  },
  seed: () => ({
    customer: [
      {
        resourceName: 'customers/123',
        id: '123',
        manager: false,
        autoTaggingEnabled: true,
        trackingUrlTemplate: '',
        finalUrlSuffix: '',
        descriptiveName: 'Store',
        videoBrandSafetySuitability: 'STANDARD_INVENTORY',
        callReportingSetting: {callReportingEnabled: true, callConversionReportingEnabled: false},
      },
    ],
  }),
  paginatedCodes: ['CUSTOMER_SETTING_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123:mutate') {
      // A partial answer: Google accepted the call but names no mutated customer.
      if (mode.partial) return {json: {}};
      Object.assign(state.customer[0], body.operation.update);
      return {json: {result: {resourceName: 'customers/123'}}};
    }
  },
  decisive: {
    change: state => (state.customer[0].videoBrandSafetySuitability = 'LIMITED_INVENTORY'),
    field: /videoBrandSafetySuitability/,
  },
};
