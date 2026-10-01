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
import {allocationReport} from './fixtures/allocation-data.mjs';
import {metaPortfolioData} from './fixtures/meta-portfolio-data.mjs';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {WebStore} from '../dist/server/web-store.js';
import {UserAccounts} from '../dist/server/user-accounts.js';

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

test('MCP Google portfolio represents omitted optional fields consistently in both result envelopes', async () => {
  const f = await fixture('reader', async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.match(String(url), /googleads.googleapis.com/);
    return Response.json({results: [{campaign: {id: '10', name: 'Synthetic Google', status: 'PAUSED'}}]});
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

test('MCP guided campaign capture to bounded allocation uses advertised contracts and one read', async t => {
  const evidence = allocationReport();
  const f = await fixture('operator', async (_url, init) => {
    assert.equal(init.method, 'GET');
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
    assert.equal(f.metrics().provider_requests, 1);
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
    assert.equal(f.metrics().provider_requests, 2);
    t.diagnostic(JSON.stringify({journey: 'allocation-to-native-budget-draft', ...f.metrics(), advertising_writes: 0}));
  } finally {
    await f.close();
  }
});

test('MCP discovery to Meta evidence to verified linked-ad performance follows current advertised contracts', async t => {
  const f = await fixture('operator', async (url, init) => {
    assert.equal(init.method, 'GET');
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
    assert.equal(f.metrics().provider_requests, 1);
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
