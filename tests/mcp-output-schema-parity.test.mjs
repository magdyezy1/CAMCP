import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv} from 'ajv';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// MCP-07 (wave 4b MCP quality pass; mcp-builder guidance: define outputSchema and return structuredContent with the
// equivalent text; report tool errors inside results with actionable next steps). The outcome schema was checked for
// the AMCP tools only. Here a real MCP SDK client, which validates structuredContent against each listed outputSchema
// and throws on a mismatch, calls every tool of both deployment modes with a successful call and a refused one: the
// text block is the same JSON, isError is set exactly when success is false, and every refusal names its code,
// category, remedy, next action and request ID. The parked Criteo and WooCommerce gateways (ARC-01, P9) are offered, as
// a deployment whose AMCP_PROVIDERS names them lists them, so their schemas are checked too.
offerParkedProviders('criteo', 'woocommerce');
const key = Buffer.alloc(32, 89).toString('base64'),
  actor = {tenantId: 'output-parity', userId: 'operator', role: 'operator'},
  connection = {
    reddit: '77000000-0000-4000-8000-0000000000aa',
    gtm: '77000000-0000-4000-8000-0000000000bb',
    criteo: '77000000-0000-4000-8000-0000000000cc',
    apple: '77000000-0000-4000-8000-0000000000dd',
  };
/** A Criteo campaign update whose body satisfies the pinned schema (tests/criteo-campaign-writes.test.ts). */
const criteoUpdate = {
  action: 'UPDATE_CAMPAIGN_BY_CAMPAIGN_ID',
  connection_id: connection.criteo,
  account_id: '8000001',
  params: {campaignId: '456'},
  payload: {
    data: {
      type: 'Campaign',
      id: '456',
      attributes: {
        name: 'Summer campaign',
        budget: 1000,
        dailyPacing: 25,
        monthlyPacing: 500,
        isAutoDailyPacing: false,
        startDate: '2030-08-01T00:00:00Z',
        endDate: '2030-08-31T23:59:59Z',
        clickAttributionWindow: '30D',
        viewAttributionWindow: '1D',
        clickAttributionScope: 'sameSkuCategory',
        viewAttributionScope: 'sameSku',
        companyName: 'Test advertiser',
        onBehalfCompanyName: null,
      },
    },
  },
};
async function connected(t, allowWrites) {
  const store = new Store(':memory:', key);
  store.ensureTenant(actor.tenantId);
  // Synthetic connections for the gateways whose one call without a provider is a write preview.
  for (const [id, gateway, account, scopes] of [
    [connection.reddit, 'reddit_native_action', 't2_abc', ['adsread', 'adsedit']],
    [connection.gtm, 'gtm_native_action', '6000001', []],
    [connection.criteo, 'criteo_native_action', '8000001', []],
    [connection.apple, 'apple_ads_native_action', '9000001', []],
  ])
    store.putConnection(
      {...actor, role: 'admin'},
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: [account],
        writeAccounts: [account],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes,
      },
      {accessToken: 'synthetic-' + account},
    );
  const requests = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async url => {
        requests.push(String(url));
        throw Error('No provider request is expected');
      }),
      undefined,
      allowWrites ? {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true} : undefined,
    ),
    server = createMcpServer(service, actor),
    client = new Client({name: 'Synthetic output-schema parity client', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  t.after(async () => {
    await client.close();
    await server.close();
    store.close();
  });
  return {client, requests};
}
/** A call that succeeds without a provider, and one that is refused, for each tool. */
function calls(tool) {
  const selector = tool.inputSchema.properties?.action
    ? 'action'
    : tool.inputSchema.properties?.operation
      ? 'operation'
      : null;
  const success = {
    amcp_tool_help: {gateway: tool.name === 'amcp_tool_help' ? 'amcp_workspace' : tool.name},
    amcp_platform_workspace: {operation: 'list_accounts'},
    amcp_workspace: {action: 'contracts', limit: 1},
    amcp_campaign: {action: 'recipes'},
    amcp_reporting: {action: 'capture_presets'},
    amcp_reporting_overview: {action: 'list', limit: 1},
    amcp_media: {action: 'list', limit: 1},
    amcp_write: {
      action: 'inspect',
      gateway: 'meta_native_action',
      arguments: {action: 'meta_campaign_create', account_id: '123', payload: {name: 'Synthetic'}},
    },
    amcp_native_action: {operation: 'list_reporting_templates', arguments: {}},
    // Operation-mode gateways: a local status or list operation, or a write without dry_run:false, which is previewed
    // without a provider request (MCP-10). Before the wave 4b review these had a refused call only.
    ga4_native_action: {operation: 'ga4_connection_ops', arguments: {action: 'status'}},
    google_search_console_native_action: {operation: 'gsc_connection_ops', arguments: {action: 'status'}},
    google_business_native_action: {operation: 'gmb_connection_ops', arguments: {action: 'status'}},
    adjust_native_action: {operation: 'adjust_list_assets', arguments: {}},
    commerce_native_action: {operation: 'woocommerce_list_stores', arguments: {}},
    reddit_native_action: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'UPDATE_CAMPAIGN',
        account_id: 't2_abc',
        connection_id: connection.reddit,
        params: {campaign_id: '1'},
        payload: {data: {name: 'Synthetic'}},
      },
    },
    gtm_native_action: {
      operation: 'gtm_ops',
      arguments: {
        action: 'CREATE_WORKSPACE',
        connection_id: connection.gtm,
        account_id: '6000001',
        container_id: '7000001',
        payload: {name: 'Synthetic'},
      },
    },
    criteo_native_action: {operation: 'criteo_campaign_ops', arguments: criteoUpdate},
    // DV360 lists its actions as an enum, so the LIST_ACTIONS fallback below passed it over; it answers LIST_ACTIONS.
    dv360_native_action: {action: 'LIST_ACTIONS', limit: 1},
    // Apple Ads has no LIST_ACTIONS catalog and no limit: that call was refused and counted as a refusal.
    apple_ads_native_action: {
      action: 'apple_ads_v1_campaign_update',
      connection_id: connection.apple,
      org_id: '9000001',
      path_params: {id: '1'},
      payload: {name: 'Synthetic'},
    },
  }[tool.name];
  const out = [];
  if (success) out.push(['success', success]);
  else if (tool.inputSchema.properties?.action?.type === 'string' && !tool.inputSchema.properties.action.enum)
    out.push(['success', {action: 'LIST_ACTIONS', limit: 1}]);
  out.push([
    'refused',
    selector === null
      ? tool.name === 'amcp_tool_help'
        ? {gateway: 'no_such_gateway'}
        : {platform: 'no_such_platform', account_id: '1'}
      : {[selector]: 'no_such_' + selector},
  ]);
  return out;
}

test('every tool’s structuredContent validates against its outputSchema, with the same text and isError on refusals', async t => {
  let successes = 0,
    refusals = 0;
  for (const allowWrites of [true, false]) {
    const c = await connected(t, allowWrites),
      {tools} = await c.client.listTools(),
      ajv = new Ajv({strict: false}),
      succeeded = new Set();
    assert.ok(tools.length >= 27);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, tool.name + ' declares an outputSchema');
      const validate = ajv.compile(tool.outputSchema);
      for (const [kind, args] of calls(tool)) {
        const label =
          tool.name + ' ' + kind + ' ' + JSON.stringify(args).slice(0, 120) + (allowWrites ? '' : ' (read-only)');
        // The SDK validates structuredContent against the cached outputSchema and throws on a mismatch. The in-memory
        // transport hands the object over unserialized; a client on a real transport receives its JSON.
        const result = await c.client.callTool({name: tool.name, arguments: args});
        assert.ok(result.structuredContent && typeof result.structuredContent === 'object', label);
        const content = JSON.parse(JSON.stringify(result.structuredContent));
        assert.ok(validate(content), label + ': ' + JSON.stringify(validate.errors));
        assert.equal(result.content.length, 1, label);
        assert.equal(result.content[0].type, 'text', label);
        assert.deepEqual(JSON.parse(result.content[0].text), content, label + ': the text is the structured result');
        assert.equal(typeof content.meta?.requestId, 'string', label + ': request ID');
        // isError is set exactly on a refusal, and a refusal names its code (below).
        assert.equal(result.isError === true, content.success === false, label + ': isError exactly on refusal');
        if (content.success === false) {
          const e = content.error;
          assert.equal(typeof e.code, 'string', label);
          // A call meant to succeed must succeed, so the outputSchema is checked against its success, not a refusal.
          assert.equal(kind, 'refused', label + ' was refused with ' + e.code);
          refusals++;
          assert.ok(e.message.length > 0, label);
          assert.equal(typeof e.category, 'string', label);
          assert.equal(typeof e.retryable, 'boolean', label);
          assert.equal(typeof e.next_action, 'string', label + ': an actionable next step');
          assert.ok(e.next_action.length > 10, label);
          assert.deepEqual(
            [typeof e.remedy?.owner, typeof e.remedy?.action, e.remedy?.mutation_retry_safe],
            ['string', 'string', false],
            label + ': remedy',
          );
          assert.notEqual(e.code, 'INTERNAL_ERROR', label + ': a refusal, not a crash');
        } else {
          successes++;
          succeeded.add(tool.name);
          assert.equal(kind, 'success', label + ' was not refused');
        }
      }
    }
    // Every tool's successful structuredContent is validated too, except amcp_ad_previews, which reads a provider.
    assert.deepEqual(
      tools.map(tool => tool.name).filter(name => !succeeded.has(name)),
      ['amcp_ad_previews'],
      'tools without a validated success' + (allowWrites ? '' : ' (read-only)'),
    );
    assert.deepEqual(c.requests, [], 'nothing reached a provider');
  }
  assert.ok(successes >= 52, 'successes ' + successes);
  assert.ok(refusals >= 54, 'refusals ' + refusals);
});
