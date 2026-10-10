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
    for (const link of ['/login', '/privacy', '/terms']) assert.ok(html.includes(' href="' + link + '"'));
    // WEB-02: without JavaScript (or while registration cannot complete) no call to action leads to sign-up.
    assert.ok(!html.includes(' href="/signup"'));
    assert.match(html, /data-open-href="\/signup"/);
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
  // The page is complete without any API. Its script reads only the anonymous registration options, to offer
  // sign-up where a new person can complete it (WEB-02); it reads nothing private.
  assert.deepEqual(
    [...controller.matchAll(/\/api\/[\w/-]*/g)].map(m => m[0]),
    ['/api/account/options'],
  );
  assert.doesNotMatch(controller, /method:|X-AMCP-CSRF|localStorage\.setItem\('amcp\.(?!locale)/);
});

test('About offers sign-up only when the deployment reports that registration can complete', async () => {
  for (const [options, open] of [
    [{registrationAvailable: false, signupEnabled: true, emailEnabled: false, providers: []}, false],
    [{registrationAvailable: true}, true],
    [null, false],
  ]) {
    const elements = [
        {href: '/login', 'data-open-href': '/signup', 'data-open-text': 'Make yourself at home'},
        {href: '/login', 'data-open-href': '/signup', 'data-open-text': 'Create an account'},
      ].map(attributes => ({
        attributes: {...attributes, 'data-ui-text': 'Sign in to your workspace'},
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      })),
      note = {hidden: false};
    let applied = 0;
    const context = {
      document: {
        getElementById: () => ({textContent: ''}),
        querySelectorAll: selector =>
          selector === '[data-registration-cta]' ? elements : selector === '[data-registration-note]' ? [note] : [],
      },
      fetch: async url => {
        assert.equal(url, '/api/account/options');
        if (!options) throw Error('offline');
        return {ok: true, json: async () => options};
      },
      initializeUILocale() {},
      applyUILocale: () => applied++,
    };
    const source = readFileSync('web/about.js', 'utf8'),
      startup = 'initializeUILocale();\napplyRegistration();\n';
    assert.ok(source.endsWith(startup), 'About applies the registration state when it loads');
    const run = new Function(...Object.keys(context), source.slice(0, -startup.length) + '\nreturn applyRegistration;');
    await run(...Object.values(context))();
    for (const element of elements)
      assert.equal(element.attributes.href, open ? '/signup' : '/login', JSON.stringify(options));
    assert.equal(elements[0].attributes['data-ui-text'], open ? 'Make yourself at home' : 'Sign in to your workspace');
    assert.equal(note.hidden, open);
    assert.equal(applied, open ? 1 : 0);
  }
});
