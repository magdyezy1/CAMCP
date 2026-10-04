import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {xCatalogComparisonFixture} from './fixtures/x-catalog-comparison.mjs';
import {product} from './x-catalog-fixture.mjs';

test('real MCP withholds malformed X identity read-back, recovers original accepted receipts and retires old caches without resubmission', async t => {
  let malformed = false;
  const f = xCatalogComparisonFixture({
      writable: true,
      tenant: 'synthetic-x-identity-sdk',
      read: ({request, result}) => {
        if (malformed && request.path.endsWith('/products')) result.data.data[0].product_key = 5000001;
      },
    }),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic X identity evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validate = new Map(
        ['amcp_write', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(d => d.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      const check = validate.get(name);
      assert.equal(check(input), true, JSON.stringify(check.errors));
      const result = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
      assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.structuredContent)));
      assert.equal(result.isError === true, result.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(result.structuredContent),
        /synthetic-token|consumerSecret|tokenSecret|accessToken/,
      );
      return result.structuredContent;
    };
    const {product_key, inventory, sale_price, item_group_id, additional_image_link, ...native} = product(1, {
      title: 'Changed source',
    });
    const original = structuredClone(native),
      prepared = await call('amcp_write', {
        action: 'prepare',
        gateway: 'x_ads_native_action',
        connection_id: 'x',
        arguments: {
          action: 'x_product_catalogs_product_catalog_id_products_put',
          account_id: 'acct1',
          params: {product_catalog_id: '9001'},
          payload: {products: [native]},
        },
      });
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 1200));
    const execute = {
        action: 'execute',
        review_id: prepared.data.review_id,
        idempotency_key: prepared.data.idempotency_key,
        confirmed: true,
      },
      accepted = await call('amcp_write', execute);
    assert.equal(accepted.success, true, JSON.stringify(accepted).slice(0, 1200));
    assert.equal(f.writes(), 1);
    assert.deepEqual(f.calls.find(c => c.method === 'PUT').body.products[0], original);
    const verify = {action: 'verify', review_id: prepared.data.review_id};
    malformed = true;
    const withheld = await call('amcp_campaign', verify);
    assert.equal(withheld.success, true);
    assert.equal(withheld.data.status, 'unverified');
    const recovered = await call('amcp_write', execute);
    assert.equal(recovered.success, true);
    assert.equal(recovered.data.replayed, true);
    assert.deepEqual(recovered.data.data, accepted.data.data);
    assert.equal(f.writes(), 1);
    malformed = false;
    const verified = await call('amcp_campaign', verify);
    assert.equal(verified.success, true);
    assert.equal(verified.data.status, 'verified');
    assert.equal(verified.data.verification_cache_version, 'x-catalog-identities-v3');
    const reads = f.calls.length;
    assert.equal((await call('amcp_campaign', verify)).data.cached, true);
    assert.equal(f.calls.length, reads);
    const old = f.store.document(actor.tenantId, 'write_verification', prepared.data.review_id);
    f.store.putDocument(actor.tenantId, 'write_verification', prepared.data.review_id, {
      ...old,
      verification_cache_version: 'x-catalog-decimal-v2',
    });
    const fresh = await call('amcp_campaign', verify);
    assert.equal(fresh.success, true);
    assert.equal(fresh.data.cached, undefined);
    assert.equal(fresh.data.status, 'verified');
    assert.ok(f.calls.length > reads);
    assert.equal(f.writes(), 1);
    f.store.revokeKey(key);
    const before = f.calls.length;
    assert.equal((await call('amcp_campaign', verify)).success, false);
    assert.equal(f.calls.length, before);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_gets: f.calls.filter(c => c.method === 'GET').length,
        synthetic_native_puts: f.writes(),
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.store.close();
  }
});
