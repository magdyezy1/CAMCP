// Offline qualification of accepted product fields against Meta's versioned public SDK. No credentials/network.
import {argumentDirectory, dictionary, metaSdkTag, metaVersion, pin, readSdk, sdkMethod} from './meta-sdk.mjs';
const {sources, text} = readSdk(argumentDirectory('--source-dir', 'ProductItem and ProductCatalog SDK files'), [
  'productitem',
  'productcatalog',
]);
const create = sdkMethod(text.productcatalog, 'create_product'),
  get = sdkMethod(text.productcatalog, 'get_products');
if (
  !create?.includes("method='POST'") ||
  !get?.includes("method='GET'") ||
  ![create, get].every(method => method.includes("endpoint='/products'"))
)
  throw Error('Pinned catalog product routes changed.');
const selected = [
  'retailer_id',
  'name',
  'description',
  'short_description',
  'brand',
  'category',
  'fb_product_category',
  'product_type',
  'color',
  'size',
  'material',
  'pattern',
  'gtin',
  'manufacturer_part_number',
  'retailer_product_group_id',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
  'availability',
  'condition',
  'age_group',
  'gender',
  'visibility',
  'url',
  'image_url',
  'mobile_link',
  'sale_price_start_date',
  'sale_price_end_date',
  'additional_image_urls',
  'inventory',
  'currency',
  'price',
  'sale_price',
];
const fields = dictionary(text.productitem, '_field_types'),
  params = dictionary(create, 'param_types');
if (selected.some(field => !fields[field] || !params[field]))
  throw Error('An accepted product field lost its read/write model.');
pin(
  'tests/fixtures/meta-catalog-product-fields-sdk-v26.json',
  {
    api_version: metaVersion,
    sdk_tag: metaSdkTag,
    checked_at: '2026-10-04',
    sources,
    routes: {read: {method: 'GET', edge: '/products'}, write: {method: 'POST', edge: '/products'}},
    fields: Object.fromEntries(selected.map(field => [field, {read: fields[field], write: params[field]}])),
    intent_fields: {allow_upsert: params.allow_upsert},
    meaning:
      'Selected official generated field types and catalog edges only. Native normalization, permissions, product-group eligibility and live acceptance remain separate. Prices require the existing receipt-bound native numeric filters.',
  },
  'Meta catalog product field evidence',
);
console.log('Qualified 35 observable accepted fields and one explicit upsert intent against SDK ' + metaSdkTag + '.');
