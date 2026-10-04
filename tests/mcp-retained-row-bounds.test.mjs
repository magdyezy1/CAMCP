import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {retainedEvidence, evidenceId, evidenceConnection} from './fixtures/retained-evidence-data.mjs';

test('real MCP retained row bounds, search and downloads preserve exact source identity and current revocation', async t => {
  const owner = {tenantId: 'synthetic-retained-mcp', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 162).toString('base64'));
  store.putConnection(
    owner,
    {
      id: evidenceConnection,
      tenantId: owner.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic retained source',
      scopes: [],
    },
    {accessToken: 'synthetic-retained-key'},
  );
  const original = retainedEvidence();
  store.putDocument(owner.tenantId, 'decision_report', evidenceId, original);
  let requests = 0,
    calls = 0,
    bytes = 0;
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        requests++;
        throw Error('Retained reads forbid provider egress');
      }),
      undefined,
      {allowWrites: false},
    ),
    key = store.createKey(owner),
    actor = store.authenticate(key),
    server = createMcpServer(service, actor),
    client = new Client({name: 'Synthetic retained evidence evaluator', version: '1.0.0'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const tools = (await client.listTools()).tools,
      validate = new Ajv({strict: false}).compile(tools.find(tool => tool.name === 'amcp_reporting').inputSchema);
    const call = async args => {
      const input = {action: 'get', id: evidenceId, ...args};
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const out = await client.callTool({name: 'amcp_reporting', arguments: input});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), JSON.parse(JSON.stringify(out.structuredContent)));
      assert.equal(out.isError === true, out.structuredContent.success === false);
      assert.doesNotMatch(JSON.stringify(out.structuredContent), /synthetic-retained-key/);
      return out.structuredContent;
    };
    const first = await call({offset: 0, limit: 25});
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.data.rows.length, 25);
    assert.equal(first.data.row_count, 151);
    assert.equal(first.data.rows[0].entity_id, original.rows[0].entity_id);
    assert.equal(first.data.rows[0].spend, original.rows[0].spend);
    assert.equal(first.data.rows[0].conversions, null);
    const filtered = await call({offset: 0, limit: 10, row_query: 'Home <img> 100'});
    assert.equal(filtered.data.matched_row_count, 1);
    assert.equal(filtered.data.row_count, 151);
    assert.equal(filtered.data.rows[0].entity_id, original.rows[100].entity_id);
    assert.deepEqual(filtered.data.totals, original.totals);
    assert.equal(filtered.data.source_hash, original.source_hash);
    assert.equal(filtered.data.xlsx_path, '/api/reporting-evidence/' + evidenceId + '.xlsx');
    const last = await call({offset: 150, limit: 100});
    assert.equal(last.data.rows.length, 1);
    assert.equal(last.data.has_more, false);
    assert.equal(last.data.rows[0].entity_id, original.rows[150].entity_id);
    store.revokeKey(key);
    assert.equal((await call({offset: 25, limit: 25})).success, false);
    assert.equal(requests, 0);
    assert.equal(store.documents(owner.tenantId, 'write_review').length, 0);
    t.diagnostic(
      JSON.stringify({
        tool_calls: calls,
        structured_response_bytes: bytes,
        retained_rows: 151,
        synthetic_native_reads: requests,
        provider_mutations: 0,
        external_requests: 0,
      }),
    );
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});
