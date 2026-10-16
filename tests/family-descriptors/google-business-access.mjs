// google_business_access: PATCH https://mybusinessaccountmanagement.googleapis.com/v1/accounts/{id}/admins/{admin}
// (Business Profile Account Management API, Admin) through the delegated gmb_account_ops operation. The update
// overwrites an administrator's `role`, what that person may do with every location of the group; the admin's current
// `role` is the decisive field. Only a workspace administrator may review account access changes.
const parent = 'accounts/123',
  management = 'https://mybusinessaccountmanagement.googleapis.com',
  admin = (id, who, role) => ({name: parent + '/admins/' + id, admin: who, role});

export default {
  family: 'google_business_access',
  risk: 'settings',
  role: 'admin',
  gateway: 'google_business_native_action',
  account: '123',
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_account_ops',
    arguments: {
      action: 'PATCH_ACCOUNT_ADMIN',
      account_id: '123',
      admin_id: '20',
      payload: {role: 'MANAGER'},
      query: {updateMask: 'role'},
    },
  },
  seed: () => ({
    account: {
      name: parent,
      accountName: 'Synthetic business group',
      type: 'LOCATION_GROUP',
      role: 'PRIMARY_OWNER',
      permissionLevel: 'OWNER_LEVEL',
      verificationState: 'VERIFIED',
      vettedState: 'NOT_VETTED',
    },
    admins: [
      admin('10', 'Primary Owner', 'PRIMARY_OWNER'),
      admin('20', 'Chosen User', 'OWNER'),
      admin('30', 'Another User', 'MANAGER'),
    ],
  }),
  paginatedCodes: ['BUSINESS_ACCESS_STATE_UNVERIFIED'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== management) return;
    if (method === 'GET' && path === '/v1/' + parent) return {json: structuredClone(state.account)};
    if (method === 'GET' && path === '/v1/' + parent + '/admins')
      // The admins of an account come in one answer; one that names another page is not the whole list.
      return {
        json: {
          accountAdmins: structuredClone(state.admins),
          ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
        },
      };
    if (method === 'PATCH' && path.startsWith('/v1/' + parent + '/admins/')) {
      // A partial answer: Google answers without naming the admin it changed.
      if (mode.partial) return {json: {}};
      const row = state.admins.find(a => a.name === path.slice(4));
      row.role = body.role;
      return {json: structuredClone(row)};
    }
  },
  decisive: {change: state => (state.admins[1].role = 'SITE_MANAGER'), field: /role/},
};
