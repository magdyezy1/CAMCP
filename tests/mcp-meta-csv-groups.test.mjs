import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
import {wooSourceFixture} from './fixtures/woocommerce-source-data.mjs';

test('real MCP keeps exact canonical and supplier Meta group intent in identical original unapproved drafts', async t => {
  const f = wooSourceFixture({role: 'operator'}),
    key = f.store.createKey(f.actor),
    actor = f.store.authenticate(key),
    browser = accountWorkflowFixture();
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: 'meta-login',
      tenantId: f.actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: [],
    },
    {accessToken: 'synthetic-meta-token'},
  );
  const server = createMcpServer(f.service, actor),
    client = new Client({name: 'Synthetic supplied group evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      validators = new Map(
        ['amcp_workspace', 'amcp_campaign'].map(name => [
          name,
          new Ajv({strict: false}).compile(tools.find(tool => tool.name === name).inputSchema),
        ]),
      );
    const call = async (name, input) => {
      const validate = validators.get(name);
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name, arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /synthetic-meta-token|consumerSecret|PRIVATE-COLUMN/);
      return out.structuredContent;
    };
    browser.context.csv =
      'retailer_id,name,price,currency,image_url,retailer_product_group_id\nVAR-001,Reviewed shoe,0012.34,SAR,https://example.test/child.png,GROUP-001\n';
    // COM-03: a supplier export is projected by AMCP with the catalog's saved mapping profile; the MCP client sends
    // the export as it is, and its unmapped private column is never returned.
    const supplier =
        'SKU,Title,Price,Image,Parent group,Ignored\nVAR-001,Reviewed shoe,0012.34,https://example.test/child.png,GROUP-001,PRIVATE-COLUMN\n',
      scope = {gateway: 'meta_native_action', connection_id: 'meta-login', account_id: '123', catalog_id: '555'};
    const mapping = await call('amcp_workspace', {
      action: 'save_catalog_mapping',
      ...scope,
      revision: 0,
      requirements: {
        columns: {
          retailer_id: 'SKU',
          name: 'Title',
          price: 'Price',
          image_url: 'Image',
          retailer_product_group_id: 'Parent group',
        },
        fixed_currency: 'SAR',
        image_mode: 'single',
      },
    });
    assert.equal(mapping.success, true, JSON.stringify(mapping));
    const variants = [
        {products: JSON.parse(JSON.stringify(browser.run('parseProductCSV(csv,"meta_native_action")')))},
        {requirements: {source: {kind: 'csv', text: supplier, columns: 'profile', profile_version: 1}}},
      ],
      plans = [];
    for (const variant of variants) {
      const input = {...scope, allow_upsert: false, ...variant};
      const preview = await call('amcp_workspace', {action: 'catalog_preview', ...input});
      assert.equal(preview.success, true, JSON.stringify(preview));
      assert.equal(preview.data.items[0].retailer_product_group_id, 'GROUP-001');
      assert.equal(preview.data.plan.steps[0].arguments.payload.price, 1234);
      const products = variant.products ?? preview.data.supplied_products;
      assert.equal(products[0].price, '0012.34');
      const saved = await call('amcp_workspace', {action: 'catalog_plan', ...input});
      assert.equal(saved.success, true, JSON.stringify(saved));
      assert.equal(saved.data.state, 'draft');
      assert.equal(saved.data.source_hash, preview.data.source_hash);
      const full = await call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
      assert.deepEqual(full.data.steps[0].arguments, preview.data.plan.steps[0].arguments);
      assert.equal(full.data.steps[0].status, 'pending');
      plans.push(full.data.steps[0].arguments);
    }
    assert.deepEqual(plans[0], plans[1]);
    assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
    f.store.revokeKey(key);
    assert.equal(
      (
        await call('amcp_workspace', {
          action: 'catalog_preview',
          gateway: 'meta_native_action',
          connection_id: 'meta-login',
          account_id: '123',
          catalog_id: '555',
          allow_upsert: false,
          products: variants[0].products,
        })
      ).success,
      false,
    );
    assert.equal(f.calls.length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_native_reads: 0,
        provider_mutations: 0,
        local_drafts: 2,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});
