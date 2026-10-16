// google_business_location_attributes: PATCH
// https://mybusinessbusinessinformation.googleapis.com/v1/locations/{id}/attributes (Business Profile Business
// Information API, Attributes) through the delegated gmb_location_ops operation. The update overwrites the masked
// attribute, here `attributes/url_menu` (the menu link Google shows); that attribute's current value is the decisive
// field.
const location = 'locations/456',
  information = 'https://mybusinessbusinessinformation.googleapis.com',
  metadata = [
    {parent: 'attributes/has_wifi_free', valueType: 'BOOL', displayName: 'Free Wi-Fi'},
    {parent: 'attributes/url_menu', valueType: 'URL', repeatable: false, displayName: 'Menu link'},
  ];

export default {
  family: 'google_business_location_attributes',
  risk: 'settings',
  gateway: 'google_business_native_action',
  account: location,
  connection: {scopes: ['https://www.googleapis.com/auth/business.manage']},
  arguments: {
    operation: 'gmb_location_ops',
    arguments: {
      action: 'UPDATE_LOCATION_ATTRIBUTES',
      location_id: '456',
      payload: {
        name: location + '/attributes',
        attributes: [{name: 'attributes/url_menu', uriValues: [{uri: 'https://example.com/menu-new'}]}],
      },
      query: {attributeMask: 'attributes/url_menu'},
    },
  },
  seed: () => ({
    location: {name: location, openInfo: {status: 'OPEN'}, metadata: {hasVoiceOfMerchant: true}},
    attributes: [
      {name: 'attributes/has_wifi_free', valueType: 'BOOL', values: [false]},
      {name: 'attributes/url_menu', valueType: 'URL', uriValues: [{uri: 'https://example.com/menu'}]},
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (url.origin !== information) return;
    const shown = () => ({json: {name: location + '/attributes', attributes: structuredClone(state.attributes)}});
    if (method === 'GET' && path === '/v1/attributes') {
      // The catalog of attributes available to the location; another page names the same token each time.
      const page = mode.paginate && url.searchParams.has('pageToken') ? [] : metadata;
      return {
        json: {
          ...(page.length ? {attributeMetadata: structuredClone(page)} : {}),
          ...(mode.paginate ? {nextPageToken: 'synthetic-next-page'} : {}),
        },
      };
    }
    if (method === 'GET' && path === '/v1/' + location + '/attributes') return shown();
    if (method === 'GET' && path === '/v1/' + location) return {json: structuredClone(state.location)};
    if (method === 'PATCH' && path === '/v1/' + location + '/attributes') {
      // A failed answer: Business Profile reports an error in a success envelope.
      if (mode.partial) return {json: {error: {code: 3, message: 'Synthetic invalid attribute value'}}};
      for (const name of url.searchParams.get('attributeMask').split(',')) {
        const sent = body.attributes.find(a => a.name === name),
          at = state.attributes.findIndex(a => a.name === name),
          type = metadata.find(m => m.parent === name).valueType;
        if (sent)
          state.attributes.splice(at < 0 ? state.attributes.length : at, at < 0 ? 0 : 1, {...sent, valueType: type});
        else if (at >= 0) state.attributes.splice(at, 1);
      }
      return shown();
    }
  },
  decisive: {
    change: state => (state.attributes[1].uriValues = [{uri: 'https://example.com/menu-2'}]),
    field: /url_menu/,
  },
};
