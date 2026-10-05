import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Introspection} from '../dist/src/introspection.js';
import {Registry} from '../dist/src/catalog.js';
import {portfolioRefusalFixture} from './fixtures/portfolio-refusal-data.mjs';
const cases = [
  {
    gateway: 'google_ads_native_action',
    operation: 'google_ads_v23_google_ads_search',
    version: 'v25',
    path: '/v25/customers/{customer_id=*}/googleAds:search',
  },
  {
    gateway: 'google_ads_native_action',
    operation: 'google_ads_v23_shareable_preview_generate_shareable_previews',
    version: 'v25',
    path: '/v25/customers/{customer_id=*}:generateShareablePreviews',
  },
  {
    gateway: 'meta_native_action',
    operation: 'meta_ad_account_id_campaigns_get',
    version: 'v26.0',
    path: '/v26.0/act_{ad_account_id}/campaigns',
  },
];
for (const mode of ['captured', 'catalog'])
  test(
    'real MCP ' + mode + ' operation help keeps current version, schema/text parity and zero native authority',
    async t => {
      const f = portfolioRefusalFixture('google'),
        server = createMcpServer(f.service, f.actor),
        client = new Client({name: 'Synthetic discovery version evaluator', version: '1'}),
        [a, b] = InMemoryTransport.createLinkedPair(),
        reference = new Introspection(new Registry());
      try {
        await Promise.all([server.connect(b), client.connect(a)]);
        const advertised = (await client.listTools()).tools.find(x => x.name === 'amcp_tool_help'),
          validate = new Ajv({strict: false}).compile(advertised.inputSchema);
        for (const spec of cases.filter(x =>
          mode === 'catalog' ? x.operation.includes('shareable_preview') : !x.operation.includes('shareable_preview'),
        )) {
          const args = {gateway: spec.gateway, operation: spec.operation},
            original = JSON.stringify(args);
          assert.equal(validate(args), true, JSON.stringify(validate.errors));
          const result = await client.callTool({name: 'amcp_tool_help', arguments: args}),
            out = result.structuredContent;
          assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(out)));
          assert.equal(result.isError === true, false);
          assert.equal(out.api_version, spec.version);
          assert.equal(out.path, spec.path);
          const described = reference.describe(spec.gateway, {target_action: spec.operation});
          assert.deepEqual(out.required_fields, described.required_fields);
          if (mode === 'catalog') assert.match(out.mirror_evidence, /unverified/);
          assert.equal(JSON.stringify(args), original);
        }
        assert.equal(f.requests.length, 0);
        for (const type of ['decision_report', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.actor.tenantId, type).length, 0);
        t.diagnostic(JSON.stringify({mode, native_reads: 0, provider_mutations: 0}));
      } finally {
        await client.close();
        await server.close();
        f.close();
      }
    },
  );
