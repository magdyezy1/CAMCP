// google_user_list_customer_types: POST /v25/customers/{id}/userListCustomerTypes:mutate (Google Ads API,
// UserListCustomerType). Attaching a customer type depends on the types the list already has: Google refuses
// conflicting pairs (UserListCustomerTypeError.CONFLICTING_CUSTOMER_TYPES), and customer acquisition bidding reads the
// list's whole set of types. The list's current customer types are the decisive field.
import * as g from './_google-ads.mjs';

const list = g.resource('userLists', '500');

export default {
  family: 'google_user_list_customer_types',
  risk: 'settings',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_user_list_customer_type_mutate_user_list_customer_types',
    payload: {operations: [{create: {userList: list, customerTypeCategory: 'PURCHASERS'}}]},
  },
  seed: () => ({
    customer: [
      {
        id: g.account,
        manager: false,
        conversionTrackingSetting: {conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF'},
      },
    ],
    user_list: [
      {
        resourceName: list,
        id: '500',
        name: 'Customers',
        type: 'CRM_BASED',
        readOnly: false,
        accountUserListStatus: 'ENABLED',
        accessReason: 'OWNED',
      },
    ],
    user_list_customer_type: [
      {
        resourceName: g.resource('userListCustomerTypes', '500~HIGH_VALUE_CUSTOMERS'),
        userList: list,
        customerTypeCategory: 'HIGH_VALUE_CUSTOMERS',
      },
    ],
  }),
  paginatedCodes: ['CUSTOMER_TYPE_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/userListCustomerTypes:mutate') {
      if (mode.partial) return g.partialFailure();
      const results = body.operations.map(({create}) => {
        const resourceName = g.resource(
          'userListCustomerTypes',
          create.userList.split('/').at(-1) + '~' + create.customerTypeCategory,
        );
        state.user_list_customer_type.push({resourceName, ...create});
        return {resourceName};
      });
      return {json: {results}};
    }
  },
  // Another type attached to the list in the meantime (one that does not conflict with PURCHASERS).
  decisive: {
    change: state =>
      state.user_list_customer_type.push({
        resourceName: g.resource('userListCustomerTypes', '500~PAID_SUBSCRIBERS'),
        userList: list,
        customerTypeCategory: 'PAID_SUBSCRIBERS',
      }),
    field: /types/,
  },
};
