import test from 'node:test';
import assert from 'node:assert/strict';
import {connectWooCommerce} from '../dist/src/woocommerce-connection.js';
import {wooCommerceSources} from '../dist/src/woocommerce-source.js';
import {disconnectLocalConnection} from '../dist/src/connection-disconnect.js';
import {MirrorError} from '../dist/src/errors.js';
import {sha256} from '../dist/src/security.js';
import {wooConnectionFixture, wooConnectionInput, wooConnectionJSON} from './fixtures/woocommerce-connection-data.mjs';

const connectionId = wooConnectionInput().connection_id;
function fixture(t, options) {
  const f = wooConnectionFixture(options);
  t.after(f.close);
  return f;
}
const setup = (f, input = wooConnectionInput(), options = {}) =>
  connectWooCommerce(f.store, f.actor, input, {request: f.request, ...options});
function noArtifacts(f) {
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 0);
  assert.equal(f.store.audit(f.actor.tenantId).length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM service_locks').get().count, 0);
}
test('existing WooCommerce key setup uses three exact HTTPS GETs and stores one encrypted read-only origin binding', async t => {
  const f = fixture(t),
    out = await setup(f);
  assert.equal(out.record_kind, 'woocommerce_connection');
  assert.equal(out.account_id, 'wc_' + sha256('https://shop.example.test'));
  assert.equal(out.account_id_kind, 'amcp_origin_binding');
  assert.equal(out.key_permission_evidence, 'operator_recorded');
  assert.equal(out.read_access_verified, true);
  assert.equal(out.network_requests, 3);
  assert.equal(out.native_currency, 'SAR');
  assert.equal(out.reported_published_products, 1);
  assert.equal(out.full_inventory, false);
  assert.equal(out.writes_enabled, false);
  assert.equal(out.provider_mutations, 0);
  assert.equal(out.credentials_disclosed, false);
  assert.deepEqual(
    f.calls.map(c => c.url.pathname),
    [
      '/wp-json/wc/v3/settings/general/woocommerce_currency',
      '/wp-json/wc/v3/products',
      '/wp-json/wc/v3/settings/general/woocommerce_currency',
    ],
  );
  assert.deepEqual(Object.fromEntries(f.calls[1].url.searchParams), {
    _fields: 'id,status',
    context: 'view',
    status: 'publish',
    order: 'asc',
    orderby: 'id',
    per_page: '1',
    page: '1',
  });
  for (const {url, options} of f.calls) {
    assert.equal(url.origin, 'https://shop.example.test');
    assert.equal(url.username + url.password, '');
    assert.equal(options.body, undefined);
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(
      options.headers.Authorization,
      'Basic ' + Buffer.from('ck_setupSyntheticKey:cs_setupSyntheticSecret').toString('base64'),
    );
    assert.equal(typeof options.lookup, 'function');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.isFrozen(options.headers), true);
    assert.doesNotMatch(url.href, /consumer|setupSynthetic/);
  }
  const [saved] = f.store.listConnections(f.actor.tenantId);
  assert.deepEqual(saved.accounts, [out.account_id]);
  assert.deepEqual(saved.scopes, ['read']);
  assert.deepEqual(saved.writeAccounts, []);
  assert.equal(saved.defaultWriteAccess, false);
  assert.equal(saved.isDefault, false);
  assert.equal(saved.apiVersion, 'wc/v3');
  assert.deepEqual(f.store.credentials(f.actor.tenantId, connectionId), {
    consumerKey: 'ck_setupSyntheticKey',
    consumerSecret: 'cs_setupSyntheticSecret',
  });
  const stored = JSON.stringify([
    f.store.db.prepare('SELECT * FROM connections').all(),
    f.store.db.prepare('SELECT * FROM documents').all(),
    f.store.db.prepare('SELECT * FROM audit').all(),
  ]);
  assert.doesNotMatch(
    stored + JSON.stringify(out),
    /ck_setupSyntheticKey|cs_setupSyntheticSecret|PRIVATE-SETUP-NATIVE|\\*"(?:sku|permalink)\\*"\s*:/,
  );
  assert.equal(f.store.audit(f.actor.tenantId).length, 1);
  assert.equal(wooCommerceSources(f.store, f.actor).items[0].connection_id, connectionId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM service_locks').get().count, 0);
});
test('a verified empty published collection is valid setup evidence without claiming a full inventory', async t => {
  const f = fixture(t);
  f.respond((url, options, n, native) =>
    url.pathname.endsWith('/products')
      ? wooConnectionJSON([], {'x-wp-total': '0', 'x-wp-totalpages': '0'})
      : native(url),
  );
  const out = await setup(f);
  assert.equal(out.reported_published_products, 0);
  assert.equal(out.read_access_verified, true);
  assert.equal(out.full_inventory, false);
  assert.equal(f.calls.length, 3);
});
test('the new connection immediately supports selected product reads without creating a draft, review or import', async t => {
  const f = fixture(t),
    out = await setup(f),
    response = await f.service.call(
      'amcp_workspace',
      {
        action: 'catalog_source',
        gateway: 'commerce_native_action',
        connection_id: out.connection_id,
        account_id: out.account_id,
        requirements: {product_ids: ['101'], price_field: 'price'},
      },
      {...f.actor, role: 'reader'},
    );
  assert.equal(response.success, true, JSON.stringify(response));
  assert.equal(response.data.items[0].selected_price, '0012.34');
  assert.equal(response.data.native_currency, 'SAR');
  assert.equal(f.calls.length, 7);
  for (const kind of ['campaign_run', 'write_review', 'decision_report', 'reporting_snapshot', 'catalog_source'])
    assert.equal(f.store.documents(f.actor.tenantId, kind).length, 0);
});
for (const change of [{role: 'reader'}, {role: 'operator'}, {role: 'admin', testAccount: true}])
  test('setup refuses non-administrator or evaluator authority before network ' + JSON.stringify(change), async t => {
    const f = fixture(t);
    Object.assign(f.actor, change);
    await assert.rejects(setup(f), {code: 'FORBIDDEN'});
    assert.equal(f.calls.length, 0);
    noArtifacts(f);
  });
test('missing encrypted storage refuses setup before lock admission or credential egress', async t => {
  const f = fixture(t, {encryption: false});
  await assert.rejects(setup(f), {code: 'ENCRYPTION_REQUIRED'});
  assert.equal(f.calls.length, 0);
  noArtifacts(f);
});
for (const patch of [
  {connection_id: 'arbitrary'},
  {connection_id: '12345678-1234-1123-8123-123456789abc'},
  {connection_id: 1},
  {label: ''},
  {label: ' padded'},
  {label: 'x\nsecret'},
  {label: 'x'.repeat(201)},
  {consumer_key: 'ck_value:secret'},
  {consumer_secret: 'cs_value\nsecret'},
  {consumer_key: 'key'},
  {key_permission: 'read_write'},
  {key_permission: 'write'},
  {confirmed: false},
  {confirmed: 'true'},
  {store_origin: 'http://shop.example.test'},
  {store_origin: 'https://shop.example.test/shop'},
  {store_origin: 'https://127.0.0.1'},
  {store_origin: 'https://user:password@shop.example.test'},
  {store_origin: 'https://shop.example.test?secret=x'},
  {store_origin: 'https://shop.example.test:444'},
  {write_access: true},
  {timeout: 999999},
  {tenant_id: 'other'},
  {headers: {Authorization: 'caller'}},
])
  test('setup rejects malformed, privileged or arbitrary transport input ' + Object.keys(patch).join(), async t => {
    const f = fixture(t);
    await assert.rejects(setup(f, wooConnectionInput(patch)), e =>
      ['INVALID_WOOCOMMERCE_CONNECTION', 'INVALID_WOOCOMMERCE_SOURCE'].includes(e.code),
    );
    assert.equal(f.calls.length, 0);
    noArtifacts(f);
  });
for (const body of [null, [], 'key', {}, {...wooConnectionInput(), consumer_key: undefined}])
  test('setup requires an exact input object ' + JSON.stringify(body), async t => {
    const f = fixture(t);
    await assert.rejects(setup(f, body), {code: 'INVALID_WOOCOMMERCE_CONNECTION'});
    assert.equal(f.calls.length, 0);
    noArtifacts(f);
  });
for (const status of [301, 302, 401, 403, 429, 500])
  test('native status ' + status + ' is cancelled without a retry, a leaked error or a saved connection', async t => {
    const f = fixture(t);
    let cancelled = 0;
    f.respond(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          {status, headers: {'content-type': 'application/json'}},
        ),
    );
    await assert.rejects(
      setup(f),
      e => e.code === 'WOOCOMMERCE_CONNECTION_UNAVAILABLE' && !/setupSynthetic|PRIVATE/.test(JSON.stringify(e)),
    );
    assert.equal(cancelled, 1);
    assert.equal(f.calls.length, 1);
    noArtifacts(f);
  });
for (const headers of [
  {'content-type': 'text/html'},
  {'content-encoding': 'gzip'},
  {'content-length': '262145'},
  {'content-length': '-1'},
  {'content-length': '10'},
])
  test('setup refuses unsupported or inconsistent response headers ' + JSON.stringify(headers), async t => {
    const f = fixture(t);
    f.respond(() => wooConnectionJSON({id: 'woocommerce_currency', value: 'SAR'}, headers));
    await assert.rejects(setup(f), e => /^WOOCOMMERCE_CONNECTION_(INCOMPLETE|UNAVAILABLE)$/.test(e.code));
    assert.equal(f.calls.length, 1);
    noArtifacts(f);
  });
for (const [rows, headers] of [
  [[], {}],
  [[], {'x-wp-total': '1', 'x-wp-totalpages': '1'}],
  [[{id: 1, status: 'draft'}], {'x-wp-total': '1', 'x-wp-totalpages': '1'}],
  [[{id: 1, status: 'publish'}], {'x-wp-total': '10', 'x-wp-totalpages': '1'}],
  [[{id: '0', status: 'publish'}], {'x-wp-total': '1', 'x-wp-totalpages': '1'}],
  [[{id: '01', status: 'publish'}], {'x-wp-total': '1', 'x-wp-totalpages': '1'}],
  [
    [
      {id: 1, status: 'publish'},
      {id: 2, status: 'publish'},
    ],
    {'x-wp-total': '2', 'x-wp-totalpages': '2'},
  ],
  [[], {'x-wp-total': '0', 'x-wp-totalpages': '1'}],
  [[], {'x-wp-total': '9007199254740992', 'x-wp-totalpages': '9007199254740992'}],
])
  test(
    'setup validates published sample membership and exact one-row page totals ' + JSON.stringify([rows, headers]),
    async t => {
      const f = fixture(t);
      f.respond((url, options, n, native) => (n === 2 ? wooConnectionJSON(rows, headers) : native(url)));
      await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_INCOMPLETE'});
      assert.equal(f.calls.length, 2);
      noArtifacts(f);
    },
  );
test('currency must retain its exact setting identity and remain unchanged across setup', async t => {
  for (const value of [
    {id: 'other', value: 'SAR'},
    {id: 'woocommerce_currency', value: 'sar'},
    {id: 'woocommerce_currency', value: 'EUR'},
  ]) {
    const f = fixture(t);
    f.respond((url, options, n, native) => (n === 3 ? wooConnectionJSON(value) : native(url)));
    await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_INCOMPLETE'});
    noArtifacts(f);
  }
});
test('malformed JSON, invalid UTF-8 and aggregate body overflow leave no connection', async t => {
  for (const body of ['{', new Uint8Array([0xff]), ' '.repeat(262145)]) {
    const f = fixture(t);
    f.respond(() => new Response(body, {headers: {'content-type': 'application/json'}}));
    await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_INCOMPLETE'});
    noArtifacts(f);
  }
});
test('empty-chunk flood and monotonic deadline cancel the current body without saving or retrying', async t => {
  for (const kind of ['empty', 'deadline']) {
    const f = fixture(t);
    let cancelled = 0,
      tick = 0;
    f.respond(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (kind === 'deadline') tick = 20001;
              controller.enqueue(new Uint8Array());
            },
            cancel() {
              cancelled++;
            },
          }),
          {headers: {'content-type': 'application/json'}},
        ),
    );
    await assert.rejects(setup(f, wooConnectionInput(), {monotonic: () => tick}), {
      code: kind === 'empty' ? 'WOOCOMMERCE_CONNECTION_INCOMPLETE' : 'WOOCOMMERCE_CONNECTION_UNAVAILABLE',
    });
    assert.equal(cancelled, 1);
    assert.equal(f.calls.length, 1);
    noArtifacts(f);
  }
});
test('withdrawn current authority cancels a delivered body and prevents persistence at every response boundary', async t => {
  for (const point of [1, 2, 3]) {
    const f = fixture(t);
    let active = true,
      cancelled = 0;
    f.store.bindActorCheck(f.actor, () => {
      if (!active) throw new MirrorError('UNAUTHORIZED', 'Synthetic authority withdrawn', {}, 401);
    });
    f.respond((url, options, n, native) => {
      if (n !== point) return native(url);
      active = false;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {headers: {'content-type': 'application/json'}},
      );
    });
    await assert.rejects(setup(f), {code: 'UNAUTHORIZED'});
    assert.equal(f.calls.length, point);
    assert.equal(cancelled, 1);
    noArtifacts(f);
  }
});
test('authority withdrawn during atomic save rolls back the connection, metadata and audit', async t => {
  const f = fixture(t);
  let active = true;
  f.store.bindActorCheck(f.actor, () => {
    if (!active) throw new MirrorError('UNAUTHORIZED', 'Synthetic authority withdrawn', {}, 401);
  });
  const put = f.store.putConnection.bind(f.store);
  f.store.putConnection = (...args) => {
    put(...args);
    active = false;
  };
  await assert.rejects(setup(f), {code: 'UNAUTHORIZED'});
  assert.equal(f.calls.length, 3);
  noArtifacts(f);
});
test('request cancellation cancels a late response without saving a connection', async t => {
  const f = fixture(t),
    controller = new AbortController();
  let release,
    reached,
    cancelled = 0;
  const gate = new Promise(r => {
      release = r;
    }),
    entered = new Promise(r => {
      reached = r;
    });
  f.respond(async () => {
    reached();
    await gate;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      {headers: {'content-type': 'application/json'}},
    );
  });
  const pending = setup(f, wooConnectionInput(), {signal: controller.signal});
  await entered;
  controller.abort();
  await assert.rejects(pending, {code: 'WOOCOMMERCE_CONNECTION_UNAVAILABLE'});
  release();
  await new Promise(r => setImmediate(r));
  assert.equal(cancelled, 1);
  noArtifacts(f);
});
test('an identical explicit retry recovers the original verification without a store request, duplicate audit or connection', async t => {
  const f = fixture(t),
    first = await setup(f),
    second = await setup(f);
  assert.equal(second.replayed, true);
  assert.equal(second.network_requests, 0);
  assert.equal(second.collected_bytes, 0);
  assert.equal(second.verified_at, first.verified_at);
  assert.equal(second.account_id, first.account_id);
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.listConnections(f.actor.tenantId).length, 1);
  assert.equal(f.store.audit(f.actor.tenantId).length, 1);
});
for (const patch of [
  {consumer_secret: 'cs_different'},
  {label: 'Another'},
  {store_origin: 'https://other.example.test'},
])
  test('the same request ID cannot replace a saved store ' + Object.keys(patch).join(), async t => {
    const f = fixture(t);
    const first = await setup(f);
    await assert.rejects(setup(f, wooConnectionInput(patch)), {code: 'WOOCOMMERCE_CONNECTION_CONFLICT'});
    assert.equal(f.calls.length, 3);
    assert.equal(f.store.listConnections(f.actor.tenantId)[0].label, first.label);
  });
test('disabled, changed, credential-replaced, proof-removed or disconnected stores cannot be resurrected by setup retry', async t => {
  for (const kind of ['disabled', 'grant', 'credentials', 'proof', 'disconnect']) {
    const f = fixture(t);
    await setup(f);
    const c = f.store.listConnections(f.actor.tenantId)[0];
    if (kind === 'disabled')
      f.store.putConnection(f.actor, {...c, enabled: false}, f.store.credentials(f.actor.tenantId, c.id));
    if (kind === 'grant')
      f.store.putConnection(f.actor, {...c, writeAccounts: c.accounts}, f.store.credentials(f.actor.tenantId, c.id));
    if (kind === 'credentials')
      f.store.replaceCredentials(f.actor.tenantId, c.id, {consumerKey: 'ck_other', consumerSecret: 'cs_other'});
    if (kind === 'proof') f.store.deleteDocument(f.actor.tenantId, 'website_connection', c.id);
    if (kind === 'disconnect') disconnectLocalConnection(f.store, f.actor, c.gateway, c.id, 'website');
    await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_CONFLICT'});
    assert.equal(f.calls.length, 3);
    if (kind === 'disconnect') {
      assert.equal(f.store.listConnections(f.actor.tenantId).length, 0);
      assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 0);
    }
  }
});
test('per-workspace admission refuses a simultaneous setup and releases its locks after success', async t => {
  const f = fixture(t);
  let release, reached;
  const gate = new Promise(r => {
      release = r;
    }),
    entered = new Promise(r => {
      reached = r;
    });
  f.respond(async (url, options, n, native) => {
    if (n === 1) {
      reached();
      await gate;
    }
    return native(url);
  });
  const first = setup(f);
  await entered;
  try {
    await assert.rejects(setup(f), {code: 'WOOCOMMERCE_SETUP_BUSY'});
    assert.equal(f.calls.length, 1);
  } finally {
    release();
  }
  await first;
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM service_locks').get().count, 0);
});
test('two simultaneous tenants sharing origin and request ID retain separate encrypted keys and proofs', async t => {
  const f = fixture(t);
  let release,
    count = 0,
    reached;
  const gate = new Promise(r => {
      release = r;
    }),
    entered = new Promise(r => {
      reached = r;
    });
  f.respond(async (url, options, n, native) => {
    if (url.pathname.includes('/settings/') && n <= 2) {
      if (++count === 2) reached();
      await gate;
    }
    return native(url);
  });
  const other = {...f.actor, tenantId: 'synthetic-other-setup'},
    input = wooConnectionInput({consumer_key: 'ck_second', consumer_secret: 'cs_second'}),
    one = setup(f),
    two = connectWooCommerce(f.store, other, input, {request: f.request});
  await entered;
  release();
  const results = await Promise.all([one, two]);
  assert.equal(f.calls.length, 6);
  assert.equal(results[0].account_id, results[1].account_id);
  assert.equal(f.store.credentials(f.actor.tenantId, connectionId).consumerSecret, 'cs_setupSyntheticSecret');
  assert.equal(f.store.credentials(other.tenantId, connectionId).consumerSecret, 'cs_second');
  assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 1);
  assert.equal(f.store.documents(other.tenantId, 'website_connection').length, 1);
  assert.equal(new Set(f.calls.map(c => c.options.headers.Authorization)).size, 2);
});

test('four shared setup slots admit simultaneous tenants while a fifth is refused before any key egress', async t => {
  const f = fixture(t);
  let release,
    reached,
    arrivals = 0;
  const gate = new Promise(r => {
      release = r;
    }),
    entered = new Promise(r => {
      reached = r;
    });
  f.respond(async (url, options, n, native) => {
    if (n <= 4) {
      if (++arrivals === 4) reached();
      await gate;
    }
    return native(url);
  });
  const pending = Array.from({length: 4}, (_, i) =>
    connectWooCommerce(f.store, {...f.actor, tenantId: 'synthetic-slot-' + i}, wooConnectionInput(), {
      request: f.request,
    }),
  );
  try {
    await entered;
    await assert.rejects(
      connectWooCommerce(f.store, {...f.actor, tenantId: 'synthetic-slot-fifth'}, wooConnectionInput(), {
        request: f.request,
      }),
      {code: 'WOOCOMMERCE_SETUP_BUSY', status: 429},
    );
    assert.equal(f.calls.length, 4);
    assert.equal(f.store.listConnections('synthetic-slot-fifth').length, 0);
  } finally {
    release();
    await Promise.allSettled(pending);
  }
  assert.equal((await Promise.all(pending)).length, 4);
  assert.equal(f.calls.length, 12);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM service_locks').get().count, 0);
});

test('the 50-store workspace bound refuses a new setup without overwriting any encrypted connection', async t => {
  const f = fixture(t);
  for (let i = 0; i < 50; i++)
    f.store.putConnection(
      f.actor,
      {
        id: 'synthetic-old-' + i,
        tenantId: f.actor.tenantId,
        gateway: 'commerce_native_action',
        accounts: ['synthetic-binding-' + i],
        label: 'Existing ' + i,
        enabled: true,
        apiVersion: 'wc/v3',
        baseUrl: 'https://shop.example.test',
        scopes: ['read'],
        writeAccounts: [],
      },
      {consumerKey: 'ck_old', consumerSecret: 'cs_old'},
    );
  const before = JSON.stringify(f.store.db.prepare('SELECT * FROM connections ORDER BY id').all());
  await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_LIMIT'});
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM connections ORDER BY id').all()), before);
  assert.equal(f.store.documents(f.actor.tenantId, 'website_connection').length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM service_locks').get().count, 0);
});

test('all three reads share the byte bound even when each response individually fits', async t => {
  const f = fixture(t);
  f.respond(
    (url, options, n, native) =>
      new Response(
        ' '.repeat(140000) +
          (url.pathname.includes('/settings/')
            ? JSON.stringify({id: 'woocommerce_currency', value: 'SAR'})
            : JSON.stringify([{id: 1, status: 'publish'}])),
        {
          headers: {
            'content-type': 'application/json',
            ...(url.pathname.endsWith('/products') ? {'x-wp-total': '1', 'x-wp-totalpages': '1'} : {}),
          },
        },
      ),
  );
  await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_INCOMPLETE'});
  assert.equal(f.calls.length, 2);
  noArtifacts(f);
});

test('authority withdrawn while a response stream is read cancels its body and prevents any further native request', async t => {
  const f = fixture(t);
  let active = true,
    cancelled = 0;
  f.store.bindActorCheck(f.actor, () => {
    if (!active) throw new MirrorError('UNAUTHORIZED', 'Synthetic authority withdrawn', {}, 401);
  });
  f.respond(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            active = false;
            controller.enqueue(new TextEncoder().encode('{"id":"woocommerce_currency","value":"SAR"}'));
          },
          cancel() {
            cancelled++;
          },
        }),
        {headers: {'content-type': 'application/json'}},
      ),
  );
  await assert.rejects(setup(f), {code: 'UNAUTHORIZED'});
  assert.equal(f.calls.length, 1);
  assert.equal(cancelled, 1);
  noArtifacts(f);
});

test('a lost shared admission lease stops setup at the response and cannot save or retry it', async t => {
  const f = fixture(t);
  let cancelled = 0;
  f.respond(() => {
    f.store.db.prepare("DELETE FROM service_locks WHERE key LIKE 'woocommerce-setup-slot:%'").run();
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      {headers: {'content-type': 'application/json'}},
    );
  });
  await assert.rejects(setup(f), {code: 'WOOCOMMERCE_CONNECTION_CONFLICT'});
  assert.equal(f.calls.length, 1);
  assert.equal(cancelled, 1);
  noArtifacts(f);
});
