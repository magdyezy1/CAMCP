// V2-MCP-02 (decision 5): request-scoped progress for the two long runs, amcp_campaign run_background and an export of
// amcp_reporting_overview. A call that carries a progressToken stays open for a bounded time, sends notifications/progress
// on its own request's stream as the job moves, and answers; a client that sends no token gets today's answer at once.
// Everything here goes through a real SDK v2 client over the real HTTP stack (both protocol eras), over the real stdio
// transport framing (both eras), and over raw HTTP where the wire itself is the thing being checked. The jobs are driven
// through the store (or by the real worker), never a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {Client} from '@modelcontextprotocol/client';
import {StdioServerTransport, serveStdio} from '@modelcontextprotocol/server/stdio';
import {createMcpServer} from '../dist/server/mcp.js';
import {reportEngine} from './helpers/report-engine.mjs';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {campaignStack, campaignTool, exportStack, overviewTool, rows, until} from './helpers/mcp-long-run-stacks.mjs';

offerParkedProviders('criteo', 'woocommerce');
// The progress module is read lazily so that the tests fail on behaviour, not on a missing import, before it exists.
const progress = await import('../dist/server/mcp-progress.js').catch(() => ({progressLimits: {}, heldNow: () => 0}));
/** Narrows the hold for one test and puts the limits back after it. */
function limits(t, changes) {
  const saved = {...progress.progressLimits};
  Object.assign(progress.progressLimits, changes);
  t.after(() => Object.assign(progress.progressLimits, saved));
}
const summary = events => events.map(p => [p.progress, p.total, p.message]);
for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: an export with a progress token reports its job on its own stream and answers the finished export`, async t => {
    limits(t, {holdMs: 10000, pollMs: 25});
    const f = await exportStack(t),
      client = await f.connect(era),
      events = [];
    const result = await client.callTool(
      {name: overviewTool, arguments: f.exportArgs},
      {
        onprogress: p => {
          events.push(p);
          // The job moves when the client has seen where it was, so every stage is observed, not raced past.
          if (p.message === 'queued') f.setJob('running');
          else if (p.message === 'running') f.setJob('complete');
        },
        timeout: 20000,
      },
    );
    assert.deepEqual(summary(events), [
      [0, 2, 'queued'],
      [1, 2, 'running'],
      [2, 2, 'complete'],
    ]);
    const out = result.structuredContent;
    assert.equal(out.success, true, JSON.stringify(out.error));
    // The job had finished, so the answer is the read that shows it finished (export_status), not the stale queued handle.
    assert.equal(out.data.state, 'complete');
    assert.equal(typeof out.data.id, 'string');
    assert.equal(typeof out.data.job.id, 'string');
    assert.equal(progress.heldNow(), 0, 'the hold is released');
  });

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: an export still running when the hold ends answers its job handle, and the job runs on`, async t => {
    limits(t, {holdMs: 500, pollMs: 25});
    const f = await exportStack(t),
      client = await f.connect(era),
      events = [],
      started = Date.now();
    const result = await client.callTool(
      {name: overviewTool, arguments: f.exportArgs},
      {onprogress: p => events.push(p), timeout: 20000},
    );
    assert.ok(Date.now() - started >= 450, 'the call was held for the hold');
    assert.deepEqual(summary(events), [[0, 2, 'queued']], 'nothing grew, so one notification, sent at once');
    const out = result.structuredContent;
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.equal(out.data.state, 'queued');
    assert.equal(typeof out.data.job_id, 'string');
    assert.equal(f.jobState(), 'queued', 'the wait never touches the job');
    assert.equal(progress.heldNow(), 0);
    // The polling that always worked is unchanged: the same call without a token answers the same record at once.
    const polled = (await client.callTool({name: overviewTool, arguments: {action: 'export_status', id: out.data.id}}))
      .structuredContent;
    assert.equal(polled.data.state, 'queued');
    assert.equal(polled.data.poll_after_ms, 5000);
    assert.deepEqual(polled.data.next_call, {
      tool: overviewTool,
      arguments: {action: 'export_status', id: out.data.id},
    });
  });

for (const [era, how] of [
  ['legacy', 'closes its connection'],
  ['modern', 'closes its connection'],
  ['modern', 'cancels its request'],
])
  test(`${era} HTTP: a client that ${how} ends the wait at once and never cancels the job`, async t => {
    limits(t, {holdMs: 20000, pollMs: 25});
    const f = await exportStack(t),
      client = await f.connect(era),
      stop = new AbortController(),
      events = [];
    const call = client.callTool(
      {name: overviewTool, arguments: f.exportArgs},
      {
        onprogress: p => {
          events.push(p);
          // A closed connection is what every revision shows the server; a cancelled request is the 2026-07-28 revision's
          // own way, which closes the request's stream (the earlier revisions send a separate cancel the stateless
          // server cannot match to this request, so the connection is what ends their wait).
          if (how === 'cancels its request') stop.abort();
          else void client.close();
        },
        signal: stop.signal,
        timeout: 30000,
      },
    );
    await assert.rejects(call, how === 'cancels its request' ? {message: /aborted/i} : {code: 'CONNECTION_CLOSED'});
    assert.equal(events.length, 1);
    // The wait ended because the caller left, not because 20 seconds passed.
    await until(() => progress.heldNow() === 0, 4000, 'the hold to end');
    assert.equal(f.jobState(), 'queued', 'a closed stream never cancels the job');
    // The server is unharmed, and the job is still there to be read.
    const out = (await (await f.connect(era)).callTool({name: overviewTool, arguments: f.exportArgs}))
      .structuredContent;
    assert.equal(out.success, true);
    assert.equal(out.data.state, 'queued');
  });

test('a process holds at most maxHeld calls; the next is answered at once, and polling is the same', async t => {
  limits(t, {holdMs: 20000, pollMs: 25, maxHeld: 1});
  const f = await exportStack(t),
    first = await f.connect('legacy'),
    second = await f.connect('modern'),
    seen = [];
  const held = first.callTool(
    {name: overviewTool, arguments: f.exportArgs},
    {onprogress: p => seen.push(p), timeout: 30000},
  );
  await until(() => seen.length === 1, 4000, 'the first notification');
  assert.equal(progress.heldNow(), 1);
  const other = [],
    started = Date.now();
  const answer = (
    await second.callTool(
      {name: overviewTool, arguments: f.exportArgs},
      {onprogress: p => other.push(p), timeout: 30000},
    )
  ).structuredContent;
  assert.ok(Date.now() - started < 3000, 'past the cap the call is answered at once');
  assert.deepEqual(other, []);
  assert.equal(answer.success, true);
  assert.equal(answer.data.state, 'queued');
  assert.equal(progress.heldNow(), 1, 'the held call is still held');
  f.setJob('complete');
  assert.equal((await held).structuredContent.data.state, 'complete');
  assert.equal(progress.heldNow(), 0);
});

/** One raw POST to /mcp of the earlier revisions: its status, content type and body. */
async function post(f, params, {accept = 'application/json, text/event-stream', protocol = '2025-11-25'} = {}) {
  const started = Date.now(),
    response = await fetch(f.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept,
        authorization: 'Bearer ' + f.key,
        'mcp-protocol-version': protocol,
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 'raw-1', method: 'tools/call', params}),
    }),
    text = await response.text();
  return {status: response.status, type: response.headers.get('content-type') ?? '', text, ms: Date.now() - started};
}
/** The JSON-RPC messages of an event stream, in order. */
const messages = text =>
  text
    .split(/\r?\n\r?\n/)
    .flatMap(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')))
    .map(line => JSON.parse(line.slice(5)));

test('on the wire of the earlier revisions only a long run that carries a token and accepts a stream is answered as a stream', async t => {
  limits(t, {holdMs: 1500, pollMs: 25});
  const f = await exportStack(t),
    token = {progressToken: 'raw-token'};
  // A long run with a token, from a client that accepts an event stream: progress, then the answer, on one stream.
  const streamed = await post(f, {name: overviewTool, arguments: f.exportArgs, _meta: token});
  assert.equal(streamed.status, 200);
  assert.match(streamed.type, /^text\/event-stream/);
  const sent = messages(streamed.text);
  assert.equal(sent[0].method, 'notifications/progress');
  assert.deepEqual(sent[0].params, {progressToken: 'raw-token', progress: 0, total: 2, message: 'queued'});
  assert.equal(sent.at(-1).id, 'raw-1');
  assert.equal(sent.at(-1).result.structuredContent.data.state, 'queued');
  assert.ok(streamed.ms >= 1400, 'held for the hold');
  // The same call with no token: JSON, at once, as it always was.
  const plain = await post(f, {name: overviewTool, arguments: f.exportArgs});
  assert.equal(plain.status, 200);
  assert.match(plain.type, /^application\/json/);
  assert.ok(plain.ms < 1000, 'no token: no wait');
  assert.equal(JSON.parse(plain.text).result.structuredContent.data.state, 'queued');
  // A token on a call that is not a long run changes nothing.
  const read = await post(f, {name: overviewTool, arguments: {action: 'list', limit: 1}, _meta: token});
  assert.match(read.type, /^application\/json/);
  assert.equal(JSON.parse(read.text).result.structuredContent.success, true);
  // A token on a long run that was refused changes nothing: the refusal, in JSON-compatible form, with no wait.
  const refused = await post(f, {
    name: overviewTool,
    arguments: {action: 'export', report_id: 'no-such-report', destination_id: 'x', confirmed: true},
    _meta: token,
  });
  assert.ok(refused.ms < 1000);
  const refusal = (
    refused.type.startsWith('text/event-stream') ? messages(refused.text).at(-1) : JSON.parse(refused.text)
  ).result;
  assert.equal(refusal.isError, true);
  assert.equal(refusal.structuredContent.success, false);
  assert.equal(refusal.structuredContent.error.code, 'NOT_FOUND');
  // A client that does not accept an event stream keeps its JSON answer, with the same status and type it had without a token.
  const bare = await post(f, {name: overviewTool, arguments: f.exportArgs}, {accept: 'application/json'}),
    bareToken = await post(
      f,
      {name: overviewTool, arguments: f.exportArgs, _meta: token},
      {accept: 'application/json'},
    );
  assert.equal(bareToken.status, bare.status);
  assert.equal(bareToken.type, bare.type);
  assert.ok(bareToken.ms < 1000);
  assert.equal(progress.heldNow(), 0);
});

/** A client's half of a pair of streams that carry the stdio framing: one JSON message per line. */
function lineTransport(toServer, fromServer) {
  let buffer = '';
  const transport = {
    async start() {
      fromServer.on('data', chunk => {
        buffer += chunk.toString('utf8');
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) transport.onmessage?.(JSON.parse(line));
        }
      });
    },
    async send(message) {
      toServer.write(JSON.stringify(message) + '\n');
    },
    async close() {
      toServer.end();
      transport.onclose?.();
    },
  };
  return transport;
}
for (const era of ['legacy', 'modern'])
  test(`${era} stdio: an export with a progress token reports its job through the stdio transport and answers the finished export`, async t => {
    limits(t, {holdMs: 10000, pollMs: 25});
    const f = reportEngine(t, {rowsFor: level => rows[level] ?? []}),
      queued = await f.overview.handle({action: 'run', confirmed: true, config: f.definition(['campaign'])}, f.actor);
    await f.worker.once();
    const destination = await f.overview.handle(
      {
        action: 'bind_file_destination',
        idempotency_key: 'stdio-files',
        confirmed: true,
        file_destination: {name: 'Stdio files', formats: ['pdf']},
      },
      f.actor,
    );
    const toServer = new PassThrough(),
      fromServer = new PassThrough(),
      transport = new StdioServerTransport(toServer, fromServer);
    let server;
    if (era === 'modern')
      server = serveStdio(context => createMcpServer(f.service, f.actor, {era: context.era}), {transport});
    else {
      server = createMcpServer(f.service, f.actor);
      await server.connect(transport);
    }
    const client = new Client(
      {name: 'Synthetic stdio progress client', version: '1'},
      era === 'modern' ? {versionNegotiation: {mode: {pin: '2026-07-28'}}} : {},
    );
    await client.connect(lineTransport(toServer, fromServer));
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const events = [],
      jobs = "tenant_id=? AND kind='report_file_export'",
      setJob = state =>
        f.store
          .sql()
          .prepare('UPDATE jobs SET state=?, error=NULL WHERE ' + jobs)
          .run(state, f.actor.tenantId);
    const result = await client.callTool(
      {
        name: overviewTool,
        arguments: {action: 'export', report_id: queued.id, destination_id: destination.id, confirmed: true},
      },
      {
        onprogress: p => {
          events.push(p);
          if (p.message === 'queued') setJob('running');
          else if (p.message === 'running') setJob('complete');
        },
        timeout: 20000,
      },
    );
    assert.deepEqual(summary(events), [
      [0, 2, 'queued'],
      [1, 2, 'running'],
      [2, 2, 'complete'],
    ]);
    assert.equal(result.structuredContent.data.state, 'complete');
    assert.equal(progress.heldNow(), 0);
  });

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: run_background with a progress token reports the settled uploads of its plan and answers the finished plan`, async t => {
    limits(t, {holdMs: 15000, pollMs: 25});
    const f = await campaignStack(t),
      client = await f.connect(era),
      events = [];
    const call = client.callTool(
      {name: campaignTool, arguments: {action: 'run_background', id: f.id}},
      {onprogress: p => events.push(p), timeout: 30000},
    );
    // The first notification is the wait beginning; then the website is gone and the worker runs the plan.
    await until(() => events.length >= 1, 4000, 'the first notification');
    assert.equal(f.uploads(), 0, 'queueing sent nothing');
    assert.equal(await f.worker.once(), true);
    const out = (await call).structuredContent;
    assert.equal(f.uploads(), 2);
    assert.deepEqual(summary(events.slice(0, 1)), [[0, 2, 'queued: 0 of 2 uploads settled']]);
    assert.deepEqual(summary(events.slice(-1)), [[2, 2, 'complete: 2 of 2 uploads settled']]);
    assert.deepEqual(
      events.map(p => p.progress),
      events.map(p => p.progress).toSorted((a, b) => a - b),
    );
    assert.equal(new Set(events.map(p => p.progress)).size, events.length, 'every notification grew');
    assert.equal(out.success, true, JSON.stringify(out.error));
    // The plan finished, so the answer is the plan as get shows it, with its finished background run.
    assert.equal(out.data.id, f.id);
    assert.equal(out.data.state, 'complete');
    assert.equal(out.data.background.state, 'complete');
    assert.equal(progress.heldNow(), 0);
  });

test('run_background without a token answers at once, with the job handle and the next call, as it always did', async t => {
  limits(t, {holdMs: 10000, pollMs: 25});
  const f = await campaignStack(t),
    client = await f.connect('legacy'),
    started = Date.now();
  const out = (await client.callTool({name: campaignTool, arguments: {action: 'run_background', id: f.id}}))
    .structuredContent;
  assert.ok(Date.now() - started < 3000, 'no token: no wait');
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.equal(out.data.background.state, 'queued');
  assert.equal(typeof out.data.background.job_id, 'string');
  assert.deepEqual(out.data.next_call, {tool: campaignTool, arguments: {action: 'get', id: f.id}});
  assert.equal(f.uploads(), 0);
});
