import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {surfaceFixture} from '../tools/measure-tool-list.mjs';

// MCP-05: help described a captured 20-tool surface, answered an unknown operation with the whole gateway's help as a
// success, came in three envelopes, echoed 346 enum values on a DV360 typo and failed resource/prompt lookups as -32603.
async function connected(allowWrites = true) {
  const f = surfaceFixture({allowWrites}),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'Synthetic help evaluator', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const wire = [],
    receive = a.onmessage;
  a.onmessage = (message, extra) => {
    wire.push(message);
    receive?.(message, extra);
  };
  const call = async (name, args) => {
    const r = await client.callTool({name, arguments: args});
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assert.equal(r.isError === true, r.structuredContent.success === false);
    return r.structuredContent;
  };
  return {
    f,
    client,
    wire,
    call,
    close: async () => {
      await client.close();
      await server.close();
      f.close();
    },
  };
}
const help = (c, args) => c.call('amcp_tool_help', args);

test('root help reports the live surface in both modes, and help answers for every listed tool', async () => {
  for (const allowWrites of [false, true]) {
    const c = await connected(allowWrites);
    try {
      const tools = (await c.client.listTools()).tools,
        root = await help(c, {});
      assert.equal(root.success, true);
      assert.equal(typeof root.meta.requestId, 'string');
      // The captured block stays for compatibility; the live block counts what tools/list shows.
      assert.equal(root.data.surface, 'compact-v1');
      assert.equal(root.data.tool_count, 20);
      assert.equal(root.data.amcp_surface.tool_count, tools.length);
      assert.deepEqual(
        root.data.amcp_surface.tools.map(t => t.name),
        tools.map(t => t.name),
      );
      assert.ok(root.data.amcp_surface.tools.some(t => t.name === 'microsoft_ads_native_action'));
      assert.equal(root.data.amcp_surface.tools.find(t => t.name === 'amcp_workspace').kind, 'amcp_workflow');
      assert.equal(root.data.amcp_surface.tools.find(t => t.name === 'reddit_native_action').selector, 'operation');
      assert.match(root.data.amcp_surface.surface_revision, /^[0-9a-f]{16}$/);
      for (const tool of tools) {
        const out = await help(c, {gateway: tool.name});
        assert.equal(out.success, true, tool.name + ' ' + JSON.stringify(out.error));
        assert.equal(out.data.success, undefined, tool.name);
        assert.equal(typeof out.meta.requestId, 'string');
      }
      assert.equal(c.f.requests.length, 0);
    } finally {
      await c.close();
    }
  }
});
test('operation help describes each catalog action or refuses the name; it never falls back to gateway help', async () => {
  const c = await connected();
  try {
    for (const gateway of [
      'tiktok_native_action',
      'snapchat_native_action',
      'dv360_native_action',
      'linkedin_native_action',
      'x_ads_native_action',
    ]) {
      const whole = JSON.stringify(await help(c, {gateway})),
        catalog = c.f.service.registry.catalogs.get(gateway);
      for (const action of catalog.actions) {
        const out = await help(c, {gateway, operation: action.name}),
          text = JSON.stringify(out);
        assert.equal(out.success, true, gateway + ' ' + action.name);
        assert.notEqual(text, whole);
        assert.ok(text.length < whole.length, gateway + ' ' + action.name);
      }
      const bogus = await help(c, {gateway, operation: catalog.actions[0].name + '_typo'});
      assert.equal(bogus.success, false);
      assert.equal(bogus.error.code, 'UNKNOWN_OPERATION');
      assert.equal(bogus.error.details.value, catalog.actions[0].name + '_typo');
      assert.ok(bogus.error.details.did_you_mean.includes(catalog.actions[0].name));
      assert.ok(bogus.error.details.allowed.length <= 20);
      assert.equal(bogus.error.details.count >= catalog.actions.length, true);
      assert.equal(bogus.error.details.list_call.arguments.action, 'LIST_ACTIONS');
      assert.ok(Buffer.byteLength(JSON.stringify(bogus)) < 3000);
      assert.match(bogus.error.next_action, /details\.list_call/);
    }
    // First-party tools have operation help too, and refuse an unknown action the same way.
    const own = await help(c, {gateway: 'amcp_workspace', operation: 'capabilities'});
    assert.match(own.data.detail, /capabilities/);
    assert.ok(own.data.arguments.view);
    const unknown = await help(c, {gateway: 'amcp_workspace', operation: 'capabilites'});
    assert.equal(unknown.error.code, 'UNKNOWN_OPERATION');
    assert.ok(unknown.error.details.did_you_mean.includes('capabilities'));
    const gateway = await help(c, {gateway: 'meta_native_actoin'});
    assert.equal(gateway.error.code, 'UNKNOWN_GATEWAY');
    assert.ok(gateway.error.details.did_you_mean.includes('meta_native_action'));
    assert.equal(c.f.requests.length, 0);
  } finally {
    await c.close();
  }
});
test('introspection shares the envelope, pages alike, and DV360 gains LIST_ACTIONS and DESCRIBE_ACTION', async () => {
  const c = await connected();
  try {
    const meta = await c.call('meta_native_action', {action: 'LIST_ACTIONS', limit: 2});
    assert.equal(meta.data.success, undefined);
    assert.deepEqual(
      [meta.data.total, meta.data.offset, meta.data.limit, meta.data.has_more, meta.data.next_offset],
      [meta.data.total_actions, 0, 2, true, 2],
    );
    const snapchat = await c.call('snapchat_native_action', {action: 'LIST_ACTIONS', limit: 3, cursor: 3});
    assert.deepEqual(
      [snapchat.data.offset, snapchat.data.limit, snapchat.data.has_more, snapchat.data.next_offset],
      [3, 3, true, 6],
    );
    assert.equal(snapchat.data.next_cursor, 6, 'the captured cursor stays as an alias');
    const described = await c.call('meta_native_action', {
      action: 'DESCRIBE_ACTION',
      target_action: 'meta_ad_account_id_campaigns_get',
    });
    assert.equal(described.data.success, undefined);
    assert.equal(typeof described.meta.requestId, 'string');
    const dv = await c.call('dv360_native_action', {action: 'LIST_ACTIONS', search: 'ADVERTISERS', limit: 5});
    assert.equal(dv.success, true, JSON.stringify(dv.error));
    assert.equal(dv.data.has_more, true);
    assert.equal(dv.data.actions.length, 5);
    assert.ok(dv.data.actions.every(a => a.contract_status));
    const advertiser = await c.call('dv360_native_action', {
      action: 'DESCRIBE_ACTION',
      target_action: 'DV360_ADVERTISERS_GET',
    });
    assert.equal(advertiser.data.action, 'DV360_ADVERTISERS_GET');
    assert.ok(Buffer.byteLength(JSON.stringify(advertiser)) < 5 * 1024);
    // A misspelt DV360 action used to echo all 346 enum values (15.5 KB); it now names the field and the way forward.
    const typo = await c.call('dv360_native_action', {action: 'DV360_ADVERTISER_GETT'});
    assert.equal(typo.error.code, 'INVALID_ARGUMENT');
    assert.equal(typo.error.details.field, 'action');
    assert.match(typo.error.message, /: action\.$/);
    assert.ok(Buffer.byteLength(JSON.stringify(typo)) < 3000, String(JSON.stringify(typo).length));
    assert.equal(typo.error.details.errors[0].allowed_count, 346);
    assert.ok(typo.error.details.did_you_mean.includes('DV360_ADVERTISERS_GET'));
    assert.equal(typo.error.details.list_call.arguments.action, 'LIST_ACTIONS');
    assert.match(typo.error.details.surface_revision, /^[0-9a-f]{16}$/);
    assert.match(typo.error.next_action, /list the tools again/);
    // Amazon Ads is not offered by default (CON-06): the call is refused before its action is read.
    assert.equal(
      (await c.call('amazon_native_action', {action: 'amazon_no_such_action'})).error.code,
      'GATEWAY_NOT_OFFERED',
    );
    // Amazon and Apple have no verified LIST_ACTIONS: where a deployment offers Amazon (AMCP_PROVIDERS=amazon), the
    // refusal points at the local contracts ledger instead.
    const previous = process.env.AMCP_PROVIDERS;
    process.env.AMCP_PROVIDERS = 'amazon';
    let amazon;
    try {
      amazon = await c.call('amazon_native_action', {action: 'amazon_no_such_action'});
    } finally {
      if (previous === undefined) delete process.env.AMCP_PROVIDERS;
      else process.env.AMCP_PROVIDERS = previous;
    }
    assert.equal(amazon.error.code, 'UNKNOWN_ACTION');
    assert.equal(amazon.error.details.field, 'action');
    assert.deepEqual(amazon.error.details.list_call, {
      tool: 'amcp_workspace',
      arguments: {action: 'contracts', gateway: 'amazon_native_action', search: 'amazon'},
    });
    assert.ok(Buffer.byteLength(JSON.stringify(amazon)) < 3000);
    const unknown = await c.call('meta_native_action', {
      action: 'DESCRIBE_ACTION',
      target_action: 'meta_campaign_gett',
    });
    assert.equal(unknown.error.code, 'UNKNOWN_ACTION');
    assert.equal(unknown.error.details.field, 'target_action');
    assert.equal(c.f.requests.length, 0);
  } finally {
    await c.close();
  }
});
test('unknown guides and prompts preserve wire codes, and serverInfo names this build', async () => {
  const c = await connected();
  try {
    await assert.rejects(c.client.readResource({uri: 'amcp://guides/nothing'}), e => {
      // SDK v2 reconstructs a ResourceNotFoundError after receipt, normalizing its code and retaining only the URI.
      assert.equal(e.code, -32602);
      assert.equal(e.data.uri, 'amcp://guides/nothing');
      return true;
    });
    const missing = c.wire.find(message => message.error?.data?.uri === 'amcp://guides/nothing');
    assert.ok(missing, 'The legacy missing-guide reply is captured before SDK client normalization');
    assert.equal(missing.error.code, -32002);
    assert.equal(missing.error.data.uri, 'amcp://guides/nothing');
    assert.equal(missing.error.data.index, 'amcp://guides/index');
    await assert.rejects(c.client.getPrompt({name: 'amcp_unknown', arguments: {}}), e => {
      assert.equal(e.code, -32602);
      assert.deepEqual(e.data.allowed, ['amcp_build_campaign']);
      return true;
    });
    await assert.rejects(c.client.getPrompt({name: 'amcp_build_campaign', arguments: {platform: 'myspace'}}), e => {
      assert.equal(e.code, -32602);
      assert.ok(e.data.allowed.platform.includes('meta'));
      return true;
    });
    const record = JSON.parse(fs.readFileSync('dist/release-identity.json', 'utf8')),
      build = record.source_revision ? record.source_revision.slice(0, 12) : 'sha256.' + record.sha256.slice(0, 12);
    assert.equal(c.client.getServerVersion().version, '0.1.0+' + build);
    const root = await help(c, {});
    assert.equal(root.data.amcp_release.version, c.client.getServerVersion().version);
    assert.equal(root.data.amcp_release.artifact_sha256, record.sha256);
  } finally {
    await c.close();
  }
});
