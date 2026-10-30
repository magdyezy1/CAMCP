import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {
  inventoryProduct,
  inventoryResponse,
  wooInventoryFixture,
  wooInventoryInput,
} from './fixtures/woocommerce-inventory-data.mjs';
import {listedToolCount, offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

async function clients(t, f, actors) {
  const listener = await listenForFetch(createHttpApp(f.service, f.store, {authEnv: {}})),
    url = new URL('http://127.0.0.1:' + listener.address().port + '/mcp'),
    tokens = actors.map(actor => f.store.createKey(actor)),
    peers = actors.map((_, index) => new Client({name: 'Synthetic concurrent inventory ' + index, version: '1.0.0'}));
  t.after(async () => {
    await Promise.allSettled(peers.map(peer => peer.close()));
    listener.closeAllConnections();
    await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
    f.close();
  });
  await Promise.all(
    peers.map((peer, index) =>
      peer.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {headers: {Authorization: 'Bearer ' + tokens[index]}},
        }),
      ),
    ),
  );
  const metrics = actors.map(() => ({tool_calls: 0, structured_response_bytes: 0})),
    schemas = await Promise.all(
      peers.map(async peer => {
        const descriptors = (await peer.listTools()).tools;
        // A read-only deployment also lists amcp_write with inspect only (owner decision D15, MCP-09). Amazon Ads (CON-06)
        // and Criteo (ARC-01, P9) are parked unless AMCP_PROVIDERS offers them; this suite offers WooCommerce (26 tools).
        assert.equal(descriptors.length, listedToolCount());
        return new Ajv({strict: false}).compile(descriptors.find(tool => tool.name === 'amcp_workspace').inputSchema);
      }),
    ),
    call = async (index, args) => {
      assert.equal(schemas[index](args), true, JSON.stringify(schemas[index].errors));
      const result = await peers[index].callTool({name: 'amcp_workspace', arguments: args}),
        out = result.structuredContent;
      metrics[index].tool_calls++;
      metrics[index].structured_response_bytes += Buffer.byteLength(JSON.stringify(out));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(out)));
      assert.equal(result.isError === true, out.success === false);
      for (const secret of [
        'ck_synthetickey',
        'cs_syntheticsecret',
        'ck_secondsynthetic',
        'cs_secondsynthetic',
        ...tokens,
      ])
        assert.equal(JSON.stringify(result).includes(secret), false, 'Credentials must not enter a protocol result');
      assert.doesNotMatch(JSON.stringify(result), /UNUSED-PRIVATE-WOO|UNUSED-PRIVATE-INVENTORY/);
      return out;
    };
  return {peers, tokens, call, metrics};
}

function noArtifacts(f, tenants) {
  for (const tenant of tenants)
    for (const kind of ['campaign_run', 'campaign_plan', 'decision_report', 'write_review', 'catalog_source_snapshot'])
      assert.equal(f.store.documents(tenant, kind).length, 0);
  assert.ok(f.calls.every(request => (request.options.method ?? 'GET') === 'GET'));
  assert.ok(f.calls.every(request => request.options.body === undefined));
}

test(
  'two real HTTP MCP clients reconcile separate inventories concurrently with identical native account and product IDs',
  {timeout: 30000},
  async t => {
    const f = wooInventoryFixture({products: [inventoryProduct(101)]}),
      second = {tenantId: 'synthetic-concurrent-second', userId: 'synthetic-reader', role: 'reader'};
    f.store.putConnection(
      {...second, role: 'admin'},
      {
        ...f.connection,
        tenantId: second.tenantId,
        label: 'Second synthetic store',
      },
      {consumerKey: 'ck_secondsynthetic', consumerSecret: 'cs_secondsynthetic'},
    );
    const connected = await clients(t, f, [f.actor, second]),
      lanes = new Map([
        [
          'Basic ' + Buffer.from('ck_synthetickey:cs_syntheticsecret').toString('base64'),
          {name: 'First tenant product', currency: 'SAR', price: '0001.234500', reads: 0},
        ],
        [
          'Basic ' + Buffer.from('ck_secondsynthetic:cs_secondsynthetic').toString('base64'),
          {name: 'Second tenant product', currency: 'USD', price: '0009.876500', reads: 0},
        ],
      ]);
    let release,
      waiting = 0,
      peak = 0;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    f.inventoryRespond(async (url, options, _attempt, native) => {
      const lane = lanes.get(new Headers(options.headers).get('authorization'));
      assert.ok(lane, 'Only the exact synthetic tenant credential can read this collection');
      lane.reads++;
      if (lane.reads === 1) {
        waiting++;
        peak = Math.max(peak, waiting);
        if (waiting === 2) release();
        await gate;
        waiting--;
      }
      const response = native(url);
      if (url.pathname.endsWith('/woocommerce_currency'))
        return new Response(JSON.stringify({id: 'woocommerce_currency', value: lane.currency}), {
          headers: {'content-type': 'application/json'},
        });
      const rows = await response.json();
      rows[0].name = lane.name;
      rows[0].price = lane.price;
      return inventoryResponse(rows, 1, 1);
    });
    const discovery = await Promise.all([
      connected.call(0, {action: 'catalog_sources'}),
      connected.call(1, {action: 'catalog_sources'}),
    ]);
    assert.ok(discovery.every(out => out.success && out.data.items.length === 1));
    assert.equal(f.calls.length, 0);
    const started = performance.now(),
      results = await Promise.all([connected.call(0, wooInventoryInput()), connected.call(1, wooInventoryInput())]);
    assert.equal(peak, 2, 'Both native reads must be in flight together');
    for (const [index, expected] of [...lanes.values()].entries()) {
      const result = results[index];
      assert.equal(result.success, true);
      assert.equal(result.data.items.length, 1);
      assert.equal(result.data.items[0].product_id, '101');
      assert.equal(result.data.items[0].name, expected.name);
      assert.equal(result.data.items[0].selected_price, expected.price);
      assert.equal(result.data.native_currency, expected.currency);
      assert.equal(result.data.native_requests, 5);
      assert.equal(expected.reads, 5);
      assert.equal(result.data.source_saved, false);
      assert.equal(result.data.provider_mutations, 0);
      assert.equal(
        result.meta.workflow.website_path,
        '/commerce?woo_inventory=1&connection_id=woo-login&account_id=store-1&price_field=price',
      );
      assert.equal(JSON.stringify(result).includes(results[1 - index].data.items[0].name), false);
    }
    assert.notEqual(results[0].data.source_hash, results[1].data.source_hash);
    noArtifacts(f, [f.actor.tenantId, second.tenantId]);
    t.diagnostic(
      JSON.stringify({
        qualification:
          'two synthetic SDK clients on one real loopback HTTP endpoint; not external-client or live-provider acceptance',
        task: 'discovery then complete scoped inventory',
        clients: connected.metrics,
        native_reads: f.calls.length,
        simultaneous_native_reads: peak,
        task_elapsed_ms: performance.now() - started,
        provider_mutations: 0,
        saved_artifacts: 0,
        external_requests: 0,
      }),
    );
  },
);

test(
  'revoking one in-flight HTTP MCP caller cancels its body while a separate caller completes in the same workspace',
  {timeout: 30000},
  async t => {
    const f = wooInventoryFixture({products: [inventoryProduct(101)]}),
      connected = await clients(t, f, [f.actor, {...f.actor, userId: 'synthetic-second-reader'}]);
    let arrived,
      release,
      cancelled = 0;
    const pending = new Promise(resolve => {
        arrived = resolve;
      }),
      gate = new Promise(resolve => {
        release = resolve;
      });
    f.inventoryRespond(async (url, _options, attempt, native) => {
      if (attempt !== 2) return native(url);
      arrived();
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
    const revokedTask = connected.call(0, wooInventoryInput());
    await pending;
    try {
      const survivor = await connected.call(1, wooInventoryInput());
      assert.equal(survivor.success, true);
      assert.equal(survivor.data.items[0].product_id, '101');
      assert.equal(survivor.data.native_requests, 5);
      f.store.revokeKey(connected.tokens[0]);
    } finally {
      release();
      await Promise.allSettled([revokedTask]);
    }
    const revoked = await revokedTask;
    assert.equal(revoked.success, false);
    assert.equal(revoked.error.code, 'UNAUTHORIZED');
    assert.equal(revoked.data, undefined);
    assert.equal(cancelled, 1);
    assert.equal(f.calls.length, 7, 'The revoked scan makes no read after its current response');
    await assert.rejects(() => connected.peers[0].listTools());
    const next = await connected.call(1, {action: 'catalog_sources'});
    assert.equal(next.success, true);
    assert.equal(next.data.items.length, 1);
    assert.equal(f.calls.length, 7);
    noArtifacts(f, [f.actor.tenantId]);
    t.diagnostic(
      JSON.stringify({
        qualification: 'two synthetic SDK clients on one real loopback HTTP endpoint; no external client acceptance',
        clients: connected.metrics,
        native_reads: f.calls.length,
        revoked_reads: 2,
        successful_reads: 5,
        cancelled_bodies: cancelled,
        followup_native_reads: 0,
        provider_mutations: 0,
        saved_artifacts: 0,
        external_requests: 0,
      }),
    );
  },
);
