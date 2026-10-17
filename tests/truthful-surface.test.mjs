import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRefused} from './helpers/assert-refused.mjs';
import {Registry} from '../dist/src/catalog.js';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {actionContracts} from '../dist/src/action-contracts.js';
import {unavailableOperations} from '../dist/src/unavailable-operations.js';
import {withoutExecutableActions} from '../dist/src/tool-notes.js';
import {linkedinVersion} from '../dist/src/linkedin-version.js';
import {googleAdsVersion} from '../dist/src/google-version.js';
import {metaApiVersion} from '../dist/src/meta-version.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';
import {workspaceCapabilities} from '../dist/src/capabilities.js';
import {aliasUsageCacheMs, cachedLegacyAliasUsage, legacyAliasUsage} from '../dist/src/legacy-alias-usage.js';
import {googleLegacyCoverage} from '../dist/src/google-legacy.js';
import {serverInstructions} from '../dist/src/tool-annotations.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';

// WooCommerce is parked (ARC-01, P9): this suite exercises it, so it offers it like a
// deployment whose AMCP_PROVIDERS names it.
offerParkedProviders('woocommerce');

// MCP-10: what AMCP advertises is what it runs. The nine amcp_native_action operations that always ended in
// WORKFLOW_UNSUPPORTED, the four Adjust operations and the other unmapped operations were listed with captured text and
// no note, answered only after their (pointless) arguments were checked, and named no alternative.
const registry = new Registry();
const ledger = actionContracts(registry);
function fixture(t, {allowWrites = true} = {}) {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    requests = [],
    transport = new NativeTransport(async raw => {
      requests.push(String(raw));
      throw new Error('no provider request is expected');
    }),
    service = new MirrorService(registry, store, transport, undefined, {
      allowWrites,
      maxBudgetChange: 0,
      requireBeforeState: true,
    }),
    actor = {tenantId: 'surface', userId: 'owner', role: 'admin'};
  t.after(() => store.close());
  return {store, service, actor, requests, call: (tool, input) => service.call(tool, input, actor)};
}
const enumOf = (gateway, operation) =>
  registry.tools.get(gateway).operations.find(o => o.operation === operation).argumentsSchema.properties?.action
    ?.enum ?? [operation];

test('the unavailable-operation table names exactly the operations the contracts ledger marks unmapped', () => {
  const unmapped = ledger
    .filter(r => r.status === 'unmapped')
    .map(r => r.gateway + '/' + r.operation + '/' + r.action)
    .sort();
  const table = Object.entries(unavailableOperations)
    .flatMap(([gateway, operations]) =>
      Object.entries(operations).flatMap(([operation, entry]) =>
        (entry.actions ?? enumOf(gateway, operation)).map(action => gateway + '/' + operation + '/' + action),
      ),
    )
    .sort();
  assert.deepEqual(table, unmapped);
  // The nine amcp_native_action operations of the finding, and the four Adjust ones, are among them.
  assert.deepEqual(Object.keys(unavailableOperations.amcp_native_action).sort(), [
    'connect_google_reporting',
    'cross_platform_transfer',
    'disconnect_google_reporting',
    'download_creative_asset',
    'generate_ad_content',
    'generate_creative_design',
    'get_creative_payload',
    'openai_ads_ops',
    'suggest_targeting',
  ]);
  assert.deepEqual(Object.keys(unavailableOperations.adjust_native_action).sort(), [
    'adjust_ad_spend',
    'adjust_app_automation',
    'adjust_campaign_api',
    'adjust_deeplinks',
  ]);
  // A gateway with no executable action at all is described as such.
  const counts = new Map();
  for (const r of ledger) if (r.status !== 'unmapped') counts.set(r.gateway, (counts.get(r.gateway) ?? 0) + 1);
  const empty = [...registry.tools.keys()].filter(g => g.endsWith('_native_action') && !counts.get(g));
  assert.deepEqual(empty, [...withoutExecutableActions]);
});

test('help for each unavailable operation says unmapped, why and what to use; gateway help lists them', async t => {
  const f = fixture(t);
  for (const [gateway, operations] of Object.entries(unavailableOperations))
    for (const [operation, entry] of Object.entries(operations)) {
      const help = await f.call('amcp_tool_help', {gateway, operation});
      assert.equal(help.success, true, JSON.stringify(help.error));
      const execution = help.data.amcp_execution;
      if (entry.actions) {
        assert.equal(execution.status, 'mixed', operation);
        for (const action of entry.actions)
          assert.equal(execution.actions.find(a => a.action === action).status, 'unmapped', action);
      } else {
        assert.equal(execution.status, 'unmapped', gateway + ' ' + operation);
        assert.ok(execution.reason.startsWith(entry.reason), operation);
        assert.deepEqual(execution.alternatives, entry.alternatives, operation);
      }
    }
  for (const gateway of ['amcp_native_action', 'adjust_native_action', 'commerce_native_action']) {
    const help = await f.call('amcp_tool_help', {gateway});
    assert.deepEqual(
      help.data.amcp_unavailable_operations.map(o => o.operation),
      Object.keys(unavailableOperations[gateway]),
    );
  }
  // An executable operation is described as such.
  const reporting = await f.call('amcp_tool_help', {gateway: 'adjust_native_action', operation: 'adjust_reporting'});
  assert.equal(reporting.data.amcp_execution.status, 'local_workflow');
  assert.equal(f.requests.length, 0);
});

test('a call to an unavailable operation is refused before its arguments are checked, names alternatives and sends nothing', async t => {
  const f = fixture(t);
  // Before MCP-10 this answered INVALID_ARGUMENT asking for product_description, and with it, WORKFLOW_UNSUPPORTED
  // with no alternative.
  const copy = await f.call('amcp_native_action', {operation: 'generate_ad_content', arguments: {}});
  assert.equal(copy.error.code, 'WORKFLOW_UNSUPPORTED');
  assert.equal(copy.error.details.status, 'unmapped');
  assert.equal(copy.error.details.operation, 'generate_ad_content');
  assert.deepEqual(
    copy.error.details.alternatives,
    unavailableOperations.amcp_native_action.generate_ad_content.alternatives,
  );
  assert.match(copy.error.remedy.action, /details\.alternatives/);
  for (const operation of Object.keys(unavailableOperations.amcp_native_action)) {
    const out = await f.call('amcp_native_action', {
      operation,
      arguments: {action: enumOf('amcp_native_action', operation)[0]},
    });
    assert.equal(out.error.code, 'WORKFLOW_UNSUPPORTED', operation);
    assert.ok(Array.isArray(out.error.details.alternatives), operation);
  }
  // Adjust's four operations refused WORKFLOW_ADAPTER_REQUIRED or INVALID_ARGUMENT before; the gap is now named.
  for (const operation of Object.keys(unavailableOperations.adjust_native_action)) {
    const out = await f.call('adjust_native_action', {
      operation,
      arguments: {action: enumOf('adjust_native_action', operation)[0]},
    });
    assert.equal(out.error.code, 'CAPABILITY_UNAVAILABLE', operation);
    assert.equal(out.error.details.status, 'unmapped');
    assert.equal(out.error.details.alternatives[0].arguments.operation, 'adjust_reporting');
  }
  const ga4 = await f.call('ga4_native_action', {operation: 'ga4_connection_ops', arguments: {action: 'start'}});
  assert.equal(ga4.error.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(ga4.error.details.alternatives[0].website_path, '/connections');
  // The connection operation's status, sync and disconnect actions still run.
  const status = await f.call('ga4_native_action', {operation: 'ga4_connection_ops', arguments: {action: 'status'}});
  assert.equal(status.success, true, JSON.stringify(status.error));
  // Only the listed action of a partly available operation is refused this way.
  const legacy = await f.call('google_business_native_action', {
    operation: 'gmb_engagement_ops',
    arguments: {action: 'LEGACY_V4_REQUEST'},
  });
  assert.equal(legacy.error.code, 'CAPABILITY_UNAVAILABLE');
  const links = await f.call('google_business_native_action', {
    operation: 'gmb_engagement_ops',
    arguments: {action: 'LIST_PLACE_ACTION_LINKS'},
  });
  assert.notEqual(links.error?.code, 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.requests.length, 0);
});

test('descriptions are AMCP-owned: no tool that does not exist, Amazon says nothing runs, commerce says what is parked', async t => {
  for (const allowWrites of [true, false]) {
    const f = fixture(t, {allowWrites}),
      listed = f.service.listTools(),
      names = new Set(listed.map(t => t.name)),
      texts = [
        ...listed.map(t => [t.name, t.description]),
        ...[...registry.tools.keys()].map(g => [
          g + ' help',
          registry.help({gateway: g}, {mode: 'strict', flags: {}}).description ?? '',
        ]),
        ['server instructions', serverInstructions],
      ];
    for (const [where, text] of texts) {
      assert.doesNotMatch(text, /Prefer named tools|dv360_reporting_ops|semantic create_creative tool/, where);
      // Every tool a description names is one this connection lists.
      for (const m of text.matchAll(/\b(amcp_[a-z_]+|[a-z0-9]+(?:_[a-z0-9]+)*_native_action)\b/g))
        assert.ok(
          names.has(m[1]) || (!allowWrites && ['amcp_write', 'amcp_media'].includes(m[1])),
          where + ': ' + m[1],
        );
      for (const m of text.matchAll(/\b([a-z0-9]+(?:_[a-z0-9]+)+) tools?\b/g))
        assert.ok(names.has(m[1]), where + ': ' + m[1]);
    }
    const byName = Object.fromEntries(listed.map(t => [t.name, t.description]));
    // Amazon Ads is not offered by default (CON-06, owner decision option b); see the offered case below.
    assert.equal(byName.amazon_native_action, undefined);
    assert.match(byName.commerce_native_action, /Shopify and Salla have no AMCP connection/);
    assert.match(byName.commerce_native_action, /Shopify, Salla and WooCommerce expansion is parked/);
    assert.match(byName.adjust_native_action, /adjust_deeplinks/);
    assert.match(byName.amcp_native_action, /WORKFLOW_UNSUPPORTED.*generate_ad_content/);
    assert.doesNotMatch(byName.apple_ads_native_action, /legacy Campaign Management API v5 endpoint/);
    assert.match(byName.apple_ads_native_action, /Legacy Campaign Management API v5 routes are unavailable/);
  }
  // Where an operator offers Amazon Ads again (AMCP_PROVIDERS=amazon), its description says nothing runs.
  const providers = process.env.AMCP_PROVIDERS;
  process.env.AMCP_PROVIDERS = 'amazon';
  try {
    const amazon = fixture(t)
      .service.listTools()
      .find(tool => tool.name === 'amazon_native_action');
    assert.match(amazon?.description ?? '', /AMCP has no executable Amazon Ads action yet/);
  } finally {
    if (providers === undefined) delete process.env.AMCP_PROVIDERS;
    else process.env.AMCP_PROVIDERS = providers;
  }
  // The captured text stays available, beside AMCP's own.
  const help = registry.help({gateway: 'commerce_native_action'}, {mode: 'strict', flags: {}});
  assert.match(help.captured_catalog.description, /WooCommerce, Salla, and Shopify/);
});

test('DESCRIBE_ACTION and operation help report the version sent and AMCP’s read_only, with the captured values beside', async t => {
  const f = fixture(t);
  const cases = [
    ['linkedin_native_action', 'linkedin_rest_media_planning_post', linkedinVersion(), '202605'],
    [
      'google_ads_native_action',
      registry.catalogs.get('google_ads_native_action').actions.find(a => a.path).name,
      googleAdsVersion,
    ],
    ['meta_native_action', 'meta_ad_account_id_campaigns_get', metaApiVersion],
  ];
  for (const [gateway, action, sent, capturedVersion] of cases) {
    const described = await f.call(gateway, {action: 'DESCRIBE_ACTION', target_action: action}),
      help = await f.call('amcp_tool_help', {gateway, operation: action});
    for (const out of [described, help]) {
      assert.equal(out.success, true, JSON.stringify(out.error));
      assert.equal(out.data.api_version, sent, gateway);
      const row = ledger.find(r => r.gateway === gateway && r.action === action);
      assert.equal(out.data.amcp_execution.status, row.status, gateway);
      if (row.status === 'native_read') assert.equal(out.data.read_only, true, gateway);
      if (capturedVersion) assert.equal(out.data.captured_catalog.api_version, capturedVersion);
    }
  }
  assert.equal(f.requests.length, 0);
});

test('DESCRIBE_ACTION by an alias reports the execution status of the captured action it names', async t => {
  // The ledger has one row per captured action; an unprefixed DV360 name found no row and lost amcp_execution.
  const f = fixture(t),
    action = registry.catalogs.get('dv360_native_action').actions.find(a => a.aliases.length && !a.read_only),
    row = ledger.find(r => r.gateway === 'dv360_native_action' && r.action === action.name);
  const described = await f.call('dv360_native_action', {action: 'DESCRIBE_ACTION', target_action: action.aliases[0]});
  assert.equal(described.success, true, JSON.stringify(described.error));
  assert.equal(described.data.amcp_execution.status, row.status);
  assert.equal(f.requests.length, 0);
});

test('every alternative an unavailable operation names is a listed tool, operation or action that runs', t => {
  // A refusal that points at a call which does not exist, or is itself unavailable, repeats the defect it fixes.
  const f = fixture(t),
    listed = new Map(f.service.listTools().map(tool => [tool.name, tool]));
  for (const [gateway, operations] of Object.entries(unavailableOperations))
    for (const [operation, entry] of Object.entries(operations))
      for (const alternative of entry.alternatives) {
        const where = gateway + ' ' + operation + ' -> ' + JSON.stringify(alternative);
        assert.ok(alternative.meaning, where);
        if ('website_path' in alternative) {
          assert.match(alternative.website_path, /^\/[a-z-]+$/, where);
          continue;
        }
        const tool = listed.get(alternative.tool);
        assert.ok(tool, where);
        const {operation: target, action, arguments: inner} = alternative.arguments;
        if (target !== undefined) {
          assert.ok(
            registry.tools.get(alternative.tool).operations.some(o => o.operation === target),
            where,
          );
          const unavailable = unavailableOperations[alternative.tool]?.[target];
          assert.ok(!unavailable || (unavailable.actions && !unavailable.actions.includes(inner?.action)), where);
        }
        if (action !== undefined) assert.ok(tool.inputSchema.properties.action.enum.includes(action), where);
      }
});

test('on a read-only deployment a refusal names only the alternatives that deployment lists and runs (regression)', async t => {
  const f = fixture(t, {allowWrites: false}),
    listed = new Map(f.service.listTools().map(tool => [tool.name, tool]));
  // amcp_media lists its reads only here, so its prepare is no way to upload a finished design on this deployment.
  assert.ok(!listed.get('amcp_media')?.inputSchema.properties.action.enum.includes('prepare'));
  const design = await f.call('amcp_native_action', {
    operation: 'generate_creative_design',
    arguments: {action: enumOf('amcp_native_action', 'generate_creative_design')[0]},
  });
  assert.equal(design.error.code, 'WORKFLOW_UNSUPPORTED');
  assert.equal(
    design.error.details.alternatives.some(a => a.tool === 'amcp_media' && a.arguments.action === 'prepare'),
    false,
  );
  for (const [gateway, operations] of Object.entries(unavailableOperations)) {
    if (!listed.has(gateway)) continue;
    for (const operation of Object.keys(operations)) {
      const out = await f.call(gateway, {
        operation,
        arguments: {action: operations[operation].actions?.[0] ?? enumOf(gateway, operation)[0]},
      });
      for (const alternative of out.error.details.alternatives) {
        if ('website_path' in alternative) continue;
        const tool = listed.get(alternative.tool),
          where = gateway + ' ' + operation + ' -> ' + JSON.stringify(alternative);
        assert.ok(tool, where);
        const action = alternative.arguments.action;
        if (action !== undefined && tool.inputSchema.properties.action?.enum)
          assert.ok(tool.inputSchema.properties.action.enum.includes(action), where);
      }
    }
  }
  assert.equal(f.requests.length, 0);
});

test('a call to the Amazon gateway is refused and nothing reaches Amazon', async t => {
  const f = fixture(t);
  for (const input of [{action: 'LIST_ACTIONS'}, {action: 'LIST_SP_CAMPAIGNS', profile_id: '1'}]) {
    const out = await f.call('amazon_native_action', input);
    assertRefused(out, 'GATEWAY_NOT_OFFERED');
  }
  assert.equal(f.requests.length, 0);
});

test('get_workspace_context and list_accounts refuse the captured options AMCP does not implement, naming them', async t => {
  const f = fixture(t);
  const connection = {
    id: '77000000-0000-4000-8000-000000000001',
    tenantId: f.actor.tenantId,
    gateway: 'meta_native_action',
    accounts: ['100', '200'],
    writeAccounts: [],
    enabled: true,
    label: 'Synthetic Meta',
    scopes: ['ads_read'],
  };
  f.store.putConnection(f.actor, connection, {accessToken: 'synthetic'});
  rememberAccountMetadata(f.store, f.actor.tenantId, connection.id, '100', {
    name: 'Cached name',
    currency: 'USD',
    timezone: 'UTC',
  });
  for (const gateway of ['amcp_platform_workspace', 'amcp_native_action']) {
    // Before MCP-10 these options passed validation and were ignored.
    for (const [option, value] of [
      ['include_accounts', true],
      ['account_limit', 5],
      ['include_asset_summary', true],
      ['include_integration_details', true],
    ]) {
      const out = await f.call(gateway, {operation: 'get_workspace_context', arguments: {[option]: value}});
      assert.equal(out.error?.code, 'INVALID_ARGUMENT', option);
      assert.equal(out.error.details.field, option);
    }
    const defaults = await f.call(gateway, {operation: 'get_workspace_context', arguments: {include_accounts: false}});
    assert.equal(defaults.success, true, JSON.stringify(defaults.error));
    const inactive = await f.call(gateway, {operation: 'list_accounts', arguments: {include_inactive: true}});
    assert.equal(inactive.error.details.field, 'include_inactive');
    const openai = await f.call(gateway, {operation: 'list_accounts', arguments: {platform: 'openai'}});
    assert.equal(openai.error.code, 'INVALID_ARGUMENT');
    assert.equal(openai.error.details.field, 'platform');
    assert.ok(openai.error.details.allowed.includes('meta'));
    const accounts = await f.call(gateway, {operation: 'list_accounts', arguments: {platform: 'meta'}});
    assert.equal(accounts.success, true, JSON.stringify(accounts.error));
    const [cached, unread] = accounts.data;
    assert.equal(cached.name, 'Cached name');
    assert.equal(cached.metadata.source, 'live_account_read');
    assert.match(cached.metadata.checked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(unread.name, null);
    assert.equal(unread.next_call.arguments.action, 'check');
    // Operation help describes what AMCP returns, with the captured text beside it.
    const help = await f.call('amcp_tool_help', {gateway, operation: 'list_accounts'});
    assert.doesNotMatch(help.data.description, /OpenAI|graceful degradation/);
    assert.equal(help.data.argumentsSchema.properties.include_inactive.const, false);
    assert.match(help.data.captured_catalog.description, /OpenAI/);
    const context = await f.call('amcp_tool_help', {gateway, operation: 'get_workspace_context'});
    assert.doesNotMatch(context.data.description, /billing summary/);
    assert.equal(context.data.amcp_execution.status, 'local_workflow');
  }
  assert.equal(f.requests.length, 0);
});

test('a TikTok asset gets the provider-neutral usage refusal with no provider request', async t => {
  const f = fixture(t);
  const connection = {
    id: '77000000-0000-4000-8000-000000000002',
    tenantId: f.actor.tenantId,
    gateway: 'tiktok_native_action',
    accounts: ['7000000000000000001'],
    writeAccounts: [],
    enabled: true,
    label: 'Synthetic TikTok',
    scopes: [],
  };
  f.store.putConnection(f.actor, connection, {accessToken: 'synthetic'});
  f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-tiktok', {
    platform: 'tiktok',
    account_id: '7000000000000000001',
    connection_id: connection.id,
    media_id: 'ad-image-1',
    media_type: 'image',
    name: 'TikTok image',
    sha256: 'b'.repeat(64),
    source: 'amcp_upload',
    ready: true,
  });
  const out = await f.call('amcp_media', {action: 'asset_usage', asset_id: 'asset-tiktok'});
  // Before MCP-10 a TikTok asset went to the Meta reader: "qualified only for Meta v26 image or video upload receipts".
  assert.equal(out.error.code, 'ASSET_USAGE_UNQUALIFIED');
  assert.doesNotMatch(out.error.message, /only for Meta/);
  assert.match(out.error.message, /Meta images and videos, Google images and Snapchat images and videos/);
  assert.deepEqual(
    out.error.details.qualified_kinds.map(k => k.platform),
    ['meta', 'google_ads', 'snapchat'],
  );
  assert.equal(out.error.details.platform, 'tiktok');
  // A Google video has no usage reader either; it was told that "Google image references" need a receipt.
  const google = {
    ...connection,
    id: '77000000-0000-4000-8000-000000000003',
    gateway: 'google_ads_native_action',
    accounts: ['1234567890'],
    label: 'Synthetic Google',
  };
  f.store.putConnection(f.actor, google, {accessToken: 'synthetic'});
  f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'asset-google-video', {
    platform: 'google_ads',
    account_id: '1234567890',
    connection_id: google.id,
    media_id: 'customers/1234567890/assets/1',
    media_type: 'video',
    name: 'Google video',
    sha256: 'c'.repeat(64),
    uploaded_sha256: 'c'.repeat(64),
    source: 'amcp_upload',
    ready: true,
  });
  const video = await f.call('amcp_media', {action: 'asset_usage', asset_id: 'asset-google-video'});
  assert.equal(video.error.code, 'ASSET_USAGE_UNQUALIFIED');
  assert.doesNotMatch(video.error.message, /Google image references/);
  assert.deepEqual([video.error.details.platform, video.error.details.media_type], ['google_ads', 'video']);
  assert.equal(f.requests.length, 0);
});

test('capability evidence points at the qualification record and /versionz, not at a CI result', async t => {
  const f = fixture(t);
  const capabilities = workspaceCapabilities(f.store, f.actor);
  assert.doesNotMatch(JSON.stringify(capabilities), /\bCI\b/);
  assert.equal(capabilities.qualification.status_url, '/versionz');
  assert.match(capabilities.qualification.record, /npm run qualify/);
  const dashboard = await f.call('amcp_workspace', {action: 'dashboard'});
  assert.equal(dashboard.success, true, JSON.stringify(dashboard.error));
  assert.doesNotMatch(JSON.stringify(dashboard.data), /release CI/);
});

test('the legacy Google alias baseline counts 30 days of audited request plans, once per request and per tenant', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const legacy = googleLegacyCoverage().entries.map(e => e.action),
    canonical = registry.catalogs
      .get('google_ads_native_action')
      .actions.find(a => a.path && !legacy.includes(a.name)).name,
    actor = {tenantId: 'baseline', userId: 'owner', role: 'admin'},
    plan = action => ({gateway: 'google_ads_native_action', action, method: 'POST', path: '/x'});
  store.appendAudit('baseline', 'r1', {event: 'preview', request: plan(legacy[0])});
  store.appendAudit('baseline', 'r2', {event: 'request_started', request: plan(legacy[0])});
  store.appendAudit('baseline', 'r2', {event: 'request_started', request: plan(legacy[0])});
  store.appendAudit('baseline', 'r3', {event: 'request_started', request: plan(legacy[1])});
  store.appendAudit('baseline', 'r4', {event: 'request_started', request: plan(canonical)});
  store.appendAudit('baseline', 'r5', {
    event: 'request_started',
    request: {...plan(canonical), gateway: 'meta_native_action'},
  });
  store.appendAudit('other-tenant', 'r6', {event: 'request_started', request: plan(legacy[0])});
  // A row from before the window (the audit is append-only, so it is written with its old time).
  store.db
    .prepare('INSERT INTO audit(tenant_id,request_id,event,previous_hash,hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(
      'baseline',
      'old',
      JSON.stringify({event: 'request_started', request: plan(legacy[2])}),
      'synthetic',
      'synthetic-old',
      Date.now() - 31 * 86400000,
    );
  const usage = legacyAliasUsage(store, actor);
  assert.equal(usage.window_days, 30);
  assert.equal(usage.google_requests, 4);
  assert.equal(usage.legacy_requests, 3);
  assert.equal(usage.legacy_share, 0.75);
  assert.deepEqual(usage.top_legacy_actions, [
    {action: legacy[0], count: 2},
    {action: legacy[1], count: 1},
  ]);
  assert.equal(usage.legacy_alias_names, legacy.length);
  assert.equal(usage.complete, true);
  const empty = legacyAliasUsage(store, {...actor, tenantId: 'nobody'});
  assert.equal(empty.legacy_share, null);
});
test('the owner’s health carries the legacy alias baseline, counted from the audit a real preview writes', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const legacy = googleLegacyCoverage().entries.find(e => e.action === 'FETCH_CAMPAIGNS').action,
    actor = {tenantId: 'baseline', userId: 'owner', role: 'admin'},
    requests = [],
    transport = new NativeTransport(async raw => {
      requests.push(String(raw));
      throw new Error('no provider request is expected');
    });
  const service = new MirrorService(registry, store, transport, undefined, {allowWrites: false});
  // A preview under the legacy name records its request plan in the audit, which the baseline reads.
  const preview = await service.call(
    'google_ads_native_action',
    {action: legacy, customer_id: '1234567890', dry_run: true},
    actor,
  );
  assert.equal(preview.success, true, JSON.stringify(preview.error));
  const health = await service.call('amcp_workspace', {action: 'health'}, actor);
  assert.equal(health.success, true, JSON.stringify(health.error));
  assert.equal(health.data.google_legacy_aliases.google_requests, 1);
  assert.equal(health.data.google_legacy_aliases.legacy_requests, 1);
  assert.equal(health.data.google_legacy_aliases.complete, true);
  assert.deepEqual(health.data.google_legacy_aliases.top_legacy_actions, [{action: legacy, count: 1}]);
  assert.equal(requests.length, 0);
  // The baseline is a 30-day figure scanning up to 50,000 audit rows: health reuses it for an hour per workspace.
  const again = await service.call(
    'google_ads_native_action',
    {action: legacy, customer_id: '1234567890', dry_run: true},
    actor,
  );
  assert.equal(again.success, true);
  const cached = (await service.call('amcp_workspace', {action: 'health'}, actor)).data.google_legacy_aliases;
  assert.equal(cached.legacy_requests, 1, 'within the hour the computed baseline is reused');
  assert.equal(cached.computed_at, health.data.google_legacy_aliases.computed_at);
  const later = Date.parse(cached.computed_at) + aliasUsageCacheMs;
  assert.equal(cachedLegacyAliasUsage(store, actor, later).legacy_requests, 2, 'after an hour it is computed again');
});
