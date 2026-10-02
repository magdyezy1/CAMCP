import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return {promise, resolve, reject};
};
function fixture(locale = 'en') {
  const nodes = new Map(),
    calls = [],
    downloads = [],
    blobs = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        textContent: '',
        value: 'en',
        disabled: false,
        isConnected: true,
        events: new Map(),
        addEventListener(type, fn) {
          this.events.set(type, fn);
        },
        setAttribute() {},
      });
    return nodes.get(key);
  };
  const good = () => ({
    ok: true,
    headers: new Map([['content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]),
    blob: async () => ({size: 1024}),
  });
  let respond = good;
  const context = createContext({
    Intl,
    navigationGeneration: 1,
    identityGeneration: 1,
    selectionCurrent: true,
    report: {id: 'native/evidence?1', row_count: 101, xlsx_path: 'https://example.invalid/private'},
    document: {
      addEventListener() {},
      createElement() {
        return {
          click() {
            downloads.push({href: this.href, name: this.download});
          },
        };
      },
    },
    $: node,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    fetch: async (...args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return respond();
    },
    URL: {
      createObjectURL(blob) {
        blobs.push(blob);
        return 'blob:synthetic';
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
  });
  const run = code => new Script(code).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  run(readFileSync('web/evidence-workflows.js', 'utf8'));
  return {
    node,
    context,
    calls,
    downloads,
    blobs,
    good,
    respond: fn => {
      respond = fn;
    },
    mount: () => run('mountEvidenceDownload(report, () => selectionCurrent)'),
    click: () => node('#evidence-download-xlsx').events.get('click')(),
  };
}
test('evidence workbook controls use an explicit output language, fixed scoped URL and all-row download', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.mount();
    assert.equal(
      f.node('#evidence-download-language').value,
      'en',
      'interface language does not silently choose artifact language',
    );
    f.node('#evidence-download-language').value = 'ar';
    await f.click();
    assert.equal(f.calls[0][0], '/api/reporting-evidence/native%2Fevidence%3F1.xlsx?language=ar');
    assert.equal(f.calls[0][1].cache, 'no-store');
    assert.equal(f.downloads[0].name, 'AMCP-detailed-evidence.xlsx');
    assert.equal(f.blobs.length, 1);
    assert.doesNotMatch(f.node('#report-evidence-download').innerHTML, /example.invalid/);
    if (locale === 'ar') {
      assert.match(f.node('#report-evidence-download').innerHTML, /[\u0600-\u06ff]/);
      assert.doesNotMatch(f.node('#report-evidence-download').innerHTML, /Download all rows|Excel language/);
    }
  }
});
test('evidence downloads suppress duplicates and late files or errors after navigation, identity or selection changes', async () => {
  for (const change of ['navigation', 'identity', 'selection', 'detached'])
    for (const fail of [false, true]) {
      const f = fixture(),
        pending = deferred();
      f.mount();
      f.respond(() => pending.promise);
      const click = f.node('#evidence-download-xlsx').events.get('click'),
        downloading = click();
      await click();
      assert.equal(f.calls.length, 1);
      if (change === 'navigation') f.context.navigationGeneration++;
      if (change === 'identity') f.context.identityGeneration++;
      if (change === 'selection') f.context.selectionCurrent = false;
      if (change === 'detached') f.node('#report-evidence-download').isConnected = false;
      f.node('#evidence-download-status').textContent = 'Current destination';
      if (fail) pending.reject(Error('PRIVATE prior identity'));
      else pending.resolve(f.good());
      await assert.doesNotReject(downloading);
      await click();
      assert.equal(f.calls.length, 1);
      assert.equal(f.downloads.length, 0);
      assert.equal(f.blobs.length, 0);
      assert.equal(f.node('#evidence-download-status').textContent, 'Current destination');
    }
});
test('evidence download refuses wrong content, oversized files and unsupported language and allows a safe retry', async () => {
  const f = fixture();
  f.mount();
  f.node('#evidence-download-language').value = 'fr';
  await f.click();
  assert.equal(f.calls.length, 0);
  f.node('#evidence-download-language').value = 'en';
  for (const response of [
    {ok: false},
    {...f.good(), headers: new Map([['content-type', 'text/html']])},
    {...f.good(), blob: async () => ({size: 21 * 1024 * 1024})},
  ]) {
    f.respond(() => response);
    await f.click();
    assert.equal(f.downloads.length, 0);
    assert.equal(f.node('#evidence-download-xlsx').disabled, false);
    assert.ok(f.node('#evidence-download-status').textContent.length > 0);
  }
  const pending = deferred();
  f.respond(() => ({...f.good(), blob: () => pending.promise}));
  const read = f.click();
  await Promise.resolve();
  f.context.selectionCurrent = false;
  pending.resolve({size: 1024});
  await read;
  assert.equal(f.downloads.length, 0);
  f.context.selectionCurrent = true;
  f.respond(f.good);
  await f.click();
  assert.equal(f.downloads.length, 1);
});
