// SEC-02: /mcp refuses JSON-RPC batches and bounds each actor's request rate and concurrency.
// Before this, one authenticated POST of a 40-item `tools/list` array returned about 5.7 MB (2,400x amplification), and
// nothing limited how often or how many requests at once a key could send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {mcpLimits, mcpLimitsFromEnv, bodySizeBucket} from '../dist/server/mcp-limits.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

async function serve({secondInstance = false, ...options} = {}) {
  const store = new Store(':memory:'),
    service = new MirrorService(new Registry(), store),
    logs = [],
    executed = [],
    gates = [];
  // Every tool listing and call is recorded, so a test can prove that a refused request ran nothing.
  const listTools = service.listTools.bind(service),
    call = service.call.bind(service);
  service.listTools = () => {
    executed.push('tools/list');
    return listTools();
  };
  service.call = async (name, args, actor) => {
    executed.push('tools/call:' + name);
    if (name === 'amcp_tool_help' && args.topic === 'hold') await new Promise(resolve => gates.push(resolve));
    return call(name, args.topic === 'hold' ? {} : args, actor);
  };
  const apps = [createHttpApp(service, store, {...options, log: entry => logs.push(entry)})];
  if (secondInstance) apps.push(createHttpApp(service, store, {...options, log: entry => logs.push(entry)}));
  const listeners = await Promise.all(apps.map(app => listenForFetch(app))),
    bases = listeners.map(l => 'http://127.0.0.1:' + l.address().port);
  const keys = {
    a: store.createKey({tenantId: 'limits-a', userId: 'connector/a', role: 'reader'}),
    b: store.createKey({tenantId: 'limits-b', userId: 'connector/b', role: 'reader'}),
  };
  const post = (key, body, {headers = {}, instance = 0} = {}) =>
    fetch(bases[instance] + '/mcp', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + key,
        ...headers,
      },
    });
  return {
    store,
    logs,
    executed,
    gates,
    keys,
    post,
    close: async () => {
      for (const l of listeners) l.closeAllConnections();
      await Promise.all(listeners.map(l => new Promise(r => l.close(r))));
      store.close();
    },
  };
}
const ping = id => ({jsonrpc: '2.0', id, method: 'ping'});
const list = id => ({jsonrpc: '2.0', id, method: 'tools/list'});
const help = (id, topic) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: {name: 'amcp_tool_help', arguments: topic ? {topic} : {}},
});

test('a JSON-RPC batch gets HTTP 400 with -32600 and no request inside runs', async () => {
  const s = await serve();
  try {
    const refused = await s.post(s.keys.a, [list(1), help(2)]);
    assert.equal(refused.status, 400);
    const body = await refused.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32600);
    assert.equal(body.error.data.code, 'BATCH_UNSUPPORTED');
    // The local regression marker: a 40-item tools/list array used to return 5,755,192 bytes; now it is a refusal.
    const forty = await s.post(
      s.keys.a,
      Array.from({length: 40}, (_, i) => list(i)),
      {headers: {'MCP-Protocol-Version': '2025-03-26'}},
    );
    assert.equal(forty.status, 400);
    assert.ok(Number(forty.headers.get('content-length')) < 1000);
    assert.equal((await forty.json()).error.data.code, 'BATCH_UNSUPPORTED');
    assert.deepEqual(s.executed, [], 'nothing inside a refused batch ran');
    assert.deepEqual(
      s.logs.map(l => [l.event, l.status, l.code, l.body_size]),
      [
        ['mcp_refused', 400, 'BATCH_UNSUPPORTED', '<1KiB'],
        ['mcp_refused', 400, 'BATCH_UNSUPPORTED', '1-16KiB'],
      ],
    );
    assert.equal(JSON.stringify(s.logs).includes(s.keys.a), false, 'the log never carries the token');
    // Single requests are unchanged.
    const single = await s.post(s.keys.a, list(3));
    assert.equal(single.status, 200);
    assert.equal((await single.json()).id, 3);
  } finally {
    await s.close();
  }
});

test('legacy batches of up to AMCP_MCP_BATCH_MAX items are accepted for protocol 2025-03-26 only', async () => {
  const s = await serve({mcpLimits: {batchMax: 3}});
  try {
    const legacy = {headers: {'MCP-Protocol-Version': '2025-03-26'}};
    const accepted = await s.post(s.keys.a, [ping(1), ping(2)], legacy);
    assert.equal(accepted.status, 200);
    assert.deepEqual(
      (await accepted.json()).map(r => r.id),
      [1, 2],
    );
    for (const [body, options] of [
      [[ping(1), ping(2), ping(3), ping(4)], legacy],
      [[ping(1), ping(2)], {headers: {'MCP-Protocol-Version': '2025-11-25'}}],
      [[ping(1), ping(2)], {}],
      [[], legacy],
    ]) {
      const refused = await s.post(s.keys.a, body, options);
      assert.equal(refused.status, 400, JSON.stringify(options));
      assert.equal((await refused.json()).error.data.code, 'BATCH_UNSUPPORTED');
    }
  } finally {
    await s.close();
  }
});

test('the 21st request in a burst from one key gets 429 with Retry-After; a second key is unaffected', async () => {
  let now = Date.parse('2026-10-09T10:00:00Z');
  const s = await serve({clock: () => now});
  try {
    for (let i = 1; i <= 20; i++) assert.equal((await s.post(s.keys.a, ping(i))).status, 200, 'request ' + i);
    const refused = await s.post(s.keys.a, ping(21));
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '1');
    const body = await refused.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 21);
    assert.equal(body.error.data.code, 'RATE_LIMITED');
    assert.match(body.error.message, /60 a minute/);
    assert.equal((await s.post(s.keys.b, ping(1))).status, 200, 'another key has its own bucket');
    // The bucket refills at 60 a minute: one request a second.
    now += 1000;
    assert.equal((await s.post(s.keys.a, ping(22))).status, 200);
    assert.equal((await s.post(s.keys.a, ping(23))).status, 429);
    assert.deepEqual(
      s.logs.map(l => [l.event, l.status, l.code]),
      [
        ['mcp_refused', 429, 'RATE_LIMITED'],
        ['mcp_refused', 429, 'RATE_LIMITED'],
      ],
    );
  } finally {
    await s.close();
  }
});

test('processes sharing one database agree on the rate', async () => {
  const now = Date.parse('2026-10-09T10:00:00Z');
  const s = await serve({clock: () => now, secondInstance: true});
  try {
    for (let i = 1; i <= 20; i++)
      assert.equal((await s.post(s.keys.a, ping(i), {instance: i % 2})).status, 200, 'request ' + i);
    assert.equal((await s.post(s.keys.a, ping(21), {instance: 0})).status, 429);
    assert.equal((await s.post(s.keys.a, ping(22), {instance: 1})).status, 429);
  } finally {
    await s.close();
  }
});

test('a fifth concurrent request from one actor is refused until one of the four finishes', async () => {
  const s = await serve();
  try {
    const running = [1, 2, 3, 4].map(id => s.post(s.keys.a, help(id, 'hold')));
    while (s.gates.length < 4) await new Promise(r => setTimeout(r, 5));
    const fifth = await s.post(s.keys.a, help(5));
    assert.equal(fifth.status, 429);
    assert.equal(fifth.headers.get('retry-after'), '1');
    const body = await fifth.json();
    assert.equal(body.error.data.code, 'RATE_LIMITED');
    assert.match(body.error.message, /still running/);
    assert.equal((await s.post(s.keys.b, help(1))).status, 200, 'another actor is unaffected');
    for (const release of s.gates) release();
    assert.deepEqual(
      (await Promise.all(running)).map(r => r.status),
      [200, 200, 200, 200],
    );
    assert.equal((await s.post(s.keys.a, help(6))).status, 200, 'the slots are released when responses close');
    assert.equal(s.executed.filter(e => e === 'tools/call:amcp_tool_help').length, 6, 'the refused request never ran');
  } finally {
    await s.close();
  }
});

test('limits are validated at start-up and each can be turned off as a rollback', async () => {
  assert.deepEqual(mcpLimits(), {batchMax: 1, perMinute: 60, burst: 20, inFlight: 4});
  for (const bad of [
    {batchMax: 0},
    {batchMax: 11},
    {perMinute: -1},
    {burst: 0},
    {inFlight: 1.5},
    {burst: 2, batchMax: 3},
  ])
    assert.throws(() => mcpLimits(bad), /AMCP_MCP_/, JSON.stringify(bad));
  assert.throws(() => mcpLimitsFromEnv({AMCP_MCP_BATCH_MAX: 'two'}), /AMCP_MCP_BATCH_MAX/);
  assert.deepEqual(mcpLimitsFromEnv({AMCP_MCP_RATE_PER_MINUTE: ' 120 ', AMCP_MCP_MAX_IN_FLIGHT: ''}), {
    batchMax: undefined,
    perMinute: 120,
    burst: undefined,
    inFlight: undefined,
  });
  const store = new Store(':memory:');
  try {
    assert.throws(
      () => createHttpApp(new MirrorService(new Registry(), store), store, {mcpLimits: {batchMax: 11}}),
      /AMCP_MCP_BATCH_MAX/,
    );
  } finally {
    store.close();
  }
  assert.deepEqual([undefined, '12', '2000', '20000', '300000', '2000000', '9000000', 'x'].map(bodySizeBucket), [
    'unknown',
    '<1KiB',
    '1-16KiB',
    '16-256KiB',
    '256KiB-1MiB',
    '1-4MiB',
    '>=4MiB',
    'unknown',
  ]);
  const now = Date.parse('2026-10-09T10:00:00Z');
  const s = await serve({clock: () => now, mcpLimits: {perMinute: 0}});
  try {
    for (let i = 1; i <= 25; i++) assert.equal((await s.post(s.keys.a, ping(i))).status, 200, 'request ' + i);
  } finally {
    await s.close();
  }
});
