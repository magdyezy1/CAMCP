// google_business_lodging: PATCH https://mybusinesslodging.googleapis.com/v1/locations/{id}/lodging (Business Profile
// Lodging API, Lodging) through the delegated gmb_lodging_ops operation. The update overwrites the masked fact, here
// `property.roomsCount` (the room count Google shows for the hotel); that fact's current value is the decisive field.
const location = 'locations/456',
  lodging = location + '/lodging',
  lodgingOrigin = 'https://mybusinesslodging.googleapis.com',
  information = 'https://mybusinessbusinessinformation.googleapis.com';

export default {
  family: 'google_business_lodging',
  risk: 'settings',
  gateway: 'google_business_native_action',
  account: location,
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_lodging_ops',
    arguments: {
      action: 'UPDATE_LODGING',
      location_id: '456',
      payload: {name: lodging, metadata: {updateTime: '2026-09-28T08:00:00Z'}, property: {roomsCount: 124}},
      query: {updateMask: 'property.roomsCount,metadata.updateTime'},
    },
  },
  seed: () => ({
    location: {
      name: location,
      title: 'Harbour Hotel',
      openInfo: {status: 'OPEN'},
      metadata: {hasVoiceOfMerchant: true},
    },
    lodging: {
      name: lodging,
      metadata: {updateTime: '2026-09-01T00:00:00Z'},
      connectivity: {freeWifi: false, wifiAvailable: true},
      property: {roomsCount: 120, builtYear: 1998},
    },
  }),
  unpaginated: 'GET /v1/locations/{id} and /v1/locations/{id}/lodging each return one resource; neither API pages it',
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && url.origin === information && path === '/v1/' + location)
      return {json: structuredClone(state.location)};
    if (url.origin !== lodgingOrigin || path !== '/v1/' + lodging) return;
    if (method === 'GET') return {json: structuredClone(state.lodging)};
    if (method === 'PATCH') {
      // A partial answer: Google answers without naming the lodging it changed.
      if (mode.partial) return {json: {}};
      for (const mask of url.searchParams.get('updateMask').split(',')) {
        const [group, fact] = mask.split('.');
        state.lodging[group] = {...state.lodging[group], [fact]: body[group][fact]};
      }
      return {json: structuredClone(state.lodging)};
    }
  },
  decisive: {change: state => (state.lodging.property.roomsCount = 118), field: /roomsCount/},
};
