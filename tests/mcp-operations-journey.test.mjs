import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
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
import {allocationReport} from './fixtures/allocation-data.mjs';
import {snapchatAllocationData} from './fixtures/snapchat-allocation-data.mjs';
import {metaPortfolioData} from './fixtures/meta-portfolio-data.mjs';
import {catalogComparisonData, catalogComparisonInput} from './fixtures/catalog-comparison-data.mjs';
import {googleConversionBrief, googleRecipeGoalsData} from './fixtures/google-recipe-goals-data.mjs';

test('MCP inspects exact conversion defaults with a read grant, preserves write blockers and saves only an unapproved paused draft', async t => {
  const data = googleRecipeGoalsData({pageSize: 1}),
    f = await fixture('operator', (url, init) => Response.json(data.response(url, init)));
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: googleConversionBrief.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic read-only conversion account',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  assert.match(f.tools.find(t => t.name === 'amcp_campaign').description, /enabled explicit primary actions/);
  const recipe = 'google_search_target_cpa',
    business = googleConversionBrief;
  assert.equal((await f.call('amcp_campaign', {action: 'recipe_context', recipe})).success, true);
  const local = await f.call('amcp_campaign', {action: 'recipe_eligibility', recipe, business});
  assert.equal(local.success, true, JSON.stringify(local));
  assert.equal(f.metrics().provider_requests, 0);
  const inspected = await f.call('amcp_campaign', {action: 'recipe_eligibility', recipe, business, live: true});
  assert.equal(inspected.success, true, JSON.stringify(inspected));
  assert.equal(inspected.data.status, 'blocked');
  assert.equal(inspected.data.dependencies.find(d => d.id === 'primary_conversion_actions').status, 'ready');
  assert.equal(inspected.data.dependencies.find(d => d.id === 'conversion_event_delivery').status, 'unknown');
  assert.equal(inspected.data.conversion_goal_inspection.network_requests, 14);
  assert.equal(inspected.data.provider_mutations, 0);
  const saved = await f.call('amcp_campaign', {action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.data.state, 'draft');
  const full = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.success, true, JSON.stringify(full));
  assert.equal(full.data.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create.status, 'PAUSED');
  assert.equal(full.data.steps.length, 6);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.equal(f.metrics().provider_requests, 14);
  f.store.revokeKey(f.key);
  assert.equal(
    (await f.call('amcp_campaign', {action: 'recipe_eligibility', recipe, business, live: true})).success,
    false,
  );
  assert.equal(f.metrics().provider_requests, 14);
  t.diagnostic(
    JSON.stringify({
      journey: 'conversion-goal-inspection',
      ...f.metrics(),
      qualification: 'real SDK; synthetic selected-account searches; zero events or advertising mutations',
    }),
  );
});

test('MCP compares a catalog import and saves only its eligible source products as an unapproved draft without advertising mutations', async t => {
  const data = catalogComparisonData(),
    f = await fixture('operator', async (url, init) => {
      assert.equal(init.method, 'GET');
      return Response.json(data.response(url));
    });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: catalogComparisonInput.connection_id,
      tenantId: f.actor.tenantId,
      gateway: catalogComparisonInput.gateway,
      accounts: ['123'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic read-only catalog',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic'},
  );
  assert.match(f.tools.find(t => t.name === 'amcp_workspace').description, /catalog_compare/);
  const result = await f.call('amcp_workspace', catalogComparisonInput);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(
    result.data.items.map(i => i.state),
    ['new', 'changed', 'matching', 'unknown'],
  );
  const handoff = new URL(result.meta.workflow.website_path, 'https://synthetic.example.test');
  assert.equal(handoff.pathname, '/commerce');
  for (const key of ['account_id', 'connection_id', 'catalog_id'])
    assert.equal(handoff.searchParams.get(key), catalogComparisonInput[key]);
  assert.equal(handoff.searchParams.get('catalog_comparison'), '1');
  assert.equal(handoff.searchParams.get('products'), null);
  const selected = new Set(result.data.review_retailer_ids),
    original = structuredClone(catalogComparisonInput),
    products = original.products.filter(p => selected.has(p.retailer_id)),
    saved = await f.call('amcp_workspace', {...original, action: 'catalog_plan', products});
  assert.equal(saved.success, true, JSON.stringify(saved));
  assert.equal(saved.data.state, 'draft');
  assert.equal(saved.data.steps.length, 3);
  const full = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.success, true, JSON.stringify(full));
  assert.deepEqual(
    full.data.steps.map(s => s.arguments.payload.retailer_id),
    ['001', '002', '004'],
  );
  assert.deepEqual(
    full.data.steps.map(s => s.arguments.payload.price),
    [1234, 2000, 999],
  );
  assert.equal(f.metrics().provider_requests, result.data.network_requests, 'saving only creates a local draft');
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  assert.deepEqual(original, catalogComparisonInput);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_workspace', catalogComparisonInput)).success, false);
  assert.equal(f.metrics().provider_requests, result.data.network_requests);
  t.diagnostic(
    JSON.stringify({
      journey: 'catalog-comparison-draft',
      ...f.metrics(),
      qualification: 'real SDK; synthetic qualified Meta reads; zero advertising mutations',
    }),
  );
});
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';
import {xPortfolioResponse} from './fixtures/x-portfolio-data.mjs';
import {tiktokEvidenceInput, tiktokEvidenceResponse} from './fixtures/tiktok-evidence-data.mjs';
import {
  snapchatEvidenceInput,
  snapchatEvidenceResponse,
  snapchatEvidenceCampaign,
  snapchatEvidenceEntity,
} from './fixtures/snapchat-evidence-data.mjs';
import {gtmWorkspaceEntities} from '../dist/src/gtm-workspace-writes.js';
import {
  measurementIdentityInput,
  measurementIdentityMetadata,
  measurementIdentityReport,
} from './fixtures/measurement-identity-data.mjs';
import {
  googleEvidenceInput,
  googleEvidenceResponse,
  googleEvidenceRow,
  googleEvidenceCustomer,
} from './fixtures/google-evidence-data.mjs';

test('MCP inspects an exact synthetic GA4 test identifier and carries its original scope to the website without sending events', async t => {
  const requests = [],
    f = await fixture('reader', async (raw, init) => {
      const u = new URL(String(raw));
      assert.equal(u.hostname, 'analyticsdata.googleapis.com');
      requests.push({method: init.method, path: u.pathname});
      if (u.pathname === '/v1beta/properties/123/metadata') {
        assert.equal(init.method, 'GET');
        return Response.json(measurementIdentityMetadata());
      }
      assert.equal(u.pathname, '/v1beta/properties/123:runReport');
      assert.equal(init.method, 'POST');
      return Response.json(measurementIdentityReport());
    });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: measurementIdentityInput.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    {accessToken: 'synthetic'},
  );
  assert.match(f.tools.find(x => x.name === 'amcp_workspace').description, /measurement_event_identity/);
  const result = await f.call('amcp_workspace', measurementIdentityInput);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.observation.reported_count, '1');
  const handoff = new URL(result.meta.workflow.website_path, 'https://synthetic.example.test');
  assert.equal(handoff.pathname, '/measurement');
  assert.equal(handoff.searchParams.get('event_identity'), '1');
  for (const [field, value] of Object.entries({
    account_id: '123',
    connection_id: measurementIdentityInput.connection_id,
    ...measurementIdentityInput.requirements,
  }))
    assert.equal(handoff.searchParams.get(field), String(value));
  assert.equal(result.data.provider_mutations, 0);
  assert.equal(requests.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NATIVE/);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_workspace', measurementIdentityInput)).success, false);
  assert.equal(requests.length, 3);
  t.diagnostic(
    JSON.stringify({
      journey: 'ga4-test-identity',
      ...f.metrics(),
      qualification: 'real SDK, synthetic native metadata/report reads; zero event sends and provider mutations',
    }),
  );
});
async function fixture(role = 'operator', provider, personal = false) {
  const store = new Store(':memory:', Buffer.alloc(32, 73).toString('base64'));
  let identity = {tenantId: 'protocol-journey', userId: 'member', role};
  if (personal) {
    const accounts = new UserAccounts(
      new WebStore(store, {
        origin: 'https://sdk.example.test',
        masterKey: Buffer.alloc(32, 73).toString('base64'),
        authEnv: {},
      }),
    );
    const user = accounts.newUser('SDK member', 'sdk@example.test', null, true);
    identity = {tenantId: user.tenant_id, userId: user.id, ownerUserId: user.id, role};
  }
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
    new NativeTransport(async (url, init) => {
      network++;
      if (provider) return provider(url, init);
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

test('MCP turns retained Snapchat ad-squad allocation evidence into an unapproved draft and refuses revoked access', async t => {
  const data = snapchatAllocationData(),
    f = await fixture('operator', async (url, init) => {
      assert.equal(init.method, 'GET');
      return Response.json(data.response(url));
    });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: data.report.connection_id,
      tenantId: f.actor.tenantId,
      gateway: data.report.gateway,
      accounts: [data.report.account_id],
      writeAccounts: [data.report.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  f.store.putDocument(f.actor.tenantId, 'decision_report', 'snap-source', data.report);
  assert.equal((await f.call('amcp_reporting', {action: 'allocation_candidates', id: 'snap-source'})).success, true);
  assert.equal(
    (await f.call('amcp_reporting', {action: 'allocation', id: 'snap-source', options: data.options})).success,
    true,
  );
  const p = await f.call('amcp_reporting', {
    action: 'preview_allocation_plan',
    id: 'snap-source',
    options: data.options,
    conversion: 'equal_daily',
  });
  assert.equal(p.success, true, JSON.stringify(p));
  assert.equal(p.data.native_source_references.length, 10);
  const draft = await f.call('amcp_reporting', {
    action: 'create_allocation_plan',
    id: 'snap-source',
    preview_id: p.data.preview_id,
    preview_hash: p.data.preview_hash,
    confirmed: true,
  });
  assert.equal(draft.success, true, JSON.stringify(draft));
  assert.equal(draft.data.advertising_writes, 0);
  const inspected = await f.call('amcp_campaign', {action: 'get', id: draft.data.id});
  assert.equal(inspected.success, true);
  assert.equal(inspected.data.state, 'draft');
  const count = f.metrics().provider_requests;
  assert.equal(count, 20);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_campaign', {action: 'get', id: draft.data.id})).success, false);
  assert.equal(f.metrics().provider_requests, count);
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-allocation-draft',
      ...f.metrics(),
      qualification: 'real SDK; retained synthetic fixture and GETs; no mutation',
    }),
  );
});

test('MCP assesses a current campaign brief with exact read-only evidence and rejects revoked access through advertised schemas', async t => {
  const business = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  const f = await fixture('operator', (url, init) => {
    assert.ok(String(url).endsWith('/customers/123/googleAds:search'));
    assert.equal(init.method, 'POST');
    assert.match(
      JSON.parse(init.body).query,
      /^SELECT customer\.id, customer\.currency_code, customer\.time_zone FROM customer LIMIT 1$/,
    );
    return Response.json({results: [{customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'}}]});
  });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: business.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic Search',
      scopes: [],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const input = {action: 'recipe_eligibility', recipe: 'google_search', business};
  const context = await f.call('amcp_campaign', {action: 'recipe_context', recipe: 'google_search'});
  assert.equal(context.success, true);
  const local = await f.call('amcp_campaign', input);
  assert.equal(local.success, true, JSON.stringify(local));
  assert.equal(local.data.status, 'unknown');
  assert.equal(local.meta.workflow.website_path, '/campaigns#campaign-create');
  assert.equal(f.metrics().provider_requests, 0);
  const native = await f.call('amcp_campaign', local.data.next_call.arguments);
  assert.equal(native.success, true, JSON.stringify(native));
  assert.equal(native.data.scope.account_id, '123');
  assert.equal(native.data.dependencies.find(d => d.id === 'account_currency').status, 'ready');
  assert.equal(native.data.dependencies.find(d => d.id === 'provider_objective_acceptance').status, 'unknown');
  assert.equal(native.data.provider_mutations, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'campaign_run').length, 0);
  const before = f.metrics().provider_requests;
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_campaign', {...input, live: true})).success, false);
  assert.equal(f.metrics().provider_requests, before);
  assert.equal(before, 1);
  t.diagnostic(
    JSON.stringify({
      journey: 'recipe-eligibility',
      ...f.metrics(),
      qualification: 'real SDK; synthetic read-only provider only',
    }),
  );
});

test('MCP captures selected Snapchat campaign ad-squad evidence with native parent lineage and current reader access', async t => {
  const f = await fixture('reader', (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(snapchatEvidenceResponse(url));
  });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: snapchatEvidenceInput.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [snapchatEvidenceInput.account_id],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  const input = {...snapchatEvidenceInput, preset: 'snapchat_adsquad', campaign_id: snapchatEvidenceCampaign};
  const first = await f.call('amcp_reporting', input);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.data.native_account_evidence.parent_campaign.id, snapchatEvidenceCampaign);
  assert.equal(first.data.native_account_evidence.parent_campaign.checks.length, 3);
  const second = await f.call('amcp_reporting', input);
  assert.equal(second.success, true, JSON.stringify(second));
  const compared = await f.call('amcp_reporting', {
    action: 'reconcile_report',
    id: first.data.id,
    reference_id: second.data.id,
  });
  assert.equal(compared.success, true);
  assert.equal(compared.data.matched, true);
  const before = f.metrics().provider_requests;
  assert.equal(before, 12);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_reporting', {action: 'get', id: first.data.id})).success, false);
  assert.equal(f.metrics().provider_requests, before);
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-squad-evidence',
      ...f.metrics(),
      qualification: 'real SDK; synthetic GETs only',
    }),
  );
});

test('MCP pages saved evidence through advertised schemas without native request bodies and refuses revoked continuation access', async t => {
  const f = await fixture('reader');
  t.after(() => f.close());
  for (let i = 0; i < 3; i++)
    f.store.putDocument(f.actor.tenantId, 'decision_report', 'synthetic-index-' + i, {
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: 'meta',
      source: 'provider_read',
      preset: 'meta_campaign',
      grain: 'campaign × day',
      source_hash: 'a'.repeat(64),
      captured_at: 1790900000000,
      semantics: {
        source_name: 'Synthetic retained ' + i,
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-02',
        attribution: 'declared',
        conversion_definition: 'purchase',
        complete: true,
      },
      rows: [{entity_id: '100', marker: 'SDK-RAW-ROW'}],
      source_request: {marker: 'SDK-RAW-REQUEST'},
    });
  const first = await f.call('amcp_reporting', {action: 'list', limit: 1, search: 'Synthetic retained'});
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.data.reports.length, 1);
  assert.equal(first.data.reports[0].semantics.complete, true);
  assert.doesNotMatch(JSON.stringify(first.data), /SDK-RAW/);
  assert.ok(first.data.next_cursor);
  const second = await f.call('amcp_reporting', {
    action: 'list',
    limit: 2,
    search: 'Synthetic retained',
    cursor: first.data.next_cursor,
  });
  assert.equal(second.success, true);
  assert.equal(second.data.reports.length, 2);
  assert.equal(second.data.has_more, false);
  f.store.revokeKey(f.key);
  assert.equal(
    (await f.call('amcp_reporting', {action: 'list', search: 'Synthetic retained', cursor: first.data.next_cursor}))
      .success,
    false,
  );
  assert.equal(f.metrics().provider_requests, 0);
  t.diagnostic(
    JSON.stringify({
      journey: 'saved-evidence-index',
      ...f.metrics(),
      qualification: 'real SDK; synthetic retained metadata only; no provider calls',
    }),
  );
});

test('MCP Snapchat daily purchase evidence preserves native semantics and reconciles retained rows with current reader access', async t => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(snapchatEvidenceResponse(url));
  });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: snapchatEvidenceInput.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [snapchatEvidenceInput.account_id],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  const discover = await f.call('amcp_reporting', {action: 'capture_presets'});
  assert.equal(discover.success, true, JSON.stringify(discover));
  assert.equal(discover.data.presets.filter(p => p.id.startsWith('snapchat_')).length, 6);
  const first = await f.call('amcp_reporting', snapchatEvidenceInput);
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.data.totals.spend, '20.246912');
  assert.equal(first.data.source_pages[0].row_count, 2);
  assert.match(first.data.semantics.attribution, /conversion time; total sources/);
  const tail = await f.call('amcp_reporting', {action: 'get', id: first.data.id, offset: 1, limit: 1});
  assert.equal(tail.success, true);
  assert.equal(tail.data.rows[0].date, '2026-09-02');
  const second = await f.call('amcp_reporting', snapchatEvidenceInput);
  assert.equal(second.success, true);
  const compared = await f.call('amcp_reporting', {
    action: 'reconcile_report',
    id: first.data.id,
    reference_id: second.data.id,
  });
  assert.equal(compared.success, true);
  assert.equal(compared.data.matched, true);
  assert.equal(compared.data.network_requests, 0);
  const before = f.metrics().provider_requests;
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_reporting', {action: 'get', id: first.data.id})).success, false);
  assert.equal(f.metrics().provider_requests, before);
  assert.equal(before, 6);
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-daily-evidence',
      ...f.metrics(),
      qualification: 'real SDK; synthetic read-only provider only',
    }),
  );
});

test('MCP captures native Snapchat lead counts with independent definitions and current reader authority through advertised schemas', async t => {
  const f = await fixture('reader', (raw, init) => {
    assert.equal(init.method, 'GET');
    const url = new URL(raw),
      level = url.searchParams.get('breakdown') ?? 'campaign',
      row = snapchatEvidenceEntity(level);
    for (const day of row.timeseries) {
      day.stats.native_leads = '3';
      delete day.stats.conversion_purchases;
    }
    const data = snapchatEvidenceResponse(url, [row]);
    if (url.pathname.endsWith('/stats')) {
      const stat = data.timeseries_stats[0].timeseries_stat;
      delete stat.swipe_up_attribution_window;
      delete stat.view_attribution_window;
      delete stat.conversion_data_processed_end_time;
      assert.equal(url.searchParams.get('fields'), 'spend,impressions,swipes,native_leads');
      assert.equal(url.searchParams.has('action_report_time'), false);
    }
    return Response.json(data);
  });
  t.after(() => f.close());
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: snapchatEvidenceInput.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [snapchatEvidenceInput.account_id],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  const discover = await f.call('amcp_reporting', {action: 'capture_presets'});
  assert.equal(discover.success, true);
  assert.equal(discover.data.presets.filter(p => p.id.endsWith('_leads')).length, 3);
  const {swipe_up_attribution_window, view_attribution_window, ...base} = snapchatEvidenceInput,
    captured = [];
  for (const level of ['campaign', 'adsquad', 'ad']) {
    const out = await f.call('amcp_reporting', {
      ...base,
      preset: 'snapchat_' + level + '_leads',
      ...(level === 'campaign' ? {} : {campaign_id: snapchatEvidenceCampaign}),
    });
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.totals.conversions, '6');
    assert.equal(out.data.totals.spend, '20.246912');
    assert.equal(out.data.semantics.conversion_definition, 'native_leads (submitted native lead forms)');
    captured.push(out.data);
  }
  const tail = await f.call('amcp_reporting', {action: 'get', id: captured[2].id, offset: 1, limit: 1});
  assert.equal(tail.success, true);
  assert.equal(tail.data.rows[0].conversions, '3');
  const before = f.metrics().provider_requests;
  assert.equal(before, 15);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_reporting', {action: 'get', id: captured[2].id})).success, false);
  assert.equal(f.metrics().provider_requests, before);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  t.diagnostic(
    JSON.stringify({
      journey: 'snapchat-native-lead-evidence',
      ...f.metrics(),
      qualification: 'real SDK; synthetic aggregate GETs only; no submitted lead records or advertising mutations',
    }),
  );
});

test('MCP discovers, previews and saves a paused Maximize Clicks plan with exact native ceiling through advertised schemas', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {cpc_bid, ...base} = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  const business = {...base, cpc_bid_ceiling: '1.250001'},
    recipe = 'google_search_clicks';
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: business.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [business.account_id],
      writeAccounts: [business.account_id],
      enabled: true,
      label: 'Synthetic Search',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const recipes = await f.call('amcp_campaign', {action: 'recipes'});
  assert.equal(recipes.success, true, JSON.stringify(recipes));
  assert.ok(recipes.data.recipes.some(r => r.id === recipe));
  const context = await f.call('amcp_campaign', {action: 'recipe_context', recipe});
  assert.equal(context.success, true, JSON.stringify(context));
  assert.ok(context.data.recipe.required.includes('cpc_bid_ceiling'));
  const preview = await f.call('amcp_campaign', {action: 'preview_recipe', recipe, business});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.data.provider_mutations, 0);
  const saved = await f.call('amcp_campaign', {action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const full = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.success, true, JSON.stringify(full));
  const campaign = full.data.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create;
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.target_spend, {cpc_bid_ceiling_micros: '1250001'});
  assert.equal(
    full.data.steps.find(s => s.id === 'adgroup').arguments.payload.operations[0].create.cpc_bid_micros,
    undefined,
  );
  assert.equal(full.data.recipe.bidding_strategy, 'TARGET_SPEND');
  assert.equal(saved.meta.workflow.website_path, '/campaigns?id=' + encodeURIComponent(saved.data.id));
  assert.equal(f.metrics().provider_requests, 0);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'})).success, false);
  assert.equal(f.metrics().tool_calls, 6);
  t.diagnostic('Maximize Clicks recipe SDK: ' + JSON.stringify(f.metrics()));
});

test('MCP discovers both conversion Search workflows and saves exact CPA through advertised schemas without provider calls', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {cpc_bid, ...base} = JSON.parse(
    readFileSync('Skills/amcp-campaign-builder/examples/contracts.json', 'utf8'),
  ).recipe_business;
  const business = {...base, conversion_goal_policy: 'ACCOUNT_DEFAULT', target_cpa: '00015.250001'},
    recipe = 'google_search_target_cpa';
  f.store.putConnection(
    {...f.actor, role: 'admin'},
    {
      id: business.connection_id,
      tenantId: f.actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: [business.account_id],
      writeAccounts: [business.account_id],
      enabled: true,
      label: 'Synthetic conversion Search',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const recipes = await f.call('amcp_campaign', {action: 'recipes'});
  assert.equal(recipes.success, true, JSON.stringify(recipes));
  for (const id of ['google_search_conversions', recipe]) assert.ok(recipes.data.recipes.some(r => r.id === id));
  const context = await f.call('amcp_campaign', {action: 'recipe_context', recipe});
  assert.equal(context.success, true, JSON.stringify(context));
  assert.ok(context.data.recipe.required.includes('conversion_goal_policy'));
  const preview = await f.call('amcp_campaign', {action: 'preview_recipe', recipe, business});
  assert.equal(preview.success, true, JSON.stringify(preview));
  assert.equal(preview.data.provider_mutations, 0);
  const saved = await f.call('amcp_campaign', {action: 'create_from_recipe', recipe, business});
  assert.equal(saved.success, true, JSON.stringify(saved));
  const full = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
  assert.equal(full.success, true, JSON.stringify(full));
  const campaign = full.data.steps.find(s => s.id === 'campaign').arguments.payload.operations[0].create;
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.maximize_conversions, {target_cpa_micros: '15250001'});
  assert.equal(full.data.recipe.conversion_goal_policy, 'ACCOUNT_DEFAULT');
  assert.equal(full.data.state, 'draft');
  assert.equal(f.metrics().provider_requests, 0);
  assert.equal(f.store.documents(f.actor.tenantId, 'write_review').length, 0);
  f.store.revokeKey(f.key);
  assert.equal((await f.call('amcp_campaign', {action: 'get', id: saved.data.id})).success, false);
  assert.equal(f.metrics().tool_calls, 6);
  assert.equal(f.metrics().provider_requests, 0);
  t.diagnostic('Conversion Search recipe SDK: ' + JSON.stringify(f.metrics()));
});

test('MCP search-term evidence becomes a scoped unapproved exact-exclusion draft through advertised schemas', async t => {
  const connectionId = 'ffffffff-1111-4111-8111-111111111114',
    day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const term = {
    ...googleEvidenceRow('search_term_view', '1', '2', "free engineer's book"),
    metrics: {clicks: '40', impressions: '100', costMicros: '9007199254740993', conversions: 0},
  };
  const f = await fixture('operator', (url, init) => {
    assert.ok(String(url).endsWith('/googleAds:search'), 'synthetic reads only');
    const body = JSON.parse(init.body),
      kind = / FROM (\w+)/.exec(body.query)?.[1];
    if (kind === 'ad_group')
      return Response.json({
        results: [
          {
            customer: googleEvidenceCustomer(),
            campaign: {
              id: '1',
              resourceName: 'customers/123/campaigns/1',
              status: 'ENABLED',
              advertisingChannelType: 'SEARCH',
            },
            adGroup: {
              id: '2',
              resourceName: 'customers/123/adGroups/2',
              campaign: 'customers/123/campaigns/1',
              status: 'ENABLED',
              type: 'SEARCH_STANDARD',
            },
          },
        ],
        totalResultsCount: '1',
      });
    if (kind === 'ad_group_criterion') return Response.json({results: [], totalResultsCount: '0'});
    return Response.json(googleEvidenceResponse(body, [term]));
  });
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connectionId,
        tenantId: f.actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        writeAccounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    assert.match(f.tools.find(t => t.name === 'amcp_reporting').description, /preview_search_exclusions/);
    const captured = await f.call('amcp_reporting', {
      ...googleEvidenceInput,
      preset: 'google_search_terms',
      semantics: {...googleEvidenceInput.semantics, date_from: day, date_to: day, attribution: 'Declared 30-day click'},
    });
    assert.equal(captured.success, true, JSON.stringify(captured));
    const options = {minimum_clicks: 30, maximum_age_days: 7},
      id = captured.data.id;
    const list = await f.call('amcp_reporting', {action: 'search_exclusion_candidates', id, options});
    assert.equal(list.success, true, JSON.stringify(list));
    assert.equal(list.data.candidates[0].observed_spend, '9007199254.740993');
    const p = await f.call('amcp_reporting', {
      action: 'preview_search_exclusions',
      id,
      ids: [list.data.candidates[0].entity_id],
      options,
    });
    assert.equal(p.success, true, JSON.stringify(p));
    const args = {
      action: 'create_search_exclusion_plan',
      id,
      preview_id: p.data.preview_id,
      preview_hash: p.data.preview_hash,
      confirmed: true,
    };
    const created = await f.call('amcp_reporting', args),
      replayed = await f.call('amcp_reporting', args);
    assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(replayed.data.id, created.data.id);
    assert.equal(created.meta.workflow.website_path, '/campaigns?id=' + created.data.id);
    const plan = await f.call('amcp_campaign', {action: 'get', id: created.data.id, detail: 'full'});
    assert.equal(plan.success, true, JSON.stringify(plan));
    assert.equal(plan.data.state, 'draft');
    assert.equal(plan.data.search_exclusions.report_id, id);
    assert.equal(plan.data.steps[0].arguments.payload.operations[0].create.keyword.match_type, 'EXACT');
    assert.equal(plan.data.steps[0].arguments.payload.operations[0].create.keyword.text, "free engineer's book");
    assert.equal(f.metrics().provider_requests, 9);
    f.store.revokeKey(f.key);
    assert.equal((await f.call('amcp_reporting', {action: 'search_exclusion_candidates', id, options})).success, false);
    assert.equal(f.metrics().provider_requests, 9);
    t.diagnostic(
      JSON.stringify({
        journey: 'source-to-search-exclusion-draft',
        ...f.metrics(),
        qualification:
          'real SDK with synthetic Google Search POST reads; one unapproved local draft and zero advertising mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP LinkedIn guided evidence keeps verified account references through retained search and comparison', async t => {
  const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111',
    day = new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    [year, month, date] = day.split('-').map(Number),
    f = await fixture('reader', async (url, init) => {
      assert.equal(init.method, 'GET');
      const path = new URL(url).pathname;
      if (path === '/rest/adAccounts/100') return Response.json({id: 100, currency: 'USD', billing: 'PRIVATE'});
      assert.equal(path, '/rest/adAnalytics');
      return Response.json({
        elements: [
          {
            pivotValues: ['urn:li:sponsoredCampaign:9007199254740993'],
            dateRange: {start: {year, month, day: date}, end: {year, month, day: date}},
            costInLocalCurrency: '10.123456789',
            impressions: 100,
            clicks: 12,
            externalWebsiteConversions: 2,
            conversionValueInLocalCurrency: '42.51',
          },
        ],
      });
    });
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connectionId,
        tenantId: f.actor.tenantId,
        gateway: 'linkedin_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['r_ads', 'r_ads_reporting'],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      action: 'capture_preset',
      preset: 'linkedin_campaign',
      account_id: '100',
      connection_id: connectionId,
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        date_from: day,
        date_to: day,
        source_name: 'Synthetic LinkedIn',
        attribution: 'Declared conversion rule windows',
        complete: true,
      },
    };
    const first = await f.call('amcp_reporting', args);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.data.native_account_evidence.checks.length, 2);
    assert.equal(first.data.source_collection, 'linkedin_analytics');
    assert.equal(first.data.source_pages.length, 1);
    assert.equal(first.data.rows[0].entity_id, 'urn:li:sponsoredCampaign:9007199254740993');
    const saved = await f.call('amcp_reporting', {action: 'get', id: first.data.id, row_query: '9007199254740993'});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.matched_row_count, 1);
    assert.equal(saved.data.source_hash, first.data.source_hash);
    assert.equal(saved.data.totals.spend, '10.123456789');
    const second = await f.call('amcp_reporting', args);
    const comparison = await f.call('amcp_reporting', {
      action: 'reconcile_report',
      id: first.data.id,
      reference_id: second.data.id,
    });
    assert.equal(comparison.success, true, JSON.stringify(comparison));
    assert.equal(comparison.data.matched, true);
    assert.equal(f.metrics().provider_requests, 6);
    assert.doesNotMatch(JSON.stringify([first, saved, second, comparison]), /PRIVATE|accessToken/);
    assert.equal((await f.call('amcp_reporting', {...args, account_id: '999'})).success, false);
    f.store.revokeKey(f.key);
    assert.equal((await f.call('amcp_reporting', {action: 'get', id: first.data.id})).success, false);
    assert.equal(f.metrics().provider_requests, 6);
    t.diagnostic(JSON.stringify({journey: 'linkedin-guided-evidence', ...f.metrics(), provider_writes: 0}));
  } finally {
    await f.close();
  }
});

test('MCP retained row search pages exact matching evidence through advertised schemas with no collection or write', async t => {
  const f = await fixture('reader');
  try {
    const rows = Array.from({length: 103}, (_, i) => ({
      entity_id: String(9007199254740993n + BigInt(i)),
      entity_name: i % 2 ? 'بيت الرياض' : 'Home',
      spend: '0.123456789',
      conversions: null,
    }));
    const report = {
      ...allocationReport(),
      rows,
      source_hash: sha256(stable(rows)),
      mapping: {entity_id: '/campaign_id', entity_name: '/campaign_name', spend: '/spend'},
      totals: {spend: '12.716049267', conversions: null},
    };
    f.store.putDocument(f.actor.tenantId, 'decision_report', 'row-tools', report);
    const get = args => f.call('amcp_reporting', {action: 'get', id: 'row-tools', ...args});
    const first = await get({});
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.data.row_count, 103);
    assert.equal(first.data.matched_row_count, 103);
    const query = await get({row_query: 'الرياض', limit: 50});
    assert.equal(query.success, true, JSON.stringify(query));
    assert.equal(query.data.row_query, 'الرياض');
    assert.equal(query.data.matched_row_count, 51);
    assert.equal(query.data.rows.length, 50);
    assert.equal(query.data.has_more, true);
    const last = await get({row_query: 'الرياض', offset: 50, limit: 50});
    assert.equal(last.data.rows.length, 1);
    assert.equal(last.data.rows[0].entity_id, rows[101].entity_id);
    assert.equal(last.data.rows[0].spend, '0.123456789');
    assert.equal(last.data.rows[0].conversions, null);
    assert.equal(last.data.has_more, false);
    const exact = await get({row_query: rows[102].entity_id});
    assert.equal(exact.data.matched_row_count, 1);
    assert.equal(exact.data.rows[0].entity_id, rows[102].entity_id);
    const clear = await get({row_query: ''});
    assert.equal(clear.data.matched_row_count, 103);
    for (const result of [query, last, exact, clear]) {
      assert.equal(result.data.source_hash, first.data.source_hash);
      assert.deepEqual(result.data.totals, first.data.totals);
      assert.equal(result.data.xlsx_path, first.data.xlsx_path);
    }
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: 'meta',
        tenantId: f.actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['999'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const removed = await get({row_query: 'الرياض'});
    assert.equal(removed.success, false);
    assert.equal(removed.data, undefined);
    f.store.revokeKey(f.key);
    const revoked = await get({row_query: 'Home'});
    assert.equal(revoked.success, false);
    assert.equal(revoked.data, undefined);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify({journey: 'retained-row-search', ...f.metrics(), provider_writes: 0}));
  } finally {
    await f.close();
  }
});

test('MCP Google guided evidence captures exact native identities, retained lineage and comparison without write access', async t => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(new URL(url).pathname, '/v25/customers/123/googleAds:search');
    assert.equal(init.method, 'POST');
    return Response.json(googleEvidenceResponse(JSON.parse(init.body)));
  });
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: googleEvidenceInput.connection_id,
        tenantId: f.actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic Google',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      ...googleEvidenceInput,
      preset: 'google_ad',
      semantics: {...googleEvidenceInput.semantics, attribution: 'Declared account conversion settings'},
    };
    const first = await f.call('amcp_reporting', args);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.data.rows[0].entity_id, 'customers/123/adGroupAds/2~9007199254740993');
    assert.equal(first.data.native_account_evidence.checks.length, 2);
    assert.match(first.meta.workflow.website_path, /^\/reports/);
    const saved = await f.call('amcp_reporting', {action: 'get', id: first.data.id});
    assert.equal(saved.data.source_hash, first.data.source_hash);
    const second = await f.call('amcp_reporting', args);
    const comparison = await f.call('amcp_reporting', {
      action: 'reconcile_report',
      id: first.data.id,
      reference_id: second.data.id,
    });
    assert.equal(comparison.success, true, JSON.stringify(comparison));
    assert.equal(comparison.data.matched, true);
    assert.equal(f.metrics().provider_requests, 6);
    assert.doesNotMatch(JSON.stringify([first, saved, second, comparison]), /PRIVATE|accessToken/);
    const wrong = await f.call('amcp_reporting', {...args, account_id: '999'});
    assert.equal(wrong.success, false);
    f.store.revokeKey(f.key);
    const revoked = await f.call('amcp_reporting', args);
    assert.equal(revoked.success, false);
    assert.equal(f.metrics().provider_requests, 6);
    t.diagnostic(
      JSON.stringify({
        journey: 'google-guided-evidence',
        ...f.metrics(),
        qualification: 'real SDK with six synthetic Google Search POST reads; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP TikTok daily evidence captures, retrieves and compares source-bound reports through advertised schemas', async t => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(tiktokEvidenceResponse(url));
  });
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: tiktokEvidenceInput.connection_id,
        tenantId: f.actor.tenantId,
        gateway: 'tiktok_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic TikTok',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      ...tiktokEvidenceInput,
      semantics: {...tiktokEvidenceInput.semantics, attribution: 'Declared conversion rule'},
    };
    const first = await f.call('amcp_reporting', args);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.match(first.meta.workflow.website_path, /^\/reports/);
    const saved = await f.call('amcp_reporting', {action: 'get', id: first.data.id});
    assert.equal(saved.data.source_hash, first.data.source_hash);
    assert.equal(saved.data.rows[0].entity_id, '9007199254740993');
    assert.equal(saved.data.totals.spend, '10.123456789');
    const second = await f.call('amcp_reporting', args);
    assert.equal(second.success, true, JSON.stringify(second));
    const comparison = await f.call('amcp_reporting', {
      action: 'reconcile_report',
      id: first.data.id,
      reference_id: second.data.id,
    });
    assert.equal(comparison.success, true, JSON.stringify(comparison));
    assert.equal(f.metrics().provider_requests, 6);
    assert.doesNotMatch(JSON.stringify([first, saved, second, comparison]), /PRIVATE|accessToken/);
    t.diagnostic(
      JSON.stringify({
        journey: 'tiktok-daily-evidence',
        ...f.metrics(),
        qualification: 'real SDK with six synthetic GETs; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP X portfolio follows scoped native campaign, line-item and promoted-post reads through signed pages', async t => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(xPortfolioResponse(url));
  });
  try {
    const connection = 'ffffffff-1111-4111-8111-111111111112';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'x_ads_native_action',
        accounts: ['acct1'],
        enabled: true,
        label: 'Synthetic X',
        scopes: [],
      },
      {
        accessToken: 'synthetic-token',
        consumerKey: 'synthetic-key',
        consumerSecret: 'synthetic-secret',
        tokenSecret: 'synthetic-token-secret',
      },
    );
    const args = {
      action: 'portfolio',
      gateway: 'x_ads_native_action',
      account_id: 'acct1',
      connection_id: connection,
      limit: 2,
    };
    const root = await f.call('amcp_workspace', {...args, requirements: {entity: 'campaign'}});
    assert.equal(root.success, true, JSON.stringify(root));
    assert.equal(root.meta.workflow.website_path, '/portfolio');
    assert.equal(root.data.rows[0].native_money.daily_budget_amount_local_micro, '9007199254740993');
    const next = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'campaign'},
      cursor: root.data.next_cursor,
    });
    assert.equal(next.data.rows[0].id, 'camp3');
    const lines = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'line_item', campaign_id: root.data.rows[0].id},
    });
    assert.equal(lines.data.rows[0].native_money.bid_amount_local_micro, '320000');
    const posts = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'promoted_tweet', campaign_id: root.data.rows[0].id, line_item_id: lines.data.rows[0].id},
    });
    assert.equal(posts.data.rows[0].id, 'post1');
    assert.equal(posts.data.rows[0].tweet_id, '880290790664060928');
    assert.equal(posts.data.rows[0].approval_status, 'ACCEPTED');
    assert.doesNotMatch(JSON.stringify([root, next, lines, posts]), /PRIVATE|synthetic-secret/);
    assert.equal(f.metrics().provider_requests, 11);
    t.diagnostic(
      JSON.stringify({
        journey: 'x-portfolio',
        ...f.metrics(),
        qualification: 'real SDK with eleven synthetic native GETs; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP TikTok portfolio follows advertiser-scoped hierarchy and signed pages through native read contracts', async t => {
  const campaign = '9007199254740993',
    group = '9007199254740995',
    ad = '9007199254740997';
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'GET');
    const u = new URL(url);
    if (u.pathname.endsWith('/advertiser/info/'))
      return Response.json({code: 0, data: {list: [{advertiser_id: '123', currency: 'USD', timezone: 'Etc/GMT'}]}});
    const page = Number(u.searchParams.get('page')),
      size = Number(u.searchParams.get('page_size'));
    let list, total;
    if (u.pathname.endsWith('/campaign/get/')) {
      total = 2;
      list = [
        {
          advertiser_id: '123',
          campaign_id: page === 1 ? campaign : '9007199254740994',
          campaign_name: 'Campaign',
          operation_status: 'ENABLE',
          secondary_status: 'CAMPAIGN_STATUS_BUDGET_EXCEED',
          budget_mode: 'BUDGET_MODE_DAY',
          budget: 100.25,
          private: 'CANARY',
        },
      ];
    } else if (u.pathname.endsWith('/adgroup/get/')) {
      total = 1;
      list = [
        {
          advertiser_id: '123',
          campaign_id: campaign,
          adgroup_id: group,
          adgroup_name: 'Group',
          budget: '30.50',
          budget_mode: 'BUDGET_MODE_DAY',
          operation_status: 'DISABLE',
        },
      ];
    } else if (u.pathname.endsWith('/ad/get/')) {
      total = 1;
      list = [
        {
          advertiser_id: '123',
          campaign_id: campaign,
          adgroup_id: group,
          ad_id: ad,
          ad_name: 'Ad',
          operation_status: 'ENABLE',
          secondary_status: 'AD_STATUS_REVIEW',
          ad_text: 'CANARY',
        },
      ];
    } else throw Error('Unexpected native route');
    return Response.json({
      code: 0,
      data: {list, page_info: {page, page_size: size, total_page: Math.ceil(total / size), total_number: total}},
    });
  });
  try {
    const connection = 'ffffffff-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'tiktok_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic TikTok',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      action: 'portfolio',
      gateway: 'tiktok_native_action',
      account_id: '123',
      connection_id: connection,
      limit: 1,
    };
    const root = await f.call('amcp_workspace', {...args, requirements: {entity: 'campaign'}});
    assert.equal(root.success, true, JSON.stringify(root));
    assert.equal(root.meta.workflow.website_path, '/portfolio');
    assert.equal(root.data.rows[0].native_money.budget, 100.25);
    const next = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'campaign'},
      cursor: root.data.next_cursor,
    });
    assert.equal(next.data.rows[0].id, '9007199254740994');
    const groups = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'adgroup', campaign_id: root.data.rows[0].id},
    });
    assert.equal(groups.data.rows[0].native_money.budget, '30.50');
    const ads = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'ad', campaign_id: campaign, adgroup_id: groups.data.rows[0].id},
    });
    assert.equal(ads.data.rows[0].id, ad);
    assert.equal(ads.data.rows[0].secondary_status, 'AD_STATUS_REVIEW');
    assert.doesNotMatch(JSON.stringify([root, next, groups, ads]), /CANARY/);
    assert.equal(f.metrics().provider_requests, 8);
    t.diagnostic(
      JSON.stringify({
        journey: 'tiktok-portfolio',
        ...f.metrics(),
        qualification: 'real SDK with eight synthetic native GETs; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP Snapchat portfolio follows qualified parents and keeps money and delivery evidence through the native read routes', async t => {
  const account = '10000000-0000-4000-8000-000000000000',
    campaign = '20000000-0000-4000-8000-000000000001',
    squad = '30000000-0000-4000-8000-000000000001',
    ad = '40000000-0000-4000-8000-000000000001',
    requests = [];
  const group = (kind, row) => ({
    request_status: 'SUCCESS',
    paging: {},
    [kind]: [{sub_request_status: 'SUCCESS', [kind.slice(0, -1)]: row}],
  });
  const f = await fixture('reader', (url, init) => {
    const u = new URL(url);
    requests.push({url: u, method: init.method});
    const c = {id: campaign, ad_account_id: account, status: 'ACTIVE', daily_budget_micro: '9007199254740993'},
      s = {id: squad, campaign_id: campaign, status: 'PAUSED', bid_micro: 1000000};
    if (u.pathname === '/v1/adaccounts/' + account)
      return Response.json(group('adaccounts', {id: account, currency: 'SAR', timezone: 'Asia/Riyadh'}));
    if (u.pathname === '/v1/campaigns/' + campaign || u.pathname.endsWith('/campaigns'))
      return Response.json(group('campaigns', c));
    if (u.pathname === '/v1/adsquads/' + squad || u.pathname.endsWith('/adsquads'))
      return Response.json(group('adsquads', s));
    if (u.pathname === '/v1/adsquads/' + squad + '/ads')
      return Response.json(
        group('ads', {
          id: ad,
          ad_squad_id: squad,
          status: 'ACTIVE',
          review_status: 'PENDING',
          delivery_status: ['INVALID_NOT_ACTIVE'],
        }),
      );
    throw Error('Unexpected route');
  });
  try {
    assert.match(f.tools.find(t => t.name === 'amcp_workspace').description, /Snapchat entities/);
    const connection = {
      id: 'dddddddd-1111-4111-8111-111111111111',
      tenantId: f.actor.tenantId,
      gateway: 'snapchat_native_action',
      accounts: [account],
      enabled: true,
      label: 'Synthetic Snapchat',
      scopes: ['snapchat-marketing-api'],
    };
    f.store.putConnection({...f.actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
    for (const requirements of [
      {entity: 'campaign'},
      {entity: 'adsquad', campaign_id: campaign},
      {entity: 'ad', campaign_id: campaign, ad_squad_id: squad},
    ]) {
      const r = await f.call('amcp_workspace', {
        action: 'portfolio',
        gateway: connection.gateway,
        connection_id: connection.id,
        account_id: account,
        limit: 50,
        requirements,
      });
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.meta.workflow.website_path, '/portfolio');
      if (requirements.entity === 'campaign')
        assert.equal(r.data.rows[0].native_money.daily_budget_micro, '9007199254740993');
      if (requirements.entity === 'ad') {
        assert.equal(r.data.rows[0].review_status, 'PENDING');
        assert.deepEqual(r.data.rows[0].delivery_status, ['INVALID_NOT_ACTIVE']);
      }
    }
    assert.equal(requests.length, 9);
    assert.ok(requests.every(r => r.method === 'GET' && r.url.origin === 'https://adsapi.snapchat.com'));
    t.diagnostic(
      JSON.stringify({
        journey: 'snapchat-portfolio',
        ...f.metrics(),
        qualification: 'real SDK with synthetic native GET responses; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP mapped supplier products keep exact prices and source hash through a draft and require separate native review', async t => {
  const f = await fixture();
  try {
    const context = createContext({uiText: (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k])});
    new Script(readFileSync('web/account-workflows.js', 'utf8')).runInContext(context);
    context.csv =
      'SKU,Name,Regular price,Images,Private\n001,Home,0012.34,https://example.test/image.png,UNUSED-PRIVATE\n';
    const products = JSON.parse(
      JSON.stringify(
        new Script(
          "mapProductCSV(parseProductCSVTable(csv), {columns: {retailer_id:'SKU',name:'Name',price:'Regular price',image_url:'Images'},fixed_currency:'SAR',image_mode:'single'})",
        ).runInContext(context),
      ),
    );
    const args = {
      gateway: 'meta_native_action',
      connection_id: 'meta',
      account_id: '100',
      catalog_id: '500',
      name: 'Mapped products',
      allow_upsert: false,
      products,
    };
    const preview = await f.call('amcp_workspace', {action: 'catalog_preview', ...args});
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.data.items[0].price_minor_units, 1234);
    const saved = await f.call('amcp_workspace', {action: 'catalog_plan', ...args});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.state, 'draft');
    assert.equal(saved.data.source_hash, preview.data.source_hash);
    const detail = await f.call('amcp_campaign', {action: 'get', id: saved.data.id, detail: 'full'});
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.match(detail.data.brief, new RegExp(preview.data.source_hash));
    assert.equal(detail.data.steps[0].arguments.action, 'meta_product_catalog_id_products_create');
    assert.equal(detail.data.steps[0].arguments.payload.retailer_id, '001');
    assert.equal(detail.data.steps[0].arguments.payload.price, 1234);
    assert.equal(detail.data.steps[0].arguments.payload.allow_upsert, false);
    assert.doesNotMatch(JSON.stringify(detail), /UNUSED-PRIVATE/);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'mapped-catalog-draft',
        ...f.metrics(),
        qualification: 'real SDK with browser mapping function and synthetic store; no provider requests or mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP workspace consent evidence preserves configuration limits, native types and current access through advertised schemas', async t => {
  const account = 'accounts/44',
    container = account + '/containers/55',
    workspace = container + '/workspaces/66';
  const tag = (id, consentSettings) => ({
    path: workspace + '/tags/' + id,
    tagId: id,
    name: 'Native tag ' + id,
    type: 'html',
    paused: false,
    firingTriggerId: ['3'],
    consentSettings,
    parameter: [{type: 'template', value: 'PRIVATE-CONTENT'}],
  });
  const tags = [
      tag('1', {consentStatus: 'needed', consentType: {type: 'list', list: [{type: 'template', value: 'ad_storage'}]}}),
      tag('2', {consentStatus: 'notNeeded'}),
      tag('4', {consentStatus: 'futureValue'}),
    ],
    triggers = [{path: workspace + '/triggers/3', triggerId: '3', name: 'Page', type: 'pageview'}];
  const resources = new Map([
    [account, {path: account, name: 'Account'}],
    [container, {path: container, name: 'Web container'}],
    [workspace, {path: workspace, name: 'Workspace', fingerprint: 'sdk-version'}],
    [workspace + '/status', {workspaceChange: [], mergeConflict: []}],
    [container + '/version_headers:latest', {path: container + '/versions/9', containerVersionId: '9'}],
    [
      container + '/version_headers',
      {containerVersionHeader: [{path: container + '/versions/9', containerVersionId: '9'}]},
    ],
  ]);
  const version = {
    path: container + '/versions/9',
    accountId: '44',
    containerId: '55',
    containerVersionId: '9',
    tag: tags,
    trigger: triggers,
  };
  resources.set(container + '/versions/9', version);
  resources.set(container + '/versions:live', version);
  for (const [kind, model] of Object.entries(gtmWorkspaceEntities))
    resources.set(workspace + '/' + model.collection, {
      [model.list]: kind === 'tag' ? tags : kind === 'trigger' ? triggers : [],
    });
  const requests = [],
    f = await fixture('reader', (url, init) => {
      assert.equal(init.method, 'GET');
      const path = new URL(String(url)).pathname.replace('/tagmanager/v2/', '');
      requests.push(path);
      assert.ok(resources.has(path), path);
      return Response.json(resources.get(path));
    });
  try {
    const connection = {
      id: 'aaaaaaaa-4444-4444-8444-444444444444',
      tenantId: f.actor.tenantId,
      gateway: 'gtm_native_action',
      accounts: ['44'],
      enabled: true,
      label: 'Synthetic GTM',
      scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    };
    f.store.putConnection({...f.actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
    const args = {
      action: 'measurement_audit',
      connection_id: connection.id,
      account_id: '44',
      requirements: {container_id: '55', workspace_id: '66'},
    };
    const result = await f.call('amcp_workspace', args);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(
      result.meta.workflow.website_path,
      '/measurement?connection_id=' + connection.id + '&account_id=44&container_id=55&workspace_id=66',
    );
    const evidence = result.data.configuration.consent_evidence;
    assert.deepEqual(evidence.counts, {notSet: 0, notNeeded: 1, needed: 1, unknown: 1});
    assert.deepEqual(evidence.rows[0].required_types, ['ad_storage']);
    assert.equal(evidence.checks.built_in_consent, 'unverified');
    assert.equal(result.data.event_delivery, 'not_measured');
    assert.equal(result.data.advertising_writes, 0);
    assert.ok(result.data.configuration.findings.some(f => f.code === 'CONSENT_CONFIGURATION_UNINTERPRETABLE'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CONTENT|accessToken/);
    const reads = requests.length;
    assert.equal((await f.call('amcp_workspace', {...args, account_id: '999'})).success, false);
    f.store.revokeKey(f.key);
    assert.equal((await f.call('amcp_workspace', args)).success, false);
    assert.equal(requests.length, reads);
    t.diagnostic(
      JSON.stringify({
        journey: 'gtm-workspace-consent',
        ...f.metrics(),
        qualification: 'real SDK with synthetic scoped GETs; no runtime consent or provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP LinkedIn conversion configuration discovers exact settings and hands off current account scope without saving or writing', async t => {
  const connectionId = 'aaaaaaaa-1111-4111-8111-111111111111';
  let empty = false;
  const f = await fixture('reader', (url, init) => {
    assert.equal(init.method, 'GET');
    const u = new URL(url);
    if (u.pathname === '/rest/adAccounts/100') return Response.json({id: 100, currency: 'USD', billing: 'PRIVATE'});
    assert.equal(u.pathname, '/rest/conversions');
    assert.equal(u.searchParams.get('q'), 'account');
    assert.equal(u.searchParams.get('account'), 'urn:li:sponsoredAccount:100');
    return Response.json({
      elements: empty
        ? []
        : [
            {
              id: '9007199254740993',
              account: 'urn:li:sponsoredAccount:100',
              name: 'Purchase',
              type: 'PURCHASE',
              enabled: true,
              postClickAttributionWindowSize: 30,
              viewThroughAttributionWindowSize: 7,
              value: {amount: '9007199254740993.123456789', currencyCode: 'USD'},
              imagePixelTag: 'PRIVATE',
            },
          ],
      paging: {start: 0, count: 100, total: empty ? 0 : 1, links: []},
    });
  });
  try {
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connectionId,
        tenantId: f.actor.tenantId,
        gateway: 'linkedin_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic LinkedIn',
        scopes: ['r_ads'],
      },
      {accessToken: 'synthetic'},
    );
    assert.match(f.tools.find(t => t.name === 'amcp_workspace').description, /measurement_conversions/);
    const args = {
      action: 'measurement_conversions',
      gateway: 'linkedin_native_action',
      account_id: '100',
      connection_id: connectionId,
    };
    const first = await f.call('amcp_workspace', args);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(
      first.meta.workflow.website_path,
      '/measurement?conversion_rules=1&connection_id=' + connectionId + '&account_id=100',
    );
    assert.equal(first.data.rules[0].id, '9007199254740993');
    assert.equal(first.data.rules[0].value.amount, '9007199254740993.123456789');
    assert.equal(first.data.rules[0].attribution_type, null);
    assert.equal(first.data.account_evidence.checks.length, 2);
    assert.equal(first.data.source_pages.length, 1);
    assert.equal(first.data.checks.event_delivery, 'unverified');
    assert.equal(first.data.advertising_writes, 0);
    assert.equal(first.data.retained_snapshot, false);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE|accessToken/);
    empty = true;
    const second = await f.call('amcp_workspace', args);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.deepEqual(second.data.rules, []);
    assert.equal(second.data.complete, true);
    assert.equal(f.metrics().provider_requests, 6);
    assert.equal((await f.call('amcp_workspace', {...args, account_id: '999'})).success, false);
    f.store.revokeKey(f.key);
    assert.equal((await f.call('amcp_workspace', args)).success, false);
    assert.equal(f.metrics().provider_requests, 6);
    assert.equal(f.store.documents(f.actor.tenantId, 'conversion_rules').length, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'linkedin-conversion-configuration',
        ...f.metrics(),
        qualification: 'real SDK with synthetic scoped GETs; no events, persisted snapshots or provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP recent GA4 events expose qualified observations and an exact website handoff with no mutations', async t => {
  const requests = [],
    f = await fixture('reader', (url, init) => {
      requests.push({url: String(url), method: init.method, body: JSON.parse(init.body)});
      return Response.json({
        dimensionHeaders: [{name: 'eventName'}, {name: 'minutesAgo'}, {name: 'streamId'}],
        metricHeaders: [{name: 'eventCount', type: 'TYPE_INTEGER'}],
        rows: [{dimensionValues: [{value: 'purchase'}, {value: '00'}, {value: '900'}], metricValues: [{value: '12'}]}],
        rowCount: 1,
      });
    });
  try {
    assert.match(f.tools.find(t => t.name === 'amcp_workspace').description, /measurement_events/);
    const connection = {
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      tenantId: f.actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: ['123'],
      enabled: true,
      label: 'Synthetic GA4',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    };
    f.store.putConnection({...f.actor, role: 'admin'}, connection, {accessToken: 'synthetic'});
    const args = {
      action: 'measurement_events',
      gateway: connection.gateway,
      account_id: '123',
      connection_id: connection.id,
      requirements: {event_names: ['purchase', 'generate_lead'], minutes: 5},
    };
    const r = await f.call('amcp_workspace', args);
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.record_kind, 'measurement_events');
    assert.equal(r.data.events[0].reported_count, '12');
    assert.equal(r.data.events[1].reported_count, null);
    assert.equal(r.data.checks.test_event_identity, 'unverified');
    assert.equal(r.data.provider_mutations, 0);
    assert.equal(r.data.retained_snapshot, false);
    assert.equal(r.meta.workflow.website_path, '/measurement');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123:runRealtimeReport');
    assert.equal(requests[0].method, 'POST');
    assert.equal(
      (await f.call('amcp_workspace', {...args, requirements: {...args.requirements, minutes: 31}})).success,
      false,
    );
    f.store.putConnection({...f.actor, role: 'admin'}, {...connection, enabled: false}, {accessToken: 'synthetic'});
    assert.equal((await f.call('amcp_workspace', args)).success, false);
    assert.equal(requests.length, 1);
    t.diagnostic(
      JSON.stringify({
        journey: 'ga4-recent-events',
        ...f.metrics(),
        qualification: 'real SDK with synthetic native response; one read-only POST, zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP workbook discovery and reviewed local rename follow advertised handoffs without provider access', async t => {
  const f = await fixture();
  try {
    f.store.putDocument(f.actor.tenantId, 'workbook', 'sdk-book', {
      spreadsheet_id: 'sdk-sheet',
      spreadsheet_name: 'Original workbook',
      created_by: f.actor.userId,
    });
    let result = await f.call('amcp_workspace', {action: 'report_bindings', limit: 10});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.meta.workflow.website_path, '/operations?bindings=1');
    const next = result.data.bindings[0].next_call;
    result = await f.call(next.tool, next.arguments);
    assert.equal(result.meta.workflow.website_path, '/operations?workbook_binding_id=sdk-book');
    const version = result.data.binding_version;
    result = await f.call('amcp_workspace', {
      action: 'preview_report_binding',
      id: 'sdk-book',
      binding_version: version,
      binding: {spreadsheet_name: 'اسم المصنف'},
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.external_writes, false);
    result = await f.call('amcp_workspace', {
      action: 'save_report_binding',
      id: 'sdk-book',
      binding_version: version,
      binding: result.data.binding,
      confirmed: true,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.spreadsheet_name, 'اسم المصنف');
    assert.equal(result.meta.workflow.automatic_retry_of_mutation, false);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'workbook-local-name',
        ...f.metrics(),
        qualification: 'real SDK with synthetic store; no external spreadsheet access',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP retires and restores original empty workbook setup with current versions and no external access', async t => {
  const f = await fixture();
  try {
    f.store.putDocument(f.actor.tenantId, 'workbook', 'retire-book', {
      spreadsheet_id: 'retire-sheet',
      spreadsheet_name: 'Retained setup',
      created_by: f.actor.userId,
    });
    let r = await f.call('amcp_workspace', {action: 'report_binding', id: 'retire-book'});
    for (const active of [false, true]) {
      r = await f.call('amcp_workspace', {
        action: 'preview_report_binding_state',
        id: 'retire-book',
        binding_version: r.data.binding_version,
        active,
      });
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.meta.workflow.website_path, '/operations?workbook_binding_id=retire-book');
      r = await f.call('amcp_workspace', {
        action: 'save_report_binding_state',
        id: 'retire-book',
        binding_version: r.data.binding_version,
        active,
        confirmed: true,
      });
      assert.equal(r.success, true, JSON.stringify(r));
      assert.equal(r.data.retired, !active);
      assert.equal(r.data.external_access_verified, false);
    }
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'workbook-retirement',
        ...f.metrics(),
        qualification: 'real SDK with synthetic store; no external spreadsheet access',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP workbook move follows exact review versions and separately reviews a paused schedule before resuming', async t => {
  const f = await fixture();
  try {
    for (const id of ['source', 'target'])
      f.store.putDocument(f.actor.tenantId, 'workbook', id, {
        spreadsheet_id: 'sdk-' + id,
        spreadsheet_name: id,
        created_by: f.actor.userId,
      });
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'move-query', {
      name: 'Original query',
      workbook_binding_id: 'source',
      query_config: {...f.source, date_range: {since: '2026-09-01', until: '2026-09-07'}},
    });
    f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'move-schedule', {
      name: 'Original clock',
      workbook_binding_id: 'source',
      is_active: true,
      timezone: 'UTC',
      schedule_kind: 'daily',
      schedule_config: {query_id: 'move-query', hour: 8, minute: 12},
    });
    let r = await f.call('amcp_workspace', {action: 'report_query', id: 'move-query'});
    assert.equal(r.success, true, JSON.stringify(r));
    const query_version = r.data.query_version;
    r = await f.call('amcp_workspace', {action: 'report_bindings', spreadsheet_id: 'sdk-target'});
    assert.equal(r.data.bindings[0].id, 'target');
    r = await f.call('amcp_workspace', {
      action: 'preview_report_query_move',
      id: 'move-query',
      query_version,
      target_binding_id: 'target',
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.meta.workflow.website_path, '/operations?move_query_id=move-query');
    assert.equal(r.data.schedules_to_pause, 1);
    r = await f.call('amcp_workspace', {
      action: 'move_report_query',
      id: 'move-query',
      query_version,
      target_binding_id: 'target',
      rebinding_version: r.data.rebinding_version,
      confirmed: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.meta.workflow.website_path, '/operations?query_id=move-query');
    assert.equal(r.data.schedules[0].active, false);
    r = await f.call('amcp_workspace', {action: 'report_schedule', id: 'move-schedule'});
    assert.equal(r.success, true, JSON.stringify(r));
    const schedule_version = r.data.schedule_version;
    const schedule = {
      ...r.data.schedule,
      name: r.data.name,
      timezone: r.data.timezone,
      schedule_kind: r.data.schedule_kind,
    };
    r = await f.call('amcp_workspace', {
      action: 'preview_report_schedule',
      id: 'move-schedule',
      schedule_version,
      schedule,
      active: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    r = await f.call('amcp_workspace', {
      action: 'save_report_schedule',
      id: 'move-schedule',
      schedule_version,
      schedule: r.data.schedule,
      active: true,
      confirmed: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.active, true);
    const saved = f.store.document(f.actor.tenantId, 'reporting_schedule', 'move-schedule');
    assert.equal(saved.workbook_binding_id, 'target');
    assert.ok(saved.actor_binding);
    assert.ok(saved.next_run_at > Date.now());
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'reviewed-workbook-move',
        ...f.metrics(),
        qualification: 'real SDK with synthetic store; no spreadsheet or provider requests',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP query discovery, revision review and save preserve original prepared runs and pause changed schedules', async t => {
  const f = await fixture();
  try {
    f.store.putDocument(f.actor.tenantId, 'workbook', 'sdk-book', {
      spreadsheet_id: 'sdk-sheet',
      created_by: f.actor.userId,
    });
    const config = {...f.source, date_range: {since: '2026-09-01', until: '2026-09-07'}};
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'sdk-query', {
      name: 'Original',
      query_config: config,
      workbook_binding_id: 'sdk-book',
    });
    f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'sdk-schedule', {
      name: 'Daily',
      workbook_binding_id: 'sdk-book',
      schedule_config: {query_id: 'sdk-query', hour: 8, minute: 0},
      schedule_kind: 'daily',
      timezone: 'UTC',
      is_active: true,
    });
    let r = await f.call('amcp_workspace', {action: 'report_queries', spreadsheet_id: 'sdk-sheet', limit: 20});
    assert.deepEqual(
      r.data.queries.map(q => q.id),
      ['sdk-query'],
    );
    r = await f.call(r.data.queries[0].next_call.tool, r.data.queries[0].next_call.arguments);
    assert.equal(r.meta.workflow.website_path, '/operations?query_id=sdk-query');
    const version = r.data.query_version,
      query = {
        name: 'Revised',
        query_config: {...config, date_range: {preset: 'last_complete_week', timezone: 'Africa/Cairo'}},
      };
    r = await f.call('amcp_workspace', {
      action: 'preview_report_query',
      id: 'sdk-query',
      query_version: version,
      query,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.schedules_to_pause, 1);
    r = await f.call('amcp_workspace', {
      action: 'save_report_query',
      id: 'sdk-query',
      query_version: version,
      query: r.data.query,
      confirmed: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.schedules_paused, 1);
    const run = r.data.prepared_run_id;
    r = await f.call('amcp_workspace', {action: 'report_run', id: run});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.id, run);
    assert.equal(r.data.state, 'prepared');
    assert.deepEqual(f.store.job(f.actor.tenantId, run).input.query_config, query.query_config);
    r = await f.call('amcp_workspace', {action: 'report_schedule', id: 'sdk-schedule'});
    assert.equal(r.data.active, false);
    r = await f.call('amcp_workspace', {
      action: 'save_report_query',
      id: 'sdk-query',
      query_version: version,
      query,
      confirmed: true,
    });
    assert.equal(r.error.code, 'STALE_REPORT_QUERY');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify(f.metrics()));
  } finally {
    await f.close();
  }
});

test('MCP personal monitor opt-in, incident delivery status and opt-out preserve exact schemas and scope', async t => {
  const f = await fixture('operator', undefined, true);
  try {
    const context = {
      ...f.source,
      currency: 'USD',
      timezone: 'UTC',
      result_definition: 'Purchases',
      attribution: '7-day click',
    };
    let r = await f.call('amcp_workspace', {
      action: 'save_monitor',
      confirmed: true,
      monitor: {
        ...context,
        name: 'SDK monitor',
        metric: 'spend',
        comparison: 'above',
        threshold: '50',
        max_age_hours: 24,
      },
    });
    assert.equal(r.success, true, JSON.stringify(r));
    const id = r.data.id;
    r = await f.call('amcp_workspace', {action: 'monitor_notifications', id});
    assert.equal(r.data.enabled, false);
    assert.equal(r.meta.workflow.website_path, '/monitors?monitor_id=' + id);
    r = await f.call('amcp_workspace', {
      action: 'set_monitor_notifications',
      id,
      subscription_version: r.data.subscription_version,
      enabled: true,
      confirmed: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.enabled, true);
    const group = {
      ...context,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
      objective_group: 'sales',
      metrics: {spend: 60},
      complete: true,
    };
    f.store.putDocument(f.actor.tenantId, 'overview_report', 'sdk-notice-report', {
      state: 'complete',
      config: {sources: [context]},
      rows: [{...group, captured_at: Date.now()}],
      summary: [group],
    });
    r = await f.call('amcp_workspace', {action: 'evaluate_monitors', report_id: 'sdk-notice-report'});
    assert.equal(r.data.outcomes[0].email_notices_queued, 1);
    r = await f.call('amcp_workspace', {action: 'monitor_notifications', id});
    assert.equal(r.data.deliveries[0].state, 'pending');
    assert.doesNotMatch(JSON.stringify(r), /sdk@example|actor_binding/);
    r = await f.call('amcp_workspace', {
      action: 'set_monitor_notifications',
      id,
      subscription_version: r.data.subscription_version,
      enabled: false,
      confirmed: true,
    });
    assert.equal(r.data.deliveries[0].state, 'cancelled');
    f.store.revokeKey(f.key);
    r = await f.call('amcp_workspace', {action: 'monitor_notifications', id});
    assert.equal(r.success, false);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify({journey: 'personal-monitor-notices', ...f.metrics(), external_messages: 0}));
  } finally {
    await f.close();
  }
});

test('MCP file destination, retained export and Operations handoff share advertised schemas and original receipts', async t => {
  const f = await fixture();
  try {
    const report = packFixture();
    report.config.sources = [f.source];
    f.store.putDocument(f.actor.tenantId, 'overview_report', report.id, report);
    const bound = await f.call('amcp_reporting_overview', {
      action: 'bind_file_destination',
      confirmed: true,
      idempotency_key: 'sdk-file-destination',
      file_destination: {name: 'Client files', formats: ['pdf', 'xlsx'], presentation: {brand_name: 'Example client'}},
    });
    assert.equal(bound.success, true, JSON.stringify(bound));
    const queued = await f.call('amcp_reporting_overview', {
      action: 'export',
      report_id: report.id,
      destination_id: bound.data.id,
      confirmed: true,
    });
    assert.equal(queued.success, true, JSON.stringify(queued));
    const overview = new ReportingOverview(f.service);
    overview.files.render = async (_t, _r, format) =>
      Buffer.from(format === 'pdf' ? '%PDF-SDK fixture' : 'PK SDK fixture');
    const worker = new ReportWorker(
      f.store,
      async () => {
        throw Error('No collection expected');
      },
      (t, k, i) => overview.work(t, k, i),
    );
    await worker.once();
    const feed = await f.call('amcp_workspace', {action: 'operations', kind: 'export'});
    assert.equal(feed.data.operations.length, 1);
    const row = feed.data.operations[0];
    assert.equal(row.id, queued.data.id);
    const status = await f.call(row.next_call.tool, row.next_call.arguments);
    assert.equal(status.success, true, JSON.stringify(status));
    assert.equal(status.data.state, 'complete');
    assert.equal(status.data.files.length, 2);
    assert.equal(status.data.job.id, queued.data.job_id);
    assert.doesNotMatch(JSON.stringify([feed, status]), /sealed|actor_binding|\"bytes\":/);
    f.store.revokeKey(f.key);
    assert.equal((await f.call(row.next_call.tool, row.next_call.arguments)).success, false);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify({journey: 'retained-file-delivery', ...f.metrics()}));
  } finally {
    await f.close();
  }
});

test('MCP workbook report discovery, original status and confirmed recovery agree across protocol envelopes', async t => {
  const f = await fixture();
  try {
    const id = f.store.enqueueReport(
      f.actor,
      {
        query_id: 'synthetic-query',
        query_name: 'Weekly workbook evidence',
        query_revision: 3,
        query_config: {...f.source, private: 'CANARY'},
      },
      Number.MAX_SAFE_INTEGER,
    );
    const feed = await f.call('amcp_workspace', {action: 'operations', kind: 'workbook_report', limit: 1});
    assert.equal(feed.success, true, JSON.stringify(feed));
    const row = feed.data.operations[0];
    assert.equal(row.id, id);
    assert.equal(row.state, 'prepared');
    const detail = await f.call(row.next_call.tool, row.next_call.arguments);
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.meta.workflow.website_path, '/operations?run_id=' + id);
    assert.doesNotMatch(JSON.stringify(detail), /CANARY|query_config|authority/);
    const status = await f.call(detail.data.next_call.tool, detail.data.next_call.arguments);
    assert.equal(status.data.run_version, detail.data.run_version);
    const queued = await f.call('amcp_workspace', {
      action: 'resume_report_run',
      id,
      ...detail.data.resume_requirements,
    });
    assert.equal(queued.success, true, JSON.stringify(queued));
    assert.equal(queued.data.state, 'queued');
    assert.equal(queued.data.can_resume, false);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 1);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify(f.metrics()));
  } finally {
    await f.close();
  }
});
test('MCP workbook schedule discovery, proposed clock preview and confirmed pause agree across envelopes', async t => {
  const f = await fixture();
  try {
    f.store.putDocument(f.actor.tenantId, 'reporting_query', 'schedule-query', {
      query_config: {...f.source, private: 'CANARY'},
    });
    f.store.putDocument(f.actor.tenantId, 'reporting_schedule', 'original-schedule', {
      name: 'Weekly workbook',
      timezone: 'UTC',
      schedule_kind: 'weekly',
      is_active: true,
      schedule_config: {query_id: 'schedule-query', weekday: 1, hour: 9, minute: 0},
      actor_binding: f.store.bindJobActor(f.actor, 'reporting-schedule:original-schedule'),
      authority_version: 1,
      updated_at: new Date().toISOString(),
    });
    const feed = await f.call('amcp_workspace', {action: 'operations', kind: 'workbook_schedule', limit: 1});
    assert.equal(feed.success, true, JSON.stringify(feed));
    const row = feed.data.operations[0];
    const detail = await f.call(row.next_call.tool, row.next_call.arguments);
    assert.equal(detail.success, true, JSON.stringify(detail));
    assert.equal(detail.meta.workflow.website_path, '/operations?workbook_schedule_id=original-schedule');
    const args = {
      id: detail.data.id,
      schedule_version: detail.data.schedule_version,
      active: false,
      schedule: {
        name: 'Monthly workbook',
        timezone: 'Africa/Cairo',
        schedule_kind: 'monthly',
        day: 31,
        hour: 9,
        minute: 15,
      },
    };
    const preview = await f.call('amcp_workspace', {action: 'preview_report_schedule', ...args});
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.data.occurrences.length, 3);
    assert.ok(preview.data.changes.some(c => c.field === 'active' && c.to === false));
    assert.equal(f.store.document(f.actor.tenantId, 'reporting_schedule', args.id).revision, 1);
    const saved = await f.call('amcp_workspace', {action: 'save_report_schedule', ...args, confirmed: true});
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal(saved.data.id, 'original-schedule');
    assert.equal(saved.data.state, 'paused');
    assert.equal(saved.data.query_revision, 1);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
    assert.doesNotMatch(JSON.stringify([feed, detail, preview, saved]), /CANARY|actor_binding|query_config/);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(JSON.stringify(f.metrics()));
  } finally {
    await f.close();
  }
});

test('MCP Google portfolio signs continuation and preserves scoped hierarchy and exact micros in both result envelopes', async t => {
  const campaign = '9007199254740993',
    group = '9007199254740995',
    ad = '9007199254740997';
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.match(String(url), /\/v25\/customers\/123\/googleAds:search$/);
    const q = JSON.parse(init.body).query,
      customer = {id: '123', currencyCode: 'USD', timeZone: 'UTC'};
    let rows;
    if (q.includes(' FROM ad_group_ad '))
      rows = [
        {
          customer,
          campaign: {id: campaign, resourceName: `customers/123/campaigns/${campaign}`},
          adGroup: {id: group, resourceName: `customers/123/adGroups/${group}`},
          adGroupAd: {
            resourceName: `customers/123/adGroupAds/${group}~${ad}`,
            status: 'ENABLED',
            ad: {id: ad, private: 'CANARY-AD'},
          },
        },
      ];
    else if (q.includes(' FROM ad_group '))
      rows = [
        {
          customer,
          campaign: {id: campaign, resourceName: `customers/123/campaigns/${campaign}`},
          adGroup: {
            id: group,
            resourceName: `customers/123/adGroups/${group}`,
            cpcBidMicros: '9007199254740993',
            status: 'PAUSED',
          },
        },
      ];
    else
      rows = (q.includes('campaign.id > ') ? ['9007199254740994'] : [campaign, '9007199254740994']).map(id => ({
        customer,
        campaign: {id, resourceName: `customers/123/campaigns/${id}`, status: 'PAUSED'},
        campaignBudget: {amountMicros: '9007199254740993'},
        private: 'CANARY-ROW',
      }));
    return Response.json({results: rows});
  });
  try {
    const connection = 'eeeeeeee-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const args = {
      action: 'portfolio',
      gateway: 'google_ads_native_action',
      account_id: '123',
      connection_id: connection,
      limit: 1,
    };
    const root = await f.call('amcp_workspace', {...args, requirements: {entity: 'campaign'}});
    assert.equal(root.success, true, JSON.stringify(root));
    assert.equal(root.meta.workflow.website_path, '/portfolio');
    assert.equal(root.data.rows[0].budget_micros, '9007199254740993');
    const next = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'campaign'},
      cursor: root.data.next_cursor,
    });
    assert.equal(next.data.rows[0].id, '9007199254740994');
    const groups = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'ad_group', campaign_id: root.data.rows[0].id},
    });
    assert.equal(groups.data.rows[0].cpc_bid_micros, '9007199254740993');
    const ads = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'ad', campaign_id: campaign, ad_group_id: groups.data.rows[0].id},
    });
    assert.equal(ads.data.rows[0].id, ad);
    const changed = await f.call('amcp_workspace', {
      ...args,
      limit: 2,
      requirements: {entity: 'campaign'},
      cursor: root.data.next_cursor,
    });
    assert.equal(changed.success, false);
    assert.equal(changed.error.code, 'INVALID_CURSOR');
    assert.doesNotMatch(JSON.stringify([root, next, groups, ads, changed]), /CANARY/);
    assert.equal(f.metrics().provider_requests, 4);
    t.diagnostic(
      JSON.stringify({
        journey: 'google-portfolio',
        ...f.metrics(),
        qualification: 'real SDK with four synthetic read-only POSTs; zero provider mutations',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP Google portfolio represents omitted optional fields consistently in both result envelopes', async () => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.match(String(url), /googleads.googleapis.com/);
    return Response.json({
      results: [
        {
          customer: {id: '123'},
          campaign: {id: '10', resourceName: 'customers/123/campaigns/10', name: 'Synthetic Google', status: 'PAUSED'},
        },
      ],
    });
  });
  try {
    const connection = 'bbbbbbbb-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic Google',
        scopes: [],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    const result = await f.call('amcp_workspace', {
      action: 'portfolio',
      gateway: 'google_ads_native_action',
      account_id: '123',
      connection_id: connection,
      requirements: {entity: 'campaign'},
      limit: 2,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.rows[0].ad_group_id, null);
    assert.equal(result.data.rows[0].currency, null);
  } finally {
    await f.close();
  }
});

test('MCP Meta inventory pages and parent drilldown use advertised contracts with reader access', async t => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json(metaPortfolioData(new URL(String(url))));
  });
  try {
    const connection = 'aaaaaaaa-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic',
        scopes: ['ads_read'],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      action: 'portfolio',
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: connection,
      limit: 2,
    };
    const first = await f.call('amcp_workspace', {...args, requirements: {entity: 'campaign'}});
    assert.equal(first.success, true, JSON.stringify(first));
    const next = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'campaign'},
      cursor: first.data.next_cursor,
    });
    assert.equal(next.data.rows[0].id, '30');
    const sets = await f.call('amcp_workspace', {...args, requirements: {entity: 'adset', campaign_id: '10'}});
    assert.equal(sets.success, true, JSON.stringify(sets));
    const ads = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'ad', campaign_id: '10', adset_id: '201'},
    });
    assert.equal(ads.success, true, JSON.stringify(ads));
    assert.equal(ads.data.rows[0].id, '301');
    assert.equal(ads.data.rows[0].effective_status, 'CAMPAIGN_PAUSED');
    assert.equal(f.metrics().provider_requests, 11);
    t.diagnostic(JSON.stringify(f.metrics()));
  } finally {
    await f.close();
  }
});

test('MCP guided campaign capture to bounded allocation uses advertised contracts and verified account reads', async t => {
  const evidence = allocationReport();
  const f = await fixture('operator', async (url, init) => {
    assert.equal(init.method, 'GET');
    if (new URL(url).pathname.endsWith('/act_100'))
      return Response.json({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'});
    return Response.json({
      data: evidence.rows.map(row => ({
        account_id: '100',
        account_currency: 'USD',
        campaign_id: row.entity_id,
        campaign_name: row.entity_name,
        date_start: row.date,
        date_stop: row.date,
        spend: row.spend,
        clicks: '20',
        impressions: '1000',
        actions: [{action_type: 'offsite_conversion.fb_pixel_purchase', value: row.conversions}],
      })),
    });
  });
  try {
    const connection = 'aaaaaaaa-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'meta_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const capture = await f.call('amcp_reporting', {
      action: 'capture_preset',
      preset: 'meta_campaign',
      account_id: '100',
      connection_id: connection,
      semantics: evidence.semantics,
      result_action_type: 'offsite_conversion.fb_pixel_purchase',
      attribution_windows: ['7d_click'],
    });
    assert.equal(capture.success, true, JSON.stringify(capture));
    const choices = await f.call('amcp_reporting', {
      action: 'allocation_candidates',
      id: capture.data.id,
      offset: 0,
      limit: 20,
    });
    assert.deepEqual(
      choices.data.candidates.map(row => row.entity_id),
      ['10', '20'],
    );
    const result = await f.call('amcp_reporting', {
      action: 'allocation',
      id: capture.data.id,
      options: {
        budget: '200',
        efficiency_low: 0.8,
        efficiency_high: 1.2,
        minimum_conversions: 5,
        maximum_age_days: 7,
        allocations: [
          {entity_id: '10', minimum: '25', maximum: '125'},
          {entity_id: '20', minimum: '50', maximum: '175'},
        ],
      },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(
      result.data.allocations.map(row => row.proposed_budget),
      ['125', '75'],
    );
    assert.equal(f.metrics().provider_requests, 3);
    assert.equal(capture.data.native_account_evidence.checks.length, 2);
    t.diagnostic(
      JSON.stringify({
        journey: 'capture-to-constrained-allocation',
        ...f.metrics(),
        qualification: 'synthetic SDK and fake GET transport; no advertising mutation',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP allocation preview creates an unapproved Google draft with the correct campaign handoff', async t => {
  const f = await fixture('operator', async (url, init) => {
    assert.match(String(url), /googleAds:search$/);
    assert.equal(init.method, 'POST');
    assert.match(JSON.parse(init.body).query, /campaign_budget.reference_count/);
    return Response.json({
      results: ['10', '20'].map(id => ({
        customer: {id: '123', currencyCode: 'USD', timeZone: 'UTC'},
        campaign: {
          id,
          resourceName: 'customers/123/campaigns/' + id,
          status: 'ENABLED',
          campaignBudget: 'customers/123/campaignBudgets/1' + id,
        },
        campaignBudget: {
          resourceName: 'customers/123/campaignBudgets/1' + id,
          amountMicros: '200000000',
          referenceCount: '1',
          period: 'DAILY',
          status: 'ENABLED',
        },
      })),
    });
  });
  try {
    const connection = 'dddddddd-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic Google',
        scopes: ['https://www.googleapis.com/auth/adwords'],
      },
      {accessToken: 'synthetic', developerToken: 'synthetic'},
    );
    f.store.putDocument(f.actor.tenantId, 'decision_report', 'allocation-source', {
      ...allocationReport(),
      gateway: 'google_ads_native_action',
      preset: 'google_campaign',
      connection_id: connection,
      account_id: '123',
    });
    const preview = await f.call('amcp_reporting', {
      action: 'preview_allocation_plan',
      id: 'allocation-source',
      conversion: 'equal_daily',
      options: {
        budget: '200',
        efficiency_low: 0.8,
        efficiency_high: 1.2,
        maximum_age_days: 7,
        minimum_conversions: 5,
        allocations: [
          {entity_id: '10', minimum: '25', maximum: '125'},
          {entity_id: '20', minimum: '50', maximum: '175'},
        ],
      },
    });
    assert.equal(preview.success, true, JSON.stringify(preview));
    const created = await f.call('amcp_reporting', {
      action: 'create_allocation_plan',
      id: 'allocation-source',
      preview_id: preview.data.preview_id,
      preview_hash: preview.data.preview_hash,
      confirmed: true,
    });
    assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(created.meta.workflow.website_path, '/campaigns?id=' + created.data.id);
    assert.equal(created.meta.workflow.state, 'review_required');
    const original = await f.call(created.data.next_call.tool, created.data.next_call.arguments);
    assert.equal(original.success, true);
    assert.equal(original.data.state, 'draft');
    assert.equal(original.data.allocation.report_id, 'allocation-source');
    assert.equal(f.metrics().provider_requests, 4);
    t.diagnostic(JSON.stringify({journey: 'allocation-to-native-budget-draft', ...f.metrics(), advertising_writes: 0}));
  } finally {
    await f.close();
  }
});

test('MCP discovery to Meta evidence to verified linked-ad performance follows current advertised contracts', async t => {
  const f = await fixture('operator', async (url, init) => {
    assert.equal(init.method, 'GET');
    if (new URL(url).pathname.endsWith('/act_100'))
      return Response.json({id: 'act_100', account_id: '100', currency: 'USD', timezone_name: 'UTC'});
    assert.equal(new URL(url).pathname.endsWith('/act_100/insights'), true);
    return Response.json({
      data: [
        {
          account_id: '100',
          account_currency: 'USD',
          campaign_id: '10',
          adset_id: '20',
          ad_id: '30',
          ad_name: 'Linked ad',
          date_start: '2026-09-01',
          date_stop: '2026-09-01',
          spend: '12.5',
          clicks: '10',
          impressions: '100',
          actions: [
            {action_type: 'purchase', value: '999'},
            {action_type: 'offsite_conversion.fb_pixel_purchase', value: '2'},
          ],
        },
      ],
    });
  });
  try {
    const scope = {
      gateway: 'meta_native_action',
      account_id: '100',
      connection_id: 'aaaaaaaa-1111-4111-8111-111111111111',
    };
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: scope.connection_id,
        tenantId: f.actor.tenantId,
        gateway: scope.gateway,
        accounts: ['100'],
        writeAccounts: ['100'],
        enabled: true,
        label: 'Synthetic detailed read',
        scopes: ['ads_read'],
      },
      {accessToken: 'synthetic'},
    );
    let r = await f.call('amcp_reporting', {action: 'capture_presets'});
    assert.ok(r.data.presets.some(p => p.id === 'meta_ad'));
    r = await f.call('amcp_reporting', {
      action: 'capture_preset',
      preset: 'meta_ad',
      account_id: scope.account_id,
      connection_id: scope.connection_id,
      result_action_type: 'offsite_conversion.fb_pixel_purchase',
      attribution_windows: ['7d_click'],
      semantics: {
        currency: 'USD',
        timezone: 'UTC',
        date_from: '2026-09-01',
        date_to: '2026-09-01',
        source_name: 'SDK ad evidence',
        complete: true,
      },
    });
    assert.equal(r.success, true, JSON.stringify(r));
    const reportId = r.data.id;
    assert.equal(r.data.rows[0].conversions, '2');
    f.store.putDocument(f.actor.tenantId, 'workspace_asset', 'linked-asset', {
      platform: 'meta',
      account_id: scope.account_id,
      connection_id: scope.connection_id,
      media_id: 'hash',
      name: 'Synthetic image',
    });
    f.store.putDocument(f.actor.tenantId, 'campaign_run', 'linked-plan', {
      user_id: f.actor.userId,
      name: 'Verified fixture plan',
      steps: [
        {
          ...scope,
          id: 'image',
          kind: 'media',
          arguments: {platform: 'meta'},
          status: 'verified',
          review_id: 'linked-asset',
          result: {media_id: 'hash'},
        },
        {
          ...scope,
          id: 'creative',
          kind: 'write',
          arguments: {action: 'meta_creative_create', payload: {image_hash: {$ref: 'image#/image_hash'}}},
          status: 'verified',
          result: {created_id: '20'},
        },
        {
          ...scope,
          id: 'ad',
          kind: 'write',
          arguments: {action: 'meta_ad_create', payload: {creative_id: {$ref: 'creative#/data/id'}}},
          status: 'verified',
          result: {created_id: '30'},
        },
      ],
    });
    r = await f.call('amcp_media', {action: 'asset_performance', asset_id: 'linked-asset'});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.reports[0].id, reportId);
    r = await f.call('amcp_media', {
      action: 'asset_performance',
      asset_id: 'linked-asset',
      plan_id: 'linked-plan',
      report_id: reportId,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.rows[0].spend, '12.5');
    assert.equal(r.data.rows[0].conversions, '2');
    assert.equal(r.data.historical_creative_assignment, 'not_established');
    assert.equal(r.data.network_requests, 0);
    assert.equal(f.metrics().provider_requests, 3);
    assert.equal(f.metrics().tool_calls, 4);
    t.diagnostic(
      JSON.stringify({
        journey: 'guided-evidence-to-linked-ad',
        ...f.metrics(),
        qualification: 'synthetic MCP SDK and fake GET transport; no live acceptance',
      }),
    );
  } finally {
    await f.close();
  }
});
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
    const profile = await f.call('amcp_workspace', {
      action: 'save_profile',
      confirmed: true,
      profile: {
        name: 'Protocol client',
        report_presentation: {brand_name: 'Approved protocol brand'},
        bindings: [{gateway: 'meta_native_action', connection_id: 'meta', account_id: '100'}],
      },
    });
    assert.equal(profile.success, true, JSON.stringify(profile));
    r = await f.call('amcp_reporting_overview', {action: 'presentation_profiles', id: report.id});
    assert.equal(r.data.profiles[0].id, profile.data.id);
    r = await f.call('amcp_reporting_overview', {
      action: 'apply_profile_presentation',
      id: report.id,
      profile_id: profile.data.id,
      profile_revision: profile.data.revision,
      presentation_revision: 1,
      confirmed: true,
    });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(r.data.presentation.brand_name, 'Approved protocol brand');
    assert.equal(r.data.presentation_source.profile_revision, profile.data.revision);
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

test('MCP LinkedIn portfolio navigates exact hierarchy and signed continuations with reader access', async t => {
  const account = 'urn:li:sponsoredAccount:100';
  const group = id => ({
    id,
    account,
    name: 'Group ' + id,
    status: 'ACTIVE',
    totalBudget: {amount: '123456789012345678.90', currencyCode: 'USD'},
  });
  const campaign = {id: '201', account, campaignGroup: 'urn:li:sponsoredCampaignGroup:10', status: 'PAUSED'};
  const f = await fixture('reader', async (raw, init) => {
    assert.equal(init.method, 'GET');
    const url = new URL(String(raw));
    assert.equal(url.origin, 'https://api.linkedin.com');
    const route = url.pathname.replace('/rest/adAccounts/100', '');
    if (route === '') return Response.json({id: 100, currency: 'USD'});
    if (route === '/adCampaignGroups')
      return Response.json(
        url.searchParams.has('pageToken')
          ? {elements: [group('30')], metadata: {}}
          : {elements: [group('10'), group('20')], metadata: {nextPageToken: 'next-native'}},
      );
    if (route === '/adCampaignGroups/10') return Response.json(group('10'));
    if (route === '/adCampaigns') return Response.json({elements: [campaign], metadata: {}});
    if (route === '/adCampaigns/201') return Response.json(campaign);
    if (route === '/creatives')
      return Response.json({
        elements: [
          {
            id: 'urn:li:sponsoredCreative:301',
            account,
            campaign: 'urn:li:sponsoredCampaign:201',
            intendedStatus: 'ACTIVE',
            isServing: false,
            servingHoldReasons: ['CAMPAIGN_STOPPED'],
          },
        ],
        metadata: {},
      });
    throw Error('Unexpected fixture route ' + route);
  });
  try {
    const connection = 'cccccccc-1111-4111-8111-111111111111';
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: connection,
        tenantId: f.actor.tenantId,
        gateway: 'linkedin_native_action',
        accounts: ['100'],
        enabled: true,
        label: 'Synthetic LinkedIn',
        scopes: ['r_ads'],
      },
      {accessToken: 'synthetic'},
    );
    const args = {
      action: 'portfolio',
      gateway: 'linkedin_native_action',
      connection_id: connection,
      account_id: '100',
      limit: 2,
    };
    const first = await f.call('amcp_workspace', args);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.meta.workflow.website_path, '/portfolio');
    assert.equal(first.data.rows[0].native_money.totalBudget.amount, '123456789012345678.90');
    const next = await f.call('amcp_workspace', {...args, cursor: first.data.next_cursor});
    assert.equal(next.data.rows[0].id, '30');
    const campaigns = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'campaign', campaign_group_id: '10'},
    });
    assert.equal(campaigns.success, true, JSON.stringify(campaigns));
    const creatives = await f.call('amcp_workspace', {
      ...args,
      requirements: {entity: 'creative', campaign_group_id: '10', campaign_id: campaigns.data.rows[0].id},
    });
    assert.equal(creatives.success, true, JSON.stringify(creatives));
    assert.equal(creatives.data.rows[0].resource_name, 'urn:li:sponsoredCreative:301');
    assert.equal(creatives.data.rows[0].is_serving, false);
    assert.equal(f.metrics().provider_requests, 11);
    t.diagnostic(
      JSON.stringify({
        journey: 'linkedin-portfolio',
        ...f.metrics(),
        qualification: 'real SDK; synthetic provider reads only',
      }),
    );
  } finally {
    await f.close();
  }
});

test('MCP scoped audit history follows older events and rechecks revocation with no provider calls', async t => {
  const f = await fixture('reader');
  try {
    for (const [id, account] of [
      ['older', '100'],
      ['hidden', '200'],
      ['newer', '100'],
    ])
      f.store.appendAudit(f.actor.tenantId, id, {
        event: 'request_completed',
        connection_id: 'meta',
        request: {
          gateway: 'meta_native_action',
          accountId: account,
          action: 'native_read',
          body: {private: 'PRIVATE-INPUT'},
        },
        outcome: {private: 'PRIVATE-RECEIPT'},
      });
    const first = await f.call('amcp_workspace', {action: 'history', limit: 1});
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.meta.workflow.website_path, '/activity');
    assert.equal(first.data.events[0].request_id, 'newer');
    const second = await f.call('amcp_workspace', {action: 'history', limit: 1, cursor: first.data.next_cursor});
    assert.equal(second.data.events[0].request_id, 'older');
    assert.doesNotMatch(JSON.stringify(second), /PRIVATE-/);
    f.store.putConnection(
      {...f.actor, role: 'admin'},
      {
        id: 'meta',
        tenantId: f.actor.tenantId,
        gateway: 'meta_native_action',
        accounts: [],
        enabled: false,
        label: 'Revoked',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const revoked = await f.call('amcp_workspace', {action: 'history', limit: 1, cursor: first.data.next_cursor});
    assert.equal(revoked.data.events.length, 0);
    assert.equal(f.metrics().provider_requests, 0);
    t.diagnostic(
      JSON.stringify({
        journey: 'scoped-audit-history',
        ...f.metrics(),
        qualification: 'real SDK; synthetic audit and current grants',
      }),
    );
  } finally {
    await f.close();
  }
});
