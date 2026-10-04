import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {linkedinPortfolioFixture, linkedinPortfolioGateway} from './fixtures/linkedin-portfolio-data.mjs';

test('real MCP inventory journey preserves LinkedIn shared budgets and native precision without additional reads or writes', async t => {
  const f = linkedinPortfolioFixture(t);
  f.setChange((body, route) => {
    const dynamic = row => ({
      ...row,
      dailyBudget: {amount: '90.000001', currencyCode: 'USD'},
      budgetOptimization: {
        budgetOptimizationStrategy: 'DYNAMIC',
        bidStrategy: 'MAX_DELIVERY',
        privatePolicy: 'PRIVATE-POLICY',
      },
    });
    if (route === '/adCampaignGroups') body.elements = body.elements.map(dynamic);
    if (route === '/adCampaignGroups/10') body = dynamic(body);
    return body;
  });
  const server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic LinkedIn portfolio evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const descriptor = (await client.listTools()).tools.find(t => t.name === 'amcp_workspace'),
      validate = new Ajv({strict: false}).compile(descriptor.inputSchema),
      input = {
        action: 'portfolio',
        gateway: linkedinPortfolioGateway,
        account_id: '100',
        connection_id: f.connection.id,
        limit: 2,
      };
    const call = async additions => {
      const args = {...input, ...additions};
      assert.equal(validate(args), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name: 'amcp_workspace', arguments: args});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /PRIVATE-|accessToken|privatePolicy/);
      return out.structuredContent;
    };
    const ok = out => {
        assert.equal(out.success, true, JSON.stringify(out));
        return out.data;
      },
      first = ok(await call({}));
    assert.equal(first.rows[0].budget_context.mode, 'group_dynamic');
    assert.equal(first.rows[0].native_money.dailyBudget.amount, '90.000001');
    assert.equal(first.rows[0].native_money.totalBudget.amount, '123456789012345678.90');
    assert.deepEqual(
      ok(await call({cursor: first.next_cursor})).rows.map(r => r.id),
      ['30'],
    );
    const campaigns = ok(await call({requirements: {entity: 'campaign', campaign_group_id: '10'}}));
    assert.equal(campaigns.rows[0].budget_context.mode, 'group_dynamic');
    assert.equal(campaigns.rows[0].budget_context.group_id, '10');
    assert.equal(campaigns.rows[0].budget_context.group_daily_budget.amount, '90.000001');
    assert.equal(campaigns.rows[0].native_money.dailyBudget.amount, '80.25');
    assert.match(campaigns.meaning, /do not establish effective spend or budget-edit eligibility/);
    const creatives = ok(await call({requirements: {entity: 'creative', campaign_group_id: '10', campaign_id: '201'}}));
    assert.equal(creatives.rows[0].budget_context, undefined);
    assert.equal(creatives.rows[0].is_serving, false);
    assert.equal(f.requests.length, 11);
    assert.equal((await call({cursor: first.next_cursor + 'x'})).success, false);
    f.store.putConnection({...f.actor, role: 'admin'}, f.connection, {accessToken: 'synthetic-replacement'});
    assert.equal((await call({cursor: first.next_cursor})).success, false);
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {...f.connection, enabled: false},
      {accessToken: 'synthetic-replacement'},
    );
    assert.equal((await call({})).success, false);
    assert.equal(f.requests.length, 11);
    assert.ok(f.requests.every(r => r.init.method === 'GET'));
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        synthetic_provider_reads: f.requests.length,
        provider_mutations: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
  }
});
