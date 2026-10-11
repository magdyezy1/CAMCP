// snapchat_product_sets: PUT /v1/catalogs/{catalog_id}/product_sets (Snapchat Marketing API v1, "Dynamic Product Ads",
// Update Product Sets from {product_sets: [{id, name, filter}]}). A set's `filter` selects the products the ad squads
// and dynamic creatives that use it show, and the update replaces it, so it is the decisive field ("Get Product Sets of
// a Catalog"): a filter changed in Snapchat after the review would be silently replaced.
import {adAccount, failed, ok, page, rows} from './_snapchat.mjs';

export default {
  family: 'snapchat_product_sets',
  risk: 'settings',
  gateway: 'snapchat_native_action',
  account: 'acct1',
  request: {
    action: 'snapchat_catalogs_catalog_id_product_sets_update',
    params: {catalog_id: 'cat-1'},
    payload: {
      product_sets: [{id: 'ps-1', name: 'In stock shoes', filter: {AVAILABILITY: {EQ: 'IN_STOCK'}}}],
    },
  },
  seed: () => ({
    catalogs: [
      {id: 'cat-1', organization_id: 'org-1', name: 'Store', vertical: 'COMMERCE', default_product_set_id: 'ps-all'},
    ],
    sets: {
      'ps-all': {id: 'ps-all', catalog_id: 'cat-1', name: 'All products', filter: null},
      'ps-1': {id: 'ps-1', catalog_id: 'cat-1', name: 'Shoes', filter: {BRAND: {EQ: 'Acme'}}},
    },
    squads: [
      {
        id: 'sq1',
        name: 'Shoes DPA',
        status: 'ACTIVE',
        product_properties: {catalog_id: 'cat-1', product_set_id: 'ps-1'},
      },
    ],
    creatives: [{id: 'cr1', name: 'Shoes template', dynamic_render_properties: {product_set_id: 'ps-1'}}],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, url, path, body, state, mode}) {
    if (method === 'GET' && path === '/v1/adaccounts/acct1') return adAccount('acct1');
    if (method === 'GET' && path === '/v1/organizations/org-1/catalogs')
      return page('catalogs', 'catalog', state.catalogs, false, url);
    if (method === 'GET' && path === '/v1/catalogs/cat-1/product_sets')
      return page('product_sets', 'product_set', Object.values(state.sets), mode.paginate, url);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/adsquads')
      return page('adsquads', 'adsquad', state.squads, false, url);
    if (method === 'GET' && path === '/v1/adaccounts/acct1/creatives')
      return page('creatives', 'creative', state.creatives, false, url);
    if (method === 'PUT' && path === '/v1/catalogs/cat-1/product_sets') {
      if (mode.partial) return failed('product_sets', body.product_sets);
      for (const s of body.product_sets) Object.assign(state.sets[s.id], s);
      return ok({
        product_sets: rows(
          'product_set',
          body.product_sets.map(s => state.sets[s.id]),
        ),
      });
    }
  },
  decisive: {change: state => (state.sets['ps-1'].filter = {BRAND: {EQ: 'Zenith'}}), field: /ps-1.*filter/},
};
