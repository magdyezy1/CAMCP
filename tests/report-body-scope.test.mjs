import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorService} from '../dist/src/service.js';
import {Registry} from '../dist/src/catalog.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Client} from '@modelcontextprotocol/client';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {
  reportingConfigScope,
  validateReportingConfig,
  reportingBootstrap,
  redactReportingConfig,
} from '../dist/src/report-query-access.js';
import {workbookQuery} from '../dist/src/workbook-queries.js';
import {ReportingService} from '../dist/src/reporting.js';
import {ReportWorker} from '../dist/src/worker.js';
import {reportRunStatus} from '../dist/src/report-runs.js';
import {operationsPage} from '../dist/src/operations-feed.js';
const actor = {tenantId: 'body-scope-fixture', userId: 'operator', role: 'operator'};
const gateways = {
  dv360_native_action: ['advertiserId', '100'],
  linkedin_native_action: ['account_id', '100'],
  x_ads_native_action: ['account_id', '100'],
};
const connections = {
  dv360_native_action: '11111111-1111-4111-8111-111111111111',
  linkedin_native_action: '22222222-2222-4222-8222-222222222222',
  x_ads_native_action: '33333333-3333-4333-8333-333333333333',
};
function fixture() {
  const store = new Store(':memory:', Buffer.alloc(32, 89).toString('base64'));
  for (const gateway of Object.keys(gateways))
    store.putConnection(
      {...actor, role: 'admin'},
      {
        id: connections[gateway],
        tenantId: actor.tenantId,
        gateway,
        accounts: ['100'],
        writeAccounts: [],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
  return store;
}
function config(gateway, body, bag = 'payload') {
  const args = {action: 'retained-synthetic-read', connection_id: connections[gateway]};
  if (bag.startsWith('params.')) args.params = {[bag.slice(7)]: body};
  else args[bag] = body;
  return {gateway, arguments: args};
}
test('retained reporting scope recovers supported JSON body identifiers without loading body text or rewriting runs', () => {
  const store = fixture();
  try {
    for (const [gateway, [field, id]] of Object.entries(gateways))
      for (const bag of ['payload', 'body', 'params.payload', 'params.body']) {
        const c = config(gateway, JSON.stringify({[field]: id, private: 'DO-NOT-PROJECT'}), bag);
        const scope = reportingConfigScope(store, actor, c);
        assert.deepEqual(scope, {gateway, account_id: id, connection_id: connections[gateway]});
        const run = store.enqueueReport(actor, {query_name: 'Original', query_config: c}, Number.MAX_SAFE_INTEGER);
        const retained = store.db.prepare('SELECT input FROM jobs WHERE id=?').get(run).input;
        store.document =
          store.documents =
          store.job =
            () => {
              throw Error('Full document/job read forbidden');
            };
        const out = reportRunStatus(store, actor, run);
        assert.equal(out.account_id, id);
        assert.doesNotMatch(JSON.stringify(out), /DO-NOT-PROJECT|payload|body/);
        assert.equal(store.db.prepare('SELECT input FROM jobs WHERE id=?').get(run).input, retained);
      }
  } finally {
    store.close();
  }
});
test('encoded and object body scope conflicts, malformed values and duplicate keys fail closed without leaking payloads', () => {
  const store = fixture();
  try {
    for (const gateway of Object.keys(gateways)) {
      const [field] = gateways[gateway];
      for (const body of [
        '{',
        '[]',
        '"100"',
        'null',
        JSON.stringify({[field]: 100}),
        JSON.stringify({[field]: ['100']}),
        JSON.stringify({[field]: '100', private: 'X'.repeat(65536)}),
        '{"' + field + '":"100","' + field + '":"200"}',
      ])
        assert.throws(
          () => reportingConfigScope(store, actor, config(gateway, body)),
          e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
        );
      const conflict = config(gateway, JSON.stringify({[field]: '200'}));
      conflict.arguments[field] = '100';
      assert.throws(
        () => reportingConfigScope(store, actor, conflict),
        e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
      );
      const nested = config(gateway, {[field]: '100'}, 'params.payload');
      assert.equal(reportingConfigScope(store, actor, nested).account_id, '100');
      nested.arguments[field] = '200';
      assert.throws(
        () => reportingConfigScope(store, actor, nested),
        e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
      );
    }
  } finally {
    store.close();
  }
});
test('encoded body scope requires current actor, exact login, tenant and account authority on every page', () => {
  const store = fixture();
  try {
    const gateway = 'linkedin_native_action',
      c = config(gateway, '{"account_id":"100","private":"DO-NOT-PROJECT"}');
    const id = store.enqueueReport(actor, {query_config: c}, Number.MAX_SAFE_INTEGER);
    const out = operationsPage(store, actor, {kind: 'workbook_report'}, true);
    assert.equal(out.operations[0].id, id);
    assert.doesNotMatch(JSON.stringify(out), /DO-NOT-PROJECT|payload|body/);
    store.putConnection(
      {...actor, role: 'admin'},
      {...store.resolveConnection(actor, gateway, '100', connections[gateway]), accounts: ['200']},
      {accessToken: 'synthetic'},
    );
    assert.throws(() => reportRunStatus(store, actor, id));
    assert.deepEqual(operationsPage(store, actor, {kind: 'workbook_report'}, true).operations, []);
    assert.throws(
      () => reportRunStatus(store, {...actor, tenantId: 'other'}, id),
      e => e.code === 'NOT_FOUND',
    );
  } finally {
    store.close();
  }
});
test('unsupported encoded formats never gain inferred scope and credential keys inside supported encoded bodies are refused', () => {
  const store = fixture();
  try {
    const gateway = 'linkedin_native_action';
    for (const bag of ['payload', 'body', 'params.payload', 'params.body']) {
      const c = config(gateway, '{"account_id":"100","authorization":"private-marker"}', bag);
      c.arguments.account_id = '100';
      assert.throws(() => validateReportingConfig(store, actor, c), /credential/i);
    }
    const c = {
      gateway: 'meta_native_action',
      arguments: {action: 'synthetic', connection_id: 'meta', payload: '{"account_id":"100"}'},
    };
    assert.throws(
      () => reportingConfigScope(store, actor, c),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  } finally {
    store.close();
  }
});

test('supported encoded native account bodies validate as real read contracts with identical exact account scope', () => {
  const store = fixture();
  try {
    for (const [gateway, action, field] of [
      ['dv360_native_action', 'DV360_ADVERTISERS_GET', 'advertiserId'],
      ['linkedin_native_action', 'linkedin_rest_ad_accounts_account_id_ad_campaigns_get', 'account_id'],
      ['x_ads_native_action', 'x_accounts_account_id_get', 'account_id'],
    ]) {
      const c = config(gateway, JSON.stringify({[field]: '100'}));
      c.arguments.action = action;
      assert.equal(validateReportingConfig(store, actor, c).account_id, '100');
      assert.equal(c.arguments.payload, JSON.stringify({[field]: '100'}));
    }
  } finally {
    store.close();
  }
});
test('a valid read contract cannot persist credential keys hidden inside a JSON-encoded request', () => {
  const store = fixture();
  try {
    const gateway = 'linkedin_native_action',
      c = {
        gateway,
        arguments: {
          action: 'linkedin_rest_targeting_audience_insights_post',
          account_id: '100',
          connection_id: connections[gateway],
          query: {action: 'audienceInsights'},
          payload: JSON.stringify({
            request: {
              requestMetaData: {sponsoredAccountUrn: 'urn:li:sponsoredAccount:100'},
              targetingCriteria: {include: {authorization: 'synthetic-private-marker'}},
              groupBy: 'urn:li:adTargetingFacet:jobFunctions',
            },
          }),
        },
      };
    assert.throws(() => validateReportingConfig(store, actor, c), /credential/i);
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='reporting_query'")
        .get(actor.tenantId).n,
      0,
    );
    const deep = config(gateway, '{"account_id":"100","request":' + '['.repeat(60) + '0' + ']'.repeat(60) + '}');
    assert.throws(() => validateReportingConfig(store, actor, deep), /nesting depth/i);
  } finally {
    store.close();
  }
});

test('legacy encoded credential values are masked in query detail, bootstrap and run previews while retained source bytes stay exact', () => {
  const store = fixture();
  try {
    const gateway = 'linkedin_native_action',
      cfg = {
        gateway,
        arguments: {
          action: 'linkedin_rest_targeting_audience_insights_post',
          account_id: '100',
          connection_id: connections[gateway],
          query: {action: 'audienceInsights'},
          payload: JSON.stringify({
            request: {
              requestMetaData: {sponsoredAccountUrn: 'urn:li:sponsoredAccount:100'},
              targetingCriteria: {include: {authorization: 'legacy-private-marker'}},
              groupBy: 'urn:li:adTargetingFacet:jobFunctions',
            },
          }),
        },
      };
    const book = '44444444-4444-4444-8444-444444444444',
      query = '55555555-5555-4555-8555-555555555555';
    store.putDocument(actor.tenantId, 'workbook', book, {spreadsheet_id: 'synthetic-book', created_by: actor.userId});
    store.putDocument(actor.tenantId, 'reporting_query', query, {
      name: 'Original query',
      workbook_binding_id: book,
      query_config: cfg,
    });
    const original = store.db
      .prepare('SELECT data FROM documents WHERE id=? AND tenant_id=?')
      .get(query, actor.tenantId).data;
    const detail = workbookQuery(store, actor, query);
    assert.equal(detail.configuration_redacted, true);
    assert.equal(
      JSON.parse(detail.query_config.arguments.payload).request.targetingCriteria.include.authorization,
      '[REDACTED]',
    );
    assert.doesNotMatch(JSON.stringify(reportingBootstrap(store, actor, {})), /legacy-private-marker/);
    const run = store.enqueueReport(actor, {query_config: cfg}, Number.MAX_SAFE_INTEGER),
      reporting = new ReportingService(store, async () => {
        throw Error('No native request allowed');
      });
    for (const action of ['get_reporting_run', 'execute_reporting_run'])
      assert.doesNotMatch(JSON.stringify(reporting.handle(action, {run_id: run}, actor)), /legacy-private-marker/);
    assert.equal(
      store.db.prepare('SELECT data FROM documents WHERE id=? AND tenant_id=?').get(query, actor.tenantId).data,
      original,
    );
    assert.equal(store.job(actor.tenantId, run).input.query_config.arguments.payload, cfg.arguments.payload);
    const safe = config(gateway, '{ "account_id" : "100", "threshold" : 9007199254740993 }');
    assert.equal(redactReportingConfig(safe).arguments.payload, safe.arguments.payload);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='running'").get().n, 0);
  } finally {
    store.close();
  }
});

test('actual HTTP MCP discovery and run status preserve recovered scope and revocation without native egress', async () => {
  const store = fixture(),
    gateway = 'x_ads_native_action',
    cfg = config(gateway, '{"account_id":"100","private":"PRIVATE-BODY-MARKER"}');
  const run = store.enqueueReport(actor, {query_config: cfg}, Number.MAX_SAFE_INTEGER);
  let egress = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      egress++;
      throw Error('No native egress');
    }),
  );
  const token = store.createKey(actor),
    listener = await listenForFetch(createHttpApp(service, store, {authEnv: {}})),
    client = new Client({name: 'encoded-scope-fixture', version: '1'});
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + token}},
      }),
    );
    const call = async args =>
      JSON.parse(
        (await client.callTool({name: 'amcp_workspace', arguments: args})).content.find(c => c.type === 'text').text,
      );
    const page = await call({action: 'operations', kind: 'workbook_report'});
    assert.equal(page.success, true, JSON.stringify(page));
    assert.equal(page.data.operations[0].id, run);
    const out = await call({action: 'report_run', id: run});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.account_id, '100');
    assert.equal(out.data.connection_id, connections[gateway]);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-BODY-MARKER|payload|body/);
    store.revokeKey(token);
    await assert.rejects(() => call({action: 'report_run', id: run}));
    assert.equal(egress, 0);
  } finally {
    await client.close();
    await new Promise(resolve => listener.close(resolve));
    store.close();
  }
});

test('encoded scope occurrence limits and credential-key redaction remain bounded and match ordinary JSON protections', () => {
  const store = fixture();
  try {
    const g = 'x_ads_native_action',
      eight = '{' + Array(8).fill('"account_id":"100"').join(',') + '}',
      nine = '{' + Array(9).fill('"account_id":"100"').join(',') + '}';
    assert.equal(reportingConfigScope(store, actor, config(g, eight)).account_id, '100');
    assert.throws(
      () => reportingConfigScope(store, actor, config(g, nine)),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
    for (const key of ['authorization', 'private_key', 'storage_password', 'client_secret', 'api_key', 'cookie']) {
      const c = config(g, JSON.stringify({account_id: '100', request: {[key]: 'private-key-marker'}}));
      assert.throws(() => validateReportingConfig(store, actor, c), /credential/i);
      assert.doesNotMatch(JSON.stringify(redactReportingConfig(c)), /private-key-marker/);
      assert.match(JSON.stringify(redactReportingConfig(c)), /REDACTED/);
      const ordinary = config(g, {account_id: '100', request: {[key]: 'private-key-marker'}});
      assert.doesNotMatch(JSON.stringify(redactReportingConfig(ordinary)), /private-key-marker/);
    }
  } finally {
    store.close();
  }
});

test('a refused encoded credential input does not survive the service error audit', async () => {
  const store = fixture();
  try {
    const gateway = 'linkedin_native_action',
      book = '44444444-4444-4444-8444-444444444444';
    store.putDocument(actor.tenantId, 'workbook', book, {spreadsheet_id: 'synthetic-book', created_by: actor.userId});
    const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(async () => {
        throw Error('No native egress');
      }),
    );
    const cfg = config(gateway, '{"account_id":"100","authorization":"REFUSED-CREDENTIAL-MARKER"}');
    const out = await service.call(
      'amcp_native_action',
      {
        operation: 'create_reporting_query',
        arguments: {workbook_binding_id: book, name: 'Refused query', query_config: cfg, dry_run: false},
      },
      actor,
    );
    assert.equal(out.success, false, JSON.stringify(out));
    assert.doesNotMatch(JSON.stringify(store.audit(actor.tenantId)), /REFUSED-CREDENTIAL-MARKER/);
    assert.doesNotMatch(JSON.stringify(out), /REFUSED-CREDENTIAL-MARKER/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='reporting_query'").get().n, 0);
  } finally {
    store.close();
  }
});

test('a legacy queued report containing encoded credentials fails before collection and cannot prepare a fresh copy', async () => {
  const store = fixture();
  try {
    const cfg = config('x_ads_native_action', '{"account_id":"100","authorization":"QUEUED-CREDENTIAL-MARKER"}'),
      token = store.createKey(actor),
      as = store.authenticate(token),
      id = store.enqueueReport(as, {query_config: cfg});
    let collected = 0;
    const worker = new ReportWorker(store, async () => {
      collected++;
      return {rows: []};
    });
    assert.equal(await worker.once(), true);
    const job = store.job(actor.tenantId, id);
    assert.equal(job.state, 'failed');
    assert.equal(collected, 0);
    assert.doesNotMatch(JSON.stringify(job.error), /QUEUED-CREDENTIAL-MARKER/);
    assert.match(job.error.message, /credential/i);
    const query = '66666666-6666-4666-8666-666666666666';
    store.putDocument(actor.tenantId, 'reporting_query', query, {query_config: cfg});
    assert.throws(() => new ReportingService(store).prepareRun(as, query), /credential/i);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  } finally {
    store.close();
  }
});
