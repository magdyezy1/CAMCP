// gtm_workflows: PUT https://tagmanager.googleapis.com/tagmanager/v2/accounts/{id}/user_permissions/{id} (Tag Manager
// API v2, UserPermission.update) through the delegated gtm_ops operation. The update replaces the member's
// `containerAccess`, the containers that person may read, edit or publish; the member's current `containerAccess` is
// the decisive field. Only a workspace administrator may review account access changes.
const base = 'accounts/44',
  container = base + '/containers/55',
  member = base + '/user_permissions/7',
  origin = 'https://tagmanager.googleapis.com',
  prefix = '/tagmanager/v2/',
  permission = (id, email, access, containers = []) => ({
    path: base + '/user_permissions/' + id,
    accountId: '44',
    emailAddress: email,
    accountAccess: {permission: access},
    containerAccess: containers,
  });

export default {
  family: 'gtm_workflows',
  risk: 'settings',
  role: 'admin',
  gateway: 'gtm_native_action',
  account: '44',
  connection: {scopes: ['https://www.googleapis.com/auth/tagmanager.manage.users']},
  arguments: {
    operation: 'gtm_ops',
    arguments: {
      action: 'UPDATE_USER_PERMISSION',
      account_id: '44',
      path: member,
      payload: {
        emailAddress: 'member@example.test',
        accountAccess: {permission: 'user'},
        containerAccess: [{containerId: '55', permission: 'edit'}],
      },
    },
  },
  seed: () => ({
    container: {path: container, accountId: '44', containerId: '55', name: 'Container'},
    permissions: [
      permission('7', 'member@example.test', 'user', [{containerId: '55', permission: 'read'}]),
      permission('11', 'owner@example.test', 'admin'),
      permission('12', 'backup@example.test', 'admin'),
    ],
  }),
  paginatedCodes: ['INCOMPLETE_STATE'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== origin || !path.startsWith(prefix)) return;
    const resource = path.slice(prefix.length);
    if (method === 'GET') {
      if (resource === container) return {json: state.container};
      if (resource === base + '/user_permissions')
        // Every page names the same cursor again when the provider pages the collection.
        return {
          json: {
            ...(mode.paginate && url.searchParams.has('pageToken')
              ? {}
              : {userPermission: structuredClone(state.permissions)}),
            ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
          },
        };
      const found = state.permissions.find(p => p.path === resource);
      if (found) return {json: found};
      return;
    }
    if (method === 'PUT' && resource === member) {
      // A partial answer: Tag Manager answers without the path of the permission it changed.
      if (mode.partial) return {json: {}};
      const at = state.permissions.findIndex(p => p.path === member);
      state.permissions[at] = {...state.permissions[at], ...structuredClone(body), path: member, accountId: '44'};
      return {json: state.permissions[at]};
    }
  },
  decisive: {
    change: state => (state.permissions[0].containerAccess = [{containerId: '55', permission: 'publish'}]),
    field: /containerAccess/,
  },
};
