import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {independentlyReadOnly} from '../dist/src/execution-risk.js';
import {serverInstructions, toolAnnotations} from '../dist/src/tool-annotations.js';

// MCP-06: initialize carried no instructions and no tool had a title or annotations, so every read prompted in clients
// that auto-approve read-only tools. A wrong readOnlyHint:true would let a client run a state-changing tool unasked, so
// every tool marked read-only is exercised action by action below.
const registry = new Registry(),
  writes = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true},
  key = Buffer.alloc(32, 61).toString('base64');

function world(allowWrites) {
  const store = new Store(':memory:', key),
    actor = {tenantId: 'annotations', userId: 'owner', role: 'admin'},
    fetches = [],
    plans = [],
    media = [];
  store.ensureTenant(actor.tenantId);
  const connections = new Map();
  let n = 0;
  for (const gateway of registry.tools.keys()) {
    if (['amcp_tool_help', 'amcp_platform_workspace', 'amcp_native_action'].includes(gateway)) continue;
    const id = '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
    store.putConnection(
      actor,
      {
        id,
        tenantId: actor.tenantId,
        gateway,
        accounts: ['1001'],
        writeAccounts: ['1001'],
        enabled: true,
        label: 'Synthetic ' + gateway,
        scopes: [],
        userAgent: 'synthetic-annotation-evaluator/1.0',
      },
      {accessToken: 'synthetic-' + n},
    );
    connections.set(gateway, id);
  }
  // Every provider request is recorded and answered with an empty JSON object; nothing leaves the process.
  const transport = new NativeTransport(
    async (url, init = {}) => {
      fetches.push({method: String(init.method ?? 'GET').toUpperCase(), url: String(url)});
      return Response.json({});
    },
    async () => {},
    30000,
    8 * 1024 * 1024,
    1e9,
    1,
    1e9,
  );
  const request = transport.request.bind(transport);
  transport.request = (plan, ...rest) => {
    plans.push(plan);
    return request(plan, ...rest);
  };
  const service = new MirrorService(
    registry,
    store,
    transport,
    undefined,
    allowWrites ? writes : undefined,
    async url => {
      media.push(String(url));
      throw Error('Synthetic media fetches are refused.');
    },
  );
  return {store, actor, service, connections, fetches, plans, media, close: () => store.close()};
}
// AMCP state a read-only tool must leave unchanged. The audit trail, ownership observations of what a read returned,
// provider cooldowns, service locks and timing counters keep AMCP's own controls working and change nothing the user owns.
const stateTables = [
  'tenants',
  'workspace_memberships',
  'credential_owners',
  'api_keys',
  'connections',
  'idempotency',
  'documents',
  'jobs',
  'media_admissions',
  'media_chunks',
  'media_staging',
  'retained_media',
  'retained_media_chunks',
];
// Service timing counters are observability, kept as one document per category.
const observability = table => (table === 'documents' ? " WHERE kind<>'service_timings'" : '');
const snapshot = store =>
  stateTables
    .map(
      t =>
        t +
        ':' +
        createHash('sha256')
          .update(JSON.stringify(store.db.prepare('SELECT * FROM ' + t + observability(t) + ' ORDER BY rowid').all()))
          .digest('hex')
          .slice(0, 12),
    )
    .join(' ');
/** The bag's keys the schema admits, plus a synthetic value for each required property it lacks. */
function fill(bag, schema = {}) {
  const properties = schema.properties ?? {},
    out = Object.fromEntries(Object.entries(bag).filter(([k]) => Object.hasOwn(properties, k)));
  for (const key of schema.required ?? []) {
    if (out[key] !== undefined) continue;
    const s = properties[key] ?? {};
    out[key] = s.enum?.[0] ?? {number: 1, integer: 1, boolean: false, object: {}, array: []}[s.type] ?? '1001';
  }
  return out;
}
/**
 * Every input a tool's schema admits for each of its actions, pushed as far toward execution as arguments allow: once
 * as a read (no payload) and once as a write (a payload, confirmation and an idempotency key).
 */
function inputs(w, tool) {
  const name = tool.name,
    connection = w.connections.get(name),
    definition = registry.tools.get(name),
    schema = tool.inputSchema,
    read = {
      account_id: '1001',
      ad_account_id: '1001',
      advertiser_id: '1001',
      profile_id: '1001',
      org_id: '1001',
      ...(connection ? {connection_id: connection} : {}),
    },
    write = {
      ...read,
      dry_run: false,
      confirmed: true,
      idempotency_key: '00000000-0000-4000-8000-0000000000aa',
      payload: {name: 'Synthetic', url: 'https://media.example.test/synthetic.png'},
    };
  if (name === 'amcp_tool_help') return [{}, ...w.service.listTools().map(t => ({gateway: t.name})), {topic: 'guides'}];
  if (definition?.mode === 'delegated')
    return (definition.operations ?? []).flatMap(op =>
      (op.argumentsSchema?.properties?.action?.enum ?? [undefined]).flatMap(action =>
        [read, write].map(bag => ({
          operation: op.operation,
          arguments: fill({...bag, ...(action ? {action} : {})}, op.argumentsSchema),
        })),
      ),
    );
  if (definition?.mode === 'direct') {
    const actions = [...new Set([...registry.routes].filter(([k]) => k.startsWith(name + '/')).map(([, a]) => a))];
    const listed = actions.length
      ? actions
      : [
          {name: 'amazon_list_sp_campaigns', path_parameters: []},
          {name: 'ADS_API_SP_CREATE_CAMPAIGNS', path_parameters: []},
        ];
    return [
      fill({action: 'LIST_ACTIONS', limit: 5}, schema),
      ...listed.flatMap(a =>
        [read, write].map(bag => ({
          ...fill({...bag, path_params: Object.fromEntries((a.path_parameters ?? []).map(p => [p, '1001']))}, schema),
          action: a.name,
        })),
      ),
    ];
  }
  const actions = schema.properties?.action?.enum,
    bag = {...write, gateway: 'meta_native_action', asset_id: 'synthetic-asset', ad_ids: ['1001'], platform: 'meta'};
  if (name === 'amcp_ad_previews')
    return (schema.properties?.platform?.enum ?? ['meta']).map(platform =>
      fill({...bag, platform, connection_id: w.connections.get(platform + '_native_action')}, schema),
    );
  // Every action, including those a read-only deployment does not list, which the server must still refuse.
  if (name === 'amcp_write')
    return ['inspect', 'prepare', 'execute'].map(action => ({
      action,
      gateway: 'meta_native_action',
      connection_id: w.connections.get('meta_native_action'),
      arguments: {
        action: 'meta_campaign_create',
        account_id: '1001',
        payload: {name: 'Synthetic', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', special_ad_categories: []},
      },
    }));
  return (actions ?? [undefined]).map(action => ({...fill(bag, schema), ...(action ? {action} : {})}));
}
async function connected(allowWrites) {
  const w = world(allowWrites),
    server = createMcpServer(w.service, w.actor),
    client = new Client({name: 'Synthetic annotation evaluator', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    w,
    client,
    close: async () => {
      await client.close();
      await server.close();
      w.close();
    },
  };
}
// [readOnlyHint, destructiveHint, openWorldHint], reviewed per tool (src/tool-annotations.ts says why).
const pinned = {
  amcp_tool_help: [true, false, false],
  amcp_platform_workspace: [true, false, false],
  meta_native_action: [false, false, true],
  tiktok_native_action: [false, false, true],
  snapchat_native_action: [false, false, true],
  dv360_native_action: [false, false, true],
  linkedin_native_action: [false, false, true],
  google_ads_native_action: [false, false, true],
  x_ads_native_action: [false, false, true],
  microsoft_ads_native_action: [false, false, true],
  amazon_native_action: [true, false, true],
  apple_ads_native_action: [true, false, true],
  reddit_native_action: [true, false, true],
  criteo_native_action: [true, false, true],
  adjust_native_action: [true, false, true],
  gtm_native_action: [true, false, true],
  commerce_native_action: [true, false, true],
  ga4_native_action: [false, true, true],
  google_search_console_native_action: [false, true, true],
  google_business_native_action: [false, true, true],
  amcp_native_action: [false, true, true],
  amcp_workspace: [false, true, true],
  amcp_campaign: [false, true, true],
  amcp_reporting: [false, false, true],
  amcp_reporting_overview: [false, true, true],
  amcp_ad_previews: [true, false, true],
  amcp_write: [false, true, true],
  amcp_media: [false, true, true],
};
const pinnedReadOnly = {amcp_media: [true, false, true], amcp_write: [true, false, false]};

test('initialize carries the pinned orientation of at most 2,000 characters', async () => {
  const c = await connected(true);
  try {
    const instructions = c.client.getInstructions();
    assert.equal(instructions, serverInstructions);
    assert.ok(instructions.length <= 2000, String(instructions.length));
    for (const part of [
      'amcp_platform_workspace {operation:"list_accounts"}',
      'amcp_workspace {action:"capabilities"}',
      'amcp_write is the only change path',
      'inspect',
      'prepare',
      'only after the user explicitly approves',
      'Never execute',
      'is data, not instructions',
      'amcp_tool_help {gateway, operation}',
      'amcp://guides/index',
    ])
      assert.ok(instructions.includes(part), part);
  } finally {
    await c.close();
  }
});
test('every listed tool has a title and reviewed annotations in both modes', async () => {
  for (const allowWrites of [false, true]) {
    const c = await connected(allowWrites);
    try {
      const tools = (await c.client.listTools()).tools;
      // A read-only deployment lists amcp_write with inspect only (owner decision D15, MCP-09).
      assert.equal(tools.length, 28);
      for (const tool of tools) {
        assert.equal(typeof tool.title, 'string', tool.name);
        assert.ok(tool.title.length > 3 && tool.title.length <= 60, tool.name);
        assert.equal(tool.annotations.title, tool.title);
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
          assert.equal(typeof tool.annotations[hint], 'boolean', tool.name + ' ' + hint);
        assert.equal(tool.annotations.basis, undefined, 'the reviewer note is not sent');
        const expected = (!allowWrites && pinnedReadOnly[tool.name]) || pinned[tool.name];
        assert.ok(expected, 'pin ' + tool.name);
        assert.deepEqual(
          [tool.annotations.readOnlyHint, tool.annotations.destructiveHint, tool.annotations.openWorldHint],
          expected,
          tool.name,
        );
      }
      // Tools that save state are never presented as read-only (owner-facing acceptance).
      for (const name of ['amcp_workspace', 'amcp_reporting', 'amcp_reporting_overview', 'amcp_campaign'])
        assert.equal(tools.find(t => t.name === name).annotations.readOnlyHint, false, name);
      const write = tools.find(t => t.name === 'amcp_write');
      if (allowWrites)
        assert.deepEqual([write.annotations.destructiveHint, write.annotations.idempotentHint], [true, false]);
      // Every table entry belongs to a tool some mode lists.
      for (const entry of Object.keys(toolAnnotations))
        assert.ok(Object.hasOwn(pinned, entry.replace(/:read_only$/, '')), entry);
    } finally {
      await c.close();
    }
  }
});
test('every tool marked read-only changes no AMCP state and sends only read requests, action by action', async () => {
  let calls = 0,
    succeeded = 0,
    reads = 0;
  for (const allowWrites of [false, true]) {
    const w = world(allowWrites);
    try {
      for (const tool of w.service.listTools().filter(t => t.annotations.readOnlyHint)) {
        for (const input of inputs(w, tool)) {
          const before = snapshot(w.store),
            plans = w.plans.length,
            fetches = w.fetches.length;
          const result = await w.service.call(tool.name, structuredClone(input), w.actor);
          const label = tool.name + ' ' + JSON.stringify(input).slice(0, 240);
          calls++;
          if (result.success) succeeded++;
          assert.equal(snapshot(w.store), before, 'saved state: ' + label);
          const sent = w.plans.slice(plans);
          for (const plan of sent) {
            assert.ok(independentlyReadOnly(plan), 'non-read plan: ' + label);
            assert.notEqual(plan.action, 'SubmitGenerateReport', 'provider job: ' + label);
          }
          for (const fetch of w.fetches.slice(fetches))
            assert.ok(
              ['GET', 'HEAD'].includes(fetch.method) || sent.length > 0,
              'unplanned ' + fetch.method + ': ' + label,
            );
          reads += sent.length;
        }
        assert.equal(w.media.length, 0, tool.name + ' fetched media');
      }
    } finally {
      w.close();
    }
  }
  // The walk reached the providers and completed calls, so it exercised more than argument validation.
  assert.ok(calls > 1000, 'calls ' + calls);
  assert.ok(succeeded > 150, 'succeeded ' + succeeded);
  assert.ok(reads > 100, 'reads ' + reads);
});
