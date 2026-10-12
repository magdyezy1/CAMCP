import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';

/**
 * A synthetic Snapchat organization, ad account and product catalog for the read-only catalog comparison (COM-02 D).
 * products/search answers an {filter: {ID: {IS_ANY: [...]}}} body with the matching products, in pages of `page`
 * products when set. `mode` injects the refusals the comparison must make: repeat (a repeated cursor), empty (an empty
 * page that still continues), foreign (a product that was not asked for), duplicate (one product twice), endless (more
 * pages than one comparison reads), drift (the second scan differs) and foreign_catalog (another organization's catalog).
 */
export const snapAccount = 'snap-acct-1',
  snapCatalog = 'cat-0001',
  snapConnection = '44444444-4444-4444-8444-444444444441',
  snapActor = {tenantId: 'synthetic-snap-catalog', userId: 'operator', role: 'operator'};
export function snapWorld(products, {mode = '', page = 0, tenant = snapActor.tenantId} = {}) {
  const actor = {...snapActor, tenantId: tenant},
    store = new Store(':memory:', Buffer.alloc(32, 71).toString('base64')),
    calls = [],
    catalog = new Map(products.map(p => [p.id, structuredClone(p)]));
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: snapConnection,
      tenantId: actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [snapAccount],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic Snap',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let searches = 0,
    n = 0;
  const ok = body => Response.json({request_status: 'SUCCESS', request_id: 'r' + ++n, ...body});
  const transport = new NativeTransport(
    async (raw, init = {}) => {
      const u = new URL(String(raw)),
        method = init.method ?? 'GET',
        body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({method, path: u.pathname, query: Object.fromEntries(u.searchParams), body});
      if (method === 'GET' && u.pathname === '/v1/adaccounts/' + snapAccount)
        return ok({
          adaccounts: [
            {sub_request_status: 'SUCCESS', adaccount: {id: snapAccount, name: 'Synthetic', organization_id: 'org-1'}},
          ],
        });
      if (method === 'GET' && u.pathname === '/v1/catalogs/' + snapCatalog)
        return ok({
          catalogs: [
            {
              sub_request_status: 'SUCCESS',
              catalog: {
                id: snapCatalog,
                name: 'Synthetic shop',
                organization_id: mode === 'foreign_catalog' ? 'org-2' : 'org-1',
                vertical: 'COMMERCE',
              },
            },
          ],
        });
      if (method === 'POST' && u.pathname === '/v1/catalogs/' + snapCatalog + '/products/search') {
        if (u.searchParams.get('cursor') === null) searches++;
        if (mode === 'drift' && searches === 2) catalog.get(products[0].id).title = 'Renamed between the scans';
        const ids = body.filter.ID.IS_ANY,
          rows = ids
            .filter(id => catalog.has(id))
            .map(id => ({sub_request_status: 'SUCCESS', product: catalog.get(id)}));
        if (mode === 'foreign') rows.push({sub_request_status: 'SUCCESS', product: {id: 'NOT-ASKED', title: 'Other'}});
        if (mode === 'duplicate' && rows.length) rows.push(rows[0]);
        const cursor = Number(u.searchParams.get('cursor') ?? '0'),
          size = page || rows.length || 1,
          slice = mode === 'empty' ? [] : rows.slice(cursor * size, cursor * size + size),
          more = mode === 'repeat' || mode === 'endless' || mode === 'empty' || (cursor + 1) * size < rows.length,
          next = mode === 'repeat' ? 1 : mode === 'empty' ? 1 : cursor + 1;
        return ok({
          products: slice,
          paging: more
            ? {
                next_link:
                  'https://adsapi.snapchat.com/v1/catalogs/' +
                  snapCatalog +
                  '/products/search?limit=1000&cursor=' +
                  next,
              }
            : {},
        });
      }
      throw new Error('Unexpected ' + method + ' ' + u.pathname);
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(new Registry(), store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const scope = {
    gateway: 'snapchat_native_action',
    account_id: snapAccount,
    connection_id: snapConnection,
    catalog_id: snapCatalog,
  };
  return {
    store,
    service,
    actor,
    calls,
    catalog,
    scope,
    call: args => service.call('amcp_workspace', args, actor),
    searches: () => calls.filter(c => c.method === 'POST'),
    writes: () => calls.filter(c => c.method !== 'GET' && !c.path.endsWith('/products/search')).length,
  };
}
/** A Snapchat product as products/search returns it. */
export function snapProduct(i, overrides = {}) {
  return {
    id: 'SKU-' + i,
    title: 'Product ' + i,
    description: 'Synthetic product ' + i,
    link: 'https://shop.example.test/p/' + i,
    image_link: 'https://shop.example.test/i/' + i + '.jpg',
    availability: 'IN_STOCK',
    condition: 'NEW',
    brand: 'Brand',
    price: {value: '20.00', currency: 'SAR'},
    ...overrides,
  };
}
/** The source row that matches snapProduct(i). */
export function snapSource(i, overrides = {}) {
  return {
    retailer_id: 'SKU-' + i,
    name: 'Product ' + i,
    price: '20',
    currency: 'SAR',
    image_url: 'https://shop.example.test/i/' + i + '.jpg',
    url: 'https://shop.example.test/p/' + i,
    availability: 'in stock',
    condition: 'new',
    brand: 'Brand',
    description: 'Synthetic product ' + i,
    ...overrides,
  };
}
