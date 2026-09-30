import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(fetcher) {
  const nodes = new Map(),
    location = {pathname: '/activity', search: '', hash: ''};
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: '',
        textContent: '',
        hidden: false,
        lastElementChild: {textContent: ''},
        classList: {toggle() {}},
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        focus() {},
        querySelector: s => node(selector + ' ' + s),
      });
    return nodes.get(selector);
  };
  const context = createContext({
    URL,
    URLSearchParams,
    Intl,
    Date,
    Set,
    Map,
    console,
    fetch: fetcher,
    location,
    history: {
      pushState(_s, _t, url) {
        location.pathname = url;
      },
      replaceState() {},
    },
    window: {addEventListener() {}, scrollTo() {}},
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      getElementById: id => node('#' + id),
      body: {classList: {toggle() {}}},
      addEventListener() {},
    },
    sessionStorage: {
      setItem() {},
      getItem() {
        return null;
      },
    },
    clearTimeout() {},
    setTimeout() {
      return 1;
    },
  });
  const source = readFileSync('web/app.js', 'utf8'),
    start = source.indexOf('(async () => {\n  try {\n    session ='),
    end = source.indexOf('\n})();', start) + '\n})();'.length;
  assert.ok(start > 0 && end > start, 'remove only the automatic startup from this unit harness');
  new Script(source.slice(0, start) + source.slice(end)).runInContext(context);
  new Script(
    "session={authenticated:true,csrf:'synthetic'};renderLanding=()=>{content.innerHTML='Current home page'};renderAuthPage=async()=>{content.innerHTML='Current sign-in page'}",
  ).runInContext(context);
  return {location, node, run: code => new Script(code).runInContext(context)};
}
const json = (value, status = 200) => ({ok: status === 200, status, json: async () => value});
for (const late of ['success', 'error'])
  test('a late ' + late + ' from the previous route cannot replace the current page', async () => {
    let release;
    const gate = new Promise(r => (release = r));
    const f = fixture(async () => {
      await gate;
      return late === 'success'
        ? json({events: [{at: 1, event: {event: 'Old activity'}}]})
        : json({error: {code: 'FORBIDDEN', message: 'Old failure'}}, 403);
    });
    const pending = f.run('render()');
    f.run("navigate('/')");
    release();
    await pending;
    assert.equal(f.node('#content').innerHTML, 'Current home page');
  });
test('an expired session opens sign-in without the previous page error overwriting it', async () => {
  const f = fixture(async () => json({error: {code: 'UNAUTHORIZED', message: 'Session expired'}}, 401));
  await f.run('render()');
  assert.equal(f.location.pathname, '/login');
  assert.equal(f.node('#content').innerHTML, 'Current sign-in page');
});

for (const path of ['/connectors', '/oauth/result'])
  test('an inner error handler on ' + path + ' cannot paint over a newer route', async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
      }),
      f = fixture(async () => {
        await gate;
        return json({error: {code: 'FORBIDDEN', message: 'Old failure'}}, 403);
      });
    f.location.pathname = path;
    f.location.search = '?attempt=synthetic';
    const pending = f.run('render()');
    f.run("navigate('/')");
    release();
    await pending;
    assert.equal(f.node('#content').innerHTML, 'Current home page');
  });

test('a previous session response cannot sign out the current route', async () => {
  let release;
  const gate = new Promise(resolve => {
      release = resolve;
    }),
    f = fixture(async () => {
      await gate;
      return json({error: {code: 'UNAUTHORIZED', message: 'Old session'}}, 401);
    });
  const pending = f.run('render()');
  f.run("navigate('/')");
  release();
  await pending;
  assert.equal(f.location.pathname, '/');
  assert.equal(f.run('session.authenticated'), true);
  assert.equal(f.node('#content').innerHTML, 'Current home page');
});

for (const path of ['/connectors', '/oauth/result'])
  test('a delayed network rejection on ' + path + ' cannot paint over the current page', async () => {
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
      }),
      f = fixture(async () => {
        await gate;
        throw Error('Synthetic previous-page network failure');
      });
    f.location.pathname = path;
    f.location.search = '?attempt=synthetic';
    const pending = f.run('render()');
    f.run("navigate('/')");
    release();
    await pending;
    assert.equal(f.node('#content').innerHTML, 'Current home page');
  });
