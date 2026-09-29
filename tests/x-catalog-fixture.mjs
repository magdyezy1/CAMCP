import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';

/**
 * A synthetic X catalog world for the catalog family tests, shaped like the examples of X's "Catalog Management API
 * Reference" (docs.x.com, read 2026-09-29): responses carry {request, data, next_cursor}; prices come back with two
 * decimals ("20.00 USD"); catalogs and feeds take form parameters, products and product sets a JSON body.
 *
 * Account acct1 has FULL promotable users 111 (catalog 9001, not empty) and 333 (empty catalog 9002 unless `noCatalog`),
 * and RETWEETS_ONLY user 222. User 999 is not a promotable user of the account; its catalog 9009 is out of scope.
 */
export const registry = new Registry(),
  gateway = 'x_ads_native_action',
  account = 'acct1';
const secret = {
  accessToken: 'synthetic-token',
  consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret',
  tokenSecret: 'synthetic-token-secret',
};
const copy = x => structuredClone(x);
const price = v => {
  const m = /^(\d+(?:\.\d+)?) ([A-Z]{3})$/.exec(String(v));
  return m ? Number(m[1]).toFixed(2) + ' ' + m[2] : v;
};
export function product(i, extra = {}) {
  return {
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
  };
}
export function setup({tenant = 'x-catalogs', products = 3, feed = true, noCatalog = false} = {}) {
  const actor = {tenantId: tenant, userId: 'operator', role: 'operator'},
    admin = {...actor, role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 88).toString('base64'));
  store.putConnection(
    admin,
    {
      id: 'x',
      tenantId: actor.tenantId,
      gateway,
      accounts: [account],
      writeAccounts: [account],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    secret,
  );
  const promotable = [
    {id: 'pu1', user_id: '111', promotable_user_type: 'FULL', deleted: false},
    {id: 'pu2', user_id: '222', promotable_user_type: 'RETWEETS_ONLY', deleted: false},
    {id: 'pu3', user_id: '333', promotable_user_type: 'FULL', deleted: false},
  ];
  const catalogs = new Map([
    ['9001', {id: '9001', name: 'Shop', user: '111'}],
    ['9009', {id: '9009', name: 'Elsewhere', user: '999'}],
  ]);
  if (!noCatalog) catalogs.set('9002', {id: '9002', name: 'Empty', user: '333'});
  const items = {
    9001: Array.from({length: products}, (_, i) => product(i + 1)),
    9002: [],
    9009: [product(900)],
  };
  const sets = {
    9001: new Map([
      [
        '7001',
        {
          id: '7001',
          name: 'Picks',
          description: null,
          type: 'MANUAL',
          filters: [],
          product_ids: ['sku-1'],
          processing_status: 'DONE',
        },
      ],
      [
        '7002',
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
    ]),
    9002: new Map(),
    9009: new Map(),
  };
  const feeds = {9001: new Map(), 9002: new Map(), 9009: new Map()};
  if (feed)
    feeds[9001].set('8001', {
      id: '8001',
      product_catalog_id: '9001',
      feed_url: 'https://shop.example.test/feed.csv',
      feed_format: 'CSV',
      frequency: 'WEEKLY',
      repeat: 'SATURDAY',
      start_time: '01:30',
      time_zone: 'Asia/Riyadh',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });
  const calls = [];
  let writes = 0,
    next = 100;
  const transport = new NativeTransport(async (url, init) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      path = u.pathname,
      query = Object.fromEntries(u.searchParams),
      type = new Headers(init?.headers).get('content-type') ?? '';
    const raw = init?.body === undefined ? '' : String(init.body),
      body = type.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({method, path, query, type, body});
    const reply = (data, extra = {}) =>
      Response.json({
        request: {params: query},
        data: copy(data),
        ...(Array.isArray(data) ? {next_cursor: null} : {}),
        ...extra,
      });
    if (method === 'GET') {
      if (path === '/12/accounts/' + account + '/promotable_users') return reply(promotable);
      if (path === '/12/product_catalogs')
        return reply([...catalogs.values()].filter(c => c.user === query.user_id).map(({id, name}) => ({id, name})));
      let m = /^\/12\/product_catalogs\/(\d+)\/products$/.exec(path);
      if (m) {
        const all = items[m[1]] ?? [],
          count = Number(query.count ?? 100),
          start = Number(query.cursor ?? 0),
          page = all.slice(start, start + count);
        return Response.json({
          request: {params: query},
          data: copy(page),
          next_cursor: start + count < all.length ? String(start + count) : null,
        });
      }
      m = /^\/12\/product_catalogs\/(\d+)\/product_sets$/.exec(path);
      if (m) return reply([...(sets[m[1]]?.values() ?? [])]);
      m = /^\/12\/product_catalogs\/(\d+)\/scheduled_feeds$/.exec(path);
      if (m) return reply([...(feeds[m[1]]?.values() ?? [])]);
      throw Error('Unexpected read ' + path);
    }
    writes++;
    if (path === '/12/product_catalogs' && method === 'POST') {
      const c = {id: String(9100 + next++), name: body.name, user: body.user_id};
      catalogs.set(c.id, c);
      items[c.id] = [];
      sets[c.id] = new Map();
      feeds[c.id] = new Map();
      return reply({id: c.id, name: c.name});
    }
    let m = /^\/12\/product_catalogs\/(\d+)$/.exec(path);
    if (m && method === 'PUT') {
      catalogs.get(m[1]).name = body.name;
      return reply({id: m[1], name: body.name});
    }
    if (m && method === 'DELETE') {
      const c = catalogs.get(m[1]);
      catalogs.delete(m[1]);
      return reply({id: m[1], name: c.name});
    }
    m = /^\/12\/product_catalogs\/(\d+)\/products$/.exec(path);
    if (m && method === 'PUT') {
      const out = body.products.map(p => {
        const list = items[m[1]],
          i = list.findIndex(x => x.id === p.id),
          row = {
            ...(i >= 0 ? list[i] : product(0, {product_key: String(6000000 + next++)})),
            ...p,
            price: price(p.price),
            ...(p.sale_price ? {sale_price: price(p.sale_price)} : {}),
          };
        if (i >= 0) list[i] = row;
        else list.push(row);
        return {
          warnings: [],
          errors: [],
          product_key: row.product_key,
          id: p.id,
          status: i >= 0 ? 'UPDATE_SUCCESS' : 'CREATE_SUCCESS',
        };
      });
      return reply({products_response: out});
    }
    if (m && method === 'DELETE') {
      items[m[1]] = items[m[1]].filter(x => !body.product_keys.includes(x.product_key));
      return reply({
        delete_products: body.product_keys.map(k => ({product_key: k, failed_product_key: null, message: null})),
      });
    }
    m = /^\/12\/product_catalogs\/(\d+)\/product_sets(?:\/(\d+))?$/.exec(path);
    if (m) {
      const list = sets[m[1]],
        idsOf = keys => keys.map(k => items[m[1]].find(x => x.product_key === k)?.id);
      if (method === 'POST') {
        const s = {
          id: String(7100 + next++),
          name: body.name,
          description: body.description ?? null,
          type: body.type,
          filters: (body.filters ?? []).map(f => ({
            ...f,
            value: ['price', 'sale_price'].includes(f.attribute) ? price(f.value) : f.value,
          })),
          product_ids: body.type === 'MANUAL' ? idsOf(body.product_keys) : items[m[1]].map(x => x.id),
          processing_status: body.type === 'MANUAL' ? 'DONE' : 'PROCESSING',
        };
        list.set(s.id, s);
        return reply(s);
      }
      if (method === 'PUT') {
        const s = list.get(m[2]);
        Object.assign(s, {
          ...(body.name !== undefined ? {name: body.name} : {}),
          ...(body.description !== undefined ? {description: body.description} : {}),
          ...(body.product_keys ? {product_ids: idsOf(body.product_keys)} : {}),
        });
        return reply(s);
      }
      if (method === 'DELETE') {
        const s = list.get(m[2]);
        list.delete(m[2]);
        return reply(s);
      }
    }
    m = /^\/12\/product_catalogs\/(\d+)\/scheduled_feeds(?:\/(\d+))?$/.exec(path);
    if (m) {
      const list = feeds[m[1]];
      if (method === 'POST') {
        const f = {id: String(8100 + next++), product_catalog_id: m[1], repeat: null, ...body};
        list.set(f.id, f);
        return reply(f);
      }
      if (method === 'PUT') {
        const f = Object.assign(list.get(m[2]), body);
        return reply(f);
      }
      if (method === 'DELETE') {
        const f = list.get(m[2]);
        list.delete(m[2]);
        return reply(f);
      }
    }
    throw Error('Unexpected write ' + method + ' ' + path);
  });
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  const prepare = (action, payload, params = {}) =>
    service.call(
      'amcp_write',
      {action: 'prepare', gateway, arguments: {action, account_id: account, params, ...(payload ? {payload} : {})}},
      actor,
    );
  const execute = p =>
    service.call(
      'amcp_write',
      {action: 'execute', review_id: p.data.review_id, idempotency_key: p.data.idempotency_key, confirmed: true},
      actor,
    );
  const verify = p => service.call('amcp_campaign', {action: 'verify', review_id: p.data.review_id}, actor);
  return {store, calls, catalogs, items, sets, feeds, prepare, execute, verify, writes: () => writes};
}
