// R25 ar-lazy (items 2 and 3), R25 ar-answers (item 2): the Arabic sentences of provider refusals (the `providers` chunk) and of
// what only an error shows (the `answers` chunk: remedies, next steps, the core's refusals) are no page's before rendering.
// An answer that carries one waits for both chunks inside the website's request wrapper, before the page reads the answer: in an
// error and in a 200 that carries diagnostics or a remedy. When they cannot load, the page shows one fixed Arabic sentence in place
// of the English message and keeps everything else of the answer. The real web/app.js request wrapper and error presentation run
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
  answerChunk = chunk('answers'),
  workspace = chunk('workspace'),
  shell = chunk('shell'),
  lazy = Object.keys(providers).find(
    key => !key.includes('{') && key.length > 30 && !(key in workspace) && !(key in shell),
  ),
  eager = Object.keys(workspace).find(key => !key.includes('{') && key.length > 30),
  fallback = 'The details of this message could not be loaded. Try again.',
  // Both lazy chunks, in the order an answer asks for them.
  lazyFiles = ['answers.json', 'providers.json'];

const served = url => new Response(fs.readFileSync('web/' + url.slice(8), 'utf8'));
/**
 * The request wrapper at a page: the API answers `answers` in order; the providers chunk comes from `providers(url)` and the answers
 * chunk from `chunks(url)` (a Response or a held promise).
 */
function fixture({locale = 'ar', answers = [], providers: providersAnswer = served, chunks: chunkAnswer = served}) {
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
        return url.endsWith('/providers.json')
          ? providersAnswer(url)
          : url.endsWith('/answers.json')
            ? chunkAnswer(url)
            : served(url);
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

// A remedy a person reads (the page words a remedy that addresses an MCP client in its own sentences, from the shell) that only
// `answers` has: what errors.ts and the providers' remedy tables say.
const probe = fixture({}),
  remedy = Object.keys(answerChunk).find(
    key =>
      !key.includes('{') &&
      key.length > 40 &&
      !(key in workspace) &&
      !(key in shell) &&
      !(key in providers) &&
      !probe.run('agentDirected(' + JSON.stringify(key) + ')'),
  ),
  remedyOf = action => ({category: 'request', owner: 'operator', action, mutation_retry_safe: false});

test('an Arabic refusal whose sentence only `providers` has waits for the chunks, then reads in Arabic', async () => {
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
  assert.deepEqual(f.requests, lazyFiles, 'both chunks are requested only now, by the answer');
  assert.equal(settled, false, 'the page does not read the refusal before its sentence is here');
  release();
  const error = await pending;
  assert.equal(error.code, 'INVALID_ARGUMENT');
  Object.assign(f.context, {error});
  const parts = f.run('errorParts(error)');
  assert.equal(parts.message, providers[lazy], 'the sentence is the Arabic one');
  assert.doesNotMatch(f.run('errorBlock(error)').replace(/<details[\s\S]*<\/details>/, ''), english(lazy));
});

test('an Arabic refusal whose remedy only `answers` has waits for it, coalesced with `providers`, then shows the remedy in Arabic', async () => {
  assert.ok(remedy && eager);
  let release;
  const held = new Promise(resolve => (release = resolve)),
    f = await arabicPage({
      answers: [refused(eager, {next_action: remedy, remedy: remedyOf(remedy)})],
      chunks: async url => (await held, served(url)),
    });
  let settled = false;
  const pending = f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").then(
    () => (settled = true),
    error => ((settled = true), error),
  );
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, lazyFiles, 'the two lazy chunks are asked for together, only now, by the answer');
  assert.equal(settled, false, 'the page does not read the refusal before its remedy is here');
  release();
  const error = await pending;
  assert.equal(error.code, 'INVALID_ARGUMENT');
  Object.assign(f.context, {error});
  assert.equal(f.run('errorParts(error)').remedy, answerChunk[remedy], 'the remedy is the Arabic one');
  assert.doesNotMatch(f.run('errorBlock(error)').replace(/<details[\s\S]*<\/details>/, ''), english(remedy));
});

test('a 200 that carries a remedy is read in Arabic and is not turned into an error, and a 200 that refused nothing fetches nothing', async () => {
  // A failed step of a plan, or a finding of a report's quality, carries a remedy inside an answer that succeeded.
  const step = {id: 's1', error: {code: 'X', message: eager, remedy: remedyOf(remedy)}},
    f = await arabicPage({answers: [[200, {success: true, data: {saved: true, steps: [step]}}]]}),
    data = await f.run("api('/api/campaigns/plans/p1', {method: 'POST', body: '{}'})");
  assert.deepEqual(f.requests, lazyFiles);
  assert.equal(data.data.saved, true, 'the outcome is not turned into an error');
  Object.assign(f.context, {stepError: data.data.steps[0].error});
  assert.equal(f.run('websiteRemedy(stepError)'), answerChunk[remedy]);
  // The same text where no page looks a sentence up, in a 200 that refused nothing: neither chunk is asked for.
  const plain = await arabicPage({
    answers: [[200, {success: true, data: {name: remedy, notes: [remedy, lazy], rows: [{label: remedy}]}}]],
  });
  await plain.run("api('/api/x')");
  assert.deepEqual(plain.requests, []);
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
  assert.deepEqual(f.requests, lazyFiles);
  Object.assign(f.context, {diagnostic: data.data.groups[0].diagnostics[0]});
  assert.equal(f.run('uiOwnedError(diagnostic).nextAction'), providers[lazy], 'AMCP’s explanation, in Arabic');
  assert.equal(f.run('uiOwnedError(diagnostic).message'), 'Native', 'the provider’s own message stays literal');
});

/** An error block split into its visible part and the server's exact text kept under Technical details (WEB-03). */
function technicalDetails(block) {
  const details = /<details class="error-technical">[\s\S]*?<\/details>/.exec(block)?.[0] ?? '';
  return {
    visible: block.replace(details, ''),
    exact: details ? JSON.parse(/<pre[^>]*>([\s\S]*?)<\/pre>/.exec(details)[1]) : null,
  };
}

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
  // WEB-03: the server's exact text stays under Technical details, in English as when the chunk loads, and nowhere else.
  const block = technicalDetails(f.run('errorBlock(error)'));
  assert.equal(block.visible.includes(lazy), false, 'no English on the page itself');
  assert.deepEqual(block.exact, {code: 'INVALID_ARGUMENT', message: lazy, next_action: eager});
  const loaded = await arabicPage({answers: [refused(lazy)]});
  Object.assign(loaded.context, {
    error: await loaded.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").catch(error => error),
  });
  assert.deepEqual(
    technicalDetails(loaded.run('errorBlock(error)')).exact,
    block.exact,
    'the same text as when the chunk loads',
  );
});

test('when either lazy chunk cannot load, a remedy only `answers` has is never shown in English: in an error and in a 200', async () => {
  const unavailable = status => () => new Response(status === 409 ? 'ASSET_VERSION_CHANGED' : '', {status}),
    unscrubbed = (key, value) => (['server_message', 'server_next_action'].includes(key) ? undefined : value);
  for (const [which, status] of [
    ['chunks', 503],
    ['providers', 503],
    ['chunks', 409],
    ['providers', 409],
  ]) {
    const down = {[which]: unavailable(status)},
      label = which === 'chunks' ? 'answers' : 'providers';
    // An error keeps its code and request, and says the one Arabic sentence; a deploy (409) offers the reload instead.
    const f = await arabicPage({answers: [refused(eager, {next_action: remedy, remedy: remedyOf(remedy)})], ...down}),
      error = await f.run("api('/api/workspace/reporting', {method: 'POST', body: '{}'})").catch(error => error);
    if (status === 409) assert.equal(error.code, 'PAGE_ASSET_RELOAD_REQUIRED', label + ' answered 409');
    else {
      assert.equal(error.code, 'INVALID_ARGUMENT', label + ' answered ' + status);
      Object.assign(f.context, {error});
      const parts = f.run('errorParts(error)'),
        block = technicalDetails(f.run('errorBlock(error)'));
      assert.equal(parts.message, shell[fallback]);
      assert.doesNotMatch(JSON.stringify(parts), english(remedy));
      assert.equal(block.visible.includes(remedy), false, 'no English on the page itself');
      assert.deepEqual(block.exact, {code: 'INVALID_ARGUMENT', message: eager, next_action: remedy});
    }
    // A 200 that carries the remedy is kept whole in both cases: its outcome is not hidden by a translation that did not load.
    const step = {id: 's1', error: {code: 'X', message: eager, remedy: remedyOf(remedy)}},
      g = await arabicPage({answers: [[200, {success: true, data: {saved: true, steps: [step]}}]], ...down}),
      data = await g.run("api('/api/campaigns/plans/p1', {method: 'POST', body: '{}'})");
    assert.equal(data.data.saved, true, label + ' answered ' + status + ': nothing the answer reported is lost');
    assert.doesNotMatch(JSON.stringify(data, unscrubbed), english(remedy), 'the English is nowhere else in the answer');
    assert.equal(data.data.steps[0].error.server_next_action, remedy, 'the server’s exact text is kept on the object');
  }
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
  assert.equal(
    data.data.groups[0].diagnostics[0].server_message,
    lazy,
    'the server’s exact text is kept on the object',
  );
  assert.doesNotMatch(
    JSON.stringify(data, (key, value) => (key === 'server_message' ? undefined : value)),
    english(lazy),
    'the English is nowhere else in the answer',
  );
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

test('after a deploy a successful answer is not turned into an error: the outcome stays, and its diagnostic says the fixed sentence', async () => {
  // Lead review S3-3: a write that succeeded (200 with diagnostics) must not be shown as "AMCP was updated" with its data dropped.
  const diagnostic = {code: 'X', message: lazy, message_localization: {key: lazy}, provider: {message: 'Native'}},
    f = await arabicPage({
      answers: [[200, {success: true, data: {saved: true, groups: [{diagnostics: [diagnostic]}]}}]],
      providers: () => new Response('ASSET_VERSION_CHANGED', {status: 409}),
    }),
    data = await f.run("api('/api/connections/c1/sync', {method: 'POST', body: '{}'})");
  assert.equal(data.data.saved, true, 'the outcome of the write is not hidden');
  assert.equal(data.data.groups[0].diagnostics[0].message, shell[fallback]);
  assert.equal(data.data.groups[0].diagnostics[0].server_message, lazy);
});

// A server sentence stored without its code is not read by the answer gate, which reads error-shaped objects: the connection
// result's progress record keeps a refusal's message as `message` beside `state`, with no `code`. The page that shows it asks for
// the chunk itself (uiEnsureSentences) and, when it cannot load, says the fixed sentence (lead review S2-1).
const progress = message => [
  200,
  {platform: 'tiktok', state: 'failed', authorization: true, exchange: false, sync: false, message},
];
/** The connection result page (web/app.js renderCallback) with the real request wrapper, loader and chunks, and a bare #content. */
async function callbackPage(options) {
  const f = options.locale === 'en' ? fixture(options) : await arabicPage(options);
  if (options.locale === 'en') await f.run('initializeUILocale()');
  const content = {innerHTML: ''};
  Object.assign(f.context, {content, platforms: [], URLSearchParams, publicAssetUrl: path => path});
  Object.assign(f.context.location, {pathname: '/oauth/result', search: '?attempt=attempt-001'});
  new Script(
    slice('function header(', 'function pageFrame(') +
      slice('function renderCallbackRefusal(', '// Privacy, Terms and Data deletion'),
  ).runInContext(f.context);
  return {...f, content};
}
const escaped = (f, text) => f.run('uiEscape(' + JSON.stringify(text) + ')');
const paragraph = (f, text) => '<p>' + escaped(f, text) + '</p>';

test('the connection result reads a refusal sentence its progress record stores without a code: the page asks for the chunk itself', async () => {
  let release;
  const held = new Promise(resolve => (release = resolve)),
    page = await callbackPage({answers: [progress(lazy)], providers: async url => (await held, served(url))}),
    rendering = page.run('renderCallback()');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.requests, lazyFiles, 'the page asks for the chunks: the gate reads nothing of this record');
  assert.equal(page.content.innerHTML, '', 'nothing is on the page, in no language, while the sentence is held');
  release();
  await rendering;
  assert.ok(page.content.innerHTML.includes(paragraph(page, providers[lazy])), 'the sentence in Arabic');
  assert.equal(page.content.innerHTML.includes(lazy), false, 'never the English sentence');
  assert.equal(page.content.innerHTML.includes(escaped(page, lazy)), false);
});

test('the connection result says the fixed Arabic sentence, never the English one, when the chunk cannot load or a deploy replaced it', async () => {
  for (const unavailable of [
    () => new Response('', {status: 503}),
    () => new Response('ASSET_VERSION_CHANGED', {status: 409}),
  ]) {
    const page = await callbackPage({answers: [progress(lazy)], providers: unavailable});
    await page.run('renderCallback()');
    assert.ok(page.content.innerHTML.includes(paragraph(page, shell[fallback])), 'the fixed sentence');
    assert.equal(page.content.innerHTML.includes(lazy), false);
    assert.equal(page.content.innerHTML.includes(escaped(page, lazy)), false);
    assert.match(page.content.innerHTML, /callback-steps/, 'the rest of the page is there');
  }
});

test('the connection result drops a record the person has left, and fetches nothing for a loaded sentence or in English', async () => {
  let release;
  const held = new Promise(resolve => (release = resolve)),
    left = await callbackPage({answers: [progress(lazy)], providers: async url => (await held, served(url))}),
    rendering = left.run('renderCallback()');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  left.context.navigationGeneration++;
  release();
  await rendering;
  assert.equal(left.content.innerHTML, '', 'the page the person left is not painted over the one they are on');
  const loaded = await callbackPage({answers: [progress(eager)]});
  await loaded.run('renderCallback()');
  assert.deepEqual(loaded.requests, []);
  assert.ok(loaded.content.innerHTML.includes(paragraph(loaded, workspace[eager])));
  const en = await callbackPage({locale: 'en', answers: [progress(lazy)]});
  await en.run('renderCallback()');
  assert.deepEqual(en.requests, []);
  assert.ok(en.content.innerHTML.includes(paragraph(en, lazy)), 'English shows the sentence as it is');
});

// The write approval page (web/operations-center.js) shows each reason of a review that needs a person's confirmation with
// uiText. A reason is the message of the refusal that asked for it (src/write-review.ts executeRequirements: `reason: e.message`),
// kept in a record with no code, so the answer gate does not read it either: the page asks for the chunk itself. Found while
// checking the allow-list of the source guard in tests/web-locale-chunks.test.mjs (lead review S3-1).
async function approvalPage(options) {
  const f = await arabicPage(options),
    root = {
      innerHTML: '',
      isConnected: true,
      setAttribute() {},
      removeAttribute() {},
      querySelector: () => ({textContent: ''}),
    };
  Object.assign(f.context, {
    root,
    pretty: String,
    date: String,
    badge: String,
    errorMessage: error => error.message,
    recordDetails: () => '',
    toast() {},
    workspaceBind() {},
    confirmAction: async () => false,
  });
  new Script(fs.readFileSync('web/operations-center.js', 'utf8')).runInContext(f.context);
  return {...f, root, load: () => f.run("writeApprovalController(root, 'review-1')").load()};
}
const approval = reasons => [
  200,
  {
    review_id: 'review-1',
    group: false,
    gateway: 'tiktok_native_action',
    account_id: '123',
    action: 'update_campaign',
    summary: null,
    classes: [],
    reasons,
    prepared_by: 'operator',
    prepared_by_name: 'Operator Name',
    expires_at: '2026-10-13T10:05:00.000Z',
    fingerprint: 'f'.repeat(64),
    owner_required: false,
    approval: null,
    approval_pending: true,
    may_approve: true,
  },
];
const reason = text => `<p class="form-note">${text}</p>`;

test('a write approval reads each reason in Arabic: the page asks for the chunk itself, and shows nothing while it is held', async () => {
  let release;
  const held = new Promise(resolve => (release = resolve)),
    page = await approvalPage({
      answers: [
        approval([
          {flag: 'spend_change_confirmed', reason: lazy},
          {flag: 'creative_edit_confirmed', reason: eager},
        ]),
      ],
      providers: async url => (await held, served(url)),
    }),
    loading = page.load();
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.requests, lazyFiles, 'the page asks for the chunks: the gate reads no reason');
  assert.equal(page.root.innerHTML, '', 'nothing is on the page while the sentence is held');
  release();
  await loading;
  assert.ok(page.root.innerHTML.includes(reason(providers[lazy])), 'the refusal’s sentence in Arabic');
  assert.ok(page.root.innerHTML.includes(reason(workspace[eager])));
  assert.equal(page.root.innerHTML.includes(lazy), false, 'never the English sentence');
});

test('a write approval says the fixed sentence for a reason whose chunk cannot load, keeps the loaded ones, and asks for nothing without reasons', async () => {
  const failed = await approvalPage({
    answers: [
      approval([
        {flag: 'spend_change_confirmed', reason: lazy},
        {flag: 'creative_edit_confirmed', reason: eager},
      ]),
    ],
    providers: () => new Response('', {status: 503}),
  });
  await failed.load();
  assert.ok(failed.root.innerHTML.includes(reason(shell[fallback])), 'the fixed sentence');
  assert.ok(failed.root.innerHTML.includes(reason(workspace[eager])), 'a loaded reason stays');
  assert.equal(failed.root.innerHTML.includes(lazy), false);
  const plain = await approvalPage({answers: [approval([])]});
  await plain.load();
  assert.deepEqual(plain.requests, []);
  assert.match(plain.root.innerHTML, /write-approval-heading/);
});

/** The report pack's download button (web/report-presentation.js), which fetches its file itself and passes a refusal through the gate. */
async function reportPage(options) {
  const f = await arabicPage(options),
    bindings = new Map(),
    report = {isConnected: true, insertAdjacentHTML() {}},
    source = fs.readFileSync('web/report-presentation.js', 'utf8');
  Object.assign(f.context, {
    content: {querySelector: () => report},
    $: () => ({addEventListener() {}, elements: {confirmed: {}}}),
    workspaceBind: (selector, handler) => bindings.set(selector, handler),
    overviewCall: async () => ({}),
    renderReportPack: async () => true,
    mountReportProfileBranding: async () => {},
    toast() {},
  });
  new Script(source.slice(0, source.indexOf('async function mountReportProfileBranding('))).runInContext(f.context);
  await f.run("bindReportPresentation({presentation: null}, 'snapshot-001')");
  return {
    ...f,
    download: () =>
      bindings
        .get('#download-pack-pdf')()
        .catch(error => error),
  };
}

test('the report download shows its refusal in Arabic, says the fixed sentence when the chunk cannot load, and lets a deploy reach the reload', async () => {
  const served = await (await reportPage({answers: [refused(lazy)]})).download();
  assert.ok(served.message.includes(providers[lazy]), 'the refusal’s sentence in Arabic');
  assert.equal(served.message.includes(lazy), false);
  const failed = await (
    await reportPage({answers: [refused(lazy)], providers: () => new Response('', {status: 503})})
  ).download();
  assert.ok(failed.message.includes(shell[fallback]), 'the fixed sentence');
  assert.equal(failed.message.includes(lazy), false);
  // Lead review S4-3: after a deploy only a reload can help; "Report download failed." would hide that.
  const deployed = await (
    await reportPage({answers: [refused(lazy)], providers: () => new Response('ASSET_VERSION_CHANGED', {status: 409})})
  ).download();
  assert.equal(deployed.code, 'PAGE_ASSET_RELOAD_REQUIRED');
  assert.ok(shell['AMCP was updated. Reload to continue.']);
  assert.equal(
    deployed.message,
    shell['AMCP was updated. Reload to continue.'],
    'the loader’s own offer, not a failure',
  );
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
    gate = wrapper.indexOf('uiEnsureAnswerChunks(data, response.ok)');
  assert.ok(read > 0 && gate > read, 'the gate follows the answer’s JSON');
  for (const later of ['requestError(data)', 'return data', 'return api(url'])
    assert.ok(wrapper.indexOf(later) > gate, later + ' comes after the gate');
  // The report download shows its refusal through the same wrapper-free path, so it asks for the gate itself.
  const download = answers.find(site => site.file === 'report-presentation.js').source;
  assert.ok(download.indexOf('uiEnsureAnswerChunks(') > download.indexOf('.json()'));
  assert.ok(download.indexOf('uiEnsureAnswerChunks(') < download.indexOf('errorMessage(requestError('));
});
