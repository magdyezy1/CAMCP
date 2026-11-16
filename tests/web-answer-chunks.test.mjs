// R25 ar-lazy (items 2 and 3): the Arabic sentences of provider refusals (the `providers` chunk) are no page's before rendering.
// An answer that carries one waits for the chunk inside the website's request wrapper, before the page reads the answer: in an
// error and in a 200 that carries diagnostics. When the chunk cannot load, the page shows one fixed Arabic sentence in place of
// the English message and keeps everything else of the answer. The real web/app.js request wrapper and error presentation run
// with the real catalogue loader and the shipped chunks, in a VM with a recording fetch; no server is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createContext, Script} from 'node:vm';
import {parsers} from 'prettier/plugins/babel';

const app = fs.readFileSync('web/app.js', 'utf8'),
  slice = (from, to) => {
    const start = app.indexOf(from),
      end = app.indexOf(to, start);
    assert.ok(start >= 0 && end > start, 'web/app.js still defines ' + from);
    return app.slice(start, end);
  },
  chunk = name => JSON.parse(fs.readFileSync('web/locales/ar/' + name + '.json', 'utf8')),
  providers = chunk('providers'),
  workspace = chunk('workspace'),
  shell = chunk('shell'),
  lazy = Object.keys(providers).find(
    key => !key.includes('{') && key.length > 30 && !(key in workspace) && !(key in shell),
  ),
  eager = Object.keys(workspace).find(key => !key.includes('{') && key.length > 30),
  fallback = 'The details of this message could not be loaded. Try again.';

const served = url => new Response(fs.readFileSync('web/' + url.slice(8), 'utf8'));
/** The request wrapper at a page: the API answers `answers` in order; the providers chunk comes from `providers(url)` (a Response or a held promise). */
function fixture({locale = 'ar', answers = [], providers: providersAnswer = served}) {
  const requests = [],
    calls = [];
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
    location: {href: 'https://amcp.invalid/reports', origin: 'https://amcp.invalid', pathname: '/reports', search: ''},
    localStorage: {getItem: key => (key === 'amcp.locale' ? locale : null), setItem() {}},
    window: {addEventListener() {}, removeEventListener() {}},
    document: {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    $: () => ({}),
    session: {authenticated: true, csrf: 'csrf-token'},
    navigationGeneration: 1,
    identityGeneration: 1,
    resetPrivateState() {},
    showLogin() {},
    identityKey: () => '',
    sessionStorage: {setItem() {}},
    esc: String,
    fetch: async (url, init) => {
      if (url.startsWith('/assets/')) {
        requests.push(url.replace(/^.*\/locales\/ar\//, ''));
        return url.endsWith('/providers.json') ? providersAnswer(url) : served(url);
      }
      calls.push({url, init});
      const [status, data] = answers.shift() ?? [
        500,
        {success: false, error: {code: 'UNEXPECTED', message: 'Unexpected.'}},
      ];
      return {ok: status < 400, status, json: async () => data};
    },
  });
  const run = code => new Script(code).runInContext(context);
  for (const file of ['localization.js', 'routes.js', 'route-assets.js']) run(fs.readFileSync('web/' + file, 'utf8'));
  new Script(
    slice('function requestError(', 'const content = $(') +
      slice('function confirmIdentity(', 'function showLogin(') +
      ';globalThis.api = api;',
  ).runInContext(context);
  return {context, run, requests, calls};
}
const refused = (message, extra = {}) => [
  502,
  {
    success: false,
    error: {code: 'INVALID_ARGUMENT', message, retryable: false, category: 'request', next_action: eager, ...extra},
    meta: {requestId: 'synthetic-request'},
  },
];
/** Opens an Arabic page: the shell and the workspace chunks, which every signed-in page has. */
async function arabicPage(options) {
  const f = fixture(options);
  await f.run('initializeUILocale()');
  await f.run("uiNeedChunks(['workspace'])");
  f.requests.length = 0;
  return f;
}
const english = text => new RegExp(text.replace(/[.?*+^$()[\]{}|\\]/g, '\\$&'));

test('an Arabic refusal whose sentence only `providers` has waits for the chunk, then reads in Arabic', async () => {
  assert.ok(lazy && eager);
  let release;
  const held = new Promise(resolve => (release = resolve)),
    f = await arabicPage({
      answers: [refused(lazy)],
      providers: async url => (await held, served(url)),
    });
  let settled = false;
  const pending = f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").then(
    () => (settled = true),
    error => ((settled = true), error),
  );
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, ['providers.json'], 'the chunk is requested only now, by the answer');
  assert.equal(settled, false, 'the page does not read the refusal before its sentence is here');
  release();
  const error = await pending;
  assert.equal(error.code, 'INVALID_ARGUMENT');
  Object.assign(f.context, {error});
  const parts = f.run('errorParts(error)');
  assert.equal(parts.message, providers[lazy], 'the sentence is the Arabic one');
  assert.doesNotMatch(f.run('errorBlock(error)').replace(/<details[\s\S]*<\/details>/, ''), english(lazy));
});

test('a refusal whose sentences are loaded, and an English page, fetch no chunk', async () => {
  const f = await arabicPage({answers: [refused(eager)]});
  await assert.rejects(f.run("api('/api/x')"), error => error.message === eager);
  assert.deepEqual(f.requests, []);
  const en = fixture({locale: 'en', answers: [refused(lazy)]});
  await en.run('initializeUILocale()');
  await assert.rejects(en.run("api('/api/x')"), error => error.message === lazy);
  assert.deepEqual(en.requests, []);
});

test('a 200 that carries a diagnostic with a refusal sentence is read in Arabic, and is not turned into an error', async () => {
  const diagnostic = {
      code: 'PROVIDER_ERROR',
      message: 'rendered',
      message_localization: {key: lazy},
      provider: {message: 'Native'},
    },
    f = await arabicPage({answers: [[200, {success: true, data: {groups: [{id: 'g', diagnostics: [diagnostic]}]}}]]});
  const data = await f.run("api('/api/connections/c1/sync', {method: 'POST', body: '{}'})");
  assert.deepEqual(f.requests, ['providers.json']);
  Object.assign(f.context, {diagnostic: data.data.groups[0].diagnostics[0]});
  assert.equal(f.run('uiOwnedError(diagnostic).nextAction'), providers[lazy], 'AMCP’s explanation, in Arabic');
  assert.equal(f.run('uiOwnedError(diagnostic).message'), 'Native', 'the provider’s own message stays literal');
});

test('when the chunk cannot load, the refusal keeps its code and request and says one Arabic sentence, never the English message', async () => {
  const f = await arabicPage({answers: [refused(lazy)], providers: () => new Response('', {status: 503})});
  const error = await f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").catch(error => error);
  assert.equal(error.code, 'INVALID_ARGUMENT', 'the code that drives the page is kept');
  assert.equal(error.requestId, 'synthetic-request');
  Object.assign(f.context, {error});
  const parts = f.run('errorParts(error)');
  assert.equal(parts.message, shell[fallback]);
  assert.match(parts.message, /[؀-ۿ]/u);
  assert.doesNotMatch(JSON.stringify(parts), english(lazy));
  assert.doesNotMatch(f.run('errorMessage(error)'), english(lazy));
  assert.equal(f.run('errorBlock(error)').includes(lazy), false, 'not even under Technical details');
});

test('a 200 whose chunk cannot load is kept whole: its data stays and its diagnostic says the same Arabic sentence', async () => {
  const diagnostic = {code: 'X', message: lazy, message_localization: {key: lazy}, provider: {message: 'Native'}},
    f = await arabicPage({
      answers: [[200, {success: true, data: {saved: true, groups: [{diagnostics: [diagnostic]}]}}]],
      providers: () => new Response('', {status: 503}),
    }),
    data = await f.run("api('/api/connections/c1/sync', {method: 'POST', body: '{}'})");
  assert.equal(data.data.saved, true, 'nothing the answer reported is lost');
  Object.assign(f.context, {diagnostic: data.data.groups[0].diagnostics[0]});
  assert.equal(f.run('uiOwnedError(diagnostic).message'), 'Native', 'the provider’s own message stays literal');
  assert.equal(f.run('uiOwnedError(diagnostic).nextAction'), shell[fallback]);
  assert.doesNotMatch(JSON.stringify(data), english(lazy));
});

test('a request the person has left while the chunk loads is dropped, not shown', async () => {
  let release;
  const held = new Promise(resolve => (release = resolve)),
    f = await arabicPage({
      answers: [refused(lazy)],
      providers: async url => (await held, served(url)),
    }),
    pending = f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").catch(error => error);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  f.context.navigationGeneration++;
  release();
  assert.equal((await pending).code, 'REQUEST_SUPERSEDED');
});

test('after a deploy the chunk answers 409 and the page offers the reload, not a retry that cannot work', async () => {
  const f = await arabicPage({
    answers: [refused(lazy)],
    providers: () => new Response('ASSET_VERSION_CHANGED', {status: 409}),
  });
  const error = await f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").catch(error => error);
  assert.equal(error.code, 'PAGE_ASSET_RELOAD_REQUIRED');
});

/** Every `fetch(…)` call in web/*.js with the function around it: {file, target, source}. */
function fetchSites() {
  const sites = [],
    skip = new Set(['loc', 'start', 'end', 'range', 'extra', 'comments', 'leadingComments', 'trailingComments']);
  for (const file of fs.readdirSync('web').filter(name => name.endsWith('.js'))) {
    const text = fs.readFileSync('web/' + file, 'utf8');
    if (!/\bfetch\(/.test(text)) continue;
    const visit = (node, around) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'fetch')
        sites.push({
          file,
          target: text.slice(node.arguments[0].start, node.arguments[0].end),
          source: text.slice(around.start, around.end),
        });
      const next = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
        ? node
        : around;
      for (const [key, value] of Object.entries(node))
        if (!skip.has(key)) for (const child of Array.isArray(value) ? value : [value]) visit(child, next);
    };
    visit(parsers.babel.parse(text, {filepath: file}).program, {start: 0, end: text.length});
  }
  return sites;
}

test('every place the website fetches an API answer reads it through the gate, or never reads its text', () => {
  const sites = fetchSites(),
    // The catalogue's own read and the loader's snapshot probe fetch static assets, not answers.
    assets = new Set(['localization.js', 'route-assets.js']),
    answers = sites.filter(site => !assets.has(site.file));
  // A new place that fetches an answer stops here until someone has decided how it shows its messages.
  assert.deepEqual(answers.map(site => site.file).sort(), [
    'about.js',
    'app.js',
    'creative-push.js',
    'evidence-workflows.js',
    'report-presentation.js',
  ]);
  for (const site of answers) {
    const reads = /\.(?:json|text)\(/.test(site.source);
    if (site.file === 'about.js') {
      // The public About page reads one boolean (registrationAvailable) and shows nothing the answer says.
      assert.match(site.source, /registrationAvailable/);
      continue;
    }
    if (reads) assert.match(site.source, /uiEnsureAnswerChunks\(/, site.file + ' reads an answer without the gate');
  }
  // creative-push.js drops the answer to its discard request; evidence-workflows.js reads only the workbook it asked for.
  for (const file of ['creative-push.js', 'evidence-workflows.js'])
    for (const site of answers.filter(site => site.file === file))
      assert.doesNotMatch(
        site.source,
        /\.(?:json|text)\(/,
        file + ' now reads an answer: pass it through uiEnsureAnswerChunks',
      );
  // The request wrapper reads the sentences before anything is thrown or returned from the answer.
  const wrapper = answers.find(site => site.file === 'app.js').source,
    read = wrapper.indexOf('response.json()'),
    gate = wrapper.indexOf('uiEnsureAnswerChunks(data)');
  assert.ok(read > 0 && gate > read, 'the gate follows the answer’s JSON');
  for (const later of ['requestError(data)', 'return data', 'return api(url'])
    assert.ok(wrapper.indexOf(later) > gate, later + ' comes after the gate');
  // The report download shows its refusal through the same wrapper-free path, so it asks for the gate itself.
  const download = answers.find(site => site.file === 'report-presentation.js').source;
  assert.ok(download.indexOf('uiEnsureAnswerChunks(') > download.indexOf('.json()'));
  assert.ok(download.indexOf('uiEnsureAnswerChunks(') < download.indexOf('errorMessage(requestError('));
});
