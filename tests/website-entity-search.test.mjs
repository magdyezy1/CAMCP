import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

/**
 * WEB-09 (owner opt-in), website side: the command palette ("Search workspace") lists matching pages at once and,
 * after a short pause, this workspace's plans, reports, media and accounts from POST /api/workspace-search. These tests
 * run the real palette script in a VM with a synthetic `api`: the only request is the search itself, a result only
 * navigates, a newer query or another identity discards an older answer, and signing out or switching workspace clears
 * the cached results. tests/workspace-search.test.ts covers the server side (identity scope, no provider request).
 */
const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  identity = readFileSync('web/identity.js', 'utf8'),
  app = readFileSync('web/app.js', 'utf8'),
  palette = identity.slice(
    identity.indexOf('// The palette lists the route registry'),
    identity.indexOf('function openCommand('),
  ),
  privateState = app.slice(app.indexOf('let session ='), app.indexOf('function resetTabState('));
const t = (locale, text) => (locale === 'ar' ? catalog[text] : text);

function fixture(
  locale = 'en',
  session = {authenticated: true, id: 'alice', workspaceId: 'acme', workspaceRole: 'operator'},
) {
  const nodes = new Map(),
    requests = [],
    timers = [];
  let answer = async () => ({results: []});
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        addEventListener() {},
      });
    return nodes.get(selector);
  };
  const context = createContext({
    catalog,
    Intl,
    Date,
    URLSearchParams,
    $: node,
    content: node('#content'),
    document: {querySelector: node, querySelectorAll: () => [], addEventListener() {}},
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    setTimeout: fn => timers.push(fn),
    clearTimeout() {},
    toastTimer: 0,
    api: async (url, options = {}) => {
      requests.push({url, method: options.method ?? 'GET', body: options.body});
      return answer(JSON.parse(options.body ?? '{}'));
    },
  });
  const run = source => new Script(source).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  run(privateState);
  context.fixtureSession = session;
  run('session = fixtureSession;');
  run(readFileSync('web/routes.js', 'utf8'));
  run(readFileSync('web/workspace.js', 'utf8'));
  run(palette);
  return {
    context,
    run,
    node,
    requests,
    timers,
    respond(fn) {
      answer = fn;
    },
    type(query) {
      node('#command-query').value = query;
      run('commandResults(); commandEntitySearch();');
    },
    entities: () => node('#command-entities').innerHTML,
    results: () => node('#command-results').innerHTML,
  };
}
const found = {
  results: [
    {kind: 'plan', id: 'plan-1', label: 'Acme spring launch', detail: 'complete', href: '/campaigns?id=plan-1'},
    {kind: 'report', id: 'view-1', label: 'Acme · Weekly', detail: '', href: '/reporting-overview?view_id=view-1'},
    {
      kind: 'account',
      id: '123',
      label: 'Acme <Main>',
      detail: 'meta_native_action · Login',
      href: '/connections?connection_id=c1',
    },
    {kind: 'unknown', id: 'x', label: 'Ignored kind', detail: '', href: '/x'},
  ],
};

for (const locale of ['en', 'ar'])
  test(
    locale + ': the palette finds pages at once and workspace entities after a pause, with one search request',
    async () => {
      const f = fixture(locale);
      f.respond(async () => found);
      f.type('acme');
      assert.match(f.results(), /id="command-entities"/);
      assert.ok(f.results().includes(t(locale, 'In this workspace')));
      assert.ok(f.entities().includes(t(locale, 'Searching this workspace…')));
      assert.equal(f.requests.length, 0, 'nothing is sent until the pause ends');
      assert.equal(f.timers.length, 1);
      await f.timers[0]();
      assert.deepEqual(f.requests, [{url: '/api/workspace-search', method: 'POST', body: '{"q":"acme"}'}]);
      const html = f.entities();
      assert.deepEqual(
        [...html.matchAll(/data-command-go="([^"]+)"/g)].map(m => m[1]),
        ['/campaigns?id=plan-1', '/reporting-overview?view_id=view-1', '/connections?connection_id=c1'],
      );
      assert.ok(html.includes(t(locale, 'Campaign plan')));
      assert.ok(html.includes(t(locale, 'Saved report')));
      assert.ok(html.includes('<bdi dir="auto">Acme &lt;Main&gt;</bdi>'), 'names are escaped and isolated');
      assert.ok(html.includes('<bdi dir="ltr">123</bdi>'), 'IDs are isolated left to right');
      assert.doesNotMatch(html, /Ignored kind/);
      assert.doesNotMatch(html, /<button(?![^>]*data-command-go)/, 'every result only navigates');
      // The same query again is answered from this identity's cache, without another request.
      f.type('acme');
      assert.equal(f.requests.length, 1);
      assert.equal(f.entities(), html);
      // An empty answer and a refused search say so; the pages stay listed.
      f.respond(async () => ({results: []}));
      f.type('zzzz');
      await f.timers.at(-1)();
      assert.ok(f.entities().includes(t(locale, 'Nothing in this workspace matches.')));
      f.respond(async () => {
        throw Object.assign(Error('Refused'), {code: 'TEST_ACCOUNT_SCOPE'});
      });
      f.type('yyyy');
      await f.timers.at(-1)();
      assert.ok(
        f.entities().includes(t(locale, 'Workspace search is unavailable right now. Pages are still listed above.')),
      );
    },
  );

test('a newer query wins over an older answer, and a short query or a test account never searches', async () => {
  const f = fixture();
  let release;
  f.respond(({q}) => (q === 'acme' ? new Promise(r => (release = () => r(found))) : Promise.resolve({results: []})));
  f.type('acme');
  const older = f.timers[0]();
  f.type('globex');
  await f.timers[1]();
  release();
  await older;
  assert.ok(f.entities().includes('Nothing in this workspace matches.'), 'the older answer is discarded');
  assert.doesNotMatch(f.entities(), /Acme spring launch/);
  // One character lists pages only.
  const before = f.timers.length;
  f.type('a');
  assert.doesNotMatch(f.results(), /command-entities/);
  assert.equal(f.timers.length, before);
  // A test account keeps the page list only: its areas are limited, and the route refuses it.
  const reviewer = fixture('en', {authenticated: true, id: 'reviewer', testAccount: true, workspaceRole: 'owner'});
  reviewer.type('acme');
  assert.doesNotMatch(reviewer.results(), /command-entities/);
  assert.equal(reviewer.timers.length, 0);
  assert.equal(reviewer.requests.length, 0);
  // Signed out: no search either.
  const visitor = fixture('en', {authenticated: false});
  visitor.type('acme');
  assert.equal(visitor.timers.length, 0);
});

test('answers last while the palette is open: opening it again searches again (regression: kept until a reload)', async () => {
  const f = fixture();
  f.respond(async () => ({results: []}));
  f.type('spring');
  await f.timers[0]();
  // Typing the same query while the palette stays open is answered from the cache.
  f.type('spring');
  assert.equal(f.requests.length, 1);
  // A plan named "Spring" saved since: the palette opened again asks the workspace, and finds it.
  f.respond(async () => found);
  f.run('commandSearchOpened()');
  f.type('spring');
  await f.timers.at(-1)();
  assert.equal(f.requests.length, 2);
  assert.match(f.entities(), /Acme spring launch/);
  // openCommand is what calls it, before the first search of the opened palette.
  const open = identity.slice(identity.indexOf('function openCommand('));
  assert.ok(open.indexOf('commandSearchOpened();') < open.indexOf('commandEntitySearch();'));
  // A working client keeps its own answers: the same query for another client is asked separately.
  f.context.workingClientQuery = () => ({profile_id: 'profile-b'});
  f.type('spring');
  await f.timers.at(-1)();
  assert.equal(f.requests.length, 3);
  assert.deepEqual(JSON.parse(f.requests.at(-1).body), {q: 'spring', profile_id: 'profile-b'});
});

test('another identity discards a pending answer, and resetPrivateState clears the cached results', async () => {
  const f = fixture();
  f.respond(async () => found);
  f.type('acme');
  await f.timers[0]();
  assert.equal(f.run('commandSearchCache.size'), 1);
  // A search in flight when the identity changes is never shown to the next identity.
  let release;
  f.respond(() => new Promise(r => (release = () => r(found))));
  f.type('spring');
  const pending = f.timers.at(-1)();
  f.run('resetPrivateState()');
  assert.equal(f.run('commandSearchCache.size'), 0, 'the previous identity’s results are forgotten');
  f.node('#command-entities').innerHTML = '';
  release();
  await pending;
  assert.equal(f.entities(), '');
  assert.equal(f.run('commandSearchCache.size'), 0);
  // The next identity searches again rather than reusing what the previous one found.
  f.respond(async () => ({results: []}));
  f.type('acme');
  await f.timers.at(-1)();
  assert.equal(f.requests.filter(r => JSON.parse(r.body).q === 'acme').length, 2);
  assert.ok(f.requests.every(r => r.url === '/api/workspace-search' && r.method === 'POST'));
});
