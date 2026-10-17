// WEB-07: the Arabic catalog (web/locales/ar.json, 1.9 MB at 91 % of its 2 MiB cap) was one download that gated every
// Arabic page: About fetched all of it to translate 54 strings, and the workspace asked who was signed in only after
// it arrived. tools/locale-chunks.mjs generates bounded chunks; a page loads the shell's and its own. These tests guard
// the committed chunks, what each page requests, and the parallel session request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {chunkLimit, localeChunkProblems, moduleChunk, planLocaleChunks} from '../tools/locale-chunks.mjs';

const plan = planLocaleChunks();

test('the committed chunks are fresh, bounded, carry every message once a page has its own, and stay complete', () => {
  assert.deepEqual(localeChunkProblems(process.cwd(), plan), []);
  const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
    names = Object.keys(plan.chunks);
  for (const name of names) {
    const bytes = fs.statSync('web/locales/ar/' + name + '.json').size;
    assert.ok(bytes <= chunkLimit, name + ': ' + bytes);
  }
  // Every catalog message is in some chunk, with its translation unchanged.
  const merged = Object.assign({}, ...names.map(name => plan.chunks[name]));
  assert.deepEqual(Object.keys(merged).sort(), Object.keys(catalog).sort());
  for (const [key, value] of Object.entries(merged)) assert.equal(value, catalog[key]);
  // The shell a public page loads is a fraction of the catalog it used to wait for.
  const shell = fs.statSync('web/locales/ar/shell.json').size,
    source = fs.statSync('web/locales/ar.json').size;
  assert.ok(shell < source * 0.2, shell + ' of ' + source);
  // Each lazily loaded page script has its chunk, named after it.
  for (const file of plan.modules) assert.ok(names.includes(moduleChunk(file)), file);
  assert.deepEqual(names.slice(0, 3), ['shell', 'workspace', 'providers']);
  assert.match(fs.readFileSync('tools/check-web.mjs', 'utf8'), /localeChunkProblems\(/);
});

test('a chunk that drops a message a script requires, a stale chunk and an oversized chunk are refused', () => {
  const clone = {...plan, chunks: Object.fromEntries(Object.entries(plan.chunks).map(([k, v]) => [k, {...v}]))};
  // A message only owner-operations.js writes, removed from its chunk: Settings would show it in English.
  const owned = Object.keys(clone.chunks['owner-operations'])[0];
  assert.ok(owned);
  delete clone.chunks['owner-operations'][owned];
  const problems = localeChunkProblems(process.cwd(), clone).join('\n');
  assert.match(problems, /web\/locales\/ar\/owner-operations\.json is stale/);
  assert.ok(
    problems.includes('Arabic message in no chunk: ' + owned) ||
      problems.includes('web/owner-operations.js requires a message none of its chunks carries: ' + owned),
  );
  const large = {...plan, chunks: {...plan.chunks, shell: {...plan.chunks.shell, Huge: 'ا'.repeat(chunkLimit)}}};
  assert.match(localeChunkProblems(process.cwd(), large).join('\n'), /shell\.json: \d+ bytes \(limit 1048576\)/);
});

/** localization.js, the registry and the loader in a page, with a recording fetch that serves the shipped chunks. */
function page({locale = 'ar', version, answer} = {}) {
  const requests = [],
    appended = [];
  const context = createContext({
    URL,
    Map,
    Set,
    Promise,
    Response,
    TextDecoder,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    location: {href: 'https://amcp.invalid/', origin: 'https://amcp.invalid', pathname: '/'},
    localStorage: {getItem: key => (key === 'amcp.locale' ? locale : null), setItem() {}},
    window: {addEventListener() {}, removeEventListener() {}},
    document: {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({remove() {}}),
      // Every feature script "loads" at once: this page only measures the catalog requests.
      head: {append: script => (appended.push(script.src), queueMicrotask(() => script.onload()))},
    },
    fetch: async (url, options) => {
      requests.push({url, options});
      if (answer) return answer(url);
      const file = 'web/' + url.replace(/^\/assets\/(?:v\/[0-9a-f]{64}\/)?/, '');
      return new Response(fs.readFileSync(file, 'utf8'));
    },
  });
  const run = code => new Script(code).runInContext(context);
  if (version) run(`const AMCPAssets = {url: path => '/assets/v/${version}/' + path.slice(8)};`);
  for (const file of ['localization.js', 'routes.js', 'route-assets.js']) run(fs.readFileSync('web/' + file, 'utf8'));
  return {context, run, requests, appended, chunks: () => requests.map(r => r.url.replace(/^.*\/locales\/ar\//, ''))};
}

test('About and the public pages load the shell chunk only; a signed-in page adds the workspace and its scripts', async () => {
  const p = page();
  await p.run('initializeUILocale()');
  assert.deepEqual(p.chunks(), ['shell.json']);
  assert.equal(p.run('uiLocale'), 'ar');
  // Public pages need nothing more.
  for (const route of ['/', '/login', '/signup']) {
    assert.deepEqual(Array.from(p.run(`pageLocaleChunks(${JSON.stringify(route)})`)), []);
    assert.equal(p.run(`pageAssetsPending(${JSON.stringify(route)})`), false);
  }
  // Connections has no feature script, yet as a signed-in page it needs the workspace's messages.
  assert.deepEqual(Array.from(p.run("pageLocaleChunks('/connections')")), ['workspace', 'providers']);
  assert.equal(p.run("pageAssetsPending('/connections')"), true);
  await p.run("ensurePageAssets('/connections')");
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json', 'providers.json']);
  assert.equal(p.run("pageAssetsPending('/connections')"), false);
  // Settings adds its two scripts' chunks, requested beside the scripts themselves; nothing is fetched twice.
  await p.run("ensurePageAssets('/settings')");
  assert.deepEqual(p.chunks().slice(3).sort(), ['account-approvals.json', 'owner-operations.json']);
  assert.deepEqual(p.appended, ['/assets/owner-operations.js', '/assets/account-approvals.js']);
  // A message only owner-operations.js writes now reads in Arabic.
  const owned = Object.keys(plan.chunks['owner-operations']).find(key => !key.includes('{'));
  p.context.owned = owned;
  assert.equal(p.run('uiText(owned)'), plan.chunks['owner-operations'][owned]);
  // Back in English nothing is fetched, and choosing Arabic again loads every chunk this page has needed.
  const versions = p.requests.length;
  p.context.confirmAction = async () => true;
  p.context.render = async () => {};
  p.context.toast = () => {};
  await p.run("changeUILocale('en')");
  assert.equal(p.run('uiText(owned)'), owned);
  assert.equal(p.requests.length, versions, 'Cached chunks are not fetched again');
  await p.run("changeUILocale('ar')");
  assert.equal(p.run('uiText(owned)'), plan.chunks['owner-operations'][owned]);
});

test('English pages fetch no catalog, versioned chunks may come from the cache, and a failed chunk offers a retry', async () => {
  const english = page({locale: 'en'});
  await english.run('initializeUILocale()');
  await english.run("ensurePageAssets('/connections')");
  assert.deepEqual(english.requests, []);
  const version = 'a'.repeat(64),
    versioned = page({version});
  await versioned.run('initializeUILocale()');
  assert.equal(versioned.requests[0].url, '/assets/v/' + version + '/locales/ar/shell.json');
  assert.equal(versioned.requests[0].options.cache, 'default', 'An immutable snapshot address needs no revalidation');
  const unversioned = page();
  await unversioned.run('initializeUILocale()');
  assert.equal(unversioned.requests[0].options.cache, 'no-cache');
  // A chunk that cannot be downloaded fails the page with the retryable asset error and changes no message.
  let fail = true;
  const flaky = page({
    answer: url =>
      fail && url.includes('workspace')
        ? new Response('', {status: 503})
        : new Response(fs.readFileSync('web/' + url.slice(8), 'utf8')),
  });
  await flaky.run('initializeUILocale()');
  const before = flaky.run('uiMessages.size');
  await assert.rejects(flaky.run("ensurePageAssets('/activity')"), error => error.code === 'PAGE_ASSET_UNAVAILABLE');
  assert.equal(flaky.run('uiMessages.size'), before);
  assert.equal(flaky.run("pageAssetsPending('/activity')"), true);
  fail = false;
  await flaky.run("ensurePageAssets('/activity')");
  assert.ok(flaky.run('uiMessages.size') > before);
  // After a deploy the old snapshot's chunk answers 409: only a reload can help.
  const updated = page({
    version,
    answer: url =>
      url.endsWith('/shell.json')
        ? new Response(fs.readFileSync('web/locales/ar/shell.json', 'utf8'))
        : new Response('ASSET_VERSION_CHANGED', {status: 409}),
  });
  await updated.run('initializeUILocale()');
  await assert.rejects(
    updated.run("ensurePageAssets('/activity')"),
    error => error.code === 'PAGE_ASSET_RELOAD_REQUIRED',
  );
});

/** The workspace's boot (web/app.js) at a page, answering /api/session with `answer`; the page's files are recorded. */
function boot(pathname, answer, available = () => true) {
  const app = fs.readFileSync('web/app.js', 'utf8'),
    start = app.indexOf('(async () => {\n  // All deferred feature scripts'),
    code = app.slice(start, app.indexOf('})();', start) + 5),
    events = [];
  let catalogArrived;
  const context = createContext({
    document: {readyState: 'complete', body: {classList: {contains: () => false}}},
    location: {hash: '', pathname},
    pageAssetsFor: path => (path === '/settings' ? ['owner-operations.js', 'account-approvals.js'] : []),
    loadPageAsset: async file => events.push('script ' + file),
    pageLocaleChunks: () => ['workspace', 'providers', 'owner-operations', 'account-approvals'],
    uiPrefetchChunks: chunks => events.push('chunks ' + chunks.join(' ')),
    routeAvailable: (path, who) => available(path, who),
    initializeUILocale: () => {
      events.push('catalog requested');
      return new Promise(resolve => (catalogArrived = resolve));
    },
    api: async path => {
      events.push('request ' + path);
      return answer;
    },
    refresh: async () => events.push('render'),
    fragmentTarget: () => null,
  });
  const running = new Script(code).runInContext(context);
  return {events, context, running, arrive: () => catalogArrived()};
}

test('the workspace asks who is signed in while the shell chunk downloads (regression: it waited for the catalog)', async () => {
  const f = boot('/settings', {authenticated: true});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    f.events,
    [
      'request /api/session',
      'catalog requested',
      // The signed-in page's files start as soon as the session answers, before the shell chunk has arrived.
      'script owner-operations.js',
      'script account-approvals.js',
      'chunks workspace providers owner-operations account-approvals',
    ],
    'Everything the first page needs starts before the catalog arrives',
  );
  f.arrive();
  await f.running;
  assert.deepEqual(f.events.at(-1), 'render', 'The page still renders after both');
  assert.equal(f.context.session.authenticated, true);
});

test('a signed-out or out-of-scope visitor downloads no page files (regression: they started before the session answered)', async () => {
  // Signed out at a signed-in page, and a test account at a page outside its scope: only the session and the shell
  // chunk are requested, and the page still renders (the sign-in or scope notice).
  for (const f of [
    boot('/settings', {authenticated: false}),
    boot('/settings', {authenticated: true, testAccount: true}, (path, who) => !who.testAccount),
  ]) {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.events, ['request /api/session', 'catalog requested']);
    f.arrive();
    await f.running;
    assert.deepEqual(f.events, ['request /api/session', 'catalog requested', 'render']);
  }
});
