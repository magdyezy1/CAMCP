import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/** A synthetic Meta catalog world for the commerce parity tests (COM-02): hundredths, formatted reads, amount filters. */
export const actor = {tenantId: 'catalog-sale-price', userId: 'operator', role: 'operator'},
  owner = {...actor, role: 'admin'};
export const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r).slice(0, 1500));
  return r.data;
};
export const start = '2026-11-01T00:00:00+03:00',
  end = '2026-11-08T00:00:00+03:00';

/** A Meta catalog that keeps prices in hundredths, shows them formatted and filters price_amount/sale_price_amount. */
export function metaWorld(existing = []) {
  const store = new Store(':memory:', Buffer.alloc(32, 61).toString('base64'));
  store.putConnection(
    owner,
    {
      id: 'm',
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_management', 'catalog_management'],
    },
    {accessToken: 'synthetic'},
  );
  const products = new Map(existing.map(p => [p.retailer_id, {id: '9' + p.retailer_id.replace(/\D/g, ''), ...p}]));
  const shown = p => ({
    ...p,
    price: (p.price / 100).toFixed(2) + ' ' + p.currency,
    ...(p.sale_price !== undefined ? {sale_price: (p.sale_price / 100).toFixed(2) + ' ' + p.currency} : {}),
  });
  const calls = [];
  let writes = 0;
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url)),
        query = Object.fromEntries(u.searchParams);
      calls.push({method: init.method, path: u.pathname, query});
      if (init.method === 'GET') {
        if (u.pathname === '/v26.0/act_123') return Response.json({id: 'act_123', business: {id: '900'}});
        if (u.pathname === '/v26.0/555')
          return Response.json({id: '555', name: 'Shop', vertical: 'commerce', business: {id: '900'}});
        if (u.pathname === '/v26.0/555/products') {
          const f = JSON.parse(query.filter),
            rules = f.and ?? [f],
            p = products.get(rules.find(r => r.retailer_id)?.retailer_id.eq);
          const within = (field, value) => {
            const lo = rules.find(r => r[field]?.gte !== undefined)?.[field].gte,
              hi = rules.find(r => r[field]?.lte !== undefined)?.[field].lte;
            return lo === undefined || (value >= lo && value <= hi);
          };
          const hit = p && within('price_amount', p.price) && within('sale_price_amount', p.sale_price);
          return Response.json({data: hit ? [query.fields === 'id' ? {id: p.id} : shown(p)] : []});
        }
        throw Error('Unexpected read ' + u.pathname);
      }
      writes++;
      const b = {};
      for (const [k, v] of new URLSearchParams(String(init.body ?? '')))
        b[k] = ['price', 'sale_price'].includes(k) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
      delete b.allow_upsert;
      const before = products.get(b.retailer_id),
        id = before?.id ?? String(8000 + writes);
      products.set(b.retailer_id, {...(before ?? {}), ...b, id});
      return Response.json({id});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    100,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {store, service, products, calls, writes: () => writes};
}
export const metaInput = (products, extra = {}) => ({
  gateway: 'meta_native_action',
  account_id: '123',
  connection_id: 'm',
  catalog_id: '555',
  allow_upsert: true,
  products,
  ...extra,
});
export const metaShoe = (extra = {}) => ({
  retailer_id: 'SKU-1',
  name: 'Trail shoe',
  price: '499',
  currency: 'SAR',
  image_url: 'https://cdn.example.test/shoe.jpg',
  ...extra,
});
/** Runs every step of a saved plan through its own native review, execution and read-back. */
export async function runPlan(service, as, id) {
  const campaign = args => service.call('amcp_campaign', args, as);
  let next = ok(await campaign({action: 'prepare_next', id}));
  while (next.review) {
    const done = ok(
      await campaign({
        action: 'execute_next',
        id,
        review_id: next.review.review_id,
        idempotency_key: next.review.idempotency_key,
        confirmed: true,
      }),
    );
    if (done.state === 'complete') break;
    next = ok(await campaign({action: 'prepare_next', id}));
  }
  return ok(await campaign({action: 'get', id, detail: 'full'}));
}
