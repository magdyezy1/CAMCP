import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {portfolioRefusalFixture} from './fixtures/portfolio-refusal-data.mjs';
for (const gateway of ['google_ads_native_action', 'meta_native_action'])
  test(
    'owned HTTP MCP ' + gateway + ' discovery uses effective metadata and still rejects a revoked caller',
    async () => {
      const f = portfolioRefusalFixture('google'),
        token = f.store.createKey(f.actor),
        listener = await listenForFetch(createHttpApp(f.service, f.store, {authEnv: {}})),
        client = new Client({name: 'Synthetic HTTP discovery version evaluator', version: '1'});
      const args =
        gateway === 'google_ads_native_action'
          ? {gateway, operation: 'google_ads_v23_shareable_preview_generate_shareable_previews'}
          : {gateway, operation: 'meta_ad_account_id_campaigns_get'};
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), {
            requestInit: {headers: {Authorization: 'Bearer ' + token}},
          }),
        );
        const result = await client.callTool({name: 'amcp_tool_help', arguments: args}),
          out = result.structuredContent;
        assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(out)));
        assert.equal(result.isError === true, false);
        // Help is wrapped in the one envelope (MCP-05); the captured descriptor is under data.
        assert.equal(out.success, true);
        assert.equal(out.data.api_version, gateway === 'google_ads_native_action' ? 'v25' : 'v26.0');
        assert.ok(out.data.path.startsWith(gateway === 'google_ads_native_action' ? '/v25/' : '/v26.0/'));
        if (gateway === 'google_ads_native_action') {
          assert.deepEqual(out.data.required_fields, ['customer_id', 'operation']);
          assert.match(out.data.mirror_evidence, /unverified/);
        }
        f.store.revokeKey(token);
        await assert.rejects(() => client.callTool({name: 'amcp_tool_help', arguments: args}));
        assert.equal(f.requests.length, 0);
        for (const type of ['decision_report', 'campaign_plan', 'write_review'])
          assert.equal(f.store.documents(f.actor.tenantId, type).length, 0);
      } finally {
        await client.close();
        listener.closeAllConnections();
        await new Promise((resolve, reject) => listener.close(error => (error ? reject(error) : resolve())));
        f.close();
      }
    },
  );
