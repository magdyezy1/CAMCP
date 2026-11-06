// F-L4-13: a request body AMCP cannot decode is the client's mistake. An unknown Content-Encoding and a corrupt gzip,
// deflate, brotli or zstd body answered 500 INTERNAL_ERROR (logged at error level as http_failed or mcp_failed), on
// /register without any token, because the error handler ignored the status body-parser gave them.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {brotliCompressSync, deflateSync, gzipSync} from 'node:zlib';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {createHttpApp} from '../dist/server/http-app.js';

const origin = 'https://amcp.example',
  master = Buffer.alloc(32, 93).toString('base64'),
  registration = Buffer.from(
    JSON.stringify({
      client_name: 'Synthetic encoding client',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }),
  );

async function fixture(t) {
  const store = new Store(':memory:', master),
    service = new MirrorService(new Registry(), store),
    logs = [],
    app = createHttpApp(service, store, {
      publicOrigin: origin,
      website: {
        origin,
        masterKey: master,
        adminPassword: 'synthetic-encoding-admin-password',
        fetcher: async () => {
          throw Error('No provider traffic allowed');
        },
      },
      log: entry => logs.push(entry),
    }),
    server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port,
    key = store.createKey({tenantId: 'local', userId: 'encoding-reader', role: 'reader'});
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  /** One POST with an exact body and Content-Encoding, over a fresh connection. */
  const post = (path, encoding, body, extra = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            ...(encoding ? {'content-encoding': encoding} : {}),
            ...extra,
          },
        },
        res => {
          let text = '';
          res.on('data', chunk => (text += chunk));
          res.on('end', () => resolve({status: res.statusCode, body: text ? JSON.parse(text) : undefined}));
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  return {post, logs, key, store};
}
const authorized = f => ({authorization: 'Bearer ' + f.key, accept: 'application/json, text/event-stream'});

test('an unknown Content-Encoding is refused with 415 and its own code, on /register and on /mcp', async t => {
  const f = await fixture(t);
  const register = await f.post('/register', 'compress', registration);
  assert.equal(register.status, 415);
  assert.equal(register.body.error.code, 'UNSUPPORTED_ENCODING');
  assert.match(register.body.error.message, /content encoding/);
  const mcp = await f.post(
    '/mcp',
    'compress',
    Buffer.from(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})),
    authorized(f),
  );
  assert.equal(mcp.status, 415);
  assert.equal(mcp.body.jsonrpc, '2.0');
  assert.equal(mcp.body.error.data.code, 'UNSUPPORTED_ENCODING');
  // A character set it does not take is the same kind of mistake with the same answer.
  const charset = await f.post('/register', undefined, registration, {
    'content-type': 'application/json; charset=latin1',
  });
  assert.equal(charset.status, 415);
  assert.equal(charset.body.error.code, 'UNSUPPORTED_ENCODING');
  assert.equal(
    f.logs.some(entry => entry.level === 'error'),
    false,
    'a client mistake is not logged as a failure: ' + JSON.stringify(f.logs.map(entry => [entry.event, entry.status])),
  );
});

test('a corrupt or truncated gzip, deflate or brotli body is refused with 400 and its own code, on /register and on /mcp', async t => {
  const f = await fixture(t),
    cases = [
      ['gzip', Buffer.from('this is not gzip')],
      ['gzip', gzipSync(registration).subarray(0, 12)],
      ['deflate', Buffer.from('this is not deflate')],
      ['br', Buffer.from('this is not brotli')],
      // A label that does not match the bytes: plain JSON declared as zstd.
      ['zstd', registration],
    ];
  for (const [encoding, body] of cases) {
    const register = await f.post('/register', encoding, body);
    assert.equal(register.status, 400, encoding + ' on /register');
    assert.equal(register.body.error.code, 'INVALID_ENCODING');
    const mcp = await f.post('/mcp', encoding, body, authorized(f));
    assert.equal(mcp.status, 400, encoding + ' on /mcp');
    assert.equal(mcp.body.error.data.code, 'INVALID_ENCODING');
  }
  assert.equal(
    f.logs.some(entry => entry.level === 'error'),
    false,
    JSON.stringify(f.logs.map(entry => [entry.event, entry.status, entry.code])),
  );
});

test('bodies that decode, and bodies that are not JSON, are answered as before', async t => {
  const f = await fixture(t);
  for (const [encoding, body] of [
    [undefined, registration],
    ['gzip', gzipSync(registration)],
    ['deflate', deflateSync(registration)],
    ['br', brotliCompressSync(registration)],
  ]) {
    const response = await f.post('/register', encoding, body);
    assert.equal(response.status, 201, String(encoding) + ' ' + JSON.stringify(response.body));
  }
  const notJson = await f.post('/register', undefined, Buffer.from('{not json'));
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, 'INVALID_JSON');
  const compressedNotJson = await f.post('/register', 'gzip', gzipSync(Buffer.from('{not json')));
  assert.equal(compressedNotJson.status, 400);
  assert.equal(compressedNotJson.body.error.code, 'INVALID_JSON');
  const huge = await f.post('/register', undefined, Buffer.alloc(5 * 1024 * 1024, 0x20));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, 'REQUEST_TOO_LARGE');
});
