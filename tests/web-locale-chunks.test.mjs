// WEB-07: the Arabic catalog (web/locales/ar.json, 1.9 MB at 91 % of its 2 MiB cap) was one download that gated every
// Arabic page: About fetched all of it to translate 54 strings, and the workspace asked who was signed in only after
// it arrived. tools/locale-chunks.mjs generates bounded chunks; a page loads the shell's and its own. These tests guard
// the committed chunks, what each page requests, and the parallel session request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createContext, Script} from 'node:vm';
import {
  chunkLimit,
  chunksWith,
  loaderFiles,
  localeChunkProblems,
  moduleChunk,
  planLocaleChunks,
} from '../tools/locale-chunks.mjs';

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

// R25 ar-lazy (item 4): the chunk no page waits for is named once, in web/route-assets.js; the plan and the check read it.
// Before, `providers` (4,710 messages, a third of an Arabic page) was assumed available to every page script, so a script
// could write a message that only it carried without the check noticing.
test('route-assets.js names the chunk no page waits for, and no page script can rely on it', () => {
  const {lazy, dependencies, modules} = loaderFiles();
  assert.deepEqual(lazy, ['providers']);
  assert.deepEqual(plan.lazy, lazy);
  for (const file of modules)
    for (const name of lazy) assert.equal(chunksWith(file, dependencies).has(name), false, file + ' relies on ' + name);
});

test('providers carries refusal sentences only: what a provider contract refuses with and no page script or success answer shows', () => {
  const refusals = plan.sources.get('server:backend-contracts'),
    shown = [...plan.sources].filter(([name]) => name !== 'server:backend-contracts' && !name.startsWith('web/'));
  assert.deepEqual(
    Object.keys(plan.chunks.providers).filter(key => !refusals.has(key) || shown.some(([, set]) => set.has(key))),
    [],
  );
  // Words a page script writes, which `providers` carried because some backend file writes them too ("Yes", "Status", a
  // report preset's name, a coverage note shown from a success answer), load with every signed-in page.
  for (const word of [
    'Yes',
    'No',
    'Status',
    'Daily',
    'Weekly',
    'Monthly',
    'Entity ID',
    'Google campaign performance',
  ]) {
    assert.equal(word in plan.chunks.providers, false, word + ' is not a refusal sentence');
    assert.ok(word in plan.chunks.workspace || word in plan.chunks.shell, word + ' is there before a page renders');
  }
});

test('a script that writes a sentence a provider contract also refuses with carries its own copy', () => {
  const key = 'Invalid CSV quoting.';
  // commerce.js and report-reference.js check a CSV before sending it, with the sentence the backend refuses with.
  assert.ok(key in plan.chunks.providers, 'a refusal still reads it from providers');
  assert.ok(key in plan.chunks.commerce, 'web/commerce.js');
  assert.ok(key in plan.chunks['report-reference'], 'web/report-reference.js');
  // The check refuses a script that would rely on the lazy chunk for it.
  const clone = {...plan, chunks: {...plan.chunks, commerce: {...plan.chunks.commerce}}};
  delete clone.chunks.commerce[key];
  assert.ok(
    localeChunkProblems(process.cwd(), clone).includes(
      'web/commerce.js requires a message none of its chunks carries: ' + key,
    ),
  );
});

test('a sentence that is also data in the backend is never lazy (a success answer shows it)', () => {
  // Found by reading the role of every occurrence in src and server (R25 ar-lazy): each is a refusal sentence that is also
  // stored in a property, a variable or a return value, so a page may show it from an answer that refused nothing.
  for (const start of [
    'Not in this account', // not_found_reason of the ad previews answer (web/ad-previews.js shows it)
    'Targeting, serving and shared-list changes require spend_change_confirmed=true.',
    'Personal data: this read returns submitted leads',
    'Snapchat did not return the selected ad account with its organization.',
    'name must start with a letter, use only letters, numbers, spaces, underscores or hyphens',
    'name must not be the name of a standard event.',
  ]) {
    const key = Object.keys(plan.catalog).find(message => message.startsWith(start));
    assert.ok(key, start);
    assert.equal(key in plan.chunks.providers, false, key + ' stays out of the lazy chunk');
    assert.ok(key in plan.chunks.workspace, key + ' loads with every signed-in page');
  }
});

/** A small tree with the files the plan reads, written under a temporary directory. */
function syntheticPlan(files, locales) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amcp-lazy-plan-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), text);
    }
    return planLocaleChunks(root, locales);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

test('the plan makes a sentence lazy only when every place that writes it hands it to a function that provably throws', () => {
  const lazy = {
      'Never helper': 'a function declared to return never',
      'Sole throw helper': 'a function that is one throw',
      'Delegating helper': 'a function that hands everything to one that throws',
      'Factory helper': 'a constant built by a factory whose declared return type is a never function',
      'Typed constant': 'a constant declared with an imported never function type',
      'Constructed': 'a constructor imported from src/errors.ts',
      'Imported helper': 'a never function imported from another module',
    },
    eager = {
      'Returning helper': 'a function that can return, as well as one that throws',
      'Review helper': 'an arrow that returns an object',
      'Method call': 'a method call, as well as a throwing function',
      'Property value': 'a property value',
      'Template text': 'a template',
      'Unresolved helper': 'a helper imported from a package',
      'Other constructor': 'a constructor not imported from src/errors.ts',
    },
    pageOwned = ['Page word and refusal', 'Page word and data', 'Only the page'],
    catalog = Object.fromEntries(
      [...Object.keys(lazy), ...Object.keys(eager), ...pageOwned, 'Shell word', 'Written nowhere'].map(key => [
        key,
        'ar ' + key,
      ]),
    ),
    built = syntheticPlan(
      {
        'web/routes.js': 'const routeRegistry = [];\n',
        'web/route-assets.js':
          "const pageAssetOrder = ['page.js'];\nconst pageAssetDependencies = {};\nconst answerLocaleChunks = ['providers'];\n",
        'web/index.html': '<script src="/assets/app.js" defer></script>',
        'web/app.js': "'use strict';\n",
        'web/page.js':
          "'use strict';\nuiText('Page word and refusal');\nuiText('Page word and data');\nuiText('Only the page');\n",
        'server/website.ts': "export const words = ['Shell word'];\n",
        'src/errors.ts': 'export class MirrorError extends Error {}\n',
        'src/kit.ts': [
          "import {MirrorError} from './errors.js';",
          'export type Refusal = (message: string) => never;',
          'export function fail(code: string, message: string): never { throw new MirrorError(code, message); }',
          'export function makeRefusal(code: string): Refusal { return message => fail(code, message); }',
          '',
        ].join('\n'),
        'src/refusals.ts': [
          "import {MirrorError} from './errors.js';",
          "import {fail, makeRefusal} from './kit.js';",
          "import type {Refusal} from './kit.js';",
          "import {packaged} from 'a-package';",
          'declare function makeOne(code: string): Refusal;',
          'class Other extends Error {}',
          "function invalid(message: string): never { throw new MirrorError('X', message); }",
          "const bad = (message: string) => { throw new MirrorError('X', message); };",
          'const wrapped = (message: string) => invalid(message);',
          "const built = makeRefusal('X');",
          "const typed: Refusal = makeOne('Y');",
          'function note(message: string) { return {note: message}; }',
          'const review = (reason: string) => ({reason});',
          "export function a() { invalid('Never helper'); }",
          "export function b() { bad('Sole throw helper'); }",
          "export function c() { wrapped('Delegating helper'); }",
          "export function d() { built('Factory helper'); }",
          "export function e() { typed('Typed constant'); }",
          "export function f() { throw new MirrorError('X', 'Constructed'); }",
          "export function g() { fail('X', 'Imported helper'); }",
          "export function h() { note('Returning helper'); invalid('Returning helper'); }",
          "export function i() { review('Review helper'); invalid('Review helper'); }",
          "export function j(list: string[]) { list.push('Method call'); invalid('Method call'); }",
          "export function k() { invalid('Property value'); return {text: 'Property value'}; }",
          'export function l(x: number) { invalid(`Template text`); return `Template text ${x}`; }',
          "export function m() { packaged('Unresolved helper'); invalid('Unresolved helper'); }",
          "export function n() { throw new Other('Other constructor'); }",
          "export function o() { invalid('Page word and refusal'); return {text: 'Page word and data'}; }",
          '',
        ].join('\n'),
      },
      {
        catalog,
        sources: new Map([
          ['server:backend-contracts', new Set([...Object.keys(lazy), ...Object.keys(eager), 'Page word and refusal'])],
          ['web/page.js', new Set(pageOwned)],
        ]),
        problems: [],
      },
    ),
    where = key =>
      Object.entries(built.chunks)
        .filter(([, chunk]) => key in chunk)
        .map(([name]) => name)
        .sort();
  assert.deepEqual(built.lazy, ['providers']);
  for (const [key, why] of Object.entries(lazy)) assert.deepEqual(where(key), ['providers'], key + ': ' + why);
  // Anything a page may show from an answer that refused nothing travels in the chunk every signed-in page has.
  for (const [key, why] of Object.entries(eager)) assert.deepEqual(where(key), ['workspace'], key + ': ' + why);
  // A script's own words are its own, even when a refusal needs the same sentence.
  assert.deepEqual(where('Page word and refusal'), ['page', 'providers']);
  // A word the backend also writes (a preset name, a coverage note) may reach any page in an answer: every page has it.
  assert.deepEqual(where('Page word and data'), ['workspace']);
  assert.deepEqual(where('Only the page'), ['page']);
  assert.deepEqual(where('Shell word'), ['shell']);
  assert.deepEqual(where('Written nowhere'), ['workspace']);
});

test('a sentence a helper that returns data also takes stays eager: report advice gives it as the reason of a recommendation', () => {
  // `review` throws nowhere in src/report-advice-v4.ts: it returns the recommendation row with a `reason`. The same sentence
  // is a refusal elsewhere, so the inspector files it with the refusals; the plan reads the module's own definition of
  // `review` (not the name, which other modules use for a function that throws) and keeps it eager.
  const key = 'A metric exceeds supported numeric precision. Use the retained native source.';
  assert.ok(key in plan.catalog);
  assert.equal(key in plan.chunks.providers, false);
  assert.ok(key in plan.chunks.workspace);
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

// R25 ar-lazy (items 2 and 3): an answer that carries a sentence of the `providers` chunk loads it before the page reads the
// answer, in an error and in a 200 that carries diagnostics; an answer whose sentences are loaded, and English, load nothing.
const sentence = chunk => Object.keys(plan.chunks[chunk]).find(key => !key.includes('{') && key.length > 20);
const refusal = (message, extra = {}) => ({
  success: false,
  error: {code: 'INVALID_ARGUMENT', message, retryable: false, category: 'request', ...extra},
  meta: {requestId: 'synthetic-request'},
});

test('an Arabic answer that carries a refusal sentence only `providers` has loads it first, in an error and in a 200', async () => {
  const lazy = sentence('providers'),
    eager = sentence('workspace');
  assert.ok(lazy && eager && !(lazy in plan.chunks.workspace));
  const p = page();
  await p.run('initializeUILocale()');
  await p.run("uiNeedChunks(['workspace'])");
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
  Object.assign(p.context, {lazy, eager});
  // The sentence is in no loaded chunk: it would be shown in English.
  assert.equal(p.run('uiText(lazy)'), lazy);
  // A refusal whose sentences are loaded asks for nothing more.
  Object.assign(p.context, {loaded: refusal(eager)});
  await p.run('uiEnsureAnswerChunks(loaded)');
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
  // A success answer without message-shaped objects, whatever text it holds, asks for nothing either.
  Object.assign(p.context, {plain: {success: true, data: {name: lazy, note: lazy, rows: [{label: lazy}]}}});
  await p.run('uiEnsureAnswerChunks(plain)');
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
  // A provider's own literal message is shown as it is, so it asks for nothing either.
  Object.assign(p.context, {literal: {success: true, data: {diagnostics: [{provider: {code: 'X', message: lazy}}]}}});
  await p.run('uiEnsureAnswerChunks(literal)');
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json']);
  // A 200 that carries a diagnostic with a refusal sentence waits for the chunk, which then translates it.
  Object.assign(p.context, {
    success: {
      success: true,
      data: {groups: [{diagnostics: [{code: 'X', message: 'rendered ' + lazy, message_localization: {key: lazy}}]}]},
    },
  });
  await p.run('uiEnsureAnswerChunks(success)');
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json', 'providers.json']);
  assert.equal(p.run('uiText(lazy)'), plan.chunks.providers[lazy]);
  // Once loaded, a later answer does not wait or fetch again.
  Object.assign(p.context, {again: refusal(lazy)});
  await p.run('uiEnsureAnswerChunks(again)');
  assert.deepEqual(p.chunks(), ['shell.json', 'workspace.json', 'providers.json']);
});

test('the sentences of an answer are read where the page looks them up: the message, its template, the next step and the remedy', async () => {
  const lazy = sentence('providers'),
    loaded = sentence('workspace');
  const fetchesFor = async answer => {
    const q = page();
    await q.run('initializeUILocale()');
    await q.run("uiNeedChunks(['workspace'])");
    q.context.answer = answer;
    await q.run('uiEnsureAnswerChunks(answer)');
    return q.chunks().includes('providers.json');
  };
  // Each position the page passes to uiText, one at a time, with every other sentence of the answer already loaded.
  assert.equal(await fetchesFor(refusal(lazy)), true, 'error.message');
  assert.equal(await fetchesFor(refusal(loaded)), false, 'a message that is loaded');
  const template = {message_localization: {key: lazy, values: {}}};
  assert.equal(await fetchesFor(refusal('Rendered with values 7', template)), true, 'the template of a message');
  assert.equal(await fetchesFor(refusal('Rendered with values 7', {message_localization: {key: loaded}})), false);
  assert.equal(await fetchesFor(refusal(loaded, {next_action: lazy})), true, 'next_action');
  assert.equal(await fetchesFor(refusal(loaded, {next_action: loaded})), false);
  assert.equal(await fetchesFor(refusal(loaded, {remedy: {category: 'request', action: lazy}})), true, 'remedy.action');
  assert.equal(await fetchesFor(refusal(loaded, {details: {next_action: lazy}})), true, 'details.next_action');
  assert.equal(
    await fetchesFor({...refusal(loaded), meta: {message_parts: {base: lazy, suffix: 'a suffix'}}}),
    true,
    'the base of a split message',
  );
  // Nested at depth, as a refused step of a plan or a failed level of a report.
  assert.equal(await fetchesFor({success: true, data: {steps: [{id: 'a', error: {code: 'X', message: lazy}}]}}), true);
  // Not where a page looks a sentence up: a name, a note, a row's label, a provider's own message.
  assert.equal(await fetchesFor({success: true, data: {name: lazy, notes: [lazy], rows: [{label: lazy}]}}), false);
  assert.equal(await fetchesFor(refusal(loaded, {provider: {code: 'X', message: lazy}})), false);
});
test('an English page, and an answer after the chunk is in, never fetch a catalog chunk for an answer', async () => {
  const lazy = sentence('providers'),
    english = page({locale: 'en'});
  await english.run('initializeUILocale()');
  english.context.answer = refusal(lazy);
  await english.run('uiEnsureAnswerChunks(answer)');
  assert.deepEqual(english.requests, []);
  assert.equal(
    english.run('uiCatalogChunks.has("providers")'),
    false,
    'English adds nothing a language change would load',
  );
  // A report of 60,000 rows is read whole, in a few milliseconds, and its diagnostics after the rows are still found.
  const arabic = page();
  await arabic.run('initializeUILocale()');
  arabic.context.big = {
    success: true,
    data: {
      rows: Array.from({length: 60000}, (_, row) => ({row, a: 1, b: {c: 2}})),
      diagnostics: [{code: 'X', message: lazy}],
    },
  };
  const started = performance.now();
  await arabic.run('uiEnsureAnswerChunks(big)');
  assert.ok(arabic.chunks().includes('providers.json'), 'its diagnostics, after the rows, are found');
  assert.ok(performance.now() - started < 3000, 'a large answer is read in bounded time');
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
