import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {gtmConsentFixture, gateway} from './fixtures/gtm-consent-data.mjs';

test('real MCP client previews explicit Tag Manager consent additions, saves an unapproved draft and refuses revoked access', async t => {
  const f = gtmConsentFixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic consent draft evaluator', version: '1.0.0'});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  let calls = 0,
    bytes = 0;
  try {
    const tools = (await client.listTools()).tools,
      ajv = new Ajv({strict: false}),
      schemas = new Map(tools.filter(t => t.name.startsWith('amcp_')).map(t => [t.name, ajv.compile(t.inputSchema)]));
    assert.match(tools.find(t => t.name === 'amcp_workspace').description, /preview_consent_plan/);
    const call = async (name, args) => {
      const valid = schemas.get(name);
      assert.equal(valid(args), true, JSON.stringify(valid.errors));
      const out = await client.callTool({name, arguments: args});
      calls++;
      bytes += Buffer.byteLength(JSON.stringify(out.structuredContent));
      assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent);
      assert.equal(out.isError === true, out.structuredContent.success === false);
      return out.structuredContent;
    };
    const preview = await call('amcp_workspace', {
      action: 'preview_consent_plan',
      gateway,
      connection_id: f.connection.id,
      account_id: '44',
      requirements: f.requirements,
    });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.doesNotMatch(JSON.stringify(preview), /PRIVATE-SYNTHETIC-SCRIPT|accessToken|authorization_signature/);
    const saved = await call('amcp_workspace', {
      action: 'create_consent_plan',
      preview_id: preview.data.preview_id,
      preview_hash: preview.data.preview_hash,
      confirmed: true,
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    const detail = await call('amcp_campaign', {action: 'get', id: saved.data.id});
    assert.equal(detail.success, true);
    assert.equal(detail.data.state, 'draft');
    assert.deepEqual(detail.data.gtm_consent.scope.tag_ids, ['001', '002']);
    assert.doesNotMatch(JSON.stringify(detail), /PRIVATE-SYNTHETIC-SCRIPT|authorization_signature/);
    f.store.revokeKey(f.key);
    const revoked = await call('amcp_campaign', {action: 'get', id: saved.data.id});
    assert.equal(revoked.success, false);
    assert.equal(f.requests.length, 12);
    assert.ok(f.requests.every(r => r.method === 'GET'));
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
