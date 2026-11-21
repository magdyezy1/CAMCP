// R2.5 field3, package r25-field3-approvals, AMCP-12: a `run` of an approved plan that carries a progress token tells its client, as each
// step settles, how far the plan has come ("step 3 of 10 verified"), as `notifications/progress` on the call's own stream, and then answers
// exactly what it always answered (with run.progress added). A call without a token, and every other call, is what it was. Everything goes
// through a real SDK v2 client over the real HTTP stack (both protocol eras), over the stdio transport framing (both eras), and over raw HTTP
// where the wire itself is the thing being checked. The plan is two media uploads against a fake Meta (tests/helpers/mcp-long-run-stacks.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {Client} from '@modelcontextprotocol/client';
import {StdioServerTransport, serveStdio} from '@modelcontextprotocol/server/stdio';
import {createMcpServer} from '../dist/server/mcp.js';
import {offerParkedProviders} from './helpers/parked-providers.mjs';
import {campaignStack, campaignTool, until} from './helpers/mcp-long-run-stacks.mjs';

offerParkedProviders('criteo', 'woocommerce');
const summary = events => events.map(p => [p.progress, p.total, p.message]);
const expected = [
  [0, 2, '0 of 2 steps settled'],
  [1, 2, 'step 1 of 2 verified'],
  [2, 2, 'step 2 of 2 verified'],
];

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: a run with a progress token reports each settled step on its own stream and answers the finished plan with its progress`, async t => {
    const f = await campaignStack(t),
      client = await f.connect(era),
      events = [];
    const result = await client.callTool(
      {name: campaignTool, arguments: {action: 'run', id: f.id}},
      {onprogress: p => events.push(p), timeout: 30000},
    );
    assert.deepEqual(summary(events), expected);
    const out = result.structuredContent;
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.equal(out.data.run.stopped, 'complete');
    assert.deepEqual(out.data.run.executed, ['upload-1', 'upload-2']);
    assert.equal(out.data.run.progress.steps_total, 2);
    assert.equal(out.data.run.progress.settled, 2);
    assert.equal(out.data.run.progress.remaining, 0);
    assert.equal(f.uploads(), 2, 'the uploads ran once each');
    // The progress value only grew, so every notification was a new one.
    assert.equal(new Set(events.map(p => p.progress)).size, events.length);
  });

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: a run without a token answers the same plan with the same progress, as a plain call`, async t => {
    const f = await campaignStack(t),
      client = await f.connect(era);
    // No progress handler is given, so the client sends no progress token and nothing is streamed.
    const out = (await client.callTool({name: campaignTool, arguments: {action: 'run', id: f.id}}, {timeout: 30000}))
      .structuredContent;
    assert.equal(out.success, true, JSON.stringify(out.error));
    assert.equal(out.data.run.stopped, 'complete');
    assert.equal(out.data.run.progress.settled, 2);
  });

test('a call that is not a run of a plan sends no notification even with a token, and answers as it did', async t => {
  const f = await campaignStack(t),
    client = await f.connect('modern'),
    events = [];
  const out = (
    await client.callTool(
      {name: campaignTool, arguments: {action: 'get', id: f.id}},
      {onprogress: p => events.push(p), timeout: 30000},
    )
  ).structuredContent;
  assert.equal(out.success, true, JSON.stringify(out.error));
  assert.deepEqual(events, []);
  assert.equal(out.data.run, undefined);
  assert.equal(f.uploads(), 0, 'reading a plan sent nothing');
});

/** One raw POST to /mcp of the earlier revisions: its status, content type and body. */
async function post(f, params, {accept = 'application/json, text/event-stream', protocol = '2025-11-25'} = {}) {
  const response = await fetch(f.url, {
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
  return {status: response.status, type: response.headers.get('content-type') ?? '', text};
}
const messages = text =>
  text
    .split(/\r?\n\r?\n/)
    .flatMap(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')))
    .map(line => JSON.parse(line.slice(5)));

test('on the wire of the earlier revisions a run that carries a token and accepts a stream is answered as one; every other request keeps its JSON answer', async t => {
  const f = await campaignStack(t),
    token = {progressToken: 'run-token'};
  // The run, with a token, from a client that accepts an event stream: progress, then the answer, on one stream.
  const streamed = await post(f, {name: campaignTool, arguments: {action: 'run', id: f.id}, _meta: token});
  assert.equal(streamed.status, 200);
  assert.match(streamed.type, /^text\/event-stream/);
  const sent = messages(streamed.text);
  assert.deepEqual(
    sent.filter(m => m.method === 'notifications/progress').map(m => m.params),
    expected.map(([progress, total, message]) => ({progressToken: 'run-token', progress, total, message})),
  );
  assert.equal(sent.at(-1).id, 'raw-1');
  assert.equal(sent.at(-1).result.structuredContent.data.run.stopped, 'complete');
  // A token on a call that is not a run changes nothing: JSON.
  const read = await post(f, {name: campaignTool, arguments: {action: 'get', id: f.id}, _meta: token});
  assert.match(read.type, /^application\/json/);
  assert.equal(JSON.parse(read.text).result.structuredContent.success, true);
  // A client that does not accept an event stream is answered as it always was, token or not: the same status and type.
  const g = await campaignStack(t),
    h = await campaignStack(t),
    jsonOnly = {accept: 'application/json'},
    withToken = await post(g, {name: campaignTool, arguments: {action: 'run', id: g.id}, _meta: token}, jsonOnly),
    withoutToken = await post(h, {name: campaignTool, arguments: {action: 'run', id: h.id}}, jsonOnly);
  assert.equal(withToken.status, withoutToken.status);
  assert.equal(withToken.type, withoutToken.type);
  assert.doesNotMatch(withToken.type, /^text\/event-stream/);
  // And the same run without a token, from a client that accepts both, is the JSON answer it always was, with the progress added.
  const k = await campaignStack(t),
    bare = await post(k, {name: campaignTool, arguments: {action: 'run', id: k.id}});
  assert.match(bare.type, /^application\/json/);
  assert.equal(JSON.parse(bare.text).result.structuredContent.data.run.progress.settled, 2);
});

for (const era of ['legacy', 'modern'])
  test(`${era} HTTP: a client that cancels its request while a run is reporting stops the notifications and never stops the run, which finishes whole`, async t => {
    const f = await campaignStack(t),
      client = await f.connect(era),
      stop = new AbortController(),
      events = [];
    const call = client.callTool(
      {name: campaignTool, arguments: {action: 'run', id: f.id}},
      {
        onprogress: p => {
          events.push(p);
          // The first notification is the run beginning: the client goes, with the plan not yet run.
          if (events.length === 1) stop.abort();
        },
        signal: stop.signal,
        timeout: 30000,
      },
    );
    await assert.rejects(call, {message: /abort/i});
    // The server goes on with the plan it was running: every upload is made once, and none twice.
    await until(() => f.uploads() === 2, 8000, 'the run to finish the plan');
    const after = (
      await (await f.connect('modern')).callTool({name: campaignTool, arguments: {action: 'get', id: f.id}})
    ).structuredContent;
    assert.equal(after.data.state, 'complete');
    assert.equal(f.uploads(), 2);
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
  test(`${era} stdio: a run with a progress token reports its steps through the stdio transport and answers the finished plan`, async t => {
    const f = await campaignStack(t),
      toServer = new PassThrough(),
      fromServer = new PassThrough(),
      transport = new StdioServerTransport(toServer, fromServer);
    let server;
    if (era === 'modern')
      server = serveStdio(context => createMcpServer(f.service, f.operator, {era: context.era}), {transport});
    else {
      server = createMcpServer(f.service, f.operator);
      await server.connect(transport);
    }
    const client = new Client(
      {name: 'Synthetic stdio run client', version: '1'},
      era === 'modern' ? {versionNegotiation: {mode: {pin: '2026-07-28'}}} : {},
    );
    await client.connect(lineTransport(toServer, fromServer));
    t.after(async () => {
      await client.close();
      await server.close();
    });
    const events = [];
    const result = await client.callTool(
      {name: campaignTool, arguments: {action: 'run', id: f.id}},
      {onprogress: p => events.push(p), timeout: 30000},
    );
    assert.deepEqual(summary(events), expected);
    assert.equal(result.structuredContent.data.run.stopped, 'complete');
    assert.equal(f.uploads(), 2);
  });
