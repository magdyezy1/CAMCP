// WEB-04: an open page outlives a deploy. Its asset snapshot is then superseded, and the server answers 409
// ASSET_VERSION_CHANGED for every file of it. These tests guard that the page recognizes that state (a reload, never a
// "Try again" loop), that the unversioned cold path no longer blocks the event loop, and that every asset a page
// references is bound to the page's own snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {Script, createContext} from 'node:vm';
import {brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createPublicAssets} from '../dist/server/public-assets.js';
import {compressedAssets} from '../dist/server/compressed-assets.js';
import {listenForFetch} from '../dist/tests/http-listener.js';

const version = 'a'.repeat(64);
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));

/** The real theme (asset identity) and lazy loader, in a page delivered with snapshot `version`. */
function loader(fetcher) {
  const appended = [],
    requests = [],
    timers = new Map();
  let timerId = 0;
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    uiText: x => x,
    location: {href: 'https://amcp.invalid/reports', origin: 'https://amcp.invalid'},
    localStorage: {getItem: () => null, setItem() {}},
    matchMedia: () => ({matches: false, addEventListener() {}}),
    addEventListener() {},
    setTimeout: callback => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    AbortController,
    window: {addEventListener() {}, removeEventListener() {}},
    document: {
      currentScript: {getAttribute: () => '/assets/v/' + version + '/theme.js'},
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
    ...(fetcher
      ? {
          fetch: async (url, options) => {
            requests.push({url, options});
            return fetcher(url, options);
          },
        }
      : {}),
  });
  const run = text => new Script(text).runInContext(context);
  run(fs.readFileSync('web/theme.js', 'utf8'));
  // The loader reads each page's assets from the route registry (WEB-07).
  run(fs.readFileSync('web/routes.js', 'utf8'));
  run(fs.readFileSync('web/route-assets.js', 'utf8'));
  return {run, appended, requests, timers, load: route => run('ensurePageAssets(' + JSON.stringify(route) + ')')};
}

test('a route bundle refused after a deploy (409) asks for a reload instead of offering Try again', async () => {
  const page = loader(async () => ({status: 409, ok: false}));
  const pending = page.load('/reports');
  const refused = assert.rejects(
    pending,
    error =>
      error.code === 'PAGE_ASSET_RELOAD_REQUIRED' &&
      error.updated === true &&
      error.message === 'AMCP was updated. Reload to continue.',
  );
  await tick();
  const first = page.appended[0];
  assert.ok(first.src.startsWith('/assets/v/' + version + '/'));
  await first.onerror();
  await refused;
  // One bounded probe of the exact failed address, never cached and never following a redirect.
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, first.src);
  assert.equal(page.requests[0].options.method, 'HEAD');
  assert.equal(page.requests[0].options.cache, 'no-store');
  assert.equal(page.requests[0].options.redirect, 'error');
  assert.ok(page.requests[0].options.signal, 'The probe is bounded by a timeout');
  assert.equal(first.removed, true);
  // Retrying could never succeed: the same address is not requested again in this document.
  const count = page.appended.length;
  await assert.rejects(page.load('/reports'), error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED');
  assert.equal(page.appended.length, count);
});

test('a network failure or a current snapshot keeps the retryable download error, and the retry loads again', async () => {
  for (const answer of [
    async () => ({status: 200, ok: true}),
    async () => ({status: 404, ok: false}),
    async () => {
      throw TypeError('Failed to fetch');
    },
  ]) {
    // /account requests the QR vendor file and the QR script together: neither captures the other while it
    // initializes any more (WEB-07), and scripts inserted with async=false still run in the order they were requested.
    const page = loader(answer),
      pending = page.load('/account'),
      refused = assert.rejects(
        pending,
        error => error.code === 'PAGE_ASSET_UNAVAILABLE' && error.updated === undefined,
      );
    await tick();
    assert.equal(page.appended.length, 2);
    await page.appended[0].onerror();
    await refused;
    assert.equal(page.requests.length, 1);
    const retry = page.load('/account');
    await tick();
    assert.equal(page.appended.length, 3, 'A retryable failure inserts that script again, and only that one');
    assert.equal(page.appended[2].src, page.appended[0].src);
    page.appended[1].onload();
    page.appended[2].onload();
    await retry;
  }
});

test('an unversioned page never probes: only snapshot addresses can be superseded', async () => {
  // A page served without a version (a legacy link) loads unversioned files; their failure stays retryable.
  const appended = [];
  const legacy = createContext({
    URL,
    Map,
    Set,
    Promise,
    uiText: x => x,
    location: {href: 'https://amcp.invalid/reports', origin: 'https://amcp.invalid'},
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async () => {
      throw Error('No probe expected');
    },
    window: {addEventListener() {}, removeEventListener() {}},
    document: {createElement: () => ({remove() {}}), head: {append: script => appended.push(script)}},
  });
  new Script(fs.readFileSync('web/routes.js', 'utf8')).runInContext(legacy);
  new Script(fs.readFileSync('web/route-assets.js', 'utf8')).runInContext(legacy);
  const pending = new Script("ensurePageAssets('/operations')").runInContext(legacy),
    refused = assert.rejects(pending, error => error.code === 'PAGE_ASSET_UNAVAILABLE');
  await tick();
  assert.equal(appended[0].src, '/assets/operations-center.js');
  await appended[0].onerror();
  await refused;
});

/** localization.js with a catalog fetch answered by `answer`, and the page's reload prompt stubbed. */
function localized(answer, {withReloadPrompt = true, confirm = true} = {}) {
  const stored = new Map(),
    toasts = [],
    prompts = [];
  let reloads = 0;
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    Error,
    TextDecoder,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    localStorage: {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value)},
    fetch: async (...args) => answer(...args),
    toast: message => toasts.push(message),
    confirmAction: async () => true,
    render: async () => {},
    document: {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    ...(withReloadPrompt
      ? {
          reloadForUpdate: async prepare => {
            prompts.push(prepare);
            if (!confirm) return false;
            prepare?.();
            reloads++;
            return true;
          },
        }
      : {}),
  });
  new Script(fs.readFileSync('web/localization.js', 'utf8')).runInContext(context);
  const run = text => new Script(text).runInContext(context);
  return {run, stored, toasts, prompts, reloads: () => reloads};
}

test('the Arabic catalog refused after a deploy (409) asks for a reload and reopens in Arabic once confirmed', async () => {
  const requested = [];
  const page = localized(async (url, options) => {
    requested.push({url, options});
    return {status: 409, ok: false, body: null};
  });
  await assert.rejects(
    page.run("uiCatalog('ar')"),
    error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED' && error.message === 'AMCP was updated. Reload to continue.',
  );
  assert.equal(await page.run("changeUILocale('ar')"), false);
  assert.equal(page.prompts.length, 1, 'The update prompt is offered instead of "Language catalog unavailable"');
  assert.equal(page.reloads(), 1);
  assert.equal(page.stored.get('amcp.locale'), 'ar', 'The reloaded page opens in the chosen language');
  assert.deepEqual(page.toasts, []);
  assert.equal(page.run('uiLocale'), 'en', 'The current view stays in its language until the reload');

  const declined = localized(async () => ({status: 409, ok: false, body: null}), {confirm: false});
  assert.equal(await declined.run("changeUILocale('ar')"), false);
  assert.equal(declined.prompts.length, 1);
  assert.equal(declined.reloads(), 0);
  assert.equal(declined.stored.has('amcp.locale'), false, 'Declining keeps the saved language unchanged');

  // A page without the workspace prompt still says why, instead of a generic catalog failure.
  const plain = localized(async () => ({status: 409, ok: false, body: null}), {withReloadPrompt: false});
  await plain.run("changeUILocale('ar')");
  assert.deepEqual(plain.toasts, ['AMCP was updated. Reload to continue.']);

  // Other failures keep the existing message.
  const offline = localized(async () => {
    throw TypeError('Failed to fetch');
  });
  await offline.run("changeUILocale('ar')");
  assert.equal(offline.prompts.length, 0);
  assert.deepEqual(offline.toasts, ['The language could not be loaded. Your current view is unchanged.']);
});

/** app.js page-error and reload behavior, with only the DOM it touches. */
function workspace(locale = 'en') {
  const elements = new Map(),
    reloads = [];
  const node = selector => {
    if (!elements.has(selector)) {
      const listeners = new Map();
      elements.set(selector, {
        innerHTML: '',
        textContent: '',
        returnValue: '',
        dataset: {},
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: type => listeners.delete(type),
        querySelector: node,
        querySelectorAll: () => [],
        focus() {},
        remove() {},
        setAttribute() {},
        showModal() {
          this.open = true;
        },
        close(value) {
          this.open = false;
          if (value !== undefined) this.returnValue = value;
          listeners.get('close')?.();
        },
        click: () => listeners.get('click')?.({preventDefault() {}}),
      });
    }
    return elements.get(selector);
  };
  const context = createContext({
    URL,
    URLSearchParams,
    Intl,
    location: {pathname: '/reports', search: '', hash: '', reload: () => reloads.push(true)},
    history: {pushState() {}, replaceState() {}},
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    localStorage: {getItem: () => null, setItem() {}},
    setTimeout: () => 1,
    clearTimeout() {},
    window: {addEventListener() {}},
    document: {
      body: {classList: {toggle() {}}},
      querySelector: node,
      getElementById: id => node('#' + id),
      querySelectorAll: () => [],
      addEventListener() {},
    },
  });
  const run = source => new Script(source).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run(fs.readFileSync('web/routes.js', 'utf8'));
  const app = fs.readFileSync('web/app.js', 'utf8'),
    startup = app.indexOf('(async () => {'),
    startupEnd = app.indexOf('})();', startup) + '})();'.length;
  run(app.slice(0, startup) + app.slice(startupEnd));
  context.catalog = catalog;
  if (locale === 'ar') run("uiLocale='ar'; uiMessages=new Map(Object.entries(catalog))");
  return {run, node, reloads, context};
}

test('the page error after a deploy is titled "AMCP was updated", offers Reload (not Try again) in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    const page = workspace(locale),
      text = key => (locale === 'ar' ? catalog[key] : key);
    page.context.uiHasUnsavedEdits = () => false;
    page.run(
      "showPageError(Object.assign(Error(uiText('AMCP was updated. Reload to continue.')), {code:'PAGE_ASSET_RELOAD_REQUIRED', updated:true}))",
    );
    const html = page.node('#content').innerHTML;
    assert.ok(html.includes(text('AMCP was updated') + '</h1>'), locale);
    assert.ok(html.includes(text('AMCP was updated. Reload to continue.')), locale);
    assert.ok(html.includes(text('Reload page')), locale);
    assert.ok(!html.includes(text('Try again')), locale);
    await page.node('[data-retry-page]').click();
    assert.equal(page.reloads.length, 1, 'A pristine page reloads at once');
  }
});

test('a reload never discards unsaved edits silently: the person confirms, or the page stays', async () => {
  for (const choice of ['cancel', 'confirm']) {
    const page = workspace();
    page.context.uiHasUnsavedEdits = () => true;
    page.run(
      "showPageError({code:'PAGE_ASSET_RELOAD_REQUIRED', updated:true, message:'AMCP was updated. Reload to continue.'})",
    );
    const clicked = page.node('[data-retry-page]').click();
    await tick();
    assert.equal(page.node('#action-dialog').open, true, 'The unsaved-edit guard asks first');
    assert.equal(page.node('#action-title').textContent, 'Reload AMCP?');
    assert.match(page.node('#action-copy').textContent, /Unsaved edits on this page will be cleared/);
    page.node('#action-dialog').close(choice);
    await clicked;
    assert.equal(page.reloads.length, choice === 'confirm' ? 1 : 0, choice);
  }
  for (const [unsaved, choice] of [
    [false, 'confirm'],
    [true, 'cancel'],
  ]) {
    const page = workspace();
    page.context.uiHasUnsavedEdits = () => unsaved;
    let prepared = 0;
    page.context.prepare = () => prepared++;
    const pending = page.run('reloadForUpdate(prepare)');
    await tick();
    assert.equal(page.node('#action-title').textContent, 'AMCP was updated');
    assert.equal(
      page.node('#action-copy').textContent,
      unsaved
        ? 'Reload to continue. Unsaved edits on this page will be cleared, so save them first. Saved work is kept.'
        : 'Reload to continue. Saved work is kept.',
    );
    page.node('#action-dialog').close(choice);
    assert.equal(await pending, choice === 'confirm');
    assert.equal(page.reloads.length, choice === 'confirm' ? 1 : 0);
    assert.equal(prepared, choice === 'confirm' ? 1 : 0, 'Preparation runs only for a confirmed reload');
  }
});

function scratch() {
  const parent = path.join(fs.realpathSync(process.cwd()), '.runtime');
  fs.mkdirSync(parent, {recursive: true});
  const directory = fs.mkdtempSync(path.join(parent, 'asset-skew-test-'));
  return {
    directory,
    close() {
      assert.ok(directory.startsWith(parent + path.sep));
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

test('the first unversioned Brotli request compresses off the event loop (no stall above 100 ms)', async () => {
  // Before WEB-04 this path ran brotliCompressSync at quality 11: about 1.9 s of blocked event loop for the Arabic
  // catalog, on every attempt. A cold process and other processes competing for the CPU can also delay this loop, so
  // the server and zlib are warmed first, each attempt uses fresh (cold-cache) middleware, and the best of up to three
  // attempts must stay under 100 ms.
  const f = scratch(),
    bytes = fs.readFileSync('web/locales/ar.json'),
    delays = [];
  fs.mkdirSync(path.join(f.directory, 'locales'));
  fs.writeFileSync(path.join(f.directory, 'locales/ar.json'), bytes);
  fs.writeFileSync(path.join(f.directory, 'warm.txt'), 'warm');
  try {
    for (let attempt = 0; attempt < 3 && !(delays.length && Math.min(...delays) < 100); attempt++) {
      const app = express();
      app.use('/assets', compressedAssets(f.directory), (_req, res) => res.status(404).end());
      const listener = await listenForFetch(app),
        histogram = monitorEventLoopDelay({resolution: 5});
      try {
        const origin = 'http://127.0.0.1:' + listener.address().port,
          url = origin + '/assets/locales/ar.json';
        assert.equal((await raw(origin + '/assets/warm.txt', {'accept-encoding': 'br'})).status, 200);
        histogram.enable();
        const [first, second] = await Promise.all([
          raw(url, {'accept-encoding': 'br'}),
          raw(url, {'accept-encoding': 'br'}),
        ]);
        histogram.disable();
        delays.push(histogram.max / 1e6);
        for (const response of [first, second]) {
          assert.equal(response.status, 200);
          assert.equal(response.headers['content-encoding'], 'br');
          assert.equal(response.headers['cache-control'], 'no-cache');
          assert.deepEqual(brotliDecompressSync(response.body), bytes);
        }
        assert.equal(first.headers.etag, second.headers.etag);
        const revalidated = await raw(url, {'accept-encoding': 'br', 'if-none-match': first.headers.etag});
        assert.equal(revalidated.status, 304);
      } finally {
        histogram.disable();
        listener.closeAllConnections();
        await new Promise(resolve => listener.close(resolve));
      }
    }
    assert.ok(Math.min(...delays) < 100, 'Event-loop delays were ' + delays.map(Math.round).join(', ') + ' ms');
  } finally {
    f.close();
  }
});

test('versioned stylesheets bind their url() files to the same snapshot; the version stays computed from source bytes', async () => {
  const f = scratch();
  fs.mkdirSync(path.join(f.directory, 'fonts'));
  const font = Buffer.alloc(4096, 7),
    css =
      "@font-face { src: url('/assets/fonts/Test.ttf') format('truetype'); }\n.a { background: url(/assets/mark.svg); }\n.b { background: url('/assets/missing.png'); }\n";
  fs.writeFileSync(path.join(f.directory, 'fonts/Test.ttf'), font);
  fs.writeFileSync(path.join(f.directory, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(f.directory, 'site.css'), css);
  const bundle = createPublicAssets(f.directory),
    app = express();
  app.use('/assets', (req, res, next) => bundle.middleware(req, res, next));
  const listener = await listenForFetch(app),
    origin = 'http://127.0.0.1:' + listener.address().port;
  try {
    const sha = value => createHash('sha256').update(value).digest('hex'),
      expectedVersion = sha(
        'AMCP_PUBLIC_ASSETS_V1\0' +
          [
            ['fonts/Test.ttf', font],
            ['mark.svg', fs.readFileSync(path.join(f.directory, 'mark.svg'))],
            ['site.css', Buffer.from(css)],
          ]
            .map(([name, body]) => name + '\0' + sha(body))
            .join('\n'),
      );
    assert.equal(bundle.version, expectedVersion, 'Rewriting served bytes does not change the snapshot identity');
    const served = await raw(origin + '/assets/v/' + bundle.version + '/site.css', {'accept-encoding': 'identity'}),
      text = served.body.toString('utf8');
    assert.equal(served.status, 200);
    assert.ok(text.includes("url('/assets/v/" + bundle.version + "/fonts/Test.ttf')"));
    assert.ok(text.includes('url(/assets/v/' + bundle.version + '/mark.svg)'));
    assert.ok(text.includes("url('/assets/missing.png')"), 'A reference outside the snapshot is left unchanged');
    assert.equal(served.headers.etag, '"' + sha(served.body) + '"', 'The ETag names the bytes actually served');
    const fontResponse = await raw(origin + '/assets/v/' + bundle.version + '/fonts/Test.ttf', {
      'accept-encoding': 'br',
    });
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers['content-encoding'], 'br', 'The Arabic font is compressed');
    assert.match(fontResponse.headers['cache-control'], /immutable/);
    assert.deepEqual(brotliDecompressSync(fontResponse.body), font);
    assert.ok(fontResponse.body.length < font.length);
    const conditional = await raw(origin + '/assets/v/' + bundle.version + '/site.css', {
      'accept-encoding': 'identity',
      'if-none-match': served.headers.etag,
    });
    assert.equal(conditional.status, 304);
  } finally {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
    f.close();
  }
});

test('served HTML, CSS and JavaScript reference /assets/ only through the page snapshot (allow-listed builders aside)', async () => {
  const bundle = createPublicAssets('web'),
    unversioned = text => [...text.matchAll(/\/assets\/(?!v\/[0-9a-f]{64}\/)[^"'()\s]*/g)].map(m => m[0]);
  for (const page of [
    'index.html',
    'about.html',
    'privacy.html',
    'privacy-ar.html',
    'terms.html',
    'terms-ar.html',
    'data-deletion.html',
    'data-deletion-ar.html',
    '404.html',
    '404-ar.html',
  ])
    assert.deepEqual(unversioned(bundle.html(page)), [], page);
  const app = express();
  app.use('/assets', (req, res, next) => bundle.middleware(req, res, next));
  const listener = await listenForFetch(app);
  try {
    for (const file of fs.readdirSync('web').filter(name => name.endsWith('.css'))) {
      const response = await raw(
        'http://127.0.0.1:' + listener.address().port + '/assets/v/' + bundle.version + '/' + file,
        {'accept-encoding': 'identity'},
      );
      assert.equal(response.status, 200, file);
      assert.deepEqual(unversioned(response.body.toString('utf8')), [], file);
    }
  } finally {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
  // JavaScript builds addresses at run time, so its literals must pass through the snapshot helpers. The allow-list
  // holds the helpers themselves and the locale fallback for a page served without a snapshot.
  const allowed = [
    ['theme.js', "return version ? '/assets/v/' + version + '/' + path.slice(8) : path;"],
    ['route-assets.js', "originalPath = '/assets/' + file,"],
    [
      'localization.js',
      "typeof AMCPAssets === 'object' ? AMCPAssets.url('/assets/locales/ar.json') : '/assets/locales/ar.json',",
    ],
  ];
  const offenders = [];
  for (const file of fs.readdirSync('web', {recursive: true}).filter(name => String(name).endsWith('.js'))) {
    const name = String(file).replaceAll('\\', '/');
    if (name.startsWith('vendor/')) continue;
    for (const line of fs.readFileSync(path.join('web', name), 'utf8').split('\n')) {
      if (!line.includes('/assets/')) continue;
      const stripped = line.replace(/(?:publicAssetUrl|AMCPAssets\.url)\('\/assets\/[A-Za-z0-9_./-]+'\)/g, '');
      if (!stripped.includes('/assets/')) continue;
      if (allowed.some(([allowedFile, text]) => allowedFile === name && line.trim() === text)) continue;
      offenders.push(name + ': ' + line.trim().slice(0, 160));
    }
  }
  assert.deepEqual(offenders, []);
});
