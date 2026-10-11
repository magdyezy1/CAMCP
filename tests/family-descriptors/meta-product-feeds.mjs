// meta_product_feeds: POST /{product_feed_id} (Meta Marketing API v26.0, Product Feed, Updating) replacing a feed's
// fetch schedule. The schedule decides from where and when Meta fetches the catalog's products, so the decisive field is
// the feed's current `schedule`: a schedule changed in Meta after the review would be silently overwritten.
import {decode, paged, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_product_feeds',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management', 'catalog_management']},
  request: {
    action: 'meta_product_feed_id_update',
    params: {product_feed_id: '7001'},
    payload: {
      schedule: {
        interval: 'DAILY',
        hour: 3,
        minute: 0,
        timezone: 'Asia/Riyadh',
        url: 'https://shop.example.test/feed.csv',
      },
    },
  },
  seed: () => ({
    catalogs: [{id: '555'}],
    catalog: {id: '555', name: 'Riyadh shop', vertical: 'commerce', business: {id: '900'}},
    feeds: [
      {
        id: '7001',
        name: 'Daily feed',
        schedule: {
          interval: 'DAILY',
          hour: 1,
          minute: 0,
          timezone: 'Asia/Riyadh',
          url: 'https://shop.example.test/feed.csv',
        },
        deletion_enabled: false,
        feed_type: 'PRODUCTS',
        product_count: 40,
      },
    ],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: {id: 'act_123', business: {id: '900'}}};
      // The business's catalogs, which a review reads in one page. Another page: Meta names paging.next.
      if (path === v + '/900/owned_product_catalogs') return paged(state.catalogs, url, mode.paginate);
      if (path === v + '/555') return {json: structuredClone(state.catalog)};
      if (path === v + '/555/product_feeds') return paged(state.feeds, url, false);
      if (path === v + '/7001') return {json: structuredClone(state.feeds[0])};
      return unsupported();
    }
    if (method === 'POST' && path === v + '/7001') {
      // A partial answer: Meta reports the update as not applied.
      if (mode.partial) return {json: {success: false}};
      Object.assign(state.feeds[0], decode(body));
      return {json: {success: true}};
    }
    return unsupported();
  },
  decisive: {change: state => (state.feeds[0].schedule.hour = 6), field: /schedule/},
};
