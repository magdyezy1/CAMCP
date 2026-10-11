// x_scheduled_feeds: PUT /12/product_catalogs/{id}/scheduled_feeds/{feed} (X Ads API v12, Catalog Management) moving the
// catalog's feed to another file. X fetches that address on the feed's schedule and adds or updates the products it
// lists, so the decisive field is the feed's current `feed_url`: an address changed in X after the review would be
// silently overwritten.
import {account, catalogRead, catalogSeed, credentials, missing, reply} from './_x.mjs';

export default {
  family: 'x_scheduled_feeds',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_product_catalogs_product_catalog_id_scheduled_feeds_scheduled_feed_id_put',
    params: {product_catalog_id: '9001', scheduled_feed_id: '8001'},
    payload: {feed_url: 'https://shop.example.test/feed-2027.csv'},
  },
  seed: catalogSeed,
  isWrite: ({method}) => method !== 'GET',
  provider(request) {
    const {method, path, body, state, mode} = request;
    if (method === 'GET') return catalogRead(request, 'feeds') ?? missing();
    if (method === 'PUT' && path === '/12/product_catalogs/9001/scheduled_feeds/8001') {
      // A partial answer: X answers with a feed of no recognizable identity.
      if (mode.partial) return reply({...state.feeds[0], id: 'pending'});
      Object.assign(state.feeds[0], body);
      return reply(state.feeds[0]);
    }
  },
  decisive: {
    change: state => (state.feeds[0].feed_url = 'https://shop.example.test/feed-new.csv'),
    field: /feed_url/,
  },
};
