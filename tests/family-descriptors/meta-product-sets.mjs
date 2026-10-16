// meta_product_sets: POST /{product_set_id} (Meta Marketing API v26.0, Product Set, Updating) replacing a set's filter.
// The filter decides which products the ad sets that promote the set show ("If the filter rules you set result in an
// empty product set, ads tied to this product set will not deliver"), so the decisive field is the set's current
// `filter`: a rule changed in Meta after the review would be silently overwritten.
import {decode, paged, unsupported, v} from './_meta.mjs';

const set = (id, name, filter) => ({
  id,
  name,
  filter: JSON.stringify(filter),
  retailer_id: null,
  product_catalog: {id: '555'},
});

export default {
  family: 'meta_product_sets',
  risk: 'activation',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management', 'catalog_management']},
  request: {
    action: 'meta_product_set_id_update',
    params: {product_set_id: '6001'},
    payload: {filter: {brand: {is_any: ['Trail', 'Summit']}}},
  },
  seed: () => ({
    catalog: {id: '555', name: 'Riyadh shop', vertical: 'commerce', business: {id: '900'}},
    sets: [set('6001', 'Shoes', {brand: {is_any: ['Trail']}}), set('6002', 'Bags', {brand: {is_any: ['Carry']}})],
    adsets: [
      {id: '200', name: 'Shoes DPA', status: 'ACTIVE', promoted_object: {product_set_id: '6001'}},
      {id: '201', name: 'Prospecting', status: 'ACTIVE', promoted_object: {page_id: '500'}},
    ],
    creatives: [{id: '801', name: 'Shoes carousel', status: 'ACTIVE', product_set_id: '6001'}],
  }),
  isWrite: ({method}) => method !== 'GET',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: {id: 'act_123', business: {id: '900'}}};
      if (path === v + '/6001') return {json: structuredClone(state.sets[0])};
      if (path === v + '/555') return {json: structuredClone(state.catalog)};
      // The catalog's sets, read to their end in cursor pages. Another page: every page names one more.
      if (path === v + '/555/product_sets') return paged(state.sets, url, mode.paginate);
      // Meta's own reading of the new filter: it selects at least one product.
      if (path === v + '/555/products') return {json: {data: [{id: '91'}]}};
      if (path === v + '/act_123/adsets') return paged(state.adsets, url, false);
      if (path === v + '/act_123/adcreatives') return paged(state.creatives, url, false);
      return unsupported();
    }
    if (method === 'POST' && path === v + '/6001') {
      // A partial answer: Meta reports the update as not applied.
      if (mode.partial) return {json: {success: false}};
      state.sets[0].filter = JSON.stringify(decode(body).filter);
      return {json: {success: true}};
    }
    return unsupported();
  },
  decisive: {
    change: state => (state.sets[0].filter = JSON.stringify({brand: {is_any: ['Trail', 'Peak']}})),
    field: /filter/,
  },
};
