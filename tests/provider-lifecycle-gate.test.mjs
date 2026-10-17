import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ScopeGuard} from '../dist/src/scope.js';
import {workspaceCapabilities} from '../dist/src/capabilities.js';
import {createWebsite} from '../dist/server/website.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {wooConnectionFixture, wooConnectionInput} from './fixtures/woocommerce-connection-data.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';

// P9 (ARC-01): Criteo and WooCommerce are parked by their lifecycle status. Unless AMCP_PROVIDERS names them, they are
// absent from tools/list, contracts, capabilities and the Commerce page, and no request reaches them; named, every
// surface offers them again. Before this gate both gateways were listed and callable in every deployment.

const registry = new Registry(),
  owner = {tenantId: 'parked-gate', userId: 'owner', role: 'admin'},
  operator = {...owner, userId: 'operator', role: 'operator'},
  parked = ['criteo_native_action', 'commerce_native_action'];

/** Runs `fn` with AMCP_PROVIDERS set to `value` (undefined: unset) and restores the previous value. */
async function withProviders(value, fn) {
  const previous = process.env.AMCP_PROVIDERS;
  if (value === undefined) delete process.env.AMCP_PROVIDERS;
  else process.env.AMCP_PROVIDERS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AMCP_PROVIDERS;
    else process.env.AMCP_PROVIDERS = previous;
  }
}

/** A write-enabled service with one Criteo login whose provider answers the catalog request contract. */
function criteoWorld() {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    prefix = '/2026-07/retail-media',
    requests = [];
  store.putConnection(
    owner,
    {
      id: 'criteo',
      tenantId: owner.tenantId,
      gateway: 'criteo_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Criteo',
      scopes: ['RetailMedia_Accounts_Read', 'RetailMedia_Campaign_Read'],
    },
    {accessToken: 'synthetic'},
  );
  const status = id => ({
    data: {
      id,
      type: 'CatalogStatus',
      attributes: {status: 'pending', createdAt: '2026-09-27T10:00:00Z', currency: 'USD', rowCount: null},
    },
    errors: [],
    warnings: [],
  });
  const transport = new NativeTransport(
    async (url, init) => {
      const u = new URL(String(url));
      requests.push(init.method + ' ' + u.pathname);
      if (init.method === 'GET' && u.pathname === prefix + '/accounts')
        return Response.json({
          data: [{id: '123', type: 'RetailMediaAccount', attributes: {name: 'A', type: 'demand', currency: 'USD'}}],
          metadata: {currentPageIndex: 0, currentPageSize: 2, totalItemsAcrossAllPages: 1, totalPages: 1},
          errors: [],
          warnings: [],
        });
      if (init.method === 'POST' && u.pathname === prefix + '/accounts/123/catalogs')
        return Response.json(status('8001'));
      return Response.json({errors: [{code: 'not-found', title: 'Not found'}]}, {status: 404});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    10000,
  );
  const service = new MirrorService(registry, store, transport, undefined, {
    allowWrites: true,
    maxBudgetChange: 0,
    requireBeforeState: true,
  });
  return {store, service, requests, close: () => store.close()};
}

const catalogRequest = {
  operation: 'criteo_catalog_ops',
  arguments: {
    action: 'CATALOG_API_POST_API_V1_EXTERNAL_ACCOUNT_CATALOGS_BY_ACCOUNT_ID',
    account_id: '123',
    payload: {data: {type: 'CatalogRequest', attributes: {format: 'json-newline', brandIdFilter: ['1001']}}},
  },
};

test('parked Criteo and WooCommerce are absent from tools/list by default and listed where AMCP_PROVIDERS names them', async () => {
  const w = criteoWorld();
  try {
    const names = () => w.service.listTools().map(t => t.name);
    await withProviders(undefined, () => {
      const listed = names();
      for (const gateway of [...parked, 'amazon_native_action']) assert.ok(!listed.includes(gateway), gateway);
      assert.equal(listed.length, 25);
    });
    await withProviders('criteo,woocommerce', () => {
      const listed = names();
      for (const gateway of parked) assert.ok(listed.includes(gateway), gateway);
      assert.ok(!listed.includes('amazon_native_action'), 'Amazon Ads stays parked unless named');
      assert.equal(listed.length, 27);
    });
    await withProviders('criteo', () => {
      assert.ok(names().includes('criteo_native_action'));
      assert.ok(!names().includes('commerce_native_action'), 'each parked provider is offered on its own');
    });
  } finally {
    w.close();
  }
});

test('a parked gateway is refused before its arguments are read, whichever tool names it, and nothing is sent', async () => {
  const w = criteoWorld();
  try {
    await withProviders(undefined, async () => {
      for (const [tool, input] of [
        ['criteo_native_action', catalogRequest],
        ['commerce_native_action', {operation: 'woocommerce_list_stores'}],
        ['amcp_write', {action: 'inspect', gateway: 'criteo_native_action', arguments: catalogRequest}],
        ['amcp_write', {action: 'prepare', gateway: 'criteo_native_action', arguments: catalogRequest}],
        ['amcp_tool_help', {gateway: 'criteo_native_action'}],
        ['amcp_workspace', {action: 'contracts', gateway: 'criteo_native_action'}],
        ['amcp_workspace', {action: 'catalog_sources'}],
        [
          'amcp_workspace',
          {
            action: 'catalog_source',
            gateway: 'commerce_native_action',
            account_id: 'wc_store',
            connection_id: 'woo',
            requirements: {product_ids: ['1'], price_field: 'price'},
          },
        ],
      ]) {
        const out = await w.service.call(tool, input, owner);
        assert.equal(out.success, false, tool + ' ' + JSON.stringify(input).slice(0, 80));
        assert.equal(out.error.code, 'GATEWAY_NOT_OFFERED', tool);
        assert.equal(out.error.details.reason, 'owner_parked', tool);
        assert.match(out.error.message, /its work is parked\. Nothing was sent\./);
        assert.ok(['criteo', 'woocommerce'].includes(out.error.details.provider), tool);
      }
      assert.deepEqual(w.requests, [], 'no provider request');
    });
    // Offered again, the same calls reach the provider contract: inspect answers and the store list is read locally.
    await withProviders('criteo,woocommerce', async () => {
      const inspect = await w.service.call(
        'amcp_write',
        {action: 'inspect', gateway: 'criteo_native_action', arguments: catalogRequest},
        owner,
      );
      assert.equal(inspect.success, true, JSON.stringify(inspect).slice(0, 400));
      const sources = await w.service.call('amcp_workspace', {action: 'catalog_sources'}, owner);
      assert.equal(sources.success, true, JSON.stringify(sources).slice(0, 400));
      assert.deepEqual(sources.data.items, []);
    });
  } finally {
    w.close();
  }
});

test('ScopeGuard refuses a parked provider before credentials, so a review prepared while it was offered cannot execute after it is parked', async () => {
  const w = criteoWorld();
  try {
    const prepared = await withProviders('criteo', () =>
      w.service.call(
        'amcp_write',
        {action: 'prepare', gateway: 'criteo_native_action', arguments: catalogRequest},
        operator,
      ),
    );
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 600));
    const before = [...w.requests];
    assert.ok(before.length > 0 && before.every(r => r.startsWith('GET ')), 'prepare only read');
    const execute = () =>
      w.service.call(
        'amcp_write',
        {
          action: 'execute',
          review_id: prepared.data.review_id,
          idempotency_key: prepared.data.idempotency_key,
          confirmed: true,
        },
        operator,
      );
    // Execute names no gateway, so only the egress gate stops it: the review's plan is Criteo's.
    const refused = await withProviders(undefined, execute);
    assert.equal(refused.success, false);
    assert.equal(refused.error.code, 'GATEWAY_NOT_OFFERED', JSON.stringify(refused).slice(0, 400));
    assert.deepEqual(w.requests, before, 'nothing was read or sent after the provider was parked');
    // The refusal came before the idempotency claim: offered again, the same review executes once.
    const executed = await withProviders('criteo', execute);
    assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 600));
    assert.equal(w.requests.filter(r => r.startsWith('POST ')).length, 1);
    // Every request through the guard is refused, read or write, before any credential is fetched.
    const guard = new ScopeGuard(registry, w.store),
      connection = w.store.resolveConnection(owner, 'criteo_native_action', '123');
    await withProviders(undefined, () =>
      assert.throws(
        () =>
          guard.authorize(
            {
              gateway: 'criteo_native_action',
              method: 'GET',
              path: '/2026-07/retail-media/accounts/123/campaigns',
              query: {},
              body: undefined,
              headers: {},
              accountId: '123',
              readOnly: true,
            },
            connection,
          ),
        e => e.code === 'GATEWAY_NOT_OFFERED' && e.details.provider === 'criteo',
      ),
    );
  } finally {
    w.close();
  }
});

test('listings leave out a parked provider: contracts, its reviewed families and the capabilities providers', async () => {
  const w = criteoWorld();
  try {
    const listed = async () => {
      const contracts = await w.service.call('amcp_workspace', {action: 'contracts', limit: 100}, owner),
        // The reviewed catalog request family's action (criteo_catalog_requests).
        criteo = await w.service.call(
          'amcp_workspace',
          {action: 'contracts', search: catalogRequest.arguments.action, limit: 100},
          owner,
        );
      return {
        gateways: contracts.data.summary.map(s => s.gateway),
        criteoRows: criteo.data.total,
        providers: workspaceCapabilities(w.store, owner).providers.map(p => p.id),
      };
    };
    await withProviders(undefined, async () => {
      const {gateways, criteoRows, providers} = await listed();
      for (const gateway of parked) assert.ok(!gateways.includes(gateway), gateway);
      assert.equal(criteoRows, 0, 'no Criteo family row');
      assert.ok(!providers.includes('criteo') && providers.includes('meta'), JSON.stringify(providers));
    });
    await withProviders('criteo,woocommerce', async () => {
      const {gateways, criteoRows, providers} = await listed();
      for (const gateway of parked) assert.ok(gateways.includes(gateway), gateway);
      assert.ok(criteoRows > 0, 'the Criteo catalog request family is listed again');
      assert.ok(providers.includes('criteo'));
    });
  } finally {
    w.close();
  }
});

async function website(t) {
  const f = wooConnectionFixture({tenant: 'parked-woo'}),
    origin = 'https://synthetic-parked.amcp.invalid',
    options = {
      origin,
      masterKey: Buffer.alloc(32, f.keyByte).toString('base64'),
      tenantId: f.actor.tenantId,
      authEnv: {},
      fetcher: async () => {
        throw Error('Unexpected generic egress');
      },
    },
    {web, accounts} = createWebsite(f.store, options, true, f.service),
    user = accounts.newUser('Synthetic parked owner', null, null, true);
  f.store.db
    .prepare('INSERT INTO workspace_memberships(tenant_id,user_id,role,created_at) VALUES(?,?,?,?)')
    .run(f.actor.tenantId, user.id, 'owner', Date.now());
  const session = accounts.session(accounts.user(user.id), f.actor.tenantId),
    listener = await listenForFetch(createHttpApp(f.service, f.store, {website: options}));
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(r => listener.close(r));
    f.close();
  });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: web.cookieName + '=' + session.id,
        'X-AMCP-CSRF': session.csrf,
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    return {status: response.status, body: await response.json()};
  };
  return {...f, request};
}

test('the website names the providers it does not offer; WooCommerce setup is refused while parked and a stored connection can still be removed', async t => {
  const f = await website(t);
  const connected = await withProviders('woocommerce', () =>
    f.request('/api/commerce/stores', 'POST', wooConnectionInput()),
  );
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  const reads = f.calls.length;
  await withProviders(undefined, async () => {
    const platforms = await f.request('/api/platforms');
    assert.deepEqual([...platforms.body.providers_not_offered].sort(), ['amazon', 'criteo', 'woocommerce']);
    // The stored connection stays listed (metadata only), so an administrator can remove it.
    assert.equal(platforms.body.commerce_sources.length, 1);
    const second = await f.request(
      '/api/commerce/stores',
      'POST',
      wooConnectionInput({
        connection_id: '22345678-1234-4123-8123-123456789abc',
        store_origin: 'https://b.example.test',
      }),
    );
    assert.equal(second.status, 404);
    assert.equal(second.body.error.code, 'GATEWAY_NOT_OFFERED');
    const removed = await f.request('/api/commerce/stores/' + connected.body.connection_id, 'DELETE', {
      confirmed: true,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.disconnected, true);
    assert.equal(f.calls.length, reads, 'no store request while parked');
  });
  await withProviders('woocommerce', async () => {
    const platforms = await f.request('/api/platforms');
    assert.deepEqual([...platforms.body.providers_not_offered].sort(), ['amazon', 'criteo']);
  });
});

test('Commerce hides the WooCommerce panels and source while it is parked; an administrator can still remove a stored store connection (English and Arabic)', async () => {
  const stored = [
    {label: 'Store', store_origin: 'https://store.example.test', connection_id: 'wc-1', account_id: 'wc_1'},
  ];
  for (const locale of ['en', 'ar']) {
    // Parked, no stored connection: nothing of WooCommerce, and the import offers only the CSV source.
    const f = accountWorkflowFixture(locale);
    f.context.session.workspaceRole = 'owner';
    f.context.providersNotOffered = ['woocommerce'];
    await f.run('renderCommerce()');
    const html = f.node('content').innerHTML;
    for (const id of ['woo-source', 'woo-inventory', 'woo-connect', 'woo-connections', 'commerce-store-sources'])
      assert.doesNotMatch(html, new RegExp('id="' + id + '"'), id);
    assert.doesNotMatch(html, /<option value="woocommerce">/);
    assert.match(html, /id="catalog-import"/, 'the reviewed import stays');
    assert.equal(f.calls.length, 0);
    // Parked with a stored connection: an administrator sees only its removal, with the reason.
    const s = accountWorkflowFixture(locale);
    s.context.session.workspaceRole = 'owner';
    s.context.providersNotOffered = ['woocommerce'];
    s.context.commerceSources = stored;
    await s.run('renderCommerce()');
    const panel = s.node('content').innerHTML;
    assert.match(panel, /id="woo-parked"/);
    assert.match(
      panel,
      locale === 'ar'
        ? /لا يوفّر هذا النشر مصادر متاجر WooCommerce: العمل عليها متوقف حاليًا\./
        : /This deployment does not offer WooCommerce store sources: their work is parked\./,
    );
    assert.match(panel, /id="woo-remove"/);
    for (const id of ['woo-connect', 'woo-source', 'woo-inventory'])
      assert.doesNotMatch(panel, new RegExp('id="' + id + '"'), id);
    s.node('woo-remove:target').value = '0';
    s.node('woo-remove:confirmed').checked = true;
    s.apiRespond(call => {
      assert.deepEqual(call, {url: '/api/commerce/stores/wc-1', method: 'DELETE', body: {confirmed: true}});
      return {
        success: true,
        disconnected: true,
        connection_id: 'wc-1',
        gateway: 'commerce_native_action',
        network_requests: 0,
        provider_changes: 0,
      };
    });
    await s.bindings.get('#woo-remove')();
    assert.equal(s.httpCalls.length, 1);
    assert.match(s.node('#woo-remove-result').innerHTML, /id="woo-remove-heading"/);
    // A member who is not an administrator sees no store panel at all.
    const viewer = accountWorkflowFixture(locale);
    viewer.context.providersNotOffered = ['woocommerce'];
    viewer.context.commerceSources = stored;
    await viewer.run('renderCommerce()');
    assert.doesNotMatch(viewer.node('content').innerHTML, /id="woo-connections"/);
  }
  // Offered, the page is unchanged: the store panels and the WooCommerce source are there.
  const offered = accountWorkflowFixture();
  offered.context.session.workspaceRole = 'owner';
  offered.context.providersNotOffered = ['amazon', 'criteo'];
  await offered.run('renderCommerce()');
  const html = offered.node('content').innerHTML;
  for (const id of ['woo-source', 'woo-inventory', 'woo-connect', 'commerce-store-sources'])
    assert.match(html, new RegExp('id="' + id + '"'), id);
  assert.match(html, /<option value="woocommerce">/);
});
