// google_user_access: POST /v25/customers/{id}/customerUserAccesses:mutate (Google Ads API, CustomerUserAccess). The
// update overwrites a member's `access_role`, what that person may see and change in the account; the member's current
// `access_role` is the decisive field. Only a workspace administrator may review account access changes.
import * as g from './_google-ads.mjs';

const member = id => g.resource('customerUserAccesses', id);

export default {
  family: 'google_user_access',
  risk: 'settings',
  role: 'admin',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: g.connection,
  credentials: g.credentials,
  request: {
    action: 'google_ads_v23_customer_user_access_mutate_customer_user_access',
    payload: {operation: {update: {resourceName: member('20'), accessRole: 'READ_ONLY'}, updateMask: 'accessRole'}},
  },
  seed: () => ({
    // The family accepts only the customer fields it selects.
    customer: [{id: g.account, currencyCode: 'USD', timeZone: 'UTC', manager: false}],
    customer_user_access: [
      ['10', 'ADMIN'],
      ['11', 'ADMIN'],
      ['20', 'STANDARD'],
    ].map(([id, role]) => ({
      resourceName: member(id),
      userId: id,
      emailAddress: 'user' + id + '@example.test',
      accessRole: role,
    })),
    customer_user_access_invitation: [],
  }),
  paginatedCodes: ['GOOGLE_ACCESS_STATE_UNVERIFIED'],
  isWrite: request => !g.isSearch(request),
  provider(request) {
    const {path, body, state, mode} = request;
    if (g.isSearch(request)) return g.table(request);
    if (path === '/v25/customers/123/customerUserAccesses:mutate') {
      if (mode.partial) return g.partialFailure();
      const op = body.operation;
      state.customer_user_access.find(m => m.resourceName === op.update.resourceName).accessRole = op.update.accessRole;
      return {json: {result: {resourceName: op.update.resourceName}}};
    }
  },
  decisive: {change: state => (state.customer_user_access[2].accessRole = 'EMAIL_ONLY'), field: /accessRole/},
};
