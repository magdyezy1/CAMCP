// Shared synthetic X Ads API v12 answers for the conformance descriptors (not a descriptor itself).
export const account = 'acct1';
/** The synthetic OAuth 1.0a login X Ads writes are signed with. */
export const credentials = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
/** The path below /12/accounts/{account}, or undefined for another account. */
export const suffix = path =>
  path === '/12/accounts/' + account || path.startsWith('/12/accounts/' + account + '/')
    ? path.slice(('/12/accounts/' + account).length)
    : undefined;
/** A data answer; a list carries next_cursor (`cursor` names another page). */
export const reply = (data, cursor = null) => ({
  json: {
    data: structuredClone(data),
    request: {params: {account_id: account}},
    ...(Array.isArray(data) ? {next_cursor: cursor} : {}),
  },
});
export const missing = () => ({
  json: {errors: [{code: 'NOT_FOUND', message: 'Not found'}], request: {params: {}}},
  status: 404,
});
/** A provider refusal of a write. */
export const refused = (message = 'Synthetic refusal') => ({
  json: {errors: [{code: 'INVALID_PARAMETER', message}], request: {params: {}}},
  status: 400,
});

// X catalogs (Catalog Management API, early access): a catalog belongs to a user, and AMCP writes only catalogs of the
// account's FULL promotable users. User 111 owns catalog 9001 with three products, a manual and a filtered product set
// and a weekly scheduled feed.
export const catalogUser = '111';
export const catalogProduct = (i, extra = {}) => ({
  id: 'sku-' + i,
  product_key: String(5000000 + i),
  title: 'Product ' + i,
  description: 'Synthetic product ' + i,
  availability: 'in stock',
  condition: 'new',
  price: '20.00 SAR',
  link: 'https://shop.example.test/p/' + i,
  image_link: 'https://shop.example.test/i/' + i + '.jpg',
  brand: 'Brand',
  inventory: 5,
  sale_price: null,
  item_group_id: null,
  additional_image_link: null,
  ...extra,
});
export const catalogSeed = () => ({
  next: 100,
  catalogs: {9001: {id: '9001', name: 'Shop'}},
  products: [1, 2, 3].map(i => catalogProduct(i)),
  sets: [
    {
      id: '7001',
      name: 'Picks',
      description: null,
      type: 'MANUAL',
      filters: [],
      product_ids: ['sku-1'],
      processing_status: 'DONE',
    },
    {
      id: '7002',
      name: 'Premium',
      description: 'Over 100',
      type: 'FILTERED',
      filters: [{attribute: 'price', operator: 'GREATER_THAN', value: '100.00 SAR'}],
      product_ids: [],
      processing_status: 'DONE',
    },
  ],
  feeds: [
    {
      id: '8001',
      product_catalog_id: '9001',
      feed_url: 'https://shop.example.test/feed.csv',
      feed_format: 'CSV',
      frequency: 'WEEKLY',
      repeat: 'SATURDAY',
      start_time: '01:30',
      time_zone: 'Asia/Riyadh',
    },
  ],
});
/**
 * The catalog reads every X catalog family makes. `paged` names the list ('catalogs', 'products', 'sets' or 'feeds')
 * that, in paginate mode, names the same cursor on every page, a list that never completes.
 */
export function catalogRead({path, url, state, mode}, paged) {
  const more = what => (mode.paginate && paged === what ? 'again' : null);
  if (path === '/12/accounts/' + account + '/promotable_users')
    return reply([
      {id: 'pu1', user_id: catalogUser, promotable_user_type: 'FULL', deleted: false},
      {id: 'pu2', user_id: '222', promotable_user_type: 'RETWEETS_ONLY', deleted: false},
    ]);
  if (path === '/12/product_catalogs')
    return reply(
      url.searchParams.get('user_id') === catalogUser ? Object.values(state.catalogs) : [],
      more('catalogs'),
    );
  if (!state.catalogs[9001]) return;
  if (path === '/12/product_catalogs/9001/products') {
    const count = Number(url.searchParams.get('count') ?? 100);
    return reply(state.products.slice(0, count), more('products'));
  }
  if (path === '/12/product_catalogs/9001/product_sets') return reply(state.sets, more('sets'));
  if (path === '/12/product_catalogs/9001/scheduled_feeds') return reply(state.feeds, more('feeds'));
}
