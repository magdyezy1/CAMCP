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
// revalidating a no-cache asset sends If-None-Match alone, as this plain request does.
const revalidate = (url, etag) =>
  new Promise((resolve, reject) =>
    http
      .get(url, {headers: {'if-none-match': etag}}, res => {
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
