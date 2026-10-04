import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {recordServiceTiming, serviceTimings} from '../dist/src/service-timings.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const actor = {tenantId: 'timings-fixture', userId: 'private-actor-marker', role: 'admin'};
const key = Buffer.alloc(32, 87).toString('base64');
function fixture() {
  const store = new Store(':memory:', key);
  let requests = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      requests++;
      throw Error('No provider request is allowed');
    }),
  );
  return {store, service, requests: () => requests};
}
test('owner health counts completed tool attempts without retaining inputs, identities or provider calls', async () => {
  const f = fixture();
  try {
    assert.equal((await f.service.call('amcp_workspace', {action: 'contracts', limit: 1}, actor)).success, true);
    assert.equal((await f.service.call('amcp_workspace', {action: 'unsupported-secret-marker'}, actor)).success, false);
    assert.equal((await f.service.call('unrecognized-private-marker', {}, actor)).success, false);
    const out = await f.service.call('amcp_workspace', {action: 'health'}, actor);
    assert.equal(out.success, true, JSON.stringify(out));
    const timings = out.data.operations.timings;
    assert.ok(timings, 'Owner health must expose bounded tool-attempt timing evidence');
    const workspace = timings.items.find(item => item.category === 'workspace');
    assert.equal(workspace.attempts, 2);
    assert.equal(workspace.successes, 1);
    assert.equal(workspace.errors, 1);
    assert.equal(timings.items.find(item => item.category === 'native_other').attempts, 1);
    assert.match(timings.scope, /attempt/);
    assert.doesNotMatch(
      JSON.stringify(timings),
      /unsupported-secret-marker|unrecognized-private-marker|private-actor-marker|timings-fixture/,
    );
    assert.equal(
      (await f.service.call('amcp_workspace', {action: 'health'}, {...actor, role: 'reader'})).success,
      false,
    );
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('timing buckets preserve bounds, null measurements, tenant isolation and an honest fixed-window lifetime', () => {
  const store = new Store(':memory:', key),
    now = 1800000;
  try {
    for (const [i, ms] of [0, 25, 26, 100, 101, 500, 501, 2000, 2001, 10000, 10001, 60000, 60001].entries())
      recordServiceTiming(store, actor.tenantId, 'workspace', ms, i % 2 === 0, now + i);
    recordServiceTiming(store, 'another-workspace', 'workspace', 1, true, now);
    for (const missing of [Number.NaN, Infinity, -0.0001, '25'])
      recordServiceTiming(store, actor.tenantId, 'media', missing, true, now);
    const out = serviceTimings(store, actor.tenantId, now + 20),
      row = out.items.find(v => v.category === 'workspace');
    assert.equal(row.attempts, 13);
    assert.equal(row.successes, 7);
    assert.equal(row.errors, 6);
    assert.equal(row.minimum_ms, 0);
    assert.equal(row.maximum_ms, 60001);
    assert.deepEqual(row.p50_bucket, {lower_ms: 500, upper_ms: 2000});
    assert.deepEqual(row.p95_bucket, {lower_ms: 60000, upper_ms: null});
    const missing = out.items.find(v => v.category === 'media');
    assert.equal(missing.attempts, 0);
    assert.equal(missing.mean_ms, null);
    assert.equal(missing.omitted_count, 4);
    assert.equal(serviceTimings(store, 'another-workspace', now + 20).items[0].attempts, 1);
    assert.deepEqual(serviceTimings(store, actor.tenantId, now + 900000).items, []);
    recordServiceTiming(store, actor.tenantId, 'workspace', 3, true, now + 900001);
    assert.equal(serviceTimings(store, actor.tenantId, now + 900001).items[0].reset_reason, 'new_window');
    recordServiceTiming(store, actor.tenantId, 'workspace', 4, false, now + 900000);
    assert.equal(serviceTimings(store, actor.tenantId, now + 900000).items[0].reset_reason, 'clock_changed');
    assert.equal(serviceTimings(store, actor.tenantId, now + 900000).items[0].attempts, 1);
    assert.equal(
      store.db
        .prepare("SELECT count(*) AS n FROM documents WHERE tenant_id=? AND kind='service_timings'")
        .get(actor.tenantId).n,
      2,
    );
  } finally {
    store.close();
  }
});

test('invalid retained counters and measurement limits never manufacture trustworthy timing evidence', () => {
  const store = new Store(':memory:', key),
    now = 1800000;
  try {
    recordServiceTiming(store, actor.tenantId, 'workspace', 25, true, now);
    const original = store.document(actor.tenantId, 'service_timings', 'workspace');
    store.putDocument(actor.tenantId, 'service_timings', 'workspace', {
      ...original,
      successes: 2,
      private_field: 'never-return-this',
    });
    const invalid = serviceTimings(store, actor.tenantId, now);
    assert.equal(invalid.unavailable_counters, 1);
    assert.deepEqual(invalid.items, []);
    assert.doesNotMatch(JSON.stringify(invalid), /never-return-this|private_field/);
    recordServiceTiming(store, actor.tenantId, 'workspace', 1, false, now);
    assert.equal(serviceTimings(store, actor.tenantId, now).items[0].reset_reason, 'invalid_counter');
    store.putDocument(actor.tenantId, 'service_timings', 'workspace', {
      ...original,
      attempts: 1000000,
      successes: 1000000,
      errors: 0,
      total_us: 25000000000,
      min_us: 25000,
      max_us: 25000,
      buckets: [1000000, 0, 0, 0, 0, 0, 0],
    });
    recordServiceTiming(store, actor.tenantId, 'workspace', 50, true, now);
    const capped = serviceTimings(store, actor.tenantId, now).items[0];
    assert.equal(capped.attempts, 1000000);
    assert.equal(capped.omitted_count, 1);
    assert.equal(capped.saturated, true);
    assert.equal(capped.mean_ms, 25);
    assert.throws(() => recordServiceTiming(store, actor.tenantId, 'unbounded-private-key', 1, true, now));
  } finally {
    store.close();
  }
});

test('timing persistence failure cannot replace a tool result, expose the failure text or retry a provider', async () => {
  const f = fixture();
  try {
    f.store.serviceTiming = () => {
      throw Error('private-database-location-marker');
    };
    const result = await f.service.call('amcp_workspace', {action: 'contracts', limit: 1}, actor);
    assert.equal(result.success, true, JSON.stringify(result));
    const out = await f.service.call('amcp_workspace', {action: 'health'}, actor);
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.operations.timings.persistence_failures_in_this_process, 1);
    assert.doesNotMatch(JSON.stringify(out), /private-database-location-marker/);
    assert.equal(f.requests(), 0);
  } finally {
    f.store.close();
  }
});

test('real HTTP MCP calls expose completed attempts while revoked keys contribute no new authorized measurements', async () => {
  const f = fixture(),
    token = f.store.createKey(actor);
  const listener = await listenForFetch(createHttpApp(f.service, f.store));
  const client = new Client({name: 'service-timing-fixture', version: '1'});
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + listener.address().port + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + token}},
      }),
    );
    const call = async arguments_ =>
      JSON.parse(
        (await client.callTool({name: 'amcp_workspace', arguments: arguments_})).content.find(
          item => item.type === 'text',
        ).text,
      );
    assert.equal((await call({action: 'contracts', limit: 1})).success, true);
    const out = await call({action: 'health'});
    assert.equal(out.success, true, JSON.stringify(out));
    assert.equal(out.data.operations.timings.items.find(item => item.category === 'workspace').attempts, 1);
    f.store.revokeKey(token);
    await assert.rejects(client.callTool({name: 'amcp_workspace', arguments: {action: 'health'}}));
    assert.equal(serviceTimings(f.store, actor.tenantId).items.find(item => item.category === 'workspace').attempts, 2);
    assert.equal(f.requests(), 0);
  } finally {
    await client.close();
    await new Promise(done => listener.close(done));
    f.store.close();
  }
});

test('three actual processes update the same bounded timing record without losing counts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'amcp-service-timing-fixture-'));
  const filename = path.join(dir, 'synthetic.sqlite');
  const store = new Store(filename, key);
  try {
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['tests/fixtures/service-timing-worker.mjs', filename, '75'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let output = '';
        child.stdout.on('data', value => {
          output += value;
        });
        child.stderr.on('data', value => {
          output += value;
        });
        child.once('error', reject);
        // Full closure includes drained stdio; process exit alone can precede it on Windows.
        child.once('close', code =>
          code === 0 ? resolve() : reject(Error('Synthetic timing worker failed: ' + output)),
        );
      });
    const workers = await Promise.allSettled([run(), run(), run()]);
    for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
    const out = serviceTimings(store, 'multiprocess-fixture', 1800000).items[0];
    assert.equal(out.attempts, 225);
    assert.equal(out.successes, 225);
    assert.equal(out.errors, 0);
    assert.equal(out.mean_ms, 25);
    assert.equal(out.omitted_count, 0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM documents WHERE kind='service_timings'").get().n, 1);
  } finally {
    store.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('amcp-service-timing-fixture-'));
    await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
});
