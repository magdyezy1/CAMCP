import test from 'node:test';
import assert from 'node:assert/strict';
import {reportingConfigScope, validateReportingConfig, reportQueryPage} from '../dist/src/report-query-access.js';
import {reportRunStatus, resumeReportRun} from '../dist/src/report-runs.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/client';
import {createMcpServer} from '../dist/server/mcp.js';
import Ajv from 'ajv';
import {
  gtmParentConfig,
  businessParentConfig,
  parentScopeConnections,
  parentScopeFixture,
} from './fixtures/report-parent-scope-data.mjs';

const fixture = (t, options) => {
  const f = parentScopeFixture(options);
  t.after(() => f.store.close());
  return f;
};
const scope = (f, c, account) => {
  const out = reportingConfigScope(f.store, f.actor, c);
  assert.deepEqual(out, {gateway: c.gateway, account_id: account, connection_id: parentScopeConnections[c.gateway]});
  return out;
};
const complete = (f, c, marker = 'SYNTHETIC-OUTSIDE-PARENT') => {
  const id = f.store.enqueueReport(f.actor, {query_name: 'Synthetic retained parent', query_config: c}),
    lease = f.store.leaseJob();
  assert.equal(lease.id, id);
  f.store.finishJob(id, lease.lease_token, {marker});
  return id;
};

test('canonical Tag Manager paths establish the exact account parent without changing native compilation', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler(),
    path = 'accounts/100/containers/200/workspaces/300/tags/400';
  for (const selectors of [{path}, {params: {path}}, {path_params: {path}}, {params: {'P-a-t-h': path}}]) {
    const c = gtmParentConfig(selectors),
      before = JSON.stringify(c),
      plan = compiler.compile(c.gateway, c.arguments);
    assert.equal(plan.accountId, '100');
    scope(f, c, '100');
    assert.equal(plan.path, '/tagmanager/v2/' + path);
    assert.equal(JSON.stringify(c), before);
  }
  assert.deepEqual(validateReportingConfig(f.store, f.actor, gtmParentConfig()), scope(f, gtmParentConfig(), '100'));
  assert.equal(f.attempts(), 0);
});

test('canonical Business Profile account and location names establish their separate native grant scopes', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const c of [
    businessParentConfig(),
    businessParentConfig({location_id: '456'}),
    businessParentConfig({params: {name: 'locations/456/lodging'}}),
  ]) {
    assert.equal(compiler.compile(c.gateway, c.arguments).accountId, 'locations/456');
    scope(f, c, 'locations/456');
  }
  const c = businessParentConfig({name: 'accounts/100'});
  c.arguments.operation = 'gmb_account_ops';
  c.arguments.arguments.action = 'GET_ACCOUNT';
  delete c.arguments.arguments.query;
  assert.equal(compiler.compile(c.gateway, c.arguments).accountId, '100');
  scope(f, c, '100');
  assert.throws(
    () => validateReportingConfig(f.store, f.actor, c),
    e => e.code === 'INVALID_ARGUMENT',
  );
  c.arguments.arguments.params = {name: c.arguments.arguments.name};
  delete c.arguments.arguments.name;
  assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scope(f, c, '100'));
  assert.equal(f.attempts(), 0);
});

test('a retained canonical parent cannot be hidden by a different currently allowed explicit account or location', t => {
  const f = fixture(t);
  for (const c of [
    gtmParentConfig({account_id: '100', path: 'accounts/200/containers/200/workspaces/300/tags/400'}),
    gtmParentConfig({account_id: '100', params: {Path: 'accounts/200/containers/200/workspaces/300/tags/400'}}),
    businessParentConfig({account_id: 'locations/456', name: 'locations/999/lodging'}),
  ]) {
    const id = complete(f, c),
      before = f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.throws(
      () => reportRunStatus(f.store, f.actor, id),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.throws(
      () => resumeReportRun(f.store, f.actor, {id, confirmed: true, run_version: 'synthetic'}),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.deepEqual(f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id), before);
  }
  assert.equal(operationsPage(f.store, f.actor, {kind: 'workbook_report'}, true).operations.length, 0);
  assert.equal(f.attempts(), 0);
});

test('a location grant cannot hide a contradictory native location selector in retained metadata', t => {
  const f = fixture(t);
  for (const c of [
    businessParentConfig({account_id: 'locations/456', location_id: '999'}),
    businessParentConfig({params: {account_id: 'locations/456', location_id: '999'}}),
  ]) {
    const id = complete(f, c),
      before = f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.throws(
      () => reportRunStatus(f.store, f.actor, id),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.deepEqual(f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id), before);
  }
  const original = businessParentConfig({account_id: 'locations/456', location_id: '456'});
  assert.deepEqual(validateReportingConfig(f.store, f.actor, original), scope(f, original, 'locations/456'));
  assert.equal(operationsPage(f.store, f.actor, {kind: 'workbook_report'}, true).operations.length, 0);
  assert.equal(f.attempts(), 0);
});

test('parent-resource metadata discovery avoids complete definitions, native child paths and retained rows', t => {
  const f = fixture(t),
    c = gtmParentConfig();
  c.arguments.arguments.private_note = 'PARENT-SOURCE-MARKER';
  f.store.putDocument(f.actor.tenantId, 'reporting_query', 'allowed-parent', {
    name: 'Synthetic parent',
    query_config: c,
  });
  const id = complete(f, c, 'PARENT-RESULT-MARKER'),
    before = f.store.db.prepare('SELECT input,result FROM jobs WHERE id=?').get(id);
  f.store.document =
    f.store.documents =
    f.store.job =
      () => {
        throw Error('Full source/result read forbidden');
      };
  const page = reportQueryPage(f.store, f.actor, {}),
    status = reportRunStatus(f.store, f.actor, id),
    operations = operationsPage(f.store, f.actor, {kind: 'workbook_report'}, true);
  assert.deepEqual(
    page.queries.map(q => q.id),
    ['allowed-parent'],
  );
  assert.equal(status.account_id, '100');
  assert.deepEqual(operations.operations[0].accounts, ['100']);
  assert.doesNotMatch(
    JSON.stringify({page, status, operations}),
    /PARENT-(?:SOURCE|RESULT)-MARKER|accounts\/100|containers\/200|workspaces\/300|tags\/400/,
  );
  assert.deepEqual(f.store.db.prepare('SELECT input,result FROM jobs WHERE id=?').get(id), before);
  assert.equal(f.attempts(), 0);
});

test('account resource aliases stay exact and Business Profile child selectors do not replace the account parent', t => {
  const f = fixture(t);
  for (const c of [
    gtmParentConfig({account_id: 'accounts/100'}),
    gtmParentConfig({account_id: 'accounts/100', path: 'accounts/100/containers/200/workspaces/300/tags/400'}),
  ]) {
    if (!c.arguments.arguments.path) c.arguments.arguments.path = 'accounts/100/containers/200/workspaces/300/tags/400';
    assert.deepEqual(validateReportingConfig(f.store, f.actor, c), scope(f, c, '100'));
  }
  const c = businessParentConfig({
    account_id: '100',
    location_id: '456',
    params: {parent: 'accounts/100/locations/456'},
  });
  c.arguments.operation = 'gmb_account_ops';
  c.arguments.arguments.action = 'GET_ACCOUNT';
  // This retained composite parent is metadata scope only; the fresh account route has its own exact name pattern.
  scope(f, c, '100');
  c.arguments.arguments.location_id = '999';
  assert.throws(
    () => reportingConfigScope(f.store, f.actor, c),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
  );
  assert.equal(f.attempts(), 0);
});

test('malformed or unrelated resource values cannot authorize a native parent or expose their original text', t => {
  const f = fixture(t);
  for (const value of [
    null,
    99,
    ['accounts/100'],
    {path: 'accounts/100'},
    'https://example.com/accounts/100',
    'accounts/100/../200',
    'accounts/100%2f200',
    'accounts/100/',
    'accounts/100/' + 'x'.repeat(513),
  ]) {
    assert.throws(
      () => reportingConfigScope(f.store, f.actor, gtmParentConfig({account_id: '100', path: value})),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  }
  for (const value of [
    'http://example.com/locations/456',
    'locations/456/../999',
    'locations/456?private-note',
    'accounts/100#private-note',
    456,
    {},
    null,
  ])
    assert.throws(
      () => reportingConfigScope(f.store, f.actor, businessParentConfig({account_id: 'locations/456', name: value})),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  assert.throws(
    () => reportingConfigScope(f.store, f.actor, gtmParentConfig({name: 'accounts/100'})),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    'An unregistered GTM name is not a path selector',
  );
  assert.throws(
    () => reportingConfigScope(f.store, f.actor, businessParentConfig({path: 'locations/456/lodging'})),
    e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    'An arbitrary Business Profile path is not a captured name selector',
  );
  assert.equal(f.attempts(), 0);
});

test('bounded parent selectors preserve duplicate raw JSON keys and reject conflicting last-value parsing', t => {
  const f = fixture(t);
  for (const [c, old, insert] of [
    [
      gtmParentConfig({account_id: '100', path: 'accounts/100/containers/200/workspaces/300/tags/400'}),
      '"path":"accounts/100/containers/200/workspaces/300/tags/400"',
      '"path":"accounts/100/containers/200/workspaces/300/tags/400","path":"accounts/200/containers/200/workspaces/300/tags/400"',
    ],
    [
      businessParentConfig({account_id: 'locations/456', params: {Name: 'locations/456/lodging'}}),
      '"Name":"locations/456/lodging"',
      '"Name":"locations/456/lodging","N-a-m-e":"locations/999/lodging"',
    ],
  ]) {
    const id = complete(f, c),
      source = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input,
      duplicate = source.replace(old, insert);
    assert.notEqual(duplicate, source);
    f.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(duplicate, id);
    assert.throws(
      () => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    assert.equal(f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input, duplicate);
  }
  for (const c of [gtmParentConfig(), businessParentConfig()]) {
    c.arguments.arguments.private_note = 'x'.repeat(65536);
    assert.throws(
      () => reportingConfigScope(f.store, f.actor, c),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  }
  assert.equal(f.attempts(), 0);
});

test('parent-resource recovery still requires current actor, exact login, account and tenant grants', t => {
  for (const gateway of Object.keys(parentScopeConnections)) {
    const f = fixture(t),
      c = gateway === 'gtm_native_action' ? gtmParentConfig() : businessParentConfig(),
      account = gateway === 'gtm_native_action' ? '100' : 'locations/456',
      id = complete(f, c, 'SYNTHETIC-ALLOWED-PARENT');
    assert.equal(
      f.reporting.handle('get_reporting_run', {run_id: id}, f.actor).result.marker,
      'SYNTHETIC-ALLOWED-PARENT',
    );
    assert.throws(() => reportRunStatus(f.store, {...f.actor, tenantId: 'different-tenant'}, id));
    const connection = f.store.resolveConnection(f.actor, gateway, account, parentScopeConnections[gateway]);
    f.store.putConnection(f.admin, {...connection, accounts: ['denied']}, {accessToken: 'synthetic'});
    assert.throws(() => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor));
    assert.equal(f.attempts(), 0);
  }
  const f = fixture(t),
    id = complete(f, gtmParentConfig());
  f.store.revokeKey(f.key);
  assert.throws(() => f.reporting.handle('get_reporting_run', {run_id: id}, f.actor));
  assert.equal(f.attempts(), 0);
});

test('native parent adapters retain fresh schemas and independently classified report reads', t => {
  const f = fixture(t),
    c = gtmParentConfig({path_params: {path: 'accounts/100/containers/200/workspaces/300/tags/400'}});
  scope(f, c, '100');
  assert.throws(
    () => validateReportingConfig(f.store, f.actor, c),
    e => e.code === 'INVALID_ARGUMENT',
  );
  for (const read of [
    businessParentConfig({location_id: '456'}),
    businessParentConfig({params: {name: 'locations/456/lodging'}}),
  ])
    assert.deepEqual(validateReportingConfig(f.store, f.actor, read), scope(f, read, 'locations/456'));
  const write = gtmParentConfig({
    account_id: '100',
    container_id: '200',
    workspace_id: '300',
    payload: {name: 'Synthetic tag', type: 'html'},
  });
  write.arguments.arguments.action = 'CREATE_TAG';
  assert.throws(
    () => validateReportingConfig(f.store, f.actor, write),
    e => e.code === 'REPORT_WRITE_FORBIDDEN',
  );
  assert.equal(f.attempts(), 0);
});

test('MCP retrieves original Tag Manager and Business Profile results with a read grant and refuses revoked access', async t => {
  const f = fixture(t, {role: 'reader'}),
    client = new Client({name: 'AMCP synthetic parent-scope evaluator', version: '1.0.0'}),
    server = createMcpServer(f.service, f.actor),
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
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
  const call = async (name, arguments_) => {
    const validate = schemas.get(name);
    assert.equal(validate(arguments_), true, JSON.stringify(validate.errors));
    const r = await client.callTool({name, arguments: arguments_});
    calls++;
    bytes += Buffer.byteLength(JSON.stringify(r.structuredContent));
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assert.equal(r.isError === true, r.structuredContent.success === false);
    return r.structuredContent;
  };
  const original = [];
  for (const [c, account] of [
    [gtmParentConfig(), '100'],
    [businessParentConfig(), 'locations/456'],
  ]) {
    const id = complete(f, c, 'SYNTHETIC-ORIGINAL-' + account);
    original.push(id);
    const status = await call('amcp_workspace', {action: 'report_run', id});
    assert.equal(status.success, true, JSON.stringify(status));
    assert.equal(status.data.account_id, account);
    assert.equal(status.data.can_resume, false);
    const result = await call('amcp_native_action', {operation: 'get_reporting_run', arguments: {run_id: id}});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.result.marker, 'SYNTHETIC-ORIGINAL-' + account);
  }
  const denied = complete(
    f,
    gtmParentConfig({account_id: '100', path: 'accounts/200/containers/200/workspaces/300/tags/400'}),
  );
  const page = await call('amcp_workspace', {action: 'operations', kind: 'workbook_report'});
  assert.equal(page.success, true, JSON.stringify(page));
  assert.deepEqual(new Set(page.data.operations.map(row => row.id)), new Set(original));
  const refused = await call('amcp_native_action', {operation: 'get_reporting_run', arguments: {run_id: denied}});
  assert.equal(refused.success, false);
  assert.equal(refused.error.code, 'REPORT_SCOPE_UNAVAILABLE');
  f.store.revokeKey(f.key);
  assert.equal((await call('amcp_workspace', {action: 'report_run', id: original[0]})).success, false);
  assert.equal(f.attempts(), 0);
  t.diagnostic(
    JSON.stringify({
      journey: 'retained-native-parent-recovery',
      tool_calls: calls,
      structured_response_bytes: bytes,
      provider_requests: f.attempts(),
      qualification: 'real SDK; synthetic retained source/results; zero provider requests or mutations',
    }),
  );
});
