/** Explicit source fields for the existing X product contract; no inferred currency, condition, stock or variants. */
export const xImportProduct = (extra = {}) => ({
  retailer_id: '001',
  name: 'عرض جديد',
  price: '000012.340000',
  currency: 'SAR',
  image_url: 'https://shop.example.test/i/001.jpg',
  url: 'https://shop.example.test/p/001',
  availability: 'in stock',
  condition: 'new',
  brand: 'Original brand',
  description: 'Original plain text description',
  ...extra,
});
export const xImportInput = (extra = {}) => ({
  gateway: 'x_ads_native_action',
  connection_id: 'x',
  account_id: 'acct1',
  catalog_id: '9001',
  allow_upsert: true,
  products: [xImportProduct()],
  ...extra,
});
