import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp, tuneListener, type HttpOptions} from '../server/http-app.js';
import type {JsonObject} from '../src/types.js';

// The owner, from live use (F-88): on 2026-09-24 every call, even the offline help text, returned "Connection closed"
// while the app showed AMCP as connected. A dropout must say why, leave a log line, and show in the health check.
async function serve(options: HttpOptions = {}) {
  const store = new Store(':memory:'),
    service = new MirrorService(new Registry(), store),
    logs: JsonObject[] = [],
    listener = await listenForFetch(createHttpApp(service, store, {...options, log: entry => logs.push(entry)})),
    base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const key = store.createKey({tenantId: 'availability', userId: 'reader', role: 'reader'});
  return {
    store,
    logs,
    base,
    key,
    close: async () => {
      await new Promise<void>(r => listener.close(() => r()));
      if (store.db.isOpen) store.close();
    },
  };
}
const rpc = {jsonrpc: '2.0', id: 7, method: 'tools/list'};
const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + '/mcp', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers},
  });

test('the health check runs the database and the offline help through MCP', async () => {
  const s = await serve();
  try {
    const up = await fetch(s.base + '/healthz');
    assert.equal(up.status, 200);
    const body = await up.json();
    assert.equal(body.status, 'up');
    // An in-memory database has no disk to measure.
    assert.deepEqual(body.checks, {database: 'ok', disk: 'unknown', mcp: 'ok'});
    assert.match(body.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await s.close();
  }
});

test('a database that stops working turns the health check to 503 within its ten-second window', async () => {
  let now = Date.parse('2026-09-29T12:00:00Z');
  const s = await serve({clock: () => now});
  try {
    assert.equal((await fetch(s.base + '/healthz')).status, 200);
    s.store.db.close();
    // Still cached: a probe storm cannot turn the health check into load.
    assert.equal((await fetch(s.base + '/healthz')).status, 200);
    now += 10001;
    const down = await fetch(s.base + '/healthz');
    assert.equal(down.status, 503);
    const body = await down.json();
    assert.equal(body.status, 'unavailable');
    assert.equal(body.checks.database, 'failed');
    assert.deepEqual(
      Object.keys(body).sort(),
      ['checked_at', 'checks', 'media_retention', 'status', 'version'],
      'no internal identifiers',
    );
    assert.equal(body.media_retention.lifetime_minutes, 30);
    assert.equal(body.media_retention.cleanup_interval_ms, 15000);
  } finally {
    await new Promise<void>(r => setTimeout(r, 0));
    await s.close().catch(() => {});
  }
});

test('MCP refusals are JSON-RPC errors that say why, and each leaves a log line without the token', async () => {
  const s = await serve();
  try {
    const noBearer = await post(s.base, rpc);
    assert.equal(noBearer.status, 401);
    const unauthorized = await noBearer.json();
    assert.equal(unauthorized.jsonrpc, '2.0');
    // The token is checked before the body is read, so the refusal cannot name the request id.
    assert.equal(unauthorized.id, null);
    assert.equal(unauthorized.error.data.code, 'UNAUTHORIZED');
    const browser = await post(s.base, rpc, {Authorization: 'Bearer ' + s.key, Origin: 'https://claude.ai'});
    assert.equal(browser.status, 403);
    const refused = await browser.json();
    assert.equal(refused.error.data.code, 'FORBIDDEN_ORIGIN');
    assert.match(refused.error.message, /https:\/\/claude\.ai.*AMCP_MCP_ALLOWED_ORIGINS/);
    const malformed = await post(s.base, '{', {Authorization: 'Bearer ' + s.key});
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, -32700);
    assert.deepEqual(
      s.logs.map(l => [l.event, l.status, l.code]),
      [
        ['mcp_refused', 401, 'UNAUTHORIZED'],
        ['mcp_refused', 403, 'FORBIDDEN_ORIGIN'],
        ['mcp_refused', 400, 'INVALID_JSON'],
      ],
    );
    assert.equal(JSON.stringify(s.logs).includes(s.key), false);
    assert.equal(s.logs[1]!.origin, 'https://claude.ai');
  } finally {
    await s.close();
  }
});

test('the owner can allow an exact MCP client origin; every other origin stays refused', async () => {
  const s = await serve({mcpAllowedOrigins: ['https://claude.ai']});
  try {
    const client = new Client({name: 'origin-allowed', version: '1'});
    await client.connect(
      new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), {
        requestInit: {headers: {Authorization: 'Bearer ' + s.key, Origin: 'https://claude.ai'}},
      }),
    );
    const help = await client.callTool({name: 'amcp_tool_help', arguments: {}});
    assert.deepEqual(JSON.parse((help.content as any)[0].text), help.structuredContent);
    assert.equal((help.structuredContent as any).data.surface, 'compact-v1');
    await client.close();
    assert.equal(
      (await post(s.base, rpc, {Authorization: 'Bearer ' + s.key, Origin: 'https://evil.example'})).status,
      403,
    );
  } finally {
    await s.close();
  }
  assert.throws(
    () =>
      createHttpApp(new MirrorService(new Registry(), new Store(':memory:')), new Store(':memory:'), {
        mcpAllowedOrigins: ['https://claude.ai/path'],
      }),
    /exact origin/,
  );
});

test('idle keep-alive connections outlast the usual proxy idle timeouts', () => {
  const listener = createServer();
  tuneListener(listener);
  assert.equal(listener.keepAliveTimeout, 65000);
  assert.equal(listener.requestTimeout, 45000);
  assert.equal(listener.headersTimeout, 10000);
});
