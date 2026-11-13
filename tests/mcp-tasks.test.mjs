// V2-MCP-02 (decision 6): the tasks extension of MCP revision 2026-07-28, built by hand on the SDK's request handlers. A
// client that declares capabilities.extensions["io.modelcontextprotocol/tasks"] in a request is answered a task, not a
// polling handle, for the two long runs (an export, and run_background); it follows the task with tasks/get, may cancel
// an export with tasks/cancel, and is refused tasks/update, because AMCP never asks for input in a task. Every other
// client, and every other revision, is polled exactly as before. A task belongs to the person, the AI client and the
// workspace it was made for: an identifier that is unknown, foreign, expired or altered is answered with one error and
// nothing else (Probe 14).
// The stock SDK client does not decode a result of type "task", so the wire is driven as raw JSON-RPC over the real HTTP
// stack (and over the real stdio transport framing); the SDK client is used where the answer is an ordinary result.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {StdioServerTransport, serveStdio} from '@modelcontextprotocol/server/stdio';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createMcpServer} from '../dist/server/mcp.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {removeTestDirectory} from '../dist/tests/temp.js';
import {saveAccessSet} from '../dist/src/access-sets.js';
import {reportPlatforms} from '../dist/src/report-metrics.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {campaignStack, campaignTool, exportStack, overviewTool, rows, until} from './helpers/mcp-long-run-stacks.mjs';

offerParkedProviders('criteo', 'woocommerce');
// The task module is read lazily so that the tests fail on behaviour, not on a missing import, before it exists.
const tasks = await import('../dist/server/mcp-tasks.js').catch(() => ({taskLimits: {}}));
const extension = 'io.modelcontextprotocol/tasks',
  declared = {extensions: {[extension]: {}}},
  day = 86400000;
let sequence = 0;

/** One modern JSON-RPC request over the real HTTP stack, as a client that declares `caps` (the extension, by default). */
async function modern(f, method, params = {}, {caps = declared, key = f.key, headers = {}} = {}) {
  const name = params.name ?? params.taskId,
    body = {
      jsonrpc: '2.0',
      id: ++sequence,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': caps,
          'io.modelcontextprotocol/clientInfo': {name: 'Synthetic task client', version: '1'},
        },
      },
    },
    response = await fetch(f.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + key,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name ? {'mcp-name': name} : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return {status: response.status, body: JSON.parse(await response.text())};
}
const fail = (response, code) => {
  assert.equal(response.body.error?.code, code, JSON.stringify(response.body));
  return response.body.error;
};
/** The export of the stack's report, as a client that declares the extension: the task it is answered. */
async function exportTask(f, options) {
  const created = await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs}, options);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.result.resultType, 'task', JSON.stringify(created.body));
  return created.body.result.task;
}
const taskDocuments = f => f.store.repo('mcp_task', f.actor.tenantId).list();

test('a client that declares the extension is answered a task for an export, durable before the answer, and follows it to its end', async t => {
  const f = await exportStack(t),
    created = await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs});
  assert.equal(created.status, 200);
  const result = created.body.result,
    task = result.task;
  assert.equal(result.resultType, 'task');
  assert.match(task.taskId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(task.status, 'working');
  assert.equal(task.ttlMs, day, 'the time the task is kept is stated');
  assert.equal(task.pollIntervalMs, 5000, 'the interval is the published poll_after_ms');
  assert.equal(new Date(task.createdAt).toISOString(), task.createdAt);
  assert.equal(new Date(task.lastUpdatedAt).toISOString(), task.lastUpdatedAt);
  // The task is a document of the workspace before the answer left, and it follows the job a polling client would follow.
  const stored = f.store.repo('mcp_task', f.actor.tenantId).find(task.taskId);
  assert.ok(stored, 'durable before the response');
  assert.equal(stored.job_id, f.jobId());
  assert.equal(stored.expires_at - stored.created_at, day);
  // The same call, repeated, is the same task: one task per person and job.
  assert.equal((await exportTask(f)).taskId, task.taskId);
  assert.equal(taskDocuments(f).length, 1);

  const get = async () => (await modern(f, 'tasks/get', {taskId: task.taskId})).body.result;
  let seen = await get();
  assert.equal(seen.resultType, 'complete');
  assert.equal(seen.taskId, task.taskId);
  assert.equal(seen.status, 'working');
  assert.equal(seen.statusMessage, 'queued');
  assert.equal(seen.ttlMs, day);
  assert.equal(seen.pollIntervalMs, 5000);
  assert.equal(seen.result, undefined);
  f.setJob('running');
  seen = await get();
  assert.equal(seen.status, 'working');
  assert.equal(seen.statusMessage, 'running');
  f.setJob('complete');
  seen = await get();
  assert.equal(seen.status, 'completed');
  // The result is what the call a polling client would make shows for the finished export, as a tool result.
  assert.equal(seen.result.structuredContent.success, true);
  assert.equal(seen.result.structuredContent.data.state, 'complete');
  assert.equal(seen.result.content[0].text, JSON.stringify(seen.result.structuredContent));
  assert.equal(seen.error, undefined);
});

test('a failed job is a failed task with its error, and a cancelled job a cancelled task', async t => {
  const f = await exportStack(t),
    task = await exportTask(f),
    get = async () => (await modern(f, 'tasks/get', {taskId: task.taskId})).body.result;
  f.setJob('failed', {code: 'UPSTREAM_UNAVAILABLE', message: 'Synthetic outage', retryable: true});
  const failed = await get();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'Synthetic outage');
  assert.equal(failed.error.data.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(typeof failed.error.code, 'number');
  assert.equal(failed.result, undefined);
  f.setJob('cancelled');
  assert.equal((await get()).status, 'cancelled');
});

test('a client that does not declare the extension is polled exactly as before, in both revisions', async t => {
  const f = await exportStack(t);
  // The 2026-07-28 revision without the extension, and with an extension that is not this one: the ordinary answer.
  for (const caps of [{}, {extensions: {'io.modelcontextprotocol/other': {}}}, {tools: {}}]) {
    const answer = await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs}, {caps});
    assert.equal(answer.body.result.resultType, 'complete', JSON.stringify(caps));
    assert.equal(answer.body.result.task, undefined);
    assert.equal(answer.body.result.structuredContent.success, true);
    assert.equal(answer.body.result.structuredContent.data.state, 'queued');
    assert.equal(answer.body.result.structuredContent.data.job_id, f.jobId());
  }
  assert.equal(taskDocuments(f).length, 0, 'nothing was made for them');
  // Polling is untouched beside the new path.
  const id = (await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs}, {caps: {}})).body.result
    .structuredContent.data.id;
  const polled = (
    await modern(f, 'tools/call', {name: overviewTool, arguments: {action: 'export_status', id}}, {caps: {}})
  ).body.result.structuredContent;
  assert.equal(polled.data.state, 'queued');
  assert.equal(polled.data.poll_after_ms, 5000);
  assert.deepEqual(polled.data.next_call, {tool: overviewTool, arguments: {action: 'export_status', id}});
  // A real SDK client of either revision gets the ordinary result.
  for (const era of ['legacy', 'modern']) {
    const client = await f.connect(era),
      out = (await client.callTool({name: overviewTool, arguments: f.exportArgs})).structuredContent;
    assert.equal(out.success, true, era);
    assert.equal(out.data.state, 'queued', era);
  }
  assert.equal(taskDocuments(f).length, 0);
  // The extension is declared to a client that asks, in the 2026-07-28 revision only.
  const discover = await modern(f, 'server/discover', {}, {caps: {}});
  assert.deepEqual(discover.body.result.capabilities.extensions, {[extension]: {}});
  const initialized = await fetch(f.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + f.key,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: {name: 'Synthetic legacy client', version: '1'},
      },
    }),
  });
  const legacy = JSON.parse((await initialized.text()).replace(/^[\s\S]*?data: /, '').trim() || '{}');
  assert.equal(legacy.result.capabilities.extensions, undefined, 'the earlier revisions are not told of it');
});

test('tasks/* is not served to a client that did not declare the extension, nor in the earlier revisions', async t => {
  const f = await exportStack(t),
    task = await exportTask(f);
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    const refused = fail(await modern(f, method, {taskId: task.taskId}, {caps: {}}), -32021);
    assert.deepEqual(refused.data.requiredCapabilities, {extensions: {[extension]: {}}}, method);
  }
  assert.equal(f.jobState(), 'queued', 'a refused cancel cancelled nothing');
  // The earlier revisions have no tasks/get: the method does not exist there, as before.
  const legacy = await fetch(f.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + f.key,
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tasks/get', params: {taskId: task.taskId}}),
  });
  const answer = JSON.parse((await legacy.text()).replace(/^[\s\S]*?data: /, ''));
  assert.equal(answer.error.code, -32601);
});

test('only the two long runs are tasks: a refused export, a finished export, a queued report and a write are answered as always', async t => {
  const f = await exportStack(t);
  const refused = await modern(f, 'tools/call', {
    name: overviewTool,
    arguments: {action: 'export', report_id: 'no-such-report', destination_id: 'x', confirmed: true},
  });
  assert.equal(refused.body.result.resultType, 'complete');
  assert.equal(refused.body.result.isError, true);
  assert.equal(refused.body.result.structuredContent.error.code, 'NOT_FOUND');
  // A report queued for collection is polled with get, as before: it is not one of the two.
  const run = await modern(f, 'tools/call', {
    name: overviewTool,
    arguments: {action: 'run', confirmed: true, config: f.definition(['campaign'])},
  });
  assert.equal(run.body.result.resultType, 'complete');
  assert.equal(run.body.result.structuredContent.data.state, 'queued');
  assert.equal(run.body.result.structuredContent.data.poll_after_ms, 5000);
  // An export that has already finished has nothing left to wait for: the ordinary answer, with its state.
  await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs}, {caps: {}});
  f.setJob('complete');
  const finished = await modern(f, 'tools/call', {name: overviewTool, arguments: f.exportArgs});
  assert.equal(finished.body.result.resultType, 'complete');
  assert.equal(finished.body.result.structuredContent.data.state, 'complete');
  assert.equal(taskDocuments(f).length, 0);
  // A write never runs as a task: the upload plan runs when asked, and answers when it has run.
  const g = await campaignStack(t);
  const ran = await modern(g, 'tools/call', {name: campaignTool, arguments: {action: 'run', id: g.id}});
  assert.equal(ran.body.result.resultType, 'complete');
  assert.equal(ran.body.result.task, undefined);
  assert.equal(ran.body.result.structuredContent.success, true, JSON.stringify(ran.body.result.structuredContent));
  assert.equal(g.uploads(), 2, 'it ran inside the call');
});

test('run_background is a task whose status follows the settled uploads, and the plan is cancelled by its own action', async t => {
  const f = await campaignStack(t),
    created = await modern(f, 'tools/call', {name: campaignTool, arguments: {action: 'run_background', id: f.id}});
  assert.equal(created.body.result.resultType, 'task', JSON.stringify(created.body));
  const task = created.body.result.task,
    get = async () => (await modern(f, 'tasks/get', {taskId: task.taskId})).body.result;
  assert.equal(task.status, 'working');
  assert.equal(task.ttlMs, day);
  assert.equal((await get()).statusMessage, 'queued: 0 of 2 uploads settled');
  const asked = f.requests.length;
  // Stopping the run is the plan's own cancel, which needs the person's confirmation; the task does not take it.
  const refused = fail(await modern(f, 'tasks/cancel', {taskId: task.taskId}), -32602);
  assert.match(refused.message, /cancel/i);
  assert.deepEqual(refused.data.next_call, {
    tool: campaignTool,
    arguments: {action: 'cancel', id: f.id},
    add_after_user_approval: {confirmed: true},
  });
  assert.equal(f.jobState(), 'queued');
  assert.equal(f.requests.length, asked, 'following and refusing a task asked no provider');
  // The worker runs the plan; the task is completed with the plan as get shows it.
  assert.equal(await f.worker.once(), true);
  const done = await get();
  assert.equal(done.status, 'completed');
  assert.equal(done.result.structuredContent.data.id, f.id);
  assert.equal(done.result.structuredContent.data.state, 'complete');
  assert.equal(done.result.structuredContent.data.background.state, 'complete');
  assert.equal(f.uploads(), 2);
});

test('an identifier that is unknown, altered, expired, another person’s or another workspace’s is answered with one error and nothing else (Probe 14)', async t => {
  const f = await exportStack(t),
    task = await exportTask(f),
    tenant = f.actor.tenantId,
    second = f.store.createKey({tenantId: tenant, userId: 'second-person', role: 'admin'}),
    elsewhere = f.store.createKey({tenantId: 'other-workspace', userId: 'owner', role: 'admin'});
  // A spy on every road to a provider: a task is read and answered from this workspace's own records.
  const providerCalls = [],
    transport = f.service.transport,
    request = transport.request.bind(transport);
  transport.request = (...args) => {
    providerCalls.push(args);
    return request(...args);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith(f.url.origin)) providerCalls.push(String(input));
    return realFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const altered = task.taskId.slice(0, -1) + (task.taskId.endsWith('A') ? 'B' : 'A'),
    stale = f.store
      .sql()
      .prepare("UPDATE documents SET data=json_set(data,'$.expires_at',?) WHERE kind='mcp_task' AND id=?"),
    cases = {
      unknown: [{taskId: 'a'.repeat(32)}, f.key],
      altered: [{taskId: altered}, f.key],
      long: [{taskId: 'a'.repeat(5000)}, f.key],
      'another person': [{taskId: task.taskId}, second],
      'another workspace': [{taskId: task.taskId}, elsewhere],
    };
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    const answers = {};
    for (const [name, [params, key]] of Object.entries(cases)) answers[name] = await modern(f, method, params, {key});
    const reference = answers.unknown;
    assert.equal(reference.body.error.code, -32602, method);
    assert.equal(reference.body.error.message, 'Unknown task.', method);
    for (const [name, answer] of Object.entries(answers))
      assert.deepEqual(
        [answer.status, answer.body.error],
        [reference.status, reference.body.error],
        method + ' ' + name,
      );
  }
  // Nothing happened to the task or its job: the cancels of the others cancelled nothing.
  assert.equal(f.jobState(), 'queued');
  assert.equal(taskDocuments(f).length, 1);
  // It is still the owner's.
  assert.equal((await modern(f, 'tasks/get', {taskId: task.taskId})).body.result.status, 'working');
  // Once expired it is as if it never was, though its document has not been swept yet.
  stale.run(Date.now() - 1, task.taskId);
  for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
    const reference = await modern(f, method, cases.unknown[0]),
      answer = await modern(f, method, {taskId: task.taskId});
    assert.equal(reference.body.error.message, 'Unknown task.', method);
    assert.deepEqual([answer.status, answer.body.error], [reference.status, reference.body.error], method + ' expired');
  }
  assert.equal(providerCalls.length, 0, 'no provider was asked: ' + JSON.stringify(providerCalls));
  assert.equal(f.jobState(), 'queued');
});

test('a task is bound to the person, the AI client and the workspace: the binding differs for each', () => {
  const actor = {tenantId: 'w', userId: 'oauth/client-a', ownerUserId: 'person', role: 'operator'};
  const same = tasks.taskBinding('task-id', {...actor, role: 'admin'});
  assert.equal(tasks.taskBinding('task-id', actor), same, 'a change of role does not change whose task it is');
  assert.equal(tasks.taskBinding('task-id', {...actor, accessSetId: undefined}), same);
  for (const other of [
    {...actor, userId: 'oauth/client-b'},
    {...actor, ownerUserId: 'another-person'},
    {...actor, tenantId: 'x'},
    {...actor, accessSetId: 'limited'},
  ])
    assert.notEqual(tasks.taskBinding('task-id', other), same, JSON.stringify(other));
  assert.notEqual(tasks.taskBinding('other-id', actor), same);
});

test('tasks/update always refuses: AMCP asks for no input in a task', async t => {
  const f = await exportStack(t),
    task = await exportTask(f),
    refused = fail(await modern(f, 'tasks/update', {taskId: task.taskId, inputResponses: {}}), -32602);
  assert.match(refused.message, /input/i);
  assert.notEqual(refused.message, 'Unknown task.');
  assert.equal(f.jobState(), 'queued');
  assert.equal((await modern(f, 'tasks/get', {taskId: task.taskId})).body.result.status, 'working');
});

test('tasks/cancel cancels an export with the rights a cancel needs today, and a finished task is not cancelled again', async t => {
  const f = await exportStack(t),
    task = await exportTask(f);
  // The rights are today's: a person who can no longer cancel a job cannot cancel it through its task.
  const hash = createHash('sha256').update(f.key).digest('hex');
  f.store.sql().prepare('UPDATE api_keys SET role=? WHERE hash=?').run('reader', hash);
  const denied = await modern(f, 'tasks/cancel', {taskId: task.taskId});
  assert.equal(denied.body.error.code, -32602, JSON.stringify(denied.body));
  assert.equal(denied.body.error.data.code, 'FORBIDDEN');
  assert.equal(f.jobState(), 'queued');
  assert.equal((await modern(f, 'tasks/get', {taskId: task.taskId})).body.result.status, 'working');
  f.store.sql().prepare('UPDATE api_keys SET role=? WHERE hash=?').run('admin', hash);
  const cancelled = await modern(f, 'tasks/cancel', {taskId: task.taskId});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.result.resultType, 'complete');
  assert.equal(f.jobState(), 'cancelled');
  assert.equal((await modern(f, 'tasks/get', {taskId: task.taskId})).body.result.status, 'cancelled');
  const again = fail(await modern(f, 'tasks/cancel', {taskId: task.taskId}), -32602);
  assert.match(again.message, /finished/i);
});

// P2A-03 (differential review, wave 5 round 2 part 2a): every read of a task is made again, as the caller and under the
// rights the caller has now, whatever the status. A task is bound to the access set by its id, not by its content, so a
// set that is narrowed keeps the binding valid; the rights are what is read again.
/** An AI client limited to a client access set that reaches the stack's one account, with a key of its own. */
function limitedClient(f) {
  const gateway = reportPlatforms.meta.gateway,
    bind = (connection_id, account_id) => [{gateway, connection_id, account_id}];
  // A second login with a second account: the set can later be narrowed to an account the report does not use.
  f.store.putConnection(
    f.actor,
    {
      id: 'other-login',
      tenantId: f.actor.tenantId,
      gateway,
      accounts: ['200'],
      enabled: true,
      scopes: [],
      label: 'Other',
    },
    {accessToken: 'synthetic'},
  );
  let set = saveAccessSet(f.store, f.actor, {name: 'Task client', bindings: bind('login', '100')});
  return {
    key: f.store.createKey({
      tenantId: f.actor.tenantId,
      userId: 'connector/task-client',
      role: 'operator',
      accessSetId: String(set.id),
    }),
    /** An administrator removes the report's account from the set and gives it another one (the same set id). */
    narrow() {
      set = saveAccessSet(f.store, f.actor, {
        id: set.id,
        revision: set.revision,
        name: set.name,
        bindings: bind('other-login', '200'),
      });
    },
  };
}
const outageText = 'Synthetic outage of destination Long-run files';

test('a completed task is read again under the rights of now: an access set that lost the report’s account turns it into a refusal, with no result (P2A-03)', async t => {
  const f = await exportStack(t),
    client = limitedClient(f),
    task = await exportTask(f, {key: client.key}),
    // The administrator’s own task for the same export, made while it is still running.
    own = await exportTask(f),
    get = async () => (await modern(f, 'tasks/get', {taskId: task.taskId}, {key: client.key})).body.result;
  f.setJob('complete');
  const seen = await get();
  assert.equal(seen.status, 'completed');
  assert.equal(seen.result.structuredContent.data.state, 'complete', 'the set reaches the account: the result is read');
  client.narrow();
  const refused = await get();
  assert.equal(refused.status, 'failed');
  assert.equal(refused.error.data.code, 'ACCOUNT_SCOPE_RESTRICTED');
  assert.equal(refused.result, undefined, 'no result of a report the caller may no longer read');
  assert.ok(!JSON.stringify(refused).includes('Spring sale'), 'no row of the report');
  // The person's own (administrator) key, whose rights did not change, still reads it: the refusal is the caller's.
  assert.equal((await modern(f, 'tasks/get', {taskId: own.taskId})).body.result.status, 'completed');
});

test('a task whose report was deleted is an unknown task, and a task of a deactivated actor is refused (P2A-03)', async t => {
  const f = await exportStack(t),
    task = await exportTask(f),
    get = () => modern(f, 'tasks/get', {taskId: task.taskId});
  f.setJob('complete');
  assert.equal((await get()).body.result.status, 'completed');
  // The key is revoked (the actor is deactivated): refused before any task is read, and no task data is answered.
  const hash = createHash('sha256').update(f.key).digest('hex');
  f.store.sql().prepare('UPDATE api_keys SET revoked=1 WHERE hash=?').run(hash);
  const refused = await get();
  assert.equal(refused.status, 401, JSON.stringify(refused.body));
  assert.equal(refused.body.result, undefined);
  assert.ok(!JSON.stringify(refused.body).includes(task.taskId) || refused.body.result === undefined);
  f.store.sql().prepare('UPDATE api_keys SET revoked=0 WHERE hash=?').run(hash);
  assert.equal((await get()).body.result.status, 'completed');
  // The report is deleted, with its jobs: nothing is left to report, and the task is as if it never was.
  const deleted = await f.overview.handle(
    {
      action: 'delete_report',
      id: f.reportId,
      confirmed: true,
      revision: f.store.document(f.actor.tenantId, 'overview_report', f.reportId).revision,
    },
    f.actor,
  );
  assert.deepEqual([deleted.id, deleted.deleted], [f.reportId, true], JSON.stringify(deleted));
  const gone = await get(),
    unknown = await modern(f, 'tasks/get', {taskId: 'a'.repeat(32)});
  assert.equal(gone.body.error.message, 'Unknown task.', JSON.stringify(gone.body));
  assert.deepEqual([gone.status, gone.body.error], [unknown.status, unknown.body.error]);
});

test('the status and the error of a task that is working, failed or cancelled are shown only to a caller who may still read its report (P2A-03)', async t => {
  const f = await exportStack(t),
    client = limitedClient(f),
    task = await exportTask(f, {key: client.key}),
    get = async () => (await modern(f, 'tasks/get', {taskId: task.taskId}, {key: client.key})).body.result;
  // The set reaches the account: the status is the job's, with its message and its error.
  const working = await get();
  assert.deepEqual([working.status, working.statusMessage], ['working', 'queued']);
  f.setJob('failed', {code: 'UPSTREAM_UNAVAILABLE', message: outageText, retryable: true});
  const failed = await get();
  assert.deepEqual(
    [failed.status, failed.error.message, failed.error.data.code],
    ['failed', outageText, 'UPSTREAM_UNAVAILABLE'],
  );
  f.setJob('cancelled');
  assert.equal((await get()).status, 'cancelled');
  // The set loses the account: whatever the job says, the caller is answered the refusal and nothing of the job.
  client.narrow();
  for (const [state, error] of [
    ['queued', null],
    ['running', null],
    ['failed', {code: 'UPSTREAM_UNAVAILABLE', message: outageText, retryable: true}],
    ['cancelled', null],
  ]) {
    f.setJob(state, error);
    const seen = await get();
    assert.equal(seen.status, 'failed', state);
    assert.equal(seen.error.data.code, 'ACCOUNT_SCOPE_RESTRICTED', state);
    assert.equal(seen.statusMessage, undefined, state + ' shows no progress of the job');
    assert.equal(seen.result, undefined, state);
    assert.ok(!JSON.stringify(seen).includes(outageText), state + ' shows the job’s error text');
  }
});

test('a task survives a restart: a fresh process on the same store follows it to its end', async t => {
  const f = await exportStack(t),
    task = await exportTask(f),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-mcp-tasks-')),
    file = path.join(dir, 'restart.store');
  f.store.sql().exec("VACUUM INTO '" + file.replaceAll("'", "''") + "'");
  // The first process is gone; a new one opens the same store with the same key and serves the same credential.
  const store = new Store(file, Buffer.alloc(32, 121).toString('base64')),
    refused = [],
    service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async url => {
          refused.push(String(url));
          throw new Error('No provider in this test');
        },
        async () => {},
      ),
    ),
    listener = await listenForFetch(createHttpApp(service, store, {mcpModernProtocol: 'on'}));
  // The second store is open while the directory it lives in is removed, so it is closed first.
  t.after(async () => {
    await new Promise(resolve => listener.close(resolve));
    store.close();
    removeTestDirectory(dir, 'amcp-mcp-tasks-');
  });
  const next = {url: new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), key: f.key},
    jobs = "tenant_id=? AND kind='report_file_export'";
  const working = (await modern(next, 'tasks/get', {taskId: task.taskId})).body.result;
  assert.equal(working.status, 'working');
  assert.equal(working.taskId, task.taskId);
  store
    .sql()
    .prepare('UPDATE jobs SET state=? WHERE ' + jobs)
    .run('complete', f.actor.tenantId);
  const done = (await modern(next, 'tasks/get', {taskId: task.taskId})).body.result;
  assert.equal(done.status, 'completed');
  assert.equal(done.result.structuredContent.data.state, 'complete');
  assert.deepEqual(refused, [], 'no provider was asked');
});

test('a person has a bounded number of tasks; past it the call is answered as a polling handle', async t => {
  const saved = {...tasks.taskLimits};
  Object.assign(tasks.taskLimits, {maxActive: 1});
  t.after(() => Object.assign(tasks.taskLimits, saved));
  const f = await exportStack(t),
    first = await exportTask(f);
  assert.equal((await exportTask(f)).taskId, first.taskId, 'the same job is the same task, not another');
  // A second export (another destination, so another job) is over the bound: the ordinary answer, with its job handle.
  const other = await f.overview.handle(
    {
      action: 'bind_file_destination',
      idempotency_key: 'long-run-files-2',
      confirmed: true,
      file_destination: {name: 'Second files', formats: ['pdf']},
    },
    f.actor,
  );
  const over = await modern(f, 'tools/call', {
    name: overviewTool,
    arguments: {...f.exportArgs, destination_id: other.id},
  });
  assert.equal(over.body.result.resultType, 'complete');
  assert.equal(over.body.result.structuredContent.data.state, 'queued');
  assert.equal(taskDocuments(f).length, 1);
});

test('the ingress checks a task request as it checks every other: its method, and its name, which is the task', async t => {
  const f = await exportStack(t),
    task = await exportTask(f);
  const mismatched = await modern(f, 'tasks/get', {taskId: task.taskId}, {headers: {'mcp-name': 'another-task'}});
  assert.equal(mismatched.status, 400);
  assert.equal(fail(mismatched, -32020).data.header, 'Mcp-Name');
  const method = await modern(f, 'tasks/get', {taskId: task.taskId}, {headers: {'mcp-method': 'tasks/cancel'}});
  assert.equal(method.status, 400);
  assert.equal(fail(method, -32020).data.header, 'Mcp-Method');
  // The name is required, as it is of tools/call, resources/read and prompts/get: a request without it is refused.
  const response = await fetch(f.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + f.key,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tasks/get',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tasks/get',
      params: {
        taskId: task.taskId,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': declared,
        },
      },
    }),
  });
  assert.equal(response.status, 400);
  const refused = await response.json();
  assert.equal(refused.error.code, -32020);
  assert.equal(refused.error.data.header, 'Mcp-Name');
  // The same task, named, is served.
  assert.equal((await modern(f, 'tasks/get', {taskId: task.taskId})).body.result.status, 'working');
  // tasks/list was never part of the 2026-07-28 extension.
  const list = await modern(f, 'tasks/list', {});
  assert.equal(list.status, 404);
  assert.equal(fail(list, -32601).message.length > 0, true);
});

test('over the real stdio transport framing a client that declares the extension is answered a task and follows it', async t => {
  const f = reportEngine(t, {rowsFor: level => rows[level] ?? []}),
    queued = await f.overview.handle({action: 'run', confirmed: true, config: f.definition(['campaign'])}, f.actor);
  await f.worker.once();
  const destination = await f.overview.handle(
    {
      action: 'bind_file_destination',
      idempotency_key: 'stdio-task-files',
      confirmed: true,
      file_destination: {name: 'Stdio task files', formats: ['pdf']},
    },
    f.actor,
  );
  const toServer = new PassThrough(),
    fromServer = new PassThrough(),
    server = serveStdio(context => createMcpServer(f.service, f.actor, {era: context.era}), {
      transport: new StdioServerTransport(toServer, fromServer),
    });
  t.after(() => server.close());
  const received = [];
  let buffer = '';
  fromServer.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      if (buffer.slice(0, end).trim()) received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const ask = async (method, params, caps = declared) => {
    const id = ++sequence;
    toServer.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': caps,
            'io.modelcontextprotocol/clientInfo': {name: 'Synthetic stdio task client', version: '1'},
          },
        },
      }) + '\n',
    );
    return (await until(() => received.find(message => message.id === id), 5000, method + ' answer')).result;
  };
  const created = await ask('tools/call', {
    name: overviewTool,
    arguments: {action: 'export', report_id: queued.id, destination_id: destination.id, confirmed: true},
  });
  assert.equal(created.resultType, 'task');
  assert.equal(created.task.status, 'working');
  f.store
    .sql()
    .prepare("UPDATE jobs SET state='complete' WHERE tenant_id=? AND kind='report_file_export'")
    .run(f.actor.tenantId);
  const done = await ask('tasks/get', {taskId: created.task.taskId});
  assert.equal(done.status, 'completed');
  assert.equal(done.result.structuredContent.data.state, 'complete');
  // A client that does not declare it is answered the ordinary result on the same connection.
  const ordinary = await ask(
    'tools/call',
    {name: overviewTool, arguments: {action: 'export_status', id: done.result.structuredContent.data.id}},
    {},
  );
  assert.equal(ordinary.resultType, 'complete');
  assert.equal(ordinary.structuredContent.data.state, 'complete');
});
