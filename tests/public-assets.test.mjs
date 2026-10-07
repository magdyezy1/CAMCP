import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {createContext, Script} from 'node:vm';
import {brotliDecompressSync, gunzipSync} from 'node:zlib';
import {createPublicAssets} from '../dist/server/public-assets.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

function files() {
  const parent = path.join(fs.realpathSync(process.cwd()), '.runtime');
  fs.mkdirSync(parent, {recursive: true});
  assert.equal(fs.realpathSync(parent), parent);
  const directory = fs.mkdtempSync(path.join(parent, 'public-assets-test-'));
  fs.mkdirSync(path.join(directory, 'locales'));
  fs.writeFileSync(path.join(directory, 'theme.js'), fs.readFileSync('web/theme.js'));
  fs.writeFileSync(path.join(directory, 'tokens.css'), ':root { --test: OLDVALUE; }\n');
  fs.writeFileSync(path.join(directory, 'locales/ar.json'), '{"Home":"الرئيسية"}\n');
  fs.writeFileSync(
    path.join(directory, 'index.html'),
    '<html lang="en"><head><script src="/assets/theme.js"></script><link rel="stylesheet" href="/assets/tokens.css"></head><body>Original content</body></html>',
  );
  fs.writeFileSync(path.join(directory, '.private'), 'OWNED-PRIVATE-FIXTURE');
  return {
    directory,
    close() {
      assert.ok(directory.startsWith(parent + path.sep));
      assert.equal(fs.realpathSync(directory), directory);
      fs.rmSync(directory, {recursive: true, force: false});
    },
  };
}
const raw = (url, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    const request = http.request(url, {headers, method}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}),
      );
    });
    request.on('error', reject);
    request.end();
  });
async function serving(bundle) {
  let active = bundle;
  const app = express();
  app.get('/', (_req, res) => res.setHeader('Cache-Control', 'no-store').type('html').send(active.html('index.html')));
  app.use('/assets', (req, res, next) => active.middleware(req, res, next));
  app.use((_req, res) => res.status(404).end());
  const listener = await listenForFetch(app);
  return {
    origin: 'http://127.0.0.1:' + listener.address().port,
    replace(value) {
      active = value;
    },
    close: async () => {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    },
  };
}

test('public page assets share one content identity, preserve the complete original HTML and exclude private files', () => {
  const f = files();
  try {
    const bundle = createPublicAssets(f.directory),
      html = bundle.html('index.html');
    assert.match(bundle.version, /^[0-9a-f]{64}$/);
    const references = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
    assert.equal(references.length, 2);
    for (const reference of references)
      assert.equal(new URL(reference, 'https://amcp.invalid').pathname.split('/')[3], bundle.version);
    assert.equal(
      html.replace(/\/assets\/v\/[0-9a-f]{64}\//g, '/assets/'),
      fs.readFileSync(path.join(f.directory, 'index.html'), 'utf8'),
    );
    fs.writeFileSync(path.join(f.directory, '.private'), 'DIFFERENT-OWNED-PRIVATE-FIXTURE');
    assert.equal(createPublicAssets(f.directory).version, bundle.version);
    assert.doesNotMatch(html, /PRIVATE|cookie|\/api\//);
  } finally {
    f.close();
  }
});

test('a same-size same-mtime deployment gets fresh URLs; an old process retains its exact snapshot and the new one refuses stale versions', async () => {
  const f = files(),
    first = createPublicAssets(f.directory),
    site = await serving(first);
  try {
    const source = path.join(f.directory, 'tokens.css'),
      before = fs.statSync(source),
      original = fs.readFileSync(source),
      oldVersion = first.version;
    const oldUrl = site.origin + '/assets/v/' + oldVersion + '/tokens.css';
    assert.deepEqual((await raw(oldUrl)).body, original);
    fs.writeFileSync(source, original.toString().replace('OLDVALUE', 'NEWVALUE'));
    fs.utimesSync(source, before.atime, before.mtime);
    assert.equal(fs.statSync(source).size, before.size);
    assert.deepEqual((await raw(oldUrl)).body, original, 'An active snapshot cannot silently serve changed files');
    const next = createPublicAssets(f.directory);
    assert.notEqual(next.version, oldVersion);
    site.replace(next);
    const stale = await raw(oldUrl);
    assert.equal(stale.status, 409);
    assert.equal(stale.headers['cache-control'], 'no-store');
    assert.equal(stale.body.toString(), 'ASSET_VERSION_CHANGED');
    const page = await raw(site.origin + '/');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.ok(page.body.toString().includes('/assets/v/' + next.version + '/tokens.css'));
    const fresh = await raw(site.origin + '/assets/v/' + next.version + '/tokens.css');
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body, fs.readFileSync(source));
  } finally {
    await site.close();
    f.close();
  }
});

test('versioned bytes, compression, conditional requests and HEAD agree; malformed versions and hidden paths never expose fixture data', async () => {
  const f = files(),
    bundle = createPublicAssets(f.directory),
    site = await serving(bundle);
  try {
    const url = site.origin + '/assets/v/' + bundle.version + '/theme.js',
      expected = fs.readFileSync(path.join(f.directory, 'theme.js'));
    const plain = await raw(url, {'accept-encoding': 'identity'}),
      br = await raw(url, {'accept-encoding': 'br'}),
      gz = await raw(url, {'accept-encoding': 'gzip'});
    assert.equal(plain.status, 200);
    assert.deepEqual(plain.body, expected);
    assert.deepEqual(brotliDecompressSync(br.body), expected);
    assert.deepEqual(gunzipSync(gz.body), expected);
    assert.notEqual(plain.headers.etag, br.headers.etag);
    assert.notEqual(gz.headers.etag, br.headers.etag);
    assert.match(plain.headers['cache-control'], /immutable/);
    for (const [encoding, response] of [
      ['identity', plain],
      ['br', br],
      ['gzip', gz],
    ]) {
      const head = await raw(url, {'accept-encoding': encoding}, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers.etag, response.headers.etag);
      assert.equal(head.headers['content-length'], response.headers['content-length']);
      const cached = await raw(url, {'accept-encoding': encoding, 'if-none-match': 'W/' + response.headers.etag});
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
    }
    for (const reference of ['/assets/v/invalid/theme.js', '/assets/v/' + bundle.version]) {
      const response = await raw(site.origin + reference);
      assert.equal(response.status, 400);
      assert.doesNotMatch(response.body.toString(), /OWNED-PRIVATE/);
    }
    const hidden = await raw(site.origin + '/assets/v/' + bundle.version + '/.private');
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.length, 0);
  } finally {
    await site.close();
    f.close();
  }
});

function client(scriptUrl) {
  const appended = [],
    listeners = new Map(),
    timers = new Map();
  let timerId = 0;
  const add = (name, callback) => {
    const set = listeners.get(name) ?? new Set();
    set.add(callback);
    listeners.set(name, set);
  };
  const remove = (name, callback) => listeners.get(name)?.delete(callback);
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    uiText: x => x,
    location: {href: 'https://amcp.invalid/campaigns', origin: 'https://amcp.invalid'},
    localStorage: {getItem: () => null, setItem() {}},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    addEventListener: add,
    setTimeout: callback => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    window: {addEventListener: add, removeEventListener: remove},
    document: {
      currentScript: {getAttribute: () => scriptUrl},
      documentElement: {dataset: {}},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({
        remove() {
          this.removed = true;
        },
      }),
      head: {append: script => appended.push(script)},
    },
  });
  const run = text => new Script(text).runInContext(context);
  run(fs.readFileSync('web/theme.js', 'utf8'));
  run(fs.readFileSync('web/route-assets.js', 'utf8'));
  return {run, appended, listeners, timers};
}
test('real theme and lazy loader bind concurrent modules to the delivered version and keep evaluation failures recoverable', async () => {
  const f = files();
  try {
    const bundle = createPublicAssets(f.directory),
      scriptUrl = '/assets/v/' + bundle.version + '/theme.js',
      browser = client(scriptUrl);
    assert.equal(
      browser.run("AMCPAssets.url('/assets/locales/ar.json')"),
      '/assets/v/' + bundle.version + '/locales/ar.json',
    );
    for (const unsafe of [
      'https://foreign.invalid/a.js',
      '/api/session',
      '/assets/../private',
      '/assets/nested/.private',
      '/assets/file.js?secret=x',
      '/assets//file.js',
    ])
      assert.throws(() => browser.run('AMCPAssets.url(' + JSON.stringify(unsafe) + ')'), /INVALID_PUBLIC_ASSET_PATH/);
    const first = browser.run("ensurePageAssets('/campaigns')"),
      second = browser.run("ensurePageAssets('/campaigns')");
    await Promise.resolve();
    assert.equal(browser.appended.length, 2, 'Concurrent callers share original module requests');
    for (const script of browser.appended) {
      assert.ok(script.src.startsWith('/assets/v/' + bundle.version + '/'));
      assert.equal(script.async, false);
      script.onload();
    }
    await Promise.all([first, second]);
    assert.equal(browser.timers.size, 0);
    const refused = client(scriptUrl),
      pending = refused.run("ensurePageAssets('/campaigns')");
    await Promise.resolve();
    for (const listener of [...refused.listeners.get('error')])
      listener({filename: 'https://amcp.invalid' + refused.appended[0].src, message: 'PRIVATE-EVALUATION-DETAIL'});
    refused.appended[1].onload();
    await assert.rejects(
      pending,
      error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED' && !error.message.includes('PRIVATE-EVALUATION-DETAIL'),
    );
    assert.equal(refused.timers.size, 0);
  } finally {
    f.close();
  }
});
