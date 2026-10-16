// meta_product_catalogs: DELETE /{product_catalog_id} (Meta Marketing API v26.0, Product Catalog, Deleting). "If the
// catalog has live product sets, the deletion will be blocked by default", and the deletion takes the catalog's sets and
// feeds with it, so the decisive field is the catalog's `product_sets`: a set added in Meta after the review would be
// deleted without the owner having seen it.
import {paged, unsupported, v} from './_meta.mjs';

export default {
  family: 'meta_product_catalogs',
  risk: 'destructive',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management', 'catalog_management']},
  request: {action: 'meta_product_catalog_id_delete', params: {product_catalog_id: '555'}},
  seed: () => ({
    catalog: {
      id: '555',
      name: 'Riyadh shop',
      vertical: 'commerce',
      business: {id: '900'},
      product_count: 0,
      feed_count: 1,
    },
    sets: [{id: '6001', name: 'All products'}],
    feeds: [{id: '7001', name: 'Daily feed'}],
  }),
  isWrite: ({method}) => method === 'DELETE',
  provider({method, path, url, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: {id: 'act_123', business: {id: '900'}}};
      if (!state.catalog) return unsupported();
      if (path === v + '/555') return {json: structuredClone(state.catalog)};
      // The catalog's sets and feeds, read to their end in cursor pages. Another page: every page names one more.
      if (path === v + '/555/product_sets') return paged(state.sets, url, mode.paginate);
      if (path === v + '/555/product_feeds') return paged(state.feeds, url, mode.paginate);
      return unsupported();
    }
    if (method === 'DELETE' && path === v + '/555' && state.catalog) {
      // A partial answer: Meta reports the deletion as not done.
      if (mode.partial) return {json: {success: false}};
      state.catalog = undefined;
      return {json: {success: true}};
    }
  },
  decisive: {change: state => state.sets.push({id: '6002', name: 'Sale items'}), field: /product_sets/},
};
