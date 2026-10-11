// google_offline_conversions: POST https://datamanager.googleapis.com/v1/events:ingest (Google Data Manager API)
// sending offline conversions to an import (UPLOAD_CLICKS) conversion action read through the Google Ads API. Google
// records conversions only for an enabled action, and a received conversion cannot be recalled, so the action's
// `status` is the decisive field: an action disabled after the review makes the family's own prerequisite refuse the
// upload as the state is read again at execute. The owner prepares and executes it (personal data).
import * as g from './_google-ads.mjs';
import * as dm from './_google-data-manager.mjs';

const now = Math.floor(Date.now() / 1000),
  people = {
    schema: ['EMAIL'],
    rows: [
      {EMAIL: 'person.one@example.com', event_time: now - 3600, value: 250, currency: 'SAR', transaction_id: 'order-7'},
    ],
  };

export default {
  family: 'google_offline_conversions',
  risk: 'settings',
  role: 'admin',
  gateway: 'google_ads_native_action',
  account: g.account,
  connection: dm.connection,
  credentials: g.credentials,
  request: {action: 'DATA_MANAGER_INGEST_EVENTS', payload: {conversion_action_id: '800', consent: dm.consent}},
  prepareFields: {people, personal_data: dm.confirmations},
  // People are never stored: execute is given them again and checks they are the ones reviewed.
  execute: {people},
  prime: dm.prime,
  seed: () => ({
    customer: [{resourceName: 'customers/' + g.account, id: g.account, manager: false}],
    conversion_action: [
      {
        resourceName: g.resource('conversionActions', '800'),
        id: '800',
        name: 'Offline sales',
        type: 'UPLOAD_CLICKS',
        status: 'ENABLED',
        ownerCustomer: 'customers/' + g.account,
      },
    ],
    sent: [],
  }),
  unpaginated:
    'both reads select one row at most (customer LIMIT 1, conversion_action.id = 800); Google pages past 10,000',
  isWrite: dm.isWrite,
  provider: request =>
    dm.provider(request, {
      path: '/v1/events:ingest',
      counts: last => ({eventsIngestionStatus: {recordCount: String(last.events.length)}}),
    }),
  decisive: {
    change: state => (state.conversion_action[0].status = 'HIDDEN'),
    field: /status/,
    refusal: {code: 'INVALID_GOOGLE_DATA_MANAGER', message: /Conversion action 800 is HIDDEN, not ENABLED/},
  },
};
