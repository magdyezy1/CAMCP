import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';
import http from 'node:http';

// fetch() adds Cache-Control: no-cache to a request with If-None-Match (Fetch spec), which always forces a 200; a browser
// revalidating a no-cache asset sends If-None-Match with the Accept-Encoding it used before (fetch() sends gzip, deflate).
const revalidate = (url, etag) =>
  new Promise((resolve, reject) =>
    http
      .get(url, {headers: {'if-none-match': etag, 'accept-encoding': 'gzip, deflate'}}, res => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject),
  );

test('static assets revalidate instead of downloading again, and pages stay uncached', async () => {
  const master = Buffer.alloc(32, 92).toString('base64'),
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider traffic');
    }),
  );
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {origin, masterKey: master, adminPassword: 'a-long-test-passphrase', authEnv: {}},
    }),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  try {
    for (const asset of ['/assets/app.js', '/assets/accessibility.css']) {
      const first = await fetch(base + asset);
      assert.equal(first.status, 200, asset);
      await first.arrayBuffer();
      assert.equal(first.headers.get('cache-control'), 'no-cache', asset);
      const etag = first.headers.get('etag');
      assert.ok(etag, asset);
      assert.equal(await revalidate(base + asset, etag), 304, asset);
    }
    const page = await fetch(base + '/connections');
    await page.arrayBuffer();
    assert.equal(page.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise(r => listener.close(r));
    store.close();
  }
});

const raw = (url, headers) =>
  new Promise((resolve, reject) =>
    http
      .get(url, {headers}, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
      })
      .on('error', reject),
  );

test('text assets are served compressed when the browser accepts it, and still revalidate', async () => {
  const {brotliDecompressSync, gunzipSync} = await import('node:zlib');
  const {readFileSync} = await import('node:fs');
  const master = Buffer.alloc(32, 93).toString('base64'),
    origin = 'https://amcp.shop',
    store = new Store(':memory:', master);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      throw Error('No provider traffic');
    }),
  );
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: origin,
      website: {origin, masterKey: master, adminPassword: 'a-long-test-passphrase', authEnv: {}},
    }),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  try {
    const original = readFileSync('web/app.js');
    const br = await raw(base + '/assets/app.js', {'accept-encoding': 'gzip, deflate, br'});
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'Accept-Encoding');
    assert.equal(br.headers['cache-control'], 'no-cache');
    assert.match(br.headers['content-type'], /javascript/);
    assert.ok(brotliDecompressSync(br.body).equals(original));
    assert.ok(br.body.length < original.length / 2, 'at least halves the transfer');
    const gz = await raw(base + '/assets/app.js', {'accept-encoding': 'gzip'});
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gunzipSync(gz.body).equals(original));
    assert.notEqual(gz.headers.etag, br.headers.etag, 'each encoding has its own validator');
    assert.equal(
      (await raw(base + '/assets/app.js', {'accept-encoding': 'br', 'if-none-match': br.headers.etag})).status,
      304,
    );
    // No acceptable encoding, or br refused with q=0: the static handler serves the file as before.
    for (const accept of [undefined, 'identity', 'br;q=0']) {
      const plain = await raw(base + '/assets/app.js', accept ? {'accept-encoding': accept} : {});
      assert.equal(plain.headers['content-encoding'], undefined, String(accept));
      assert.ok(plain.body.equals(original));
    }
    // Nothing outside the asset directory or under a dot segment is reachable through the compressed path.
    for (const path of ['/assets/..%2fpackage.json', '/assets/%2e%2e/package.json', '/assets/.hidden.js'])
      assert.notEqual((await raw(base + path, {'accept-encoding': 'br'})).status, 200, path);
  } finally {
    await new Promise(r => listener.close(r));
    store.close();
  }
});
