// google_business_notifications: PATCH /v1/accounts/{id}/notificationSetting (mybusinessnotifications.googleapis.com,
// Business Profile Notifications API, NotificationSetting) through the delegated gmb_notification_ops operation. The
// update overwrites the account's `pubsubTopic`, the Pub/Sub topic that receives every review and update notification
// of the account's locations; the setting's current `pubsubTopic` is the decisive field. Only a workspace
// administrator may review it.
const name = 'accounts/123/notificationSetting',
  management = 'https://mybusinessaccountmanagement.googleapis.com',
  notifications = 'https://mybusinessnotifications.googleapis.com';

export default {
  family: 'google_business_notifications',
  risk: 'settings',
  role: 'admin',
  gateway: 'google_business_native_action',
  account: '123',
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_notification_ops',
    arguments: {
      action: 'UPDATE_NOTIFICATION_SETTING',
      account_id: '123',
      payload: {
        name,
        pubsubTopic: 'projects/amcp-test/topics/new-reviews',
        notificationTypes: ['NEW_REVIEW', 'UPDATED_REVIEW'],
      },
      query: {updateMask: 'pubsubTopic,notificationTypes'},
    },
  },
  seed: () => ({
    account: {
      name: 'accounts/123',
      accountName: 'Synthetic Group',
      type: 'LOCATION_GROUP',
      role: 'OWNER',
      permissionLevel: 'OWNER_LEVEL',
      verificationState: 'VERIFIED',
    },
    setting: {name, pubsubTopic: 'projects/amcp-test/topics/existing-reviews', notificationTypes: ['NEW_REVIEW']},
  }),
  // Both reads are single resources; an answer that names another page is not the resource and is refused.
  paginatedCodes: ['BUSINESS_NOTIFICATION_STATE_UNVERIFIED'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    const page = mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {};
    if (method === 'GET' && url.origin === management && path === '/v1/accounts/123')
      return {json: {...structuredClone(state.account), ...page}};
    if (url.origin !== notifications || path !== '/v1/' + name) return;
    if (method === 'GET') return {json: {...structuredClone(state.setting), ...page}};
    if (method === 'PATCH') {
      // A partial answer: Google answers without naming the setting it changed.
      if (mode.partial) return {json: {}};
      Object.assign(state.setting, structuredClone(body));
      return {json: structuredClone(state.setting)};
    }
  },
  decisive: {
    change: state => (state.setting.pubsubTopic = 'projects/amcp-test/topics/other'),
    field: /pubsubTopic/,
  },
};
