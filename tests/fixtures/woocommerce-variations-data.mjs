import {wooSourceFixture, wooSourceProduct} from './woocommerce-source-data.mjs';

export const wooVariationInput = (requirements = {}) => ({
  action: 'catalog_source',
  gateway: 'commerce_native_action',
  connection_id: 'woo-login',
  account_id: 'store-1',
  requirements: {
    source_kind: 'variations',
    parent_product_id: '101',
    variation_ids: ['102'],
    price_field: 'price',
    ...requirements,
  },
});
export const wooVariationParent = (extra = {}) =>
  wooSourceProduct({
    id: 101,
    sku: 'GROUP-001',
    name: 'Original <shoe>',
    type: 'variable',
    variations: [102, 103],
    ...extra,
  });
export const wooVariation = (extra = {}) => ({
  id: 102,
  sku: 'VAR-001',
  status: 'publish',
  price: '0012.34',
  regular_price: '20.00',
  sale_price: '12.34',
  stock_status: 'instock',
  tax_status: 'taxable',
  virtual: false,
  downloadable: false,
  image: {id: 11, src: 'https://shop.example.test/red-shoe.jpg', private_note: 'UNUSED-PRIVATE-WOO'},
  attributes: [
    {id: 1, name: 'Color', option: 'Red'},
    {id: 2, name: 'Size', option: 'Small'},
  ],
  permalink: 'https://shop.example.test/product/shoe?attribute_color=red',
  date_modified_gmt: '2026-10-04T10:00:00',
  meta_data: [{key: 'private', value: 'UNUSED-PRIVATE-WOO'}],
  ...extra,
});
export function wooVariationsFixture(options = {}) {
  const f = wooSourceFixture(options),
    data = {parent: wooVariationParent(), items: [wooVariation()]};
  const response = url =>
    url.pathname.includes('/settings/')
      ? Response.json({id: 'woocommerce_currency', value: 'SAR', private: 'UNUSED-PRIVATE-WOO'})
      : url.pathname.endsWith('/variations')
        ? Response.json(data.items, {headers: {'x-wp-total': String(data.items.length), 'x-wp-totalpages': '1'}})
        : Response.json(data.parent);
  f.respond(response);
  return {...f, data, response};
}
