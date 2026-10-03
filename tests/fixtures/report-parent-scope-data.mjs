import {resourceScopeFixture} from './report-resource-scope-data.mjs';

export const parentScopeConnections = {
  gtm_native_action: '66666666-6666-4666-8666-666666666666',
  google_business_native_action: '77777777-7777-4777-8777-777777777777',
};
export const gtmParentConfig = (selectors = {path: 'accounts/100/containers/200/workspaces/300/tags/400'}) => ({
  gateway: 'gtm_native_action',
  arguments: {
    operation: 'gtm_ops',
    arguments: {action: 'GET_TAG', connection_id: parentScopeConnections.gtm_native_action, ...selectors},
  },
});
export const businessParentConfig = (selectors = {name: 'locations/456/lodging'}) => ({
  gateway: 'google_business_native_action',
  arguments: {
    operation: 'gmb_lodging_ops',
    arguments: {
      action: 'GET_LODGING',
      connection_id: parentScopeConnections.google_business_native_action,
      query: {readMask: '*'},
      ...selectors,
    },
  },
});
/** Existing native paths, synthetic retained source and zero native egress. */
export function parentScopeFixture(options = {}) {
  const f = resourceScopeFixture(options);
  for (const [gateway, id] of Object.entries(parentScopeConnections))
    f.store.putConnection(
      f.admin,
      {
        id,
        tenantId: f.actor.tenantId,
        gateway,
        accounts: gateway === 'gtm_native_action' ? ['100'] : ['100', 'locations/456'],
        writeAccounts: [],
        enabled: true,
        label: gateway === 'gtm_native_action' ? 'Synthetic Tag Manager' : 'Synthetic Business Profile',
        scopes:
          gateway === 'gtm_native_action'
            ? ['https://www.googleapis.com/auth/tagmanager.readonly']
            : ['https://www.googleapis.com/auth/business.manage'],
      },
      {accessToken: 'synthetic'},
    );
  return f;
}
