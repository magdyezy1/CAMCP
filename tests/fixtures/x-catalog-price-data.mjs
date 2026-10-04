/** Original native strings at AMCP's accepted syntax boundary; entirely synthetic, not provider acceptance evidence. */
export const lower = '999999999999.000001 SAR',
  upper = '999999999999.000002 SAR',
  action = 'x_product_catalogs_product_catalog_id_products_put',
  catalog = {product_catalog_id: '9001'};
export const exactCatalogProduct = (price, extra = {}) => ({
  id: 'sku-1',
  title: 'Product 1',
  description: 'Synthetic product 1',
  availability: 'in stock',
  condition: 'new',
  price,
  link: 'https://shop.example.test/p/1',
  image_link: 'https://shop.example.test/i/1.jpg',
  brand: 'Brand',
  inventory: 5,
  ...extra,
});
