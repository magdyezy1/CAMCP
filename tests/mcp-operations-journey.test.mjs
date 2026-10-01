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
import {sha256, stable} from '../dist/src/security.js';
import {packFixture} from './fixtures/report-pack-data.mjs';

async function fixture(role = 'operator') {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  const identity = {tenantId: 'protocol-journey', userId: 'member', role};
  const key = store.createKey(identity),
    actor = store.authenticate(key);
  const source = {platform: 'meta', connection_id: 'meta', account_id: '100'};
  store.putConnection(
    {...identity, role: 'admin'},
    {
      id: 'meta',
      tenantId: identity.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      writeAccounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  let network = 0,
    calls = 0,
    bytes = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      network++;
      throw Error('Unexpected provider call');
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const server = createMcpServer(service, actor),
    client = new Client({name: 'AMCP synthetic workflow evaluator', version: '1.0.0'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv({strict: false}),
    schemas = new Map(tools.filter(t => t.name.startsWith('amcp_')).map(t => [t.name, ajv.compile(t.inputSchema)]));
  const call = async (tool, args) => {
    const valid = schemas.get(tool);
    assert.ok(valid, args.action);
    assert.equal(valid(args), true, JSON.stringify(valid.errors));
    const response = await client.callTool({name: tool, arguments: args});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(response.structuredContent));
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(response.isError === true, response.structuredContent.success === false);
    return response.structuredContent;
  };
  return {
    store,
    actor,
    key,
    source,
    service,
    call,
    tools,
    metrics: () => ({tool_calls: calls, structured_response_bytes: bytes, provider_requests: network}),
    close: async () => {
      await client.close();
      await server.close();
      store.close();
    },
  };
}
test('MCP capability → creative metadata → report presentation journey follows advertised schemas with zero provider calls', async t => {
  const f = await fixture();
  try {
    let r = await f.call('amcp_workspace', {
      action: 'capabilities',
      workflow_id: 'recipe:meta_website_traffic',
      connection_id: 'meta',
      account_id: '100',
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.workflows.length, 1);
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset', {
      ...f.source,
      review_id: 'asset',
      name: 'Launch image',
      media_id: 'image-native',
      sha256: sha256('synthetic'),
    });
    r = await f.call('amcp_media', {action: 'library', search: 'launch'});
    assert.equal(r.data.assets.length, 1);
    r = await f.call('amcp_media', {action: 'asset', asset_id: r.data.assets[0].asset_id});
    assert.equal(r.data.availability, 'requires_fresh_check');
    r = await f.call('amcp_media', {
      action: 'save_asset_metadata',
      asset_id: 'asset',
      revision: r.data.metadata_revision,
      confirmed: true,
      metadata: {name: 'Launch image', tags: ['approved']},
    });
    assert.deepEqual(r.data.tags, ['approved']);
    const report = packFixture();
    report.config.sources = [f.source];
    f.store.putDocument(f.actor.tenantId, 'overview_report', report.id, report);
    r = await f.call('amcp_reporting_overview', {action: 'report_pack', id: report.id});
    assert.equal(r.data.presentation_revision, 0);
    r = await f.call('amcp_reporting_overview', {
      action: 'save_presentation',
      id: report.id,
      presentation_revision: 0,
      confirmed: true,
      presentation: {brand_name: 'Synthetic brand'},
    });
    assert.equal(r.data.presentation_revision, 1);
    assert.ok(r.data.xlsx_path.endsWith('.xlsx'));
    assert.ok(r.data.pdf_path.endsWith('.pdf'));
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify(f.metrics()));
  } finally {
    await f.close();
  }
});
test('MCP tools/list → attention feed → original incident → snooze → resume uses exposed contracts and preserves authority', async t => {
  const f = await fixture();
  try {
    const incident = {
      ...f.source,
      id: 'incident',
      monitor_id: 'rule',
      monitor_name: 'Spend ceiling',
      state: 'open',
      metric: 'spend',
      value: 60,
      comparison: 'above',
      threshold: '50',
      currency: 'USD',
      timezone: 'UTC',
      result_definition: 'Purchases',
      attribution: '7-day click',
      updated_at: Date.now(),
      evidence: [],
    };
    f.store.putDocument(f.actor.tenantId, 'report_incident', incident.id, incident);
    assert.ok(
      f.tools.find(t => t.name === 'amcp_workspace').inputSchema.properties.action.enum.includes('snooze_incident'),
    );
    let r = await f.call('amcp_workspace', {action: 'operations', state: 'attention', limit: 1});
    assert.equal(r.success, true);
    assert.equal(r.meta.workflow.website_path, '/operations');
    let next = r.data.operations[0].next_call;
    r = await f.call(next.tool, next.arguments);
    assert.equal(r.meta.workflow.state, 'attention_required');
    assert.equal(r.meta.workflow.website_path, '/monitors?incident_id=incident');
    r = await f.call('amcp_workspace', {
      action: 'snooze_incident',
      id: r.data.id,
      revision: r.data.revision,
      snooze_hours: 4,
    });
    assert.equal(r.data.state, 'open');
    assert.equal(r.meta.workflow.state, 'deferred');
    const currentRevision = r.data.revision;
    r = await f.call('amcp_workspace', {action: 'operations', state: 'attention'});
    assert.equal(r.data.operations.length, 0);
    r = await f.call('amcp_workspace', {action: 'resume_incident', id: 'incident', revision: currentRevision});
    assert.equal(r.data.attention_state, 'open');
    r = await f.call('amcp_workspace', {action: 'acknowledge_incident', id: r.data.id, revision: r.data.revision});
    assert.equal(r.data.attention_state, 'acknowledged');
    f.store.revokeKey(f.key);
    r = await f.call('amcp_workspace', {action: 'incident', id: 'incident'});
    assert.equal(r.success, false);
    assert.equal(r.error.code, 'UNAUTHORIZED');
    assert.equal(f.metrics().provider_requests, 0);
    assert.equal(f.metrics().tool_calls, 7);
    assert.ok(f.metrics().structured_response_bytes < 15000);
    t.diagnostic(
      JSON.stringify({
        journey: 'incident-triage',
        ...f.metrics(),
        qualification: 'synthetic MCP SDK transport; no external client acceptance',
      }),
    );
  } finally {
    await f.close();
  }
});
test('MCP campaign and uncertain-upload handoffs inspect original work without approval or mutation', async t => {
  const f = await fixture();
  try {
    const created = await f.call('amcp_campaign', {
      action: 'create',
      name: 'Synthetic paused launch',
      brief: 'A protocol test only',
      steps: [
        {
          id: 'campaign',
          kind: 'write',
          gateway: 'meta_native_action',
          connection_id: 'meta',
          account_id: '100',
          arguments: {action: 'meta_campaign_create', payload: {name: 'Synthetic', status: 'PAUSED'}},
          depends_on: [],
        },
      ],
    });
    assert.equal(created.success, true, JSON.stringify(created));
    const plan = {
        ...f.source,
        name: 'Synthetic image',
        kind: 'image',
        mime: 'image/png',
        filename: 'fixture.png',
        size: 10,
        sha256: 'x'.repeat(64),
      },
      fingerprint = sha256(stable({tenant: f.actor.tenantId, user: f.actor.userId, plan}));
    f.store.putDocument(f.actor.tenantId, 'media_review', 'original-upload', {
      user_id: f.actor.userId,
      plan,
      fingerprint,
      expires_at: Date.now() + 300000,
      state_hash: 'state',
      state: {},
    });
    f.store.claim(f.actor.tenantId, 'original-upload', fingerprint);
    f.store.uncertain(f.actor.tenantId, 'original-upload');
    const feed = await f.call('amcp_workspace', {action: 'operations'});
    assert.equal(feed.success, true, JSON.stringify(feed));
    assert.equal(feed.data.operations.length, 2);
    for (const row of feed.data.operations) {
      assert.equal(row.next_call.arguments.confirmed, undefined);
      const original = await f.call(row.next_call.tool, row.next_call.arguments);
      assert.equal(original.success, true, JSON.stringify(original));
      assert.equal(original.meta.workflow.website_path, row.website_path);
      if (row.kind === 'upload') {
        assert.equal(original.data.review_id, 'original-upload');
        assert.equal(original.data.state, 'uncertain');
        assert.equal(original.data.can_execute, false);
        assert.equal(original.meta.workflow.automatic_retry_of_mutation, false);
      }
    }
    assert.equal(f.metrics().provider_requests, 0);
    assert.equal(f.metrics().tool_calls, 4);
    t.diagnostic(JSON.stringify({journey: 'inspect-original-work', ...f.metrics()}));
  } finally {
    await f.close();
  }
});
test('MCP viewer can inspect incident evidence but cannot acknowledge, snooze, resume or edit rules', async () => {
  const f = await fixture('reader');
  try {
    f.store.putDocument(f.actor.tenantId, 'report_incident', 'incident', {
      ...f.source,
      monitor_id: 'rule',
      state: 'open',
      updated_at: Date.now(),
    });
    const r = await f.call('amcp_workspace', {action: 'incident', id: 'incident'});
    assert.equal(r.success, true);
    for (const action of ['acknowledge_incident', 'snooze_incident', 'resume_incident']) {
      const denied = await f.call('amcp_workspace', {
        action,
        id: 'incident',
        revision: r.data.revision,
        ...(action === 'snooze_incident' ? {snooze_hours: 1} : {}),
      });
      assert.equal(denied.success, false);
      assert.equal(denied.error.code, 'FORBIDDEN');
    }
    assert.equal(f.metrics().provider_requests, 0);
  } finally {
    await f.close();
  }
});
