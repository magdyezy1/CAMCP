import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {DelegatedNativeCompiler} from '../dist/src/delegated-native.js';
import {reportingConfigScope, reportQueryPage} from '../dist/src/report-query-access.js';
import {reportRunStatus, resumeReportRun} from '../dist/src/report-runs.js';
import {operationsPage} from '../dist/src/operations-feed.js';
import {ReportingService} from '../dist/src/reporting.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const gateway = 'reddit_native_action',
  connection = '11111111-1111-4111-8111-111111111119';
const config = selector => ({
  gateway,
  arguments: {
    operation: 'reddit_account_ops',
    arguments: {
      action: 'GET_AD_ACCOUNT',
      connection_id: connection,
      ...selector,
    },
  },
});
function fixture(t) {
  const store = new Store(':memory:', Buffer.alloc(32, 91).toString('base64'));
  const key = store.createKey({tenantId: 'synthetic-reddit-recovery', userId: 'operator', role: 'operator'});
  const actor = store.authenticate(key);
  store.putConnection(
    {...actor, role: 'admin'},
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway,
      accounts: ['t2_allowed'],
      writeAccounts: [],
      enabled: true,
      label: 'Synthetic read-only Reddit',
      scopes: ['adsread'],
    },
    {accessToken: 'synthetic'},
  );
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider requests in retained-scope inspection');
    }),
    undefined,
    {allowWrites: false},
  );
  t.after(() => store.close());
  return {store, actor, key, service, requests: () => requests};
}
test('Reddit exact path selectors recover the same account as native compilation without reading full records', t => {
  const f = fixture(t),
    compiler = new DelegatedNativeCompiler();
  for (const selector of [
    {ad_account_id: 't2_allowed'},
    {params: {ad_account_id: 't2_allowed'}},
    {path_params: {ad_account_id: 't2_allowed'}},
    {params: {'Ad-Account-ID': 't2_allowed'}},
  ]) {
    const c = config(selector),
      original = JSON.stringify(c),
      plan = compiler.compile(gateway, c.arguments);
    assert.equal(plan.accountId, 't2_allowed');
    assert.equal(plan.path, '/api/v3/ad_accounts/t2_allowed');
    assert.deepEqual(reportingConfigScope(f.store, f.actor, c), {
      gateway,
      account_id: 't2_allowed',
      connection_id: connection,
    });
    const id = f.store.enqueueReport(
      f.actor,
      {query_config: c, private_note: 'DO-NOT-PROJECT-SOURCE'},
      Number.MAX_SAFE_INTEGER,
    );
    f.store.job = f.store.documents = () => {
      throw Error('Full metadata reads are forbidden');
    };
    const status = reportRunStatus(f.store, f.actor, id);
    assert.equal(status.account_id, plan.accountId);
    assert.doesNotMatch(JSON.stringify(status), /DO-NOT-PROJECT|path_params|Ad-Account-ID/);
    assert.equal(JSON.stringify(c), original);
  }
  assert.equal(f.requests(), 0);
});
test('conflicting, foreign, malformed, hidden and oversized Reddit selectors refuse retained results and recovery', t => {
  const f = fixture(t),
    reporting = new ReportingService(f.store);
  for (const selector of [
    {account_id: 't2_allowed', ad_account_id: 't2_foreign'},
    {account_id: 't2_allowed', params: {'Ad-Account-ID': 't2_foreign'}},
    {ad_account_id: 't2_foreign'},
    {ad_account_id: ['t2_allowed']},
    {ad_account_id: 't2_allowed/../foreign'},
    {account_id: 't2_allowed', path_params: {ad_account_id: null}},
    {path: '/api/v3/ad_accounts/t2_allowed'},
    {campaign_id: 't2_allowed'},
    {ad_account_id: 't2_allowed', private_note: 'x'.repeat(65536)},
  ]) {
    const c = config(selector),
      id = f.store.enqueueReport(f.actor, {query_config: c}),
      lease = f.store.leaseJob();
    f.store.finishJob(id, lease.lease_token, {marker: 'PRIVATE-RETAINED-RESULT'});
    const original = f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id);
    for (const read of [
      () => reportRunStatus(f.store, f.actor, id),
      () => reporting.handle('get_reporting_run', {run_id: id}, f.actor),
      () => resumeReportRun(f.store, f.actor, {id, confirmed: true, run_version: 'unqualified'}),
    ])
      assert.throws(read, e => ['REPORT_SCOPE_UNAVAILABLE', 'CONNECTION_REQUIRED'].includes(e.code));
    assert.deepEqual(f.store.db.prepare('SELECT input,result,state FROM jobs WHERE id=?').get(id), original);
  }
  assert.equal(operationsPage(f.store, f.actor, {kind: 'workbook_report'}, false).operations.length, 0);
  assert.equal(f.requests(), 0);
});
test('duplicate JSON selectors cannot conceal another account from the SQLite metadata projection', t => {
  const f = fixture(t),
    id = f.store.enqueueReport(f.actor, {query_config: config({ad_account_id: 't2_allowed'})});
  const input = f.store.db.prepare('SELECT input FROM jobs WHERE id=?').get(id).input;
  for (const extra of ['"ad_account_id":"t2_foreign"', '"Ad-Account-ID":"t2_foreign"']) {
    const duplicate = input.replace('"ad_account_id":"t2_allowed"', '"ad_account_id":"t2_allowed",' + extra);
    f.store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(duplicate, id);
    assert.throws(
      () => reportRunStatus(f.store, f.actor, id),
      e => e.code === 'REPORT_SCOPE_UNAVAILABLE',
    );
  }
  assert.equal(f.requests(), 0);
});
test('real SDK discovery hands off to the original Reddit run and immediately refuses revoked access', async t => {
  const f = fixture(t),
    c = config({path_params: {ad_account_id: 't2_allowed'}});
  f.store.putDocument(f.actor.tenantId, 'reporting_query', 'synthetic-query', {
    name: 'Synthetic Reddit',
    query_config: c,
  });
  const id = f.store.enqueueReport(f.actor, {query_config: c}, Number.MAX_SAFE_INTEGER);
  const server = createMcpServer(f.service, f.actor);
  const client = new Client({name: 'retained-recovery-evaluation', version: '1.0.0'});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const inspect = async args => {
    const response = await client.callTool({name: 'amcp_workspace', arguments: args});
    const body = JSON.parse(response.content.find(c => c.type === 'text').text);
    assert.deepEqual(response.structuredContent, body);
    return body;
  };
  const feed = await inspect({action: 'operations', kind: 'workbook_report'});
  assert.equal(feed.success, true);
  assert.equal(feed.data.operations[0].id, id);
  assert.equal(feed.data.operations[0].next_call.arguments.id, id);
  const status = await inspect({action: 'report_run', id});
  assert.equal(status.success, true);
  assert.equal(status.data.run_id, id);
  assert.equal(reportQueryPage(f.store, f.actor, {}).queries[0].id, 'synthetic-query');
  f.store.revokeKey(f.key);
  assert.equal((await inspect({action: 'report_run', id})).success, false);
  assert.equal(f.requests(), 0);
});
