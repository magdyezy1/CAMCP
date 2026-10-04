import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {setup, gateway, account} from './x-catalog-fixture.mjs';
import {lower, upper, action, catalog, exactCatalogProduct} from './fixtures/x-catalog-price-data.mjs';

test('real MCP preserves exact X prices, legacy receipt recovery, guarded caches and revoked client access', async t => {
  const f = setup({tenant: 'synthetic-x-price-sdk'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic X decimal recovery evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const descriptors = (await client.listTools()).tools,
      validators = new Map(
        ['amcp_write', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(descriptors.find(d => d.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      const validate = validators.get(name);
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      // Match the JSON-RPC wire value; the in-memory transport itself retains optional undefined properties.
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(
        JSON.stringify(out.structuredContent),
        /synthetic-token|consumerSecret|tokenSecret|accessToken/,
      );
      return out.structuredContent;
    };
    const input = exactCatalogProduct(upper, {id: 'sku-sdk', sale_price: lower});
    const p = await call('amcp_write', {
      action: 'prepare',
      gateway,
      connection_id: 'x',
      arguments: {action, account_id: account, params: catalog, payload: {products: [input]}},
    });
    assert.equal(p.success, true, JSON.stringify(p));
    assert.equal(p.data.creative_impact.creating.price.amount, '999999999999.000002');
    assert.equal(p.data.creative_impact.creating.sale_price.amount, '999999999999.000001');
    const execute = {
      action: 'execute',
      review_id: p.data.review_id,
      idempotency_key: p.data.idempotency_key,
      confirmed: true,
    };
    const accepted = await call('amcp_write', execute);
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    assert.deepEqual(f.calls.find(c => c.method === 'PUT').body, {products: [input]});
    f.store.putDocument(actor.tenantId, 'write_verification', p.data.review_id, {
      status: 'verified',
      checked_at: Date.now(),
      checks: [],
    });
    const verify = {action: 'verify', review_id: p.data.review_id};
    assert.equal((await call('amcp_campaign', verify)).data.status, 'inconclusive');
    const mismatch = await call('amcp_campaign', verify);
    assert.equal(mismatch.data.status, 'mismatch');
    assert.equal(mismatch.data.automatic_retry_of_mutation, false);
    assert.deepEqual(
      mismatch.data.checks[0].diff.map(d => d.expected),
      ['999999999999.000002', '999999999999.000001'],
    );
    const native = f.items[9001].find(r => r.id === 'sku-sdk');
    native.price = upper;
    native.sale_price = lower;
    assert.equal((await call('amcp_campaign', verify)).data.status, 'verified');
    const reads = f.calls.length;
    assert.equal((await call('amcp_campaign', verify)).data.cached, true);
    assert.equal(f.calls.length, reads);
    const replayed = await call('amcp_write', execute);
    assert.equal(replayed.data.replayed, true);
    assert.deepEqual(replayed.data.data, accepted.data.data);
    assert.equal(f.writes(), 1);
    f.store.revokeKey(key);
    assert.equal((await call('amcp_campaign', verify)).success, false);
    assert.equal(f.calls.length, reads);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_reads: f.calls.filter(c => c.method === 'GET').length,
        synthetic_provider_mutations: f.writes(),
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.store.close();
  }
});
