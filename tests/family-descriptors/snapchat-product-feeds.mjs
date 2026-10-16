// snapchat_product_feeds: PUT /v1/catalogs/{catalog_id}/product_feeds (Snapchat Marketing API v1, "Dynamic Product
// Ads", Update a Product Feed; a catalog holds one feed). The update sends the whole feed, schedule included, so the
// decisive field is the feed's `schedule` in "Get Product Feeds of a Catalog", whose `url` is where Snapchat fetches the
// products: a fetch address changed in Snapchat after the review would be overwritten by the reviewed one.
import {adAccount, failed, ok, page, rows} from './_snapchat.mjs';

const schedule = url => ({url, timezone: 'Asia/Riyadh', interval_type: 'DAILY', hour: 3, minute: 0});

export default {
  family: 'snapchat_product_feeds',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  request: {
    action: 'snapchat_catalogs_catalog_id_product_feeds_update',
    params: {catalog_id: 'cat-1'},
    payload: {
      product_feeds: [
        {
          id: 'pf-1',
          catalog_id: 'cat-1',
          name: 'Store feed',
          default_currency: 'SAR',
          schedule: {...schedule('https://shop.example.test/feed.csv'), hour: 5},
        },
      ],
    },
  },
  seed: () => ({
    catalogs: [{id: 'cat-1', organization_id: 'org-1', name: 'Store', vertical: 'COMMERCE'}],
    feeds: {
      'pf-1': {
        id: 'pf-1',
        catalog_id: 'cat-1',
        name: 'Store feed',
        default_currency: 'SAR',
        status: 'ACTIVE',
        feed_type: 'PRIMARY',
        schedule: schedule('https://shop.example.test/feed.csv'),
      },
    },
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1');
    if (method === 'GET' && path === '/v1/organizations/org-1/catalogs')
      return page('catalogs', 'catalog', state.catalogs, mode.paginate, url);
    if (method === 'GET' && path === '/v1/catalogs/cat-1/product_feeds')
      return page('product_feeds', 'product_feed', Object.values(state.feeds), false, url);
    const one = /^\/v1\/product_feeds\/([\w-]+)$/.exec(path)?.[1];
    if (method === 'GET' && one && state.feeds[one])
      return ok({product_feeds: rows('product_feed', [state.feeds[one]])});
    if (method === 'PUT' && path === '/v1/catalogs/cat-1/product_feeds') {
      if (mode.partial) return failed('product_feeds', body.product_feeds);
      const f = body.product_feeds[0];
      Object.assign(state.feeds[f.id], f);
      return ok({product_feeds: rows('product_feed', [state.feeds[f.id]])});
    }
  },
  decisive: {
    change: state => (state.feeds['pf-1'].schedule.url = 'https://cdn.example.test/products.csv'),
    field: /schedule/,
  },
};
