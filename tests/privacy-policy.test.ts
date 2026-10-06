import {listenForFetch} from './http-listener.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {createHttpApp} from '../server/http-app.js';

test('the full privacy policy is public HTML without redirects, login, JavaScript or provider requests', async () => {
  const key = Buffer.alloc(32, 91).toString('base64'),
    store = new Store(':memory:', key);
  const app = createHttpApp(new MirrorService(new Registry(), store), store, {
    website: {
      origin: 'https://amcp.shop',
      masterKey: key,
      authEnv: {},
      fetcher: async () => {
        throw Error('Public privacy page must not contact a provider');
      },
    },
  });
  const listener = await listenForFetch(app);
  const base = 'http://127.0.0.1:' + (listener.address() as {port: number}).port;
  try {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(base + '/privacy', {
          method,
          redirect: 'manual',
          headers: {'User-Agent': 'Java/1.8.0_332'},
        }),
        body = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(response.headers.get('location'), null);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      if (method === 'HEAD') {
        assert.equal(body, '');
        continue;
      }
      assert.equal(body, readFileSync('web/privacy.html', 'utf8'));
      assert.match(body, /<h1>Privacy policy/);
      assert.match(body, /analytics\.readonly/);
      assert.match(body, /AES-256-GCM/);
      assert.match(body, /scrypt/);
      assert.match(body, /Limited Use/);
      assert.match(body, /Retention and deletion/);
      // Customer lists and offline conversions (personal-data policy of 2026-09-30) and the Data Manager permission.
      assert.match(body, /datamanager/);
      assert.match(body, /hashed with SHA-256 in memory/);
      assert.doesNotMatch(body, /<iframe\b|Opening your workspace/i);
      assert.deepEqual(
        [...body.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]),
        ['<script src="/assets/theme.js">'],
      );
      for (const anchor of body.matchAll(/href="#([^"]+)"/g))
        assert.ok(body.includes('id="' + anchor[1] + '"'), 'Section anchor exists: ' + anchor[1]);
    }
    const css = await fetch(base + '/assets/privacy.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
    await css.text();
    const protectedResponse = await fetch(base + '/api/activity');
    assert.equal(protectedResponse.status, 401);
    await protectedResponse.text();
    const arbitraryFile = await fetch(base + '/privacy.css');
    assert.equal(arbitraryFile.status, 404);
    await arbitraryFile.text();
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM amcp_web_sessions').get()!.n, 0);
  } finally {
    const closed = new Promise<void>(r => listener.close(() => r()));
    listener.closeAllConnections();
    await closed;
    store.close();
  }
});
