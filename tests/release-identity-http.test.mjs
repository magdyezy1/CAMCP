import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {request} from 'node:http';
const rawGet = (url, host) =>
  new Promise((resolve, reject) => {
    const req = request(url, {headers: {host}, signal: AbortSignal.timeout(3000)}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => resolve({status: res.statusCode, body}));
    });
    req.on('error', reject);
    req.end();
  });
import {listenForFetch} from '../dist/tests/http-listener.js';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {packagedIdentity} from '../dist/src/release-identity.js';
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-versionz-'));
  for (const [file, value] of Object.entries({
    'dist/server/app.js': 'owned code',
    'generated/schema.json': '{}',
    '.mirror/VENDOR/native.json': '{}',
    'web/app.js': 'owned web',
    'Skills/amcp-campaign-builder/SKILL.md': 'owned skill',
    'package.json': '{}',
    'docs/REPORTING-OVERVIEW.md': 'owned guide',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.writeFileSync(path.join(root, file), value);
  }
  const record = packagedIdentity(root, 'a'.repeat(40));
  fs.writeFileSync(path.join(root, 'dist', 'release-identity.json'), JSON.stringify(record));
  return {root, record};
};
const cleanup = root => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('amcp-versionz-'))
    throw Error('Unsafe cleanup');
  fs.rmSync(resolved, {recursive: true, force: true});
};
const setup = async () => {
  const {root, record} = fixture();
  let now = 0;
  const store = new Store(':memory:'),
    service = new MirrorService(new Registry(), store),
    logs = [];
  const listener = await listenForFetch(
    createHttpApp(service, store, {releaseRoot: root, clock: () => now, log: entry => logs.push(entry)}),
  );
  const address = listener.address(),
    origin = 'http://127.0.0.1:' + address.port;
  return {
    root,
    record,
    store,
    service,
    logs,
    origin,
    setClock: value => {
      now = value;
    },
    close: async () => {
      await new Promise(resolve => listener.close(resolve));
      store.close();
      cleanup(root);
    },
  };
};
test('actual HTTP release route verifies packaged bytes without bearer, query or header disclosure', async () => {
  const context = await setup();
  try {
    const response = await fetch(context.origin + '/versionz?token=PRIVATE_QUERY', {
      headers: {Authorization: 'Bearer PRIVATE_HEADER', Cookie: 'PRIVATE_COOKIE=1', Origin: 'https://foreign.invalid'},
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.json();
    assert.equal(body.status, 'matches_build');
    assert.equal(body.build.source_revision, 'a'.repeat(40));
    assert.equal(body.runtime.source_revision, null);
    assert.equal(body.runtime.sha256, context.record.sha256);
    assert.equal(body.runtime.files, 7);
    assert.ok(!JSON.stringify(body).includes('PRIVATE'));
    assert.ok(!JSON.stringify(body).includes(context.root));
    assert.equal(context.logs.length, 0);
    fs.appendFileSync(path.join(context.root, 'web/app.js'), ' changed');
    assert.equal((await (await fetch(context.origin + '/versionz')).json()).status, 'matches_build');
    context.setClock(10000);
    const changed = await fetch(context.origin + '/versionz');
    assert.equal(changed.status, 503);
    const diagnostic = await changed.json();
    assert.equal(diagnostic.status, 'payload_mismatch');
    assert.notEqual(diagnostic.runtime.sha256, diagnostic.build.sha256);
    assert.equal(diagnostic.observed_at, '1970-01-01T00:00:10.000Z');
  } finally {
    await context.close();
  }
});
test('actual health host exemption and MCP bearer boundary remain intact while identity follows host validation', async () => {
  const context = await setup();
  try {
    const forbidden = await rawGet(context.origin + '/versionz', 'foreign.invalid');
    assert.equal(forbidden.status, 403);
    assert.ok(!forbidden.body.includes(context.record.sha256));
    const health = await rawGet(context.origin + '/healthz', 'railway-probe.invalid');
    assert.equal(health.status, 200);
    const body = JSON.parse(health.body);
    assert.deepEqual(Object.keys(body).sort(), ['checked_at', 'checks', 'media_retention', 'status', 'version']);
    assert.equal(body.media_retention.lifetime_minutes, 30);
    assert.equal(body.version, '0.1.0');
    assert.equal(body.status, 'up');
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.mcp, 'ok');
    const mcp = await fetch(context.origin + '/mcp', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    });
    assert.equal(mcp.status, 401);
    const result = await mcp.json();
    assert.equal(result.jsonrpc, '2.0');
    assert.equal(result.error.data.code, 'UNAUTHORIZED');
    assert.equal(context.logs.length, 1);
    assert.equal(context.logs[0].event, 'mcp_refused');
  } finally {
    await context.close();
  }
});
test('actual HTTP malformed build record produces fixed unavailable metadata without private text or root paths', async () => {
  const context = await setup();
  try {
    fs.writeFileSync(path.join(context.root, 'dist/release-identity.json'), 'PRIVATE_RECORD invalid');
    const response = await fetch(context.origin + '/versionz');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      schema_version: 1,
      status: 'unavailable',
      observed_at: '1970-01-01T00:00:00.000Z',
      build: null,
      runtime: null,
      code: 'RELEASE_IDENTITY_UNAVAILABLE',
    });
    assert.equal(context.logs.length, 0);
  } finally {
    await context.close();
  }
});
