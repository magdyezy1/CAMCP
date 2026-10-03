import test from 'node:test';
import assert from 'node:assert/strict';
import {reportingConfigScope, validateReportingConfig, reportQueryPage} from '../dist/src/report-query-access.js';
import {reportRunStatus} from '../dist/src/report-runs.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {resumeReportRun} from '../dist/src/report-runs.js';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {
  ga4ResourceConfig,
  gscResourceConfig,
  resourceScopeConnections,
  resourceScopeFixture,
} from './fixtures/report-resource-scope-data.mjs';

function fixture(t, options) {
  const f = resourceScopeFixture(options);
  t.after(() => f.store.close());
  return f;
}
function completeLegacy(f, config, marker = 'SYNTHETIC-DENIED-RESOURCE-ROW') {
  const id = f.store.enqueueReport(f.actor, {query_name: 'Synthetic retained resource', query_config: config});
  const lease = f.store.leaseJob();
  assert.equal(lease.id, id);
  f.store.finishJob(id, lease.lease_token, {marker});
  return id;
}
const scoped = (f, c, id) => {
  const out = reportingConfigScope(f.store, f.actor, c);
  assert.deepEqual(out, {gateway: c.gateway, account_id: id, connection_id: resourceScopeConnections[c.gateway]});
  return out;
};

test('canonical GA4 property selectors recover metadata and validate against the existing native compiler', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const selector of [
    {property: '100'},
    {property: 'properties/100'},
    {params: {property: 'properties/100'}},
    {path_params: {property: 'properties/100'}},
  ]) {
    const c = ga4ResourceConfig(selector),
      original = JSON.stringify(c);
    assert.equal(compiler.compile(c.gateway, c.arguments).accountId, '100');
    scoped(f, c, '100');
    if (selector.property) assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scoped(f, c, '100'));
    else
      assert.throws(
        () => validateReportingConfig(f.store, f.actor, c),
        e => e.code === 'INVALID_ARGUMENT',
        'Legacy native parameter bags do not expand the captured fresh-query schema',
      );
    assert.equal(JSON.stringify(c), original);
  }
  assert.equal(f.attempts(), 0);
});

test('GA4 report-task resource selectors retain exact parent scope without projecting the native path', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const [action, selectors] of [
    ['query', {name: 'properties/100/reportTasks/opaque-task_7'}],
    ['get', {params: {name: 'properties/100/reportTasks/opaque-task_7'}}],
    ['list', {params: {parent: 'properties/100'}}],
    ['query', {property: '100', report_task_name: 'properties/100/reportTasks/opaque-task_7'}],
  ]) {
    const c = ga4ResourceConfig();
    c.arguments = {
      operation: 'ga4_report_task_ops',
      arguments: {action, connection_id: resourceScopeConnections[c.gateway], ...selectors},
    };
    assert.equal(compiler.compile(c.gateway, c.arguments).accountId, '100');
    scoped(f, c, '100');
    if (selectors.property) assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scoped(f, c, '100'));
    else
      assert.throws(
        () => validateReportingConfig(f.store, f.actor, c),
        e => e.code === 'INVALID_ARGUMENT',
      );
    const id = f.store.enqueueReport(f.actor, {query_config: c}, Number.MAX_SAFE_INTEGER),
      out = reportRunStatus(f.store, f.actor, id);
    assert.equal(out.account_id, '100');
    assert.doesNotMatch(JSON.stringify(out), /opaque-task_7|reportTasks|properties\//);
  }
  assert.equal(f.attempts(), 0);
});

test('Search Console canonical URL/domain aliases recover exact scopes with native URL encoding unchanged', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const value of ['sc-domain:example.com', 'https://example.com/'])
    for (const selector of [
      {siteUrl: value},
      {site_url: value},
      {site: value},
      {property_url: value},
      {params: {siteUrl: value}},
      {path_params: {siteUrl: value}},
    ]) {
      const c = gscResourceConfig(selector),
        original = JSON.stringify(c),
        native = compiler.compile(c.gateway, c.arguments);
      assert.equal(native.accountId, value);
      scoped(f, c, value);
      if (Object.hasOwn(selector, 'siteUrl'))
        assert.throws(
          () => validateReportingConfig(f.store, f.actor, c),
          e => e.code === 'INVALID_ARGUMENT',
        );
      else assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scoped(f, c, value));
      assert.ok(native.path.includes(encodeURIComponent(value)));
      assert.equal(JSON.stringify(c), original);
    }
  const c = gscResourceConfig();
  c.arguments = {
    operation: 'gsc_site_ops',
    arguments: {
      action: 'INSPECT_URL',
      connection_id: resourceScopeConnections[c.gateway],
      payload: {siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://example.com/page'},
    },
  };
  assert.equal(compiler.compile(c.gateway, c.arguments).accountId, 'sc-domain:example.com');
  scoped(f, c, 'sc-domain:example.com');
  assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scoped(f, c, 'sc-domain:example.com'));
  assert.equal(f.attempts(), 0);
});

test('conflicting native resource selectors cannot expose completed legacy rows through a different account alias', t => {
  const f = fixture(t);
  for (const c of [
    ga4ResourceConfig({account_id: '100', property: 'properties/200'}),
    ga4ResourceConfig({account_id: '100', params: {property: 'properties/200'}}),
    gscResourceConfig({account_id: 'sc-domain:example.com', site: 'sc-domain:denied.example'}),
  ]) {
    const id = completeLegacy(f, c),
      retained = f.store.db.prepare('SELECT input,result FROM jobs WHERE id=?').get(id);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
      'A denied native selector must not be hidden by an allowed explicit account alias',
    );
    assert.throws(
      () => reportRunStatus(f.store, f.actor, id),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.equal(operationsPage(f.store, f.actor, {kind: 'workbook_report'}, true).operations.length, 0);
    assert.deepEqual(f.store.db.prepare('SELECT input,result FROM jobs WHERE id=?').get(id), retained);
  }
  assert.equal(f.attempts(), 0);
});

test('native nested GA4 properties and Search Console body aliases cannot hide conflicting retained scope', t => {
  const f = fixture(t),
    ga4 = ga4ResourceConfig(),
    gsc = gscResourceConfig();
  ga4.arguments.arguments.account_id = '100';
  ga4.arguments.arguments.request.reports = [{property: 'properties/200'}];
  gsc.arguments.arguments.account_id = 'sc-domain:example.com';
  gsc.arguments.arguments.payload.siteUrl = 'sc-domain:denied.example';
  for (const c of [ga4, gsc, ga4ResourceConfig({property: '100', name: 'properties/200/reportTasks/task'})]) {
    const id = completeLegacy(f, c),
      original = f.store.db.prepare('SELECT input,state,result FROM jobs WHERE id=?').get(id);
    assert.throws(
      () => reportRunStatus(f.store, f.actor, id),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.throws(
      () => resumeReportRun(f.store, f.actor, {id, confirmed: true, run_version: 'synthetic'}),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.deepEqual(f.store.db.prepare('SELECT input,state,result FROM jobs WHERE id=?').get(id), original);
  }
  assert.equal(f.attempts(), 0);
});

test('malformed, nontext, oversized and unsafe native selectors stay unknown without returning original source text', t => {
  const f = fixture(t);
  for (const value of [
    null,
    false,
    '',
    100,
    ['100'],
    {id: '100'},
    'properties/100/metadata',
    'accounts/100',
    'properties/100?private-marker',
    'properties/100/../200',
    'properties/' + '1'.repeat(33),
  ]) {
    const c = ga4ResourceConfig({account_id: '100', property: value});
    assert.throws(
      () => reportingConfigScope(f.store, f.actor, c),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  }
  for (const value of [
    'properties/100/reportTasks/../200',
    'properties/100/reportTasks/task?private-marker',
    'properties/100/' + 'x'.repeat(513),
    'https://example.com/properties/100',
  ])
    assert.throws(
      () => reportingConfigScope(f.store, f.actor, ga4ResourceConfig({account_id: '100', name: value})),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  for (const value of [
    100,
    ['sc-domain:example.com'],
    {site: 'sc-domain:example.com'},
    'example.com',
    'https://synthetic-password@example.com/',
    'sc-domain:example.com?private-marker',
    'sc-domain:' + 'x'.repeat(201),
  ])
    assert.throws(
      () =>
        reportingConfigScope(f.store, f.actor, gscResourceConfig({account_id: 'sc-domain:example.com', site: value})),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  assert.equal(f.attempts(), 0);
});

test('resource body and selector-count bounds refuse oversized legacy inputs without partial account proof', t => {
  const f = fixture(t),
    c = ga4ResourceConfig();
  c.arguments.arguments.request.reports = Array.from({length: 7}, () => ({property: 'properties/100'}));
  scoped(f, c, '100');
  c.arguments.arguments.request.reports.push({property: 'properties/100'});
  assert.throws(
    () => reportingConfigScope(f.store, f.actor, c),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  for (const config of [ga4ResourceConfig(), gscResourceConfig()]) {
    const args = config.arguments.arguments,
      key = config.gateway === 'ga4_native_action' ? 'request' : 'payload';
    for (const value of ['{}', [], null, {private_source_note: 'x'.repeat(65536)}]) {
      args[key] = value;
      assert.throws(
        () => reportingConfigScope(f.store, f.actor, config),
        e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
      );
    }
  }
  const oversizedEnvelope = ga4ResourceConfig();
  const id = f.store.enqueueReport(f.actor, {query_config: oversizedEnvelope, private_note: 'x'.repeat(131072)});
  const original = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input;
  assert.throws(
    () => reportRunStatus(f.store, f.actor, id),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input, original);
  assert.equal(f.attempts(), 0);
});

test('Operations and query discovery recover only bounded scope metadata while retaining original definitions and runs', t => {
  const f = fixture(t),
    c = ga4ResourceConfig({name: 'properties/100/reportTasks/task'});
  c.arguments.operation = 'ga4_report_task_ops';
  c.arguments.arguments.action = 'query';
  c.arguments.arguments.request.private_source_note = 'NATIVE-SOURCE-MARKER-DO-NOT-PROJECT';
  f.store.putDocument(f.actor.tenantId, 'reporting_query', 'allowed-resource', {
    name: 'Synthetic report',
    workbook_binding_id: 'book',
    query_config: c,
  });
  f.store.putDocument(f.actor.tenantId, 'reporting_query', 'denied-resource', {
    name: 'Denied',
    workbook_binding_id: 'denied-book',
    query_config: ga4ResourceConfig({account_id: '100', property: 'properties/200'}),
  });
  const id = f.store.enqueueReport(f.actor, {query_config: c}, Number.MAX_SAFE_INTEGER),
    retained = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input;
  f.store.document =
    f.store.documents =
    f.store.job =
      () => {
        throw Error('Full source/result reads forbidden for metadata');
      };
  const page = reportQueryPage(f.store, f.actor, {}),
    ops = operationsPage(f.store, f.actor, {kind: 'workbook_report'}, true),
    status = reportRunStatus(f.store, f.actor, id);
  assert.deepEqual(
    page.queries.map(q => q.id),
    ['allowed-resource'],
  );
  assert.deepEqual(ops.operations[0].accounts, ['100']);
  assert.equal(status.account_id, '100');
  assert.doesNotMatch(
    JSON.stringify({page, ops, status}),
    /NATIVE-SOURCE-MARKER|reportTasks|properties\/|"resource_account_anchors"|"(?:request|payload)":/,
  );
  assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input, retained);
  assert.equal(f.attempts(), 0);
});

test('resource-based result access requires current login, tenant, account and actor authority', t => {
  for (const change of [
    f => f.store.revokeKey(f.key),
    f =>
      f.store.putConnection(
        f.admin,
        {
          ...f.store.resolveConnection(f.actor, 'ga4_native_action', '100', resourceScopeConnections.ga4_native_action),
          accounts: ['200'],
        },
        {accessToken: 'synthetic'},
      ),
    f =>
      f.store.putConnection(
        f.admin,
        {
          ...f.store.resolveConnection(f.actor, 'ga4_native_action', '100', resourceScopeConnections.ga4_native_action),
          enabled: false,
        },
        {accessToken: 'synthetic'},
      ),
  ]) {
    const f = fixture(t),
      id = completeLegacy(f, ga4ResourceConfig(), 'SYNTHETIC-ALLOWED-100');
    assert.equal(f.reporting.handle('get_reporting_run', {run_id: id}, f.actor).result.marker, 'SYNTHETIC-ALLOWED-100');
    assert.throws(() => reportRunStatus(f.store, {...f.actor, tenantId: 'other-tenant'}, id));
    change(f);
    assert.throws(() => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor));
    assert.equal(f.attempts(), 0);
  }
});

test('resource metadata cannot authorize unsupported gateways or turn native writes into report reads', t => {
  const f = fixture(t),
    write = ga4ResourceConfig();
  write.arguments.operation = 'ga4_create_audience_export';
  write.arguments.arguments.request = {audience: 'properties/100/audiences/7'};
  assert.throws(
    () => validateReportingConfig(f.store, f.actor, write),
    e => e.code === 'REPORT_WRITE_FORBIDDEN',
  );
  const c = ga4ResourceConfig();
  c.gateway = 'google_ads_native_action';
  assert.throws(
    () => reportingConfigScope(f.store, f.actor, c),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  assert.equal(f.attempts(), 0);
});

test('metadata follows native key normalization and refuses conflicting duplicate selectors in retained JSON', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const c of [
    ga4ResourceConfig({account_id: '100', params: {'p r o p e r t y': 'properties/200'}}),
    ga4ResourceConfig({account_id: '100', path_params: {Property: 'properties/200'}}),
    gscResourceConfig({account_id: 'sc-domain:example.com', params: {SiteURL: 'sc-domain:denied.example'}}),
  ]) {
    assert.notEqual(compiler.compile(c.gateway, c.arguments).accountId, c.arguments.arguments.account_id);
    const id = completeLegacy(f, c);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  }
  const c = ga4ResourceConfig({account_id: '100', property: 'properties/100'}),
    id = completeLegacy(f, c),
    row = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id);
  const duplicate = row.input.replace(
    '"property":"properties/100"',
    '"property":"properties/100","property":"properties/200"',
  );
  assert.notEqual(duplicate, row.input);
  assert.equal(JSON.parse(duplicate).query_config.arguments.arguments.property, 'properties/200');
  f.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(duplicate, id);
  assert.throws(
    () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input, duplicate);
  const sc = gscResourceConfig({account_id: 'sc-domain:example.com'});
  sc.arguments.operation = 'gsc_site_ops';
  sc.arguments.arguments.action = 'INSPECT_URL';
  sc.arguments.arguments.payload = {siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://example.com/page'};
  const scRun = completeLegacy(f, sc),
    scInput = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(scRun).input;
  const scDuplicate = scInput.replace(
    '"siteUrl":"sc-domain:example.com"',
    '"siteUrl":"sc-domain:example.com","SiteURL":"sc-domain:denied.example"',
  );
  assert.notEqual(scDuplicate, scInput);
  f.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(scDuplicate, scRun);
  assert.throws(
    () => f.reporting.handle('get_reporting_run', {run_id: scRun}, f.actor),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(scRun).input, scDuplicate);
  assert.equal(f.attempts(), 0);
});

test('conflicting duplicate resource envelopes cannot substitute the last native definition for the first metadata scope', t => {
  const f = fixture(t),
    allowed = ga4ResourceConfig(),
    denied = ga4ResourceConfig({account_id: '100', property: 'properties/200'});
  const configs = [
    '{"query_config":' + JSON.stringify(allowed) + ',"query_config":' + JSON.stringify(denied) + '}',
    '{"query_config":{"gateway":"ga4_native_action","arguments":' +
      JSON.stringify(allowed.arguments) +
      ',"arguments":' +
      JSON.stringify(denied.arguments) +
      '}}',
    '{"query_config":{"gateway":"ga4_native_action","arguments":{"operation":"ga4_run_report","arguments":' +
      JSON.stringify(allowed.arguments.arguments) +
      ',"arguments":' +
      JSON.stringify(denied.arguments.arguments) +
      '}}}',
  ];
  for (const input of configs) {
    assert.equal(JSON.parse(input).query_config.arguments.arguments.property, 'properties/200');
    const id = completeLegacy(f, allowed);
    f.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(input, id);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input, input);
  }
  assert.equal(f.attempts(), 0);
});

test('MCP recovers original GA4 and Search Console reports with read access and refuses conflicting or revoked scope', async t => {
  const f = fixture(t, {role: 'reader'}),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'AMCP synthetic resource-scope evaluator', version: '1.0.0'}),
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools,
    ajv = new Ajv({strict: false}),
    schemas = new Map(
      tools.filter(tool => tool.name.startsWith('amcp_')).map(tool => [tool.name, ajv.compile(tool.inputSchema)]),
    );
  let calls = 0,
    bytes = 0;
  const call = async (name, args) => {
    const validate = schemas.get(name);
    assert.equal(validate(args), true, JSON.stringify(validate.errors));
    const result = await client.callTool({name, arguments: args});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(result.structuredContent));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.isError === true, result.structuredContent.success === false);
    return result.structuredContent;
  };
  const ga4 = ga4ResourceConfig(),
    gsc = gscResourceConfig(),
    ga4Run = completeLegacy(f, ga4, 'SYNTHETIC-GA4-100'),
    gscRun = completeLegacy(f, gsc, 'SYNTHETIC-GSC-EXAMPLE'),
    denied = completeLegacy(f, ga4ResourceConfig({account_id: '100', property: 'properties/200'}));
  for (const [id, c] of [
    ['ga4-query', ga4],
    ['gsc-query', gsc],
  ])
    f.store.putDocument(f.actor.tenantId, 'reporting_query', id, {name: id, query_config: c});
  const queries = await call('amcp_workspace', {action: 'report_queries'});
  assert.equal(queries.success, true, JSON.stringify(queries));
  assert.deepEqual(new Set(queries.data.queries.map(q => q.id)), new Set(['ga4-query', 'gsc-query']));
  const operations = await call('amcp_workspace', {action: 'operations', kind: 'workbook_report'});
  assert.equal(operations.success, true, JSON.stringify(operations));
  assert.deepEqual(new Set(operations.data.operations.map(row => row.id)), new Set([ga4Run, gscRun]));
  for (const [id, account, marker] of [
    [ga4Run, '100', 'SYNTHETIC-GA4-100'],
    [gscRun, 'sc-domain:example.com', 'SYNTHETIC-GSC-EXAMPLE'],
  ]) {
    const status = await call('amcp_workspace', {action: 'report_run', id});
    assert.equal(status.success, true, JSON.stringify(status));
    assert.equal(status.data.account_id, account);
    assert.equal(status.data.can_resume, false);
    const result = await call('amcp_native_action', {operation: 'get_reporting_run', arguments: {run_id: id}});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.result.marker, marker);
  }
  const refused = await call('amcp_native_action', {operation: 'get_reporting_run', arguments: {run_id: denied}});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'REPORT_SCOPE_UNAVAILABLE');
  f.store.revokeKey(f.key);
  assert.equal((await call('amcp_workspace', {action: 'report_run', id: ga4Run})).success, false);
  assert.equal(f.attempts(), 0);
  t.diagnostic(
    JSON.stringify({
      journey: 'retained-resource-report-recovery',
      tool_calls: calls,
      structured_response_bytes: bytes,
      provider_requests: f.attempts(),
      qualification: 'real SDK; synthetic retained reports; zero provider requests or advertising mutations',
    }),
  );
});
