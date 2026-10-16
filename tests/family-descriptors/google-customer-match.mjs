// google_customer_match: POST https://datamanager.googleapis.com/v1/audienceMembers:ingest (Google Data Manager API)
// adding people, hashed in memory, to a Customer Match list read through the Google Ads API. Only an open list
// accumulates members (UserList.membership_status: "Only open user lists can accumulate more users"), so the list's
// `membership_status` is the decisive field: a list closed after the review makes the family's own prerequisite refuse
// the upload as the state is read again at execute. The owner prepares and executes it (personal data).
import * as g from './_google-ads.mjs';
import * as dm from './_google-data-manager.mjs';

const people = {
  schema: ['EMAIL', 'PHONE'],
  rows: [
    ['person.one@example.com', ''],
    ['person.two@example.com', ''],
  ],
};

export default {
  family: 'google_customer_match',
  risk: 'settings',
  role: 'admin',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: dm.connection,
  credentials: g.credentials,
  request: {action: 'DATA_MANAGER_INGEST_AUDIENCE_MEMBERS', payload: {user_list_id: '42', consent: dm.consent}},
  prepareFields: {people, personal_data: dm.confirmations},
  // People are never stored: execute is given them again and checks they are the ones reviewed.
  execute: {people},
  prime: dm.prime,
  seed: () => ({
    customer: [{resourceName: 'customers/' + g.account, id: g.account, manager: false}],
    user_list: [
      {
        resourceName: g.resource('userLists', '42'),
        id: '42',
        name: 'Newsletter',
        type: 'CRM_BASED',
        readOnly: false,
        membershipStatus: 'OPEN',
        crmBasedUserList: {uploadKeyType: 'CONTACT_INFO'},
      },
    ],
    sent: [],
  }),
  unpaginated:
    'both reads select at most one row (customer LIMIT 1, user_list.id = 42); Google Ads pages past 10,000 rows',
  isWrite: dm.isWrite,
  provider: request =>
    dm.provider(request, {
      path: '/v1/audienceMembers:ingest',
      counts: last => ({
        audienceMembersIngestionStatus: {
          userDataIngestionStatus: {recordCount: String(last.audienceMembers.length), userIdentifierCount: '2'},
        },
      }),
    }),
  decisive: {
    change: state => (state.user_list[0].membershipStatus = 'CLOSED'),
    field: /membership/,
    refusal: {code: 'INVALID_GOOGLE_DATA_MANAGER', message: /User list 42 is closed/},
  },
};
