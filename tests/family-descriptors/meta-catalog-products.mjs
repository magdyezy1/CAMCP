// meta_catalog_products: POST /{product_catalog_id}/products with allow_upsert (Meta Marketing API v26.0, Product
// Catalog Products), which "allows the request to update the item" when the retailer_id exists. The upsert replaces
// the product's attributes, so the decisive field is the existing product's `price`: a price changed in Meta after the
// review would be silently overwritten.
import {decode, unsupported, v} from './_meta.mjs';

const shown = p => ({
  ...p,
  price: (p.price / 100).toFixed(2) + ' ' + p.currency,
  ...(p.sale_price !== undefined ? {sale_price: (p.sale_price / 100).toFixed(2) + ' ' + p.currency} : {}),
});

export default {
  family: 'meta_catalog_products',
  risk: 'settings',
  gateway: 'meta_native_action',
  account: '123',
  connection: {scopes: ['ads_management', 'catalog_management']},
  request: {
    action: 'meta_product_catalog_id_products_create',
    params: {product_catalog_id: '555'},
    payload: {
      retailer_id: 'SKU-1',
      name: 'Trail shoe',
      price: 45900,
      currency: 'SAR',
      image_url: 'https://cdn.example.test/shoe.jpg',
      url: 'https://shop.example.test/shoe',
      availability: 'in stock',
      allow_upsert: true,
    },
  },
  seed: () => ({
    catalog: {id: '555', name: 'Riyadh shop', vertical: 'commerce', product_count: 40, business: {id: '900'}},
    // Prices in hundredths, as Meta keeps them; reads show them formatted.
    products: {
      'SKU-1': {
        id: '91',
        retailer_id: 'SKU-1',
        name: 'Trail shoe',
        price: 49900,
        currency: 'SAR',
        image_url: 'https://cdn.example.test/shoe.jpg',
        url: 'https://shop.example.test/shoe',
        availability: 'in stock',
      },
    },
  }),
  isWrite: ({method}) => method === 'POST',
  provider({method, path, url, body, state, mode}) {
    if (method === 'GET') {
      if (path === v + '/act_123') return {json: {id: 'act_123', business: {id: '900'}}};
      if (path === v + '/555') return {json: structuredClone(state.catalog)};
      if (path !== v + '/555/products') return unsupported();
      const f = JSON.parse(url.searchParams.get('filter')),
        rules = f.and ?? [f],
        p = state.products[rules.find(r => r.retailer_id)?.retailer_id.eq];
      const within = (field, value) => {
        const lo = rules.find(r => r[field]?.gte !== undefined)?.[field].gte,
          hi = rules.find(r => r[field]?.lte !== undefined)?.[field].lte;
        return lo === undefined || (value >= lo && value <= hi);
      };
      const hit = p && within('price_amount', p.price) && within('sale_price_amount', p.sale_price);
      return {
        json: {
          data: hit ? [url.searchParams.get('fields') === 'id' ? {id: p.id} : shown(p)] : [],
          // Another page: Meta names paging.next beside the products it returned.
          ...(mode.paginate ? {paging: {cursors: {after: 'x'}, next: 'https://graph.facebook.com' + path}} : {}),
        },
      };
    }
    if (method === 'POST' && path === v + '/555/products') {
      // A partial answer: Meta answers without the product's ID.
      if (mode.partial) return {json: {success: true}};
      const {allow_upsert, ...b} = decode(body),
        before = state.products[b.retailer_id];
      state.products[b.retailer_id] = {...before, ...b, id: before?.id ?? '92'};
      return {json: {id: state.products[b.retailer_id].id}};
    }
    return unsupported();
  },
  decisive: {change: state => (state.products['SKU-1'].price = 47900), field: /price/},
};
