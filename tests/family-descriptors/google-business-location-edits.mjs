// google_business_location_edits: PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/{id}
// (Business Profile Business Information API, Location) through the delegated gmb_location_ops operation. The update
// overwrites the location's `websiteUri`, the website Google shows on the Business Profile; the location's current
// `websiteUri` is the decisive field.
const location = 'locations/456',
  information = 'https://mybusinessbusinessinformation.googleapis.com';

export default {
  family: 'google_business_location_edits',
  risk: 'settings',
  gateway: 'google_business_native_action',
  account: location,
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_location_ops',
    arguments: {
      action: 'PATCH_LOCATION',
      location_id: '456',
      payload: {websiteUri: 'https://example.com/new'},
      query: {updateMask: 'websiteUri'},
    },
  },
  seed: () => ({
    location: {
      name: location,
      title: 'Synthetic Bakery',
      phoneNumbers: {primaryPhone: '+1 555 0100', additionalPhones: []},
      websiteUri: 'https://example.com/',
      labels: ['bakery'],
      openInfo: {status: 'OPEN'},
      metadata: {hasVoiceOfMerchant: true, hasPendingEdits: false},
    },
  }),
  unpaginated: 'GET /v1/locations/{id} returns one Location resource; the Business Information API pages only lists',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== information || path !== '/v1/' + location) return;
    if (method === 'GET') return {json: structuredClone(state.location)};
    if (method === 'PATCH') {
      // A partial answer: Google answers without naming the location it changed.
      if (mode.partial) return {json: {}};
      for (const field of url.searchParams.get('updateMask').split(',')) state.location[field] = body[field];
      return {json: structuredClone(state.location)};
    }
  },
  decisive: {change: state => (state.location.websiteUri = 'https://example.com/other'), field: /websiteUri/},
};
