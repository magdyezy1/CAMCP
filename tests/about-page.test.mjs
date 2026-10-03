import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

test('About is publicly readable without account APIs or advertising access', async () => {
  const master = Buffer.alloc(32, 92).toString('base64'),
    store = new Store(':memory:', master);
  let providerCalls = 0;
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async () => {
      providerCalls++;
      throw Error('Unexpected provider request');
    }),
  );
  const listener = await listenForFetch(
    createHttpApp(service, store, {
      publicOrigin: 'https://amcp.invalid',
      website: {origin: 'https://amcp.invalid', masterKey: master, authEnv: {}},
    }),
  );
  try {
    const response = await fetch('http://127.0.0.1:' + listener.address().port + '/about');
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(html, /<h1[^>]*>.*Advertising deserves a clearer workspace\./);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.match(html, /href="#main"/);
    for (const link of ['/login', '/signup', '/privacy', '/terms']) assert.ok(html.includes('href="' + link + '"'));
    assert.equal(providerCalls, 0);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    store.close();
  }
});

test('About provides complete authored Arabic copy and first-party-only assets', () => {
  const html = readFileSync('web/about.html', 'utf8'),
    catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  for (const match of html.matchAll(/data-ui-(?:text|label)="([^"]+)"/g)) {
    assert.equal(typeof catalog[match[1]], 'string', match[1]);
    assert.match(catalog[match[1]], /[\u0600-\u06ff]/, match[1]);
  }
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer>/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['/assets/localization.js', '/assets/about.js']);
  assert.ok(!/on(?:click|load)=|<style\b|style="|src="https?:/.test(html));
  const controller = readFileSync('web/about.js', 'utf8');
  assert.ok(!/\/api\//.test(controller));
});
