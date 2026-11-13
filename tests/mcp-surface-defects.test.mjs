// V2-MCP-06, the two contract defects of mcp-typed's report (section 8), fixed for every client: they are fixes, not new
// defaults, so nothing here depends on a client's contract profile.
//
//  1. monitor_notifications, set_monitor_notifications, retry_monitor_notification and save_monitor answered INTERNAL_ERROR
//     ("The request failed") when `id`, `monitor` or `notification_id` was missing, because the lookup received undefined.
//     They answer INVALID_ARGUMENT naming the field.
//  2. `get` of a failed overview snapshot offered no next step, and `get` of a queued or running one carried neither a
//     next_call nor poll_after_ms in meta.workflow. A running snapshot names the get to poll with and the interval; a failed
//     one names the step its error names: a retry (to be approved) where a retry can end the failure, else the step the
//     error itself words (reconnect, correct the request, or why nothing helps). All additive, and only in meta.workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {MirrorError} from '../dist/src/errors.js';
import {outcomeSchema} from '../dist/src/workflow-outcomes.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {assertRefused} from './helpers/assert-refused.mjs';
import {connectClient} from './helpers/mcp-long-run-stacks.mjs';

const workspace = 'amcp_workspace',
  overview = 'amcp_reporting_overview',
  eras = ['legacy', 'modern'];
const validWorkflow = new Ajv({strict: false}).compile(outcomeSchema);

/** The report engine over the real HTTP stack: its service, a key for its actor, and a client of either era. */
async function served(t, options) {
  const e = reportEngine(t, options),
    listener = await listenForFetch(
      createHttpApp(e.service, e.store, {mcpModernProtocol: 'on', mcpLimits: {perMinute: 0}}),
    );
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const url = new URL('http://127.0.0.1:' + listener.address().port + '/mcp'),
    key = e.store.createKey(e.actor);
  return {...e, connect: era => connectClient(t, era, url, key)};
}
const call = (e, tool, args) => e.service.call(tool, args, e.actor);

// The four monitor actions and what each is missing. A refusal names the field it needs.
const missing = [
  [{action: 'monitor_notifications'}, 'id'],
  [{action: 'monitor_notifications', id: 42}, 'id'],
  [{action: 'set_monitor_notifications', confirmed: true, enabled: true, subscription_version: 'x'}, 'id'],
  [{action: 'retry_monitor_notification', confirmed: true, notification_version: 'x'}, 'notification_id'],
  [{action: 'retry_monitor_notification', notification_id: ['a']}, 'notification_id'],
  [{action: 'save_monitor', confirmed: true}, 'monitor'],
  [{action: 'save_monitor', confirmed: true, monitor: 'cpa above 50'}, 'monitor'],
  [{action: 'save_monitor', confirmed: true, monitor: ['cpa']}, 'monitor'],
];

test('a monitor action without its id, notification_id or monitor is INVALID_ARGUMENT naming the field, not INTERNAL_ERROR', async t => {
  const e = reportEngine(t);
  for (const [args, field] of missing) {
    const out = await call(e, workspace, args);
    assertRefused(out, 'INVALID_ARGUMENT', {message: new RegExp('\\b' + field + '\\b')});
    assert.equal(out.error.retryable, false);
  }
  // Nothing was saved or sent by a refused call.
  assert.equal(e.store.documents(e.actor.tenantId, 'report_monitor').length, 0);
  assert.equal(e.store.documents(e.actor.tenantId, 'monitor_subscription').length, 0);
});

test('the same refusals reach a client in both protocol eras over the real HTTP stack', async t => {
  const e = await served(t);
  for (const era of eras) {
    const client = await e.connect(era);
    for (const [args, field] of missing) {
      const result = await client.callTool({name: workspace, arguments: args}),
        envelope = result.structuredContent;
      assert.equal(result.isError, true, era + ' ' + JSON.stringify(args));
      assertRefused(envelope, 'INVALID_ARGUMENT', {message: new RegExp('\\b' + field + '\\b')});
    }
  }
});

test('a monitor action that has what it needs still answers as before', async t => {
  const e = reportEngine(t);
  // An unknown monitor is still a missing record, not an invalid argument.
  assertRefused(await call(e, workspace, {action: 'monitor', id: 'no-such-monitor'}), 'NOT_FOUND');
  assertRefused(await call(e, workspace, {action: 'monitor_notifications', id: 'no-such-monitor'}), 'NOT_FOUND');
  assertRefused(
    await call(e, workspace, {
      action: 'retry_monitor_notification',
      notification_id: 'no-such-notice',
      confirmed: true,
    }),
    'NOT_FOUND',
  );
});

/** A report whose only source fails with `error`, run once through the worker: its queued id, then the snapshot. */
async function failedSnapshot(t, error) {
  const e = reportEngine(t, {rowsFor: () => [], fail: () => error});
  const queued = await e.queue(['campaign']);
  await e.worker.once();
  return {e, queued, read: () => call(e, overview, {action: 'get', id: queued.id, limit: 1})};
}

test('get of a queued snapshot names the get to poll with and the interval, and only in meta.workflow', async t => {
  const e = reportEngine(t, {rowsFor: () => []});
  const queued = await e.queue(['campaign']),
    out = await call(e, overview, {action: 'get', id: queued.id, limit: 1});
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.state, 'queued');
  assert.equal(out.meta.workflow.state, 'running');
  assert.deepEqual(out.meta.workflow.next_call, {tool: overview, arguments: {action: 'get', id: queued.id, limit: 1}});
  assert.equal(out.meta.workflow.poll_after_ms, 5000);
  assert.equal(validWorkflow(out.meta.workflow), true, JSON.stringify(validWorkflow.errors));
  // The snapshot itself is exactly what it was.
  for (const field of ['next_call', 'poll_after_ms', 'next_action']) assert.equal(out.data[field], undefined, field);
  // The call it names is one the queued run's own answer already names, so a client polls with the same call throughout.
  assert.deepEqual(out.meta.workflow.next_call, queued.next_call);
  assert.equal(out.meta.workflow.poll_after_ms, queued.poll_after_ms);
});

test('get of a running snapshot names the same poll, and a finished one names none', async t => {
  const e = reportEngine(t, {rowsFor: () => []});
  const queued = await e.queue(['campaign']);
  e.store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(queued.job_id);
  e.store.putDocument(e.actor.tenantId, 'overview_report', queued.id, {...e.stored(queued.id), state: 'running'});
  const running = await call(e, overview, {action: 'get', id: queued.id, limit: 1});
  assert.equal(running.data.state, 'running');
  assert.deepEqual(running.meta.workflow.next_call.arguments, {action: 'get', id: queued.id, limit: 1});
  assert.equal(running.meta.workflow.poll_after_ms, 5000);
  e.store.putDocument(e.actor.tenantId, 'overview_report', queued.id, {...e.stored(queued.id), state: 'queued'});
  e.store.db.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(queued.job_id);
  await e.worker.once();
  const done = await call(e, overview, {action: 'get', id: queued.id, limit: 1});
  assert.equal(done.data.state, 'complete');
  assert.equal(done.meta.workflow.state, 'complete');
  for (const field of ['next_call', 'poll_after_ms', 'next_action'])
    assert.equal(done.meta.workflow[field], undefined, field);
});

// Each failure of a source carries the category and the sentence the server wrote for it (src/report-errors.ts). The step a
// client is offered follows them as the website's source card does: retry where the platform's own failure may pass,
// otherwise the error's own words.
const failures = [
  {
    name: 'a permission the platform refused',
    error: new MirrorError('PLATFORM_PERMISSION_DENIED', 'Synthetic permissions error', {}, 403, false),
    category: 'permission',
    retry: false,
  },
  {
    name: 'a login that needs reconnecting',
    error: new MirrorError('AUTH_EXPIRED', 'Synthetic expired login', {}, 401, false),
    category: 'connection',
    retry: false,
  },
  {
    name: 'a request AMCP refused to widen',
    error: new MirrorError('REPORT_COLLECTION_LIMIT', 'Synthetic limit', {}, 400, false),
    category: 'request',
    retry: false,
  },
  {
    name: 'a failure on the platform’s side',
    error: new MirrorError('UPSTREAM_ERROR', 'Synthetic outage', {}, 502, false),
    category: 'provider',
    retry: true,
  },
];
for (const {name, error, category, retry} of failures)
  test('get of a snapshot that failed on ' + name + ' offers the step its error names', async t => {
    const f = await failedSnapshot(t, error),
      out = await f.read(),
      source = out.data.sources[0].error;
    assert.equal(out.data.state, 'failed');
    assert.equal(source.category, category);
    assert.equal(out.data.job.retry_available, true);
    const flow = out.meta.workflow;
    assert.equal(flow.state, 'attention_required');
    assert.equal(validWorkflow(flow), true, JSON.stringify(validWorkflow.errors));
    // The step in the error's own words is always there, and is the one the source's diagnostic wrote.
    assert.equal(typeof source.next_action, 'string');
    assert.equal(flow.next_action, source.next_action);
    if (retry) {
      // A retry is offered as the export's is: the job's own, named, and left for the person to approve.
      assert.deepEqual(flow.next_call, {
        tool: overview,
        arguments: {action: 'retry', id: out.data.job_id},
        add_after_user_approval: {confirmed: true},
      });
      assert.equal(flow.next_call.arguments.confirmed, undefined);
    } else assert.equal(flow.next_call, undefined);
    assert.equal(flow.poll_after_ms, undefined);
    for (const field of ['next_call', 'poll_after_ms', 'next_action']) assert.equal(out.data[field], undefined, field);
  });

test('the offered retry is the retry the job accepts, and a snapshot that cannot be retried is offered none', async t => {
  const f = await failedSnapshot(t, new MirrorError('UPSTREAM_ERROR', 'Synthetic outage', {}, 502, false)),
    out = await f.read(),
    next = out.meta.workflow.next_call;
  f.e.overview.native.collect = async (source, dates) => ({
    source,
    rows: [],
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    collection_complete: true,
    source_kind: 'ads',
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'Synthetic results',
    attribution: 'Synthetic click window',
    quality: {version: 2, status: 'complete'},
  });
  const retried = await call(f.e, overview, {...next.arguments, ...next.add_after_user_approval});
  assert.equal(retried.success, true, JSON.stringify(retried.error));
  assert.equal(retried.data.state, 'queued');
  await f.e.worker.once();
  assert.equal((await f.read()).data.state, 'complete');
  // A failure that repeats on every retry (the job says so) has no retry to offer, and says why in its own words.
  const again = await failedSnapshot(t, new MirrorError('UPSTREAM_ERROR', 'Synthetic outage', {}, 502, false)),
    snapshot = await again.read();
  again.e.store.db
    .prepare('UPDATE jobs SET error=? WHERE id=?')
    .run(JSON.stringify({code: 'REPORT_DEFINITION_CHANGED', message: 'The report was changed.'}), snapshot.data.job_id);
  const fixed = await again.read();
  assert.equal(fixed.data.job.retry_available, false);
  assert.equal(fixed.meta.workflow.next_call, undefined);
  assert.equal(typeof fixed.meta.workflow.next_action, 'string');
});

for (const era of eras)
  test(
    era +
      ' HTTP: a client reads the poll and the step of a snapshot in meta.workflow, validated against the listed schema',
    async t => {
      const e = await served(t, {
        rowsFor: () => [],
        fail: () => new MirrorError('UPSTREAM_ERROR', 'Synthetic outage', {}, 502, false),
      });
      const queued = await e.queue(['campaign']),
        client = await e.connect(era),
        read = async () =>
          (await client.callTool({name: overview, arguments: {action: 'get', id: queued.id, limit: 1}}))
            .structuredContent;
      const waiting = await read();
      assert.deepEqual(waiting.meta.workflow.next_call.arguments, {action: 'get', id: queued.id, limit: 1});
      assert.equal(waiting.meta.workflow.poll_after_ms, 5000);
      await e.worker.once();
      const failed = await read();
      assert.equal(failed.data.state, 'failed');
      assert.equal(failed.meta.workflow.next_call.arguments.action, 'retry');
      assert.equal(typeof failed.meta.workflow.next_action, 'string');
    },
  );
