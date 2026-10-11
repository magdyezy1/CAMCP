// x_product_sets: PUT /12/product_catalogs/{id}/product_sets/{set} (X Ads API v12, Catalog Management) replacing the
// products of a manual set: product_keys, when sent, become its products. The decisive field is the set's current
// `product_ids`: products added to the set in X after the review would be silently dropped.
import {account, catalogRead, catalogSeed, credentials, missing, reply} from './_x.mjs';

export default {
  family: 'x_product_sets',
  risk: 'activation',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_product_catalogs_product_catalog_id_product_sets_product_set_id_put',
    params: {product_catalog_id: '9001', product_set_id: '7001'},
    payload: {name: 'Picks of the week', product_keys: ['5000001', '5000002']},
  },
  seed: catalogSeed,
  isWrite: ({method}) => method !== 'GET',
  provider(request) {
    const {method, path, body, state, mode} = request;
    if (method === 'GET') return catalogRead(request, 'sets') ?? missing();
    if (method === 'PUT' && path === '/12/product_catalogs/9001/product_sets/7001') {
      const set = state.sets[0],
        after = {
          ...set,
          ...(body.name !== undefined ? {name: body.name} : {}),
          ...(body.product_keys
            ? {product_ids: body.product_keys.map(k => state.products.find(x => x.product_key === k)?.id)}
            : {}),
        };
      // A partial answer: X answers with the set under its old name, unchanged.
      if (mode.partial) return reply(set);
      state.sets[0] = after;
      return reply(after);
    }
  },
  decisive: {change: state => state.sets[0].product_ids.push('sku-3'), field: /product_ids/},
};
