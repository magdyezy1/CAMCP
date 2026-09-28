import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';
import {activityReportErrors} from '../src/report-errors.js';
import type {JsonObject} from '../src/types.js';

const key = Buffer.alloc(32, 61).toString('base64');
const diagnostic = {
  operation: 'account_sync',
  platform: 'google',
  connection_id: 'synthetic-google',
  account_id: '1234567890',
  asset_kind: 'ad_accounts',
  code: 'PROVIDER_ACCESS_DENIED',
  http_status: 403,
  provider: {
    code: 'AUTHORIZATION_ERROR',
    message: 'Authorization of the client failed.',
    request_id: 'synthetic-google-trace',
  },
  request: {stage: 'account_lookup', method: 'POST', path: '/v25/customers/1234567890/googleAds:search'},
  login_customer_id: '1234567890',
};

test('recent activity selects the newest tenant rows before limiting, without changing audit cursor order or integrity', () => {
  const store = new Store(':memory:', key);
  try {
    for (let i = 0; i < 140; i++) {
      store.appendAudit('workspace-a', 'request-' + i, {event: 'event-' + i});
      store.appendAudit('workspace-b', 'other-' + i, {event: 'other-' + i});
    }
    const rows = store.recentAudit('workspace-a', 100) as JsonObject[];
    assert.equal(rows.length, 100);
    assert.equal(rows[0]!.request_id, 'request-139');
    assert.equal(rows.at(-1)!.request_id, 'request-40');
    assert.ok(rows.every((r, i) => r.tenant_id === 'workspace-a' && (!i || r.seq < rows[i - 1]!.seq)));
    const first = store.audit('workspace-a', 2) as JsonObject[];
    assert.deepEqual(
      first.map(r => r.request_id),
      ['request-0', 'request-1'],
    );
    assert.equal((store.audit('workspace-a', 1, first[1]!.seq)[0] as JsonObject).request_id, 'request-2');
    assert.equal(store.verifyAudit(), true);
    assert.deepEqual(store.recentAudit('empty-workspace'), []);
  } finally {
    store.close();
  }
});

test('Activity includes fresh reauthorization diagnostics after more than 100 events and excludes other tenants and secrets', async () => {
  const store = new Store(':memory:', key),
    service = new MirrorService(new Registry(), store),
    origin = 'https://amcp.shop';
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      website: {
        origin,
        masterKey: key,
        adminPassword: 'synthetic-activity-password',
        tenantId: 'workspace-a',
        fetcher: async () => {
          throw Error('Unexpected provider request');
        },
      },
    }),
  );

  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(base + path, {redirect: 'manual', ...init}),
      bytes = await response.arrayBuffer();
    return new Response(bytes, {status: response.status, headers: response.headers});
  };
  try {
    for (let i = 0; i < 125; i++) store.appendAudit('workspace-a', 'old-' + i, {event: 'old-event-' + i});
    store.appendAudit('workspace-a', 'new-google-failure', {
      event: 'website_oauth_reauthorization_failed',
      platform: 'google',
      connection_id: 'synthetic-google',
      error: {
        code: 'REAUTHORIZATION_ACCESS_FAILED',
        message: 'Fresh Google authorization did not verify account access.',
      },
      diagnostics: [{...diagnostic, access_token: 'synthetic-private-token'}],
    });
    store.appendAudit('workspace-b', 'private-other-tenant', {event: 'private-other-tenant'});
    assert.equal((await request('/api/activity')).status, 401);
    const login = await request('/api/session', {
      method: 'POST',
      headers: {Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({password: 'synthetic-activity-password'}),
    });
    assert.equal(login.status, 200);
    const response = await request('/api/activity', {
      headers: {Cookie: login.headers.get('set-cookie')!.split(';')[0]!},
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as JsonObject;
    assert.equal(result.events.length, 100);
    assert.ok(result.events.every((e: JsonObject, i: number) => !i || e.id < result.events[i - 1].id));
    const event = result.events.find((e: JsonObject) => e.event.event === 'website_oauth_reauthorization_failed');
    assert.ok(event);
    assert.equal(event.diagnostics[0].provider.request_id, 'synthetic-google-trace');
    assert.equal(event.diagnostics[0].request.path, diagnostic.request.path);
    assert.equal(event.diagnostics[0].account_id, diagnostic.account_id);
    assert.ok(!result.events.some((e: JsonObject) => e.event.event === 'old-event-0'));
    assert.ok(!JSON.stringify(result).includes('private-other-tenant'));
    assert.ok(!JSON.stringify(result).includes('synthetic-private-token'));
    assert.equal(store.verifyAudit(), true);
  } finally {
    await new Promise<void>(resolve => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
    store.close();
  }
});

test('reauthorization Activity projections keep only bounded account-sync diagnostics', () => {
  const projected = activityReportErrors({
    event: 'website_oauth_reauthorization_failed',
    diagnostics: [null, {operation: 'unrelated'}, diagnostic],
  });
  assert.deepEqual(projected, [diagnostic]);
  assert.equal(
    activityReportErrors({
      event: 'website_oauth_reauthorization_failed',
      diagnostics: Array.from({length: 101}, () => diagnostic),
    }).length,
    100,
  );
  assert.deepEqual(
    activityReportErrors({event: 'website_oauth_reauthorization_failed', diagnostics: {unexpected: true}}),
    [],
  );
});
