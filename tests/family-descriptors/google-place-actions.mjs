// google_place_actions: PATCH https://mybusinessplaceactions.googleapis.com/v1/{location}/placeActionLinks/{id}
// (Business Profile Place Actions API, PlaceActionLink) through the delegated gmb_engagement_ops operation. The update
// overwrites the link's `uri`, where the location's "Book" button sends customers; the link's current `uri` is the
// decisive field.
const location = 'locations/456',
  link = location + '/placeActionLinks/100',
  actions = 'https://mybusinessplaceactions.googleapis.com',
  information = 'https://mybusinessbusinessinformation.googleapis.com';

export default {
  family: 'google_place_actions',
  risk: 'settings',
  gateway: 'google_business_native_action',
  account: location,
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_engagement_ops',
    arguments: {
      action: 'PATCH_PLACE_ACTION_LINK',
      location_id: '456',
      place_action_link_id: '100',
      payload: {uri: 'https://example.com/book-new'},
      query: {updateMask: 'uri'},
    },
  },
  seed: () => ({
    business: {
      name: location,
      title: 'Synthetic Clinic',
      storeCode: 'clinic-a',
      categories: {primaryCategory: {name: 'gcid:medical_clinic', displayName: 'Clinic'}, additionalCategories: []},
      websiteUri: 'https://example.com/',
      openInfo: {status: 'OPEN'},
    },
    links: [
      {
        name: link,
        providerType: 'MERCHANT',
        isEditable: true,
        uri: 'https://example.com/book',
        placeActionType: 'APPOINTMENT',
        isPreferred: true,
      },
    ],
    types: [{placeActionType: 'APPOINTMENT', displayName: 'Book appointment'}],
  }),
  paginatedCodes: ['PLACE_ACTION_STATE_UNVERIFIED'],
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET') {
      if (url.origin === information && path === '/v1/' + location) return {json: state.business};
      if (url.origin !== actions) return;
      const metadata = path === '/v1/placeActionTypeMetadata',
        key = metadata ? 'placeActionTypeMetadata' : 'placeActionLinks';
      if (!metadata && path !== '/v1/' + location + '/placeActionLinks') return;
      // Another page: the same token on every page, the shape a family must refuse.
      const values = mode.paginate && url.searchParams.has('pageToken') ? [] : metadata ? state.types : state.links;
      return {
        json: {
          ...(values.length ? {[key]: structuredClone(values)} : {}),
          ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
        },
      };
    }
    if (url.origin === actions && method === 'PATCH' && path === '/v1/' + link) {
      // A partial answer: Google answers without naming the link it changed.
      if (mode.partial) return {json: {}};
      const row = state.links.find(l => l.name === link);
      Object.assign(row, body);
      return {json: structuredClone(row)};
    }
  },
  decisive: {change: state => (state.links[0].uri = 'https://example.com/changed'), field: /uri/},
};
