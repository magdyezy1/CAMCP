// x_product_catalogs: DELETE /12/product_catalogs/{id} (X Ads API v12, Catalog Management), "a permanent deletion". X
// does not say what deleting a catalog does to its products, product sets and feeds or to the ads that use them, so the
// decisive field is what the catalog holds: a product set created in X after the review makes the family's own
// prerequisite refuse the deletion as the state is read again at execute.
import {account, catalogRead, catalogSeed, credentials, missing, reply} from './_x.mjs';

export default {
  family: 'x_product_catalogs',
  risk: 'destructive',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {action: 'x_product_catalogs_product_catalog_id_delete', params: {product_catalog_id: '9001'}},
  // An empty catalog: no product, product set or scheduled feed.
  seed: () => ({...catalogSeed(), products: [], sets: [], feeds: []}),
  isWrite: ({method}) => method !== 'GET',
  provider(request) {
    const {method, path, state, mode} = request;
    if (method === 'GET') return catalogRead(request, 'catalogs') ?? missing();
    if (method === 'DELETE' && path === '/12/product_catalogs/9001' && state.catalogs[9001]) {
      const c = state.catalogs[9001];
      // A partial answer: X answers with another catalog's identity.
      if (mode.partial) return reply({id: '9002', name: 'Other'});
      delete state.catalogs[9001];
      return reply(c);
    }
  },
  decisive: {
    change: state =>
      state.sets.push({
        id: '7003',
        name: 'New set',
        description: null,
        type: 'MANUAL',
        filters: [],
        product_ids: [],
        processing_status: 'DONE',
      }),
    field: /product_sets/,
    refusal: {code: 'CATALOG_NOT_EMPTY', message: /Catalog 9001 still has 1 product set\(s\)/},
  },
};
