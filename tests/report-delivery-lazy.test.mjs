import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}
function fixture({script = Promise.resolve(), chunks = async () => {}} = {}) {
  const loaded = [],
    requested = [],
    rendered = [];
  const context = createContext({
    Intl,
    URLSearchParams,
    navigationGeneration: 1,
    identityGeneration: 1,
    language: 'en',
    loadPageAsset: async name => {
      loaded.push(name);
      await script;
    },
    uiNeedChunks: async names => {
      requested.push({names: [...names], language: context.language});
      await chunks(context.language);
    },
    renderReportDelivery: async mode => {
      rendered.push(mode);
      return {mode};
    },
  });
  new Script(fs.readFileSync('web/reporting-overview.js', 'utf8')).runInContext(context);
  const run = code => new Script(code).runInContext(context);
  run('overviewState.loadSequence=1;overviewState.report={id:"snapshot-a"};overviewState.selection={id:"view-a"}');
  return {context, run, loaded, requested, rendered};
}

test('ordinary report routes defer the delivery script and its locale chunk until the dialog is requested', () => {
  const context = createContext({});
  for (const name of ['routes', 'route-assets'])
    new Script(fs.readFileSync('web/' + name + '.js', 'utf8')).runInContext(context);
  const run = code => new Script(code).runInContext(context);
  assert.equal(run("pageAssetsFor('/reporting-overview').includes('report-delivery.js')"), false);
  assert.equal(run("pageLocaleChunks('/reporting-overview').includes('report-delivery')"), false);
  assert.equal(run("pageAssetOrder.includes('report-delivery.js')"), true);
  assert.equal(run("pageAssetsFor('/reporting-overview').includes('report-library.js')"), true);
});

test('opening delivery waits for both the authored script and the locale chunk without provider work', async () => {
  const script = deferred(),
    chunk = deferred(),
    f = fixture({script: script.promise, chunks: () => chunk.promise});
  const opening = f.run("openReportDelivery('sheets_now')");
  assert.deepEqual(f.loaded, ['report-delivery.js']);
  assert.deepEqual(f.requested[0].names, ['report-delivery']);
  assert.deepEqual(f.rendered, []);
  script.resolve();
  await Promise.resolve();
  assert.deepEqual(f.rendered, []);
  chunk.resolve();
  await opening;
  assert.deepEqual(f.rendered, ['sheets_now']);
});

for (const change of [
  'navigationGeneration++',
  'identityGeneration++',
  'overviewState.loadSequence++',
  'overviewState.report={id:"snapshot-b"}',
  'overviewState.selection={id:"view-b"}',
])
  test('an in-flight delivery download cannot reopen a departed context: ' + change, async () => {
    const script = deferred(),
      f = fixture({script: script.promise});
    const opening = f.run('openReportDelivery()');
    f.run(change);
    script.resolve();
    await opening;
    assert.deepEqual(f.rendered, []);
  });

test('a language change during the script download loads the current language before rendering', async () => {
  const script = deferred(),
    arabic = deferred(),
    f = fixture({script: script.promise, chunks: language => (language === 'ar' ? arabic.promise : Promise.resolve())});
  const opening = f.run('openReportDelivery()');
  f.context.language = 'ar';
  script.resolve();
  for (let index = 0; index < 6; index++) await Promise.resolve();
  assert.deepEqual(
    f.requested.map(request => request.language),
    ['en', 'ar'],
  );
  assert.deepEqual(f.rendered, []);
  arabic.resolve();
  await opening;
  assert.deepEqual(f.rendered, ['delivery']);
});

test('a failed delivery download preserves the loader error and permits a fresh explicit retry', async () => {
  const script = deferred(),
    f = fixture({script: script.promise});
  const opening = f.run('openReportDelivery()');
  const error = Object.assign(new Error('Synthetic asset download failure'), {code: 'PAGE_ASSET_UNAVAILABLE'});
  script.reject(error);
  await assert.rejects(opening, e => e === error);
  assert.deepEqual(f.rendered, []);
  f.context.loadPageAsset = async name => f.loaded.push(name);
  await f.run('openReportDelivery()');
  assert.deepEqual(f.loaded, ['report-delivery.js', 'report-delivery.js']);
  assert.deepEqual(f.rendered, ['delivery']);
});
