export const catalogComparisonInput = {
  action: 'catalog_compare',
  gateway: 'meta_native_action',
  account_id: '123',
  connection_id: 'catalog-login',
  catalog_id: '555',
  name: 'Synthetic catalog changes',
  allow_upsert: true,
  products: [
    {retailer_id: '001', name: 'New shoe', price: '12.34', currency: 'SAR', image_url: 'https://example.test/new.png'},
    {
      retailer_id: '002',
      name: 'Updated shoe',
      price: '20.00',
      currency: 'SAR',
      image_url: 'https://example.test/update.png',
    },
    {
      retailer_id: '003',
      name: 'Matching shoe',
      price: '0',
      currency: 'SAR',
      image_url: 'https://example.test/match.png',
    },
    {
      retailer_id: '004',
      name: 'Unknown image',
      price: '9.99',
      currency: 'SAR',
      image_url: 'https://example.test/unknown.png',
    },
  ],
};

export function catalogComparisonData(input = catalogComparisonInput) {
  const products = new Map(
    input.products.slice(1).map((p, i) => [
      p.retailer_id,
      {
        ...p,
        id: String(9007199254740993n + BigInt(i)),
        amount: Number(BigInt(p.price.split('.')[0]) * 100n + BigInt((p.price.split('.')[1] ?? '').padEnd(2, '0'))),
        PRIVATE_UNUSED: 'PRIVATE-NATIVE-MARKER',
      },
    ]),
  );
  if (products.has('002')) Object.assign(products.get('002'), {name: 'Previous shoe', amount: 1800});
  if (products.has('004')) delete products.get('004').image_url;
  const response = raw => {
    const u = new URL(String(raw));
    if (u.pathname === '/v26.0/act_123')
      return {id: 'act_123', business: {id: '900'}, PRIVATE_UNUSED: 'PRIVATE-NATIVE-MARKER'};
    if (u.pathname === '/v26.0/555')
      return {
        id: '555',
        name: 'Synthetic shop',
        vertical: 'commerce',
        business: {id: '900'},
        PRIVATE_UNUSED: 'PRIVATE-NATIVE-MARKER',
      };
    if (u.pathname !== '/v26.0/555/products') throw Error('Unqualified synthetic route: ' + u.pathname);
    const filter = JSON.parse(u.searchParams.get('filter')),
      rules = filter.and ?? [filter],
      retailer = rules.find(r => r.retailer_id)?.retailer_id.eq,
      product = products.get(retailer),
      amounts = rules.filter(r => r.price_amount);
    if (
      !product ||
      amounts.some(
        r =>
          (r.price_amount.gte ?? product.amount) > product.amount ||
          (r.price_amount.lte ?? product.amount) < product.amount,
      )
    )
      return {data: []};
    if (u.searchParams.get('fields') === 'id') return {data: [{id: product.id}]};
    const {amount, ...row} = product;
    // Deliberately not parseable as a decimal. Equality must come from the qualified native filter.
    return {data: [{...row, price: 'Native formatted price ' + amount}]};
  };
  return {products, response};
}
