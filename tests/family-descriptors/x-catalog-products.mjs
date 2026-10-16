// x_catalog_products: PUT /12/product_catalogs/{id}/products (X Ads API v12, Catalog Management) with a known product id,
// which X answers by updating "the corresponding existing product". The update replaces the product's attributes, so the
// decisive field is the existing product's `price`: a price changed in X after the review would be silently
// overwritten.
import {catalogProduct, catalogRead, catalogSeed, credentials, account, missing, reply} from './_x.mjs';

export default {
  family: 'x_catalog_products',
  risk: 'settings',
  gateway: 'x_ads_native_action',
  account,
  credentials,
  request: {
    action: 'x_product_catalogs_product_catalog_id_products_put',
    params: {product_catalog_id: '9001'},
    payload: {
      products: [
        {
          id: 'sku-2',
          title: 'Product 2 renamed',
          description: 'Synthetic product 2',
          availability: 'in stock',
          condition: 'new',
          price: '25.00 SAR',
          link: 'https://shop.example.test/p/2',
          image_link: 'https://shop.example.test/i/2.jpg',
          brand: 'Brand',
          inventory: 5,
        },
      ],
    },
  },
  seed: catalogSeed,
  isWrite: ({method}) => method !== 'GET',
  provider(request) {
    const {method, path, body, state, mode} = request;
    if (method === 'GET') return catalogRead(request, 'products') ?? missing();
    if (method === 'PUT' && path === '/12/product_catalogs/9001/products') {
      const out = body.products.map(p => {
        const i = state.products.findIndex(x => x.id === p.id),
          row = {...(i >= 0 ? state.products[i] : catalogProduct(0, {product_key: '6000001'})), ...p};
        // A partial answer: X reports the product as an ERROR and keeps it unchanged.
        if (!mode.partial) i >= 0 ? (state.products[i] = row) : state.products.push(row);
        return {
          warnings: [],
          errors: mode.partial ? [{message: 'Invalid price'}] : [],
          product_key: row.product_key,
          id: p.id,
          status: mode.partial ? 'ERROR' : i >= 0 ? 'UPDATE_SUCCESS' : 'CREATE_SUCCESS',
        };
      });
      return reply({products_response: out});
    }
  },
  decisive: {change: state => (state.products[1].price = '22.00 SAR'), field: /price/},
};
