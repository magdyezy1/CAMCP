import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {createHttpApp} from '../dist/server/http-app.js';
import {createPublicAssets, securityTxt, securityTxtExpires} from '../dist/server/public-assets.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

// WEB-02: the public trust surface. Terms and Data deletion used to be workspace views that needed JavaScript, a
// session and healthy APIs; unknown addresses, robots.txt, security.txt and favicon.ico got Express's default page.
async function site(authEnv = {}) {
  const master = Buffer.alloc(32, 77).toString('base64'),
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
      website: {origin: 'https://amcp.invalid', masterKey: master, authEnv},
    }),
  );
  const base = 'http://127.0.0.1:' + listener.address().port;
  return {
    get: (route, init = {}) => fetch(base + route, {redirect: 'manual', ...init}),
    providerCalls: () => providerCalls,
    sessions: () => store.db.prepare('SELECT count(*) AS n FROM amcp_web_sessions').get().n,
    async close() {
      const closed = new Promise(resolve => listener.close(resolve));
      listener.closeAllConnections();
      await closed;
      store.close();
    },
  };
}

test('Terms and Data deletion are complete static pages in English and Arabic without a session or JavaScript', async () => {
  const s = await site(),
    publicAssets = createPublicAssets('web');
  try {
    for (const [route, name] of [
      ['/terms', 'terms'],
      ['/data-deletion', 'data-deletion'],
    ])
      for (const [query, locale] of [
        ['', 'en'],
        ['?lang=en', 'en'],
        ['?lang=ar', 'ar'],
        ['?lang=fr', 'en'],
        ['?lang=en&lang=ar', 'en'],
      ])
        for (const method of ['GET', 'HEAD']) {
          const response = await s.get(route + query, {method}),
            body = await response.text();
          assert.equal(response.status, 200, route + query);
          assert.equal(response.headers.get('set-cookie'), null);
          assert.equal(response.headers.get('content-language'), locale);
          assert.match(response.headers.get('content-type'), /^text\/html/);
          assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
          if (method === 'HEAD') {
            assert.equal(body, '');
            continue;
          }
          const file = name + (locale === 'ar' ? '-ar' : '') + '.html';
          assert.equal(body, publicAssets.html(file));
          assert.equal(
            body.replace(/\/assets\/v\/[0-9a-f]{64}\//g, '/assets/'),
            fs.readFileSync('web/' + file, 'utf8'),
          );
          // The whole text is in the document: no workspace shell, no content scripts.
          assert.doesNotMatch(body, /Opening your workspace|id="content"/);
          assert.deepEqual(
            [...body.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]),
            ['<script src="/assets/v/' + publicAssets.version + '/theme.js">'],
          );
          assert.match(body, locale === 'ar' ? /<html lang="ar" dir="rtl">/ : /<html lang="en" dir="ltr">/);
          // The contact the privacy policy already publishes, and a dated document.
          assert.match(body, /mailto:privacy@amcp\.shop/);
          // Data deletion was updated for self-service deletion and the P3 retention periods (SEC-07). The Terms take
          // effect on the day of the push that published them, as the owner approved on 2026-10-18 (D3).
          assert.match(
            body,
            name === 'data-deletion' ? /<time datetime="2026-10-12">/ : /<time datetime="2026-10-18">/,
          );
          assert.match(body, new RegExp('href="' + route + '\\?lang=en"'));
          assert.match(body, new RegExp('href="' + route + '\\?lang=ar"'));
          assert.match(body, /href="\/about"/);
          for (const anchor of body.matchAll(/href="#([^"]+)"/g)) assert.ok(body.includes('id="' + anchor[1] + '"'));
        }
    assert.equal(s.sessions(), 0);
    assert.equal(s.providerCalls(), 0);
  } finally {
    await s.close();
  }
});

test('the Terms state both deployment modes, independent of any session, and both languages keep one structure', () => {
  for (const name of ['terms', 'data-deletion']) {
    const en = fs.readFileSync('web/' + name + '.html', 'utf8'),
      ar = fs.readFileSync('web/' + name + '-ar.html', 'utf8'),
      article = html => html.match(/<article>[\s\S]*?<\/article>/)[0],
      // Linked destinations must match; only the language of a same-site page differs.
      tags = html => [...article(html).matchAll(/<[^>]+>/g)].map(m => m[0].replace(/\?lang=(?:en|ar)"/, '?lang="')),
      sections = html => [...html.matchAll(/<section id="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(sections(ar), sections(en), name);
    assert.deepEqual(tags(ar), tags(en), name + ': every paragraph, list and link has a translated counterpart');
    for (const html of [en, ar]) {
      assert.ok(html.includes('privacy@amcp.shop'));
      for (const anchor of html.matchAll(/href="#([^"]+)"/g)) assert.ok(html.includes('id="' + anchor[1] + '"'));
    }
  }
  const terms = fs.readFileSync('web/terms.html', 'utf8');
  assert.match(terms, /Read-only:/);
  assert.match(terms, /Reviewed writes:/);
  const deletion = fs.readFileSync('web/data-deletion.html', 'utf8');
  // Meta asks for data deletion instructions: the page names each step and how to request account deletion.
  for (const step of ['Disconnect', 'revoke', 'Delete your account or workspace', 'backup'])
    assert.ok(deletion.includes(step), step);
  // SEC-07, owner decision P3: the page used to say no self-service deletion existed; it now leads to Account and
  // states the retention periods.
  assert.doesNotMatch(deletion, /does not yet have a self-service delete/);
  for (const text of ['<a href="/account">Account</a>', 'erased after 30 days', 'erased 90 days later', '365 days'])
    assert.ok(deletion.includes(text), text);
});

test('robots.txt and security.txt answer with their own types; security.txt takes the owner contact', async () => {
  const s = await site({AMCP_SECURITY_CONTACT: 'mailto:security@example.test'});
  try {
    const robots = await s.get('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    const rules = await robots.text();
    for (const rule of ['Disallow: /api/', 'Disallow: /authorize', 'Disallow: /oauth/', 'Disallow: /assets/v/*.html'])
      assert.ok(rules.includes(rule), rule);
    const security = await s.get('/.well-known/security.txt');
    assert.equal(security.status, 200);
    assert.match(security.headers.get('content-type'), /^text\/plain/);
    const text = await security.text();
    assert.match(text, /^Contact: mailto:security@example\.test$/m);
    assert.match(text, /^Canonical: https:\/\/amcp\.invalid\/\.well-known\/security\.txt$/m);
    // Expires is the reviewed date, the same on every response, not renewed 90 days ahead each time (RFC 9116).
    const expiresLine = new RegExp('^Expires: ' + securityTxtExpires.replaceAll('.', '\\.') + '$', 'm');
    assert.match(text, expiresLine);
    assert.equal(await (await s.get('/.well-known/security.txt')).text(), text);
  } finally {
    await s.close();
  }
  // An absent or malformed contact falls back to the published privacy contact; it never echoes arbitrary text.
  for (const value of [undefined, '', 'not a uri', 'mailto:a@b.test\nContact: https://evil.invalid'])
    assert.match(
      securityTxt('https://amcp.shop', value === undefined ? {} : {AMCP_SECURITY_CONTACT: value}),
      /^Contact: mailto:privacy@amcp\.shop\nExpires: /,
    );
  // The owner's reviewed date replaces the default; anything else keeps the default.
  assert.match(
    securityTxt('https://amcp.shop', {AMCP_SECURITY_TXT_EXPIRES: '2027-01-31'}),
    /^Expires: 2027-01-31T00:00:00\.000Z$/m,
  );
  for (const value of ['soon', '2027-01-31\nContact: https://evil.invalid'])
    assert.match(
      securityTxt('https://amcp.shop', {AMCP_SECURITY_TXT_EXPIRES: value}),
      new RegExp('^Expires: ' + securityTxtExpires.replaceAll('.', '\\.') + '$', 'm'),
    );
});

// Package brand: the site's icons are the brand kit's binary files. Browsers ask for /favicon.ico and iOS for
// /apple-touch-icon.png without any markup, so both root addresses point to the file at its own versioned address,
// whose type matches its path (temporary, because the version changes with every deployment).
test('favicon.ico and apple-touch-icon.png answer at their root addresses and under /assets with the kit’s exact bytes', async () => {
  const s = await site();
  try {
    for (const [root, file, type] of [
      ['/favicon.ico', 'favicon.ico', 'image/vnd.microsoft.icon'],
      ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
    ]) {
      const bytes = fs.readFileSync('web/' + file),
        encodings = {'accept-encoding': 'br, gzip'};
      for (const method of ['GET', 'HEAD']) {
        const moved = await s.get(root, {method});
        assert.equal(moved.status, 302, method + ' ' + root);
        assert.equal(moved.headers.get('cache-control'), 'no-cache', root);
        assert.match(
          moved.headers.get('location'),
          new RegExp('^/assets/v/[0-9a-f]{64}/' + file.replace('.', '\\.') + '$'),
        );
        assert.equal(moved.headers.get('set-cookie'), null);
      }
      const location = (await s.get(root)).headers.get('location');
      // The versioned address: immutable, the file's own bytes, no transfer encoding and no text conversion.
      const versioned = await s.get(location, {headers: encodings});
      assert.equal(versioned.status, 200, location);
      assert.equal(versioned.headers.get('content-type'), type, location);
      assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable', location);
      assert.equal(versioned.headers.get('content-encoding'), null, location);
      assert.equal(versioned.headers.get('content-length'), String(bytes.length), location);
      assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), bytes, location);
      const head = await s.get(location, {method: 'HEAD', headers: encodings});
      assert.equal(head.status, 200, location);
      assert.equal(head.headers.get('content-length'), String(bytes.length), location);
      // The unversioned address keeps working and revalidates.
      const plain = await s.get('/assets/' + file, {headers: encodings});
      assert.equal(plain.status, 200, file);
      assert.equal(plain.headers.get('content-type'), type, file);
      assert.equal(plain.headers.get('cache-control'), 'no-cache', file);
      assert.equal(plain.headers.get('content-encoding'), null, file);
      assert.deepEqual(Buffer.from(await plain.arrayBuffer()), bytes, file);
    }
    assert.equal(s.sessions(), 0);
    assert.equal(s.providerCalls(), 0);
  } finally {
    await s.close();
  }
});

test('unknown pages get the branded 404 with the website policy; API, MCP, assets and OAuth discovery keep theirs', async () => {
  const s = await site();
  try {
    for (const [route, locale] of [
      ['/no-such-page', 'en'],
      ['/no-such-page?lang=ar', 'ar'],
      ['/Privacy', 'en'],
      ['/deep/unknown/path', 'en'],
    ]) {
      const response = await s.get(route),
        body = await response.text();
      assert.equal(response.status, 404, route);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('content-language'), locale);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.match(body, locale === 'ar' ? /الصفحة غير موجودة/ : /Page not found/);
      assert.doesNotMatch(body, /Cannot GET/);
    }
    const api = await s.get('/api/unknown');
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type'), /^application\/json/);
    assert.equal((await api.json()).error.code, 'NOT_FOUND');
    const posted = await s.get('/api/unknown', {method: 'POST'});
    assert.equal(posted.status, 404);
    assert.equal((await posted.json()).error.code, 'NOT_FOUND');
    const mcp = await s.get('/mcp');
    assert.equal(mcp.status, 401);
    await mcp.arrayBuffer();
    const missingAsset = await s.get('/assets/no-such-file.js');
    assert.equal(missingAsset.status, 404);
    assert.doesNotMatch(await missingAsset.text(), /Page not found/);
    for (const route of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      const discovery = await s.get(route);
      assert.equal(discovery.status, 200, route);
      assert.match(discovery.headers.get('content-type'), /json/);
      await discovery.arrayBuffer();
    }
    const wellKnown = await s.get('/.well-known/unknown');
    assert.equal(wellKnown.status, 404);
    assert.doesNotMatch(await wellKnown.text(), /Page not found/);
  } finally {
    await s.close();
  }
});

test('page templates are never served as assets, versioned or not', async () => {
  const s = await site(),
    version = createPublicAssets('web').version;
  try {
    for (const route of [
      '/assets/v/' + version + '/privacy.html',
      '/assets/v/' + version + '/index.html',
      '/assets/privacy.html',
      '/assets/terms-ar.html',
    ]) {
      const response = await s.get(route);
      assert.equal(response.status, 404, route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.text()).includes('<html'), false);
    }
    const asset = await s.get('/assets/v/' + version + '/privacy.css');
    assert.equal(asset.status, 200);
    await asset.arrayBuffer();
  } finally {
    await s.close();
  }
});

test('the public liveness probe carries the shared security headers and keeps its status semantics', async () => {
  const s = await site();
  try {
    const response = await s.get('/healthz');
    assert.ok([200, 503].includes(response.status));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.arrayBuffer();
  } finally {
    await s.close();
  }
});
