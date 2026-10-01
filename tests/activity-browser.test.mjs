import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

async function fixture(locale = 'en') {
  const nodes = new Map(),
    bindings = new Map(),
    calls = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        isConnected: true,
        attributes: {},
        elements: {search: {value: ''}, account_id: {value: ''}},
        setAttribute(k, v) {
          this.attributes[k] = v;
        },
        focus() {},
        addEventListener() {},
      });
    return nodes.get(key);
  };
  let handler = async () => ({
    events: [
      {id: 1, at: 1, event: {event: 'native_read', account_id: '100', request_id: 'reference'}, diagnostics: []},
    ],
    next_cursor: 'next',
  });
  const context = createContext({
    session: {authenticated: true},
    content: node('content'),
    navigationGeneration: 1,
    identityGeneration: 1,
    URLSearchParams,
    header: (a, b) => a + b,
    $: node,
    esc: String,
    date: String,
    pretty: String,
    uiText: v => v,
    document: {addEventListener() {}},
    recordDetails: JSON.stringify,
    errorMessage: e => e.message,
    workspaceBind: (s, fn) => bindings.set(s, fn),
    renderSourceDiagnostic: d => JSON.stringify(d),
    api: async url => {
      calls.push(url);
      return handler(url);
    },
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = s => new Script(s).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(`uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  const source = readFileSync('web/app.js', 'utf8');
  run(
    source.slice(source.indexOf('async function renderActivity()'), source.indexOf('async function renderCallback()')),
  );
  await run('renderActivity()');
  return {
    node,
    bindings,
    calls,
    context,
    respond: fn => {
      handler = fn;
    },
  };
}

test('Activity pages, filters and refresh preserve exact cursors and render translated metadata controls', async () => {
  for (const locale of ['en', 'ar']) {
    const f = await fixture(locale);
    assert.ok(f.bindings.has('#activity-next'));
    await f.bindings.get('#activity-next')();
    assert.match(f.calls.at(-1), /cursor=next/);
    f.node('#activity-filter').elements.search.value = 'native_read';
    f.node('#activity-filter').elements.account_id.value = 'act_100';
    await f.bindings.get('#activity-filter')(f.node('#activity-filter'));
    assert.match(f.calls.at(-1), /search=native_read/);
    assert.match(f.calls.at(-1), /account_id=act_100/);
    assert.doesNotMatch(f.calls.at(-1), /cursor=/);
    const html = f.node('content').innerHTML + f.node('#activity-results').innerHTML;
    assert.match(html, locale === 'ar' ? /مرجع الطلب/ : /Request reference/);
    assert.doesNotMatch(html, /undefined/);
    await f.bindings.get('#activity-refresh')();
    assert.doesNotMatch(f.calls.at(-1), /cursor=/);
  }
});

test('Activity failed pagination can retry the same cursor and late or departed requests cannot affect a new identity', async () => {
  const f = await fixture();
  assert.ok(f.bindings.has('#activity-next'));
  f.respond(async () => {
    throw Error('Temporary failure');
  });
  await f.bindings.get('#activity-next')();
  const failed = f.calls.at(-1);
  f.respond(async () => ({events: [], next_cursor: 'third'}));
  await f.bindings.get('#activity-next')();
  assert.equal(f.calls.at(-1), failed);
  let finish;
  f.respond(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = f.bindings.get('#activity-next')();
  f.context.identityGeneration++;
  f.node('#activity-results').innerHTML = 'New identity';
  finish({events: [{event: {event: 'stale'}}]});
  await pending;
  assert.equal(f.node('#activity-results').innerHTML, 'New identity');
  const n = f.calls.length;
  await f.bindings.get('#activity-refresh')();
  assert.equal(f.calls.length, n);
});
