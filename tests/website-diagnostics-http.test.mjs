import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {websiteDiagnosticFixture} from './fixtures/website-diagnostics-data.mjs';
import {accountWorkflowFixture} from './fixtures/account-workflows-ui.mjs';
const cases = [
  {
    name: 'missing original OAuth callback state',
    path: '/api/auth/google/callback',
    method: 'GET',
    code: 'OAUTH_STATE_INVALID',
    message: 'The callback is missing its security state.',
    status: 400,
  },
  {
    name: 'malformed original sign-in JSON body',
    path: '/api/session?private=PRIVATE-QUERY',
    method: 'POST',
    body: '{"password":"PRIVATE-PASSWORD","token":"PRIVATE-TOKEN"}X',
    code: 'INVALID_JSON',
    message: 'Request body is not valid JSON.',
    status: 400,
  },
  {
    name: 'invalid original OAuth callback parameters',
    path: '/api/auth/google/callback?state=PRIVATE-STATE&state=PRIVATE-SECOND',
    method: 'GET',
    code: 'OAUTH_CALLBACK_INVALID',
    message: 'The provider returned invalid callback parameters.',
    status: 400,
  },
  {
    name: 'internal website failure',
    path: '/api/platforms',
    method: 'GET',
    code: 'INTERNAL_ERROR',
    message: 'Request could not be processed.',
    status: 500,
    internal: true,
  },
];
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const c of cases)
  test(
    'actual owned HTTP ' +
      c.name +
      ' retains refusal, bilingual display and safe correlatable reference without native calls',
    async () => {
      const site = await websiteDiagnosticFixture();
      try {
        if (c.internal)
          site.store.listConnections = () => {
            throw Error('PRIVATE-INTERNAL-MESSAGE');
          };
        const before = site.evidenceCounts(),
          response = await fetch(site.origin + c.path, {
            method: c.method,
            redirect: 'manual',
            headers: {
              Cookie: site.cookie.name + '=' + site.cookie.value,
              Origin: site.origin,
              'X-Request-ID': 'PRIVATE-CLIENT-REFERENCE',
              ...(c.body ? {'Content-Type': 'application/json'} : {}),
            },
            ...(c.body ? {body: c.body} : {}),
          });
        assert.equal(response.status, c.status);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.deepEqual(result.error, {code: c.code, message: c.message});
        assert.deepEqual(Object.keys(result).sort(), ['error', 'meta']);
        assert.deepEqual(Object.keys(result.meta), ['requestId']);
        assert.match(result.meta.requestId, uuid);
        assert.notEqual(result.meta.requestId, 'PRIVATE-CLIENT-REFERENCE');
        const original = JSON.stringify(result);
        for (const locale of ['en', 'ar']) {
          const ui = accountWorkflowFixture(locale);
          ui.context.response = result;
          ui.context.error = ui.run('requestError(response)');
          const displayed = ui.run('errorMessage(error)');
          assert.ok(displayed.includes(locale === 'ar' ? catalog[c.message] : c.message));
          assert.ok(displayed.includes(result.meta.requestId));
          assert.equal(ui.context.error.code, c.code);
          assert.equal(ui.context.error.message, c.message);
          assert.equal(JSON.stringify(result), original);
        }
        assert.equal(site.logs.length, 1);
        assert.deepEqual(site.logs[0], {
          level: c.status >= 500 ? 'error' : 'warn',
          event: c.status >= 500 ? 'http_failed' : 'http_refused',
          status: c.status,
          code: c.code,
          requestId: result.meta.requestId,
          at: new Date(1791187200000).toISOString(),
        });
        const forbiddenKeys = [
          'password',
          'token',
          'state',
          'cookie',
          'origin',
          'url',
          'query',
          'body',
          'message',
          'stack',
          'headers',
          'details',
        ];
        assert.equal(
          Object.keys(site.logs[0]).some(key => forbiddenKeys.includes(key.toLowerCase())),
          false,
        );
        assert.doesNotMatch(JSON.stringify(site.logs), /PRIVATE/);
        assert.doesNotMatch(original, /PRIVATE/);
        assert.deepEqual(site.evidenceCounts(), before);
        assert.deepEqual(site.counts(), {nativeReads: 0, externalRequests: 0});
      } finally {
        await site.close();
      }
    },
  );
test('website refusal still completes with its reference when the optional diagnostic sink fails', async () => {
  const site = await websiteDiagnosticFixture({throwLog: true});
  try {
    const response = await fetch(site.origin + '/api/auth/google/callback', {
        headers: {Cookie: site.cookie.name + '=' + site.cookie.value},
        redirect: 'manual',
      }),
      result = await response.json();
    assert.equal(response.status, 400);
    assert.deepEqual(result.error, {
      code: 'OAUTH_STATE_INVALID',
      message: 'The callback is missing its security state.',
    });
    assert.match(result.meta.requestId, uuid);
    assert.equal(site.logs.length, 0);
    assert.deepEqual(site.counts(), {nativeReads: 0, externalRequests: 0});
  } finally {
    await site.close();
  }
});
test('MCP early authorization retains its original JSON-RPC contract and existing single log classification', async () => {
  const site = await websiteDiagnosticFixture();
  try {
    const response = await fetch(site.origin + '/mcp', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
      result = await response.json();
    assert.equal(response.status, 401);
    assert.deepEqual(result, {
      jsonrpc: '2.0',
      id: null,
      error: {code: -32000, message: 'Bearer authentication required.', data: {code: 'UNAUTHORIZED'}},
    });
    assert.equal(site.logs.length, 1);
    assert.equal(site.logs[0].event, 'mcp_refused');
    assert.equal(site.logs[0].code, 'UNAUTHORIZED');
    assert.equal(Object.hasOwn(site.logs[0], 'requestId'), false);
    assert.equal(
      site.logs.some(e => e.event.startsWith('http_')),
      false,
    );
    assert.deepEqual(site.counts(), {nativeReads: 0, externalRequests: 0});
  } finally {
    await site.close();
  }
});
