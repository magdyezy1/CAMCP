// V2-MCP-01: report and export next steps, with explicit retry approval and synthetic jobs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {overviewPollAfterMs} from '../dist/src/reporting-overview.js';
import {outcomeSchema} from '../dist/src/workflow-outcomes.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';

const tool = 'amcp_reporting_overview';
async function fixture(t) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const call = args => f.service.call(tool, args, f.actor);
  const run = await call({action: 'run', config: granularConfig(granularSource('meta')), confirmed: true});
  assert.equal(run.success, true, JSON.stringify(run.error));
  const report = run.data.id,
    exportId = 'synthetic-next-export',
    destination = 'synthetic-file-destination';
  const job = f.store.enqueue(f.actor.tenantId, 'report_file_export', {
    report_id: report,
    export_id: exportId,
    destination_id: destination,
  });
  f.store.putDocument(f.actor.tenantId, 'overview_export', exportId, {
    report_id: report,
    job_id: job,
    destination_id: destination,
    state: 'queued',
    created_at: Date.now(),
  });
  const setState = (state, error = null) =>
    f.store
      .sql()
      .prepare('UPDATE jobs SET state=?,error=? WHERE tenant_id=? AND id=?')
      .run(state, JSON.stringify(error), f.actor.tenantId, job);
  return {...f, call, run, report, exportId, job, setState};
}
const assertNext = (out, action, id, extra = {}) => {
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(out.data.next_call, {tool, arguments: {action, id, ...extra}});
  assert.deepEqual(out.meta.workflow.next_call, out.data.next_call);
  assert.equal(out.data.poll_after_ms, 5000);
  assert.equal(out.meta.workflow.poll_after_ms, 5000);
  assert.equal(new Ajv({strict: false}).compile(outcomeSchema)(out.meta.workflow), true);
};

test('a queued run hands off to one row of the report, with the published polling interval', async t => {
  const f = await fixture(t);
  assert.equal(overviewPollAfterMs, 5000);
  assertNext(f.run, 'get', f.report, {limit: 1});
  assert.equal(f.requests.length, 0);
});
for (const state of ['queued', 'running'])
  test('a ' + state + ' export offers export_status and polling', async t => {
    const f = await fixture(t);
    f.setState(state);
    assertNext(await f.call({action: 'export_status', id: f.exportId}), 'export_status', f.exportId);
  });
test('a retryable failed export offers retry only with a separate user-approval acknowledgement', async t => {
  const f = await fixture(t);
  f.setState('failed', {code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic outage', retryable: true});
  const out = await f.call({action: 'export_status', id: f.exportId});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.retry_available, true);
  assert.deepEqual(out.data.next_call, {
    tool,
    arguments: {action: 'retry', id: f.job},
    add_after_user_approval: {confirmed: true},
  });
  assert.equal(out.data.next_call.arguments.confirmed, undefined);
  assert.equal(out.data.poll_after_ms, undefined);
});
test('retry names the original export and polls that export after requeueing the same job', async t => {
  const f = await fixture(t);
  f.setState('failed', {code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic outage', retryable: true});
  const out = await f.call({action: 'retry', id: f.job, confirmed: true});
  assert.equal(out.data.export_id, f.exportId);
  assert.equal(out.data.id, f.job);
  assertNext(out, 'export_status', f.exportId);
  assert.equal(f.store.job(f.actor.tenantId, f.job).state, 'queued');
});
test('a completed export offers no next call or polling interval', async t => {
  const f = await fixture(t);
  f.setState('complete');
  const out = await f.call({action: 'export_status', id: f.exportId});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.next_call, undefined);
  assert.equal(out.meta.workflow.next_call, undefined);
  assert.equal(out.data.poll_after_ms, undefined);
});

test('an export requiring release offers no automatic retry call', async t => {
  const f = await fixture(t);
  f.store
    .sql()
    .prepare('UPDATE jobs SET kind=? WHERE tenant_id=? AND id=?')
    .run('sheets_export', f.actor.tenantId, f.job);
  f.setState('failed', {
    code: 'SHEETS_MARKER_MISMATCH',
    message: 'Synthetic marker mismatch',
    details: {release_available: true},
  });
  const out = await f.call({action: 'export_status', id: f.exportId});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.release_required, true);
  assert.equal(out.data.retry_available, false);
  assert.equal(out.data.next_call, undefined);
  assert.equal(out.meta.workflow.next_call, undefined);
});

test('a real SDK client validates queued run and export results with poll_after_ms', async t => {
  const f = await fixture(t),
    server = createMcpServer(f.service, f.actor),
    client = new Client({name: 'synthetic-next-calls', version: '1'}),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const run = (
      await client.callTool({
        name: tool,
        arguments: {action: 'run', config: granularConfig(granularSource('meta')), confirmed: true},
      })
    ).structuredContent;
    assertNext(run, 'get', run.data.id, {limit: 1});
    const exported = (await client.callTool({name: tool, arguments: {action: 'export_status', id: f.exportId}}))
      .structuredContent;
    assertNext(exported, 'export_status', f.exportId);
  } finally {
    await client.close();
    await server.close();
  }
});
