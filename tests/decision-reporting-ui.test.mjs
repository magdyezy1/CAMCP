import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function fixture(getReport, getList, locale = 'en') {
  const nodes = new Map(),
    rowMounts = [],
    downloadMounts = [],
    records = [],
    bindings = new Map(),
    calls = [];
  let focused;
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        isConnected: true,
        value: '',
        querySelector: node,
        addEventListener() {},
        setAttribute() {},
        focus() {
          focused = id;
        },
      });
    return nodes.get(id);
  };
  const report = {
    id: 'new-report',
    semantics: {
      source_name: 'Newly captured evidence',
      currency: 'USD',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      complete: true,
    },
    totals: {spend: '12.5', impressions: '100', clicks: '10', conversions: null},
    rows: [],
  };
  let open, url;
  const context = createContext({
    document: {addEventListener() {}},
    navigationGeneration: 1,
    identityGeneration: 1,
    content: node('#content'),
    $: node,
    workspaceCall: async (_tool, args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return args.action === 'list' ? (getList ? getList(args) : {reports: []}) : getReport ? getReport() : report;
    },
    mountCaptureWizard: async fn => {
      open = fn;
    },
    mountReferenceImport() {},
    mountScenarioModel() {},
    mountEvidenceDownload(report, current) {
      downloadMounts.push({report, current});
    },
    mountEvidenceRows(report, current) {
      rowMounts.push({report, current});
    },
    workspaceBind: (selector, callback) => bindings.set(selector, callback),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    date: String,
    badge: String,
    blank: String,
    recordDetails: (value, title) => {
      records.push({value, title});
      return '';
    },
    controls: () => '',
    history: {
      replaceState: (_a, _b, value) => {
        url = value;
      },
    },
    location: {search: ''},
    URLSearchParams,
    encodeURIComponent,
  });
  const source = readFileSync('web/workspace.js', 'utf8');
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  new Script(source.slice(source.indexOf('async function renderDecisionReports()'))).runInContext(context);
  return {
    node,
    context,
    report,
    rowMounts,
    downloadMounts,
    records,
    bindings,
    calls,
    render: () => new Script('renderDecisionReports()').runInContext(context),
    open: () => open('new-report'),
    url: () => url,
    focused: () => focused,
  };
}

test('saved evidence pages append unique sources and preserve exact continuation and current search', async () => {
  const row = id => ({
    id,
    account_id: '100',
    gateway: 'meta_native_action',
    captured_at: 1,
    semantics: {
      source_name: 'Native <evidence> ' + id,
      currency: 'USD',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
    },
  });
  const f = fixture(undefined, args =>
    args.cursor
      ? {reports: [row('a'), row('b')], has_more: false, next_cursor: null}
      : {reports: [row('a')], has_more: true, next_cursor: 'exact-opaque-cursor'},
  );
  await f.render();
  assert.equal(f.calls[0].limit, 30);
  assert.equal(f.node('#evidence-index-next').hidden, false);
  await f.bindings.get('#evidence-index-next')();
  assert.equal(f.calls[1].cursor, 'exact-opaque-cursor');
  assert.equal(f.node('#decision-report-list').innerHTML.match(/data-report="a"/g).length, 1);
  assert.match(f.node('#decision-report-list').innerHTML, /data-report="b"/);
  assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /<evidence>/);
  assert.equal(f.node('#evidence-index-next').hidden, true);
});

test('English and Arabic evidence search keep the same original wire query and clear it only on reset', async () => {
  const requests = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(undefined, () => ({reports: [], has_more: false, next_cursor: null}), locale);
    await f.render();
    assert.match(
      f.node('#content').innerHTML,
      locale === 'ar' ? /البحث في البيانات المحفوظة/ : /Search saved evidence/,
    );
    f.node('#evidence-index-query').value = 'رمضان';
    await f.bindings.get('#evidence-index-search')();
    requests.push(f.calls.at(-1));
    assert.equal(f.calls.at(-1).search, 'رمضان');
    assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
    await f.bindings.get('#evidence-index-reset')();
    assert.equal(f.node('#evidence-index-query').value, '');
    assert.equal(f.calls.at(-1).search, undefined);
    assert.equal(f.calls.at(-1).cursor, undefined);
  }
  assert.deepEqual(requests[0], requests[1]);
});

test('a bounded empty page exposes continuation and later errors preserve retry without obsolete search results', async () => {
  let resolve;
  const old = new Promise(yes => {
    resolve = yes;
  });
  const f = fixture(undefined, args =>
    args.cursor
      ? old
      : args.search
        ? {reports: [], has_more: false, next_cursor: null}
        : {reports: [], has_more: true, next_cursor: 'opaque'},
  );
  await f.render();
  assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
  assert.equal(f.node('#evidence-index-next').hidden, false);
  const loading = f.bindings.get('#evidence-index-next')();
  f.node('#evidence-index-query').value = 'new search';
  await f.bindings.get('#evidence-index-search')();
  resolve({
    reports: [{id: 'departed', account_id: '100', semantics: {source_name: 'Obsolete'}}],
    has_more: false,
    next_cursor: null,
  });
  await loading;
  assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /Obsolete|departed/);
  assert.equal(f.node('#evidence-index-next').hidden, true);
});

test('saved evidence continuation failures remain retryable while late identity failures remain silent', async () => {
  for (const changeIdentity of [false, true]) {
    let reject;
    const pending = new Promise((_yes, no) => {
      reject = no;
    });
    const f = fixture(undefined, args =>
      args.cursor ? pending : {reports: [], has_more: true, next_cursor: 'opaque'},
    );
    await f.render();
    const loading = f.bindings.get('#evidence-index-next')();
    if (changeIdentity) f.context.identityGeneration++;
    reject(Error('Synthetic failed page'));
    await assert.doesNotReject(loading);
    if (changeIdentity) assert.doesNotMatch(f.node('#evidence-index-status').textContent ?? '', /Could not load/);
    else {
      assert.match(f.node('#evidence-index-status').textContent, /Could not load/);
      assert.equal(f.node('#evidence-index-next').disabled, false);
      assert.equal(f.node('#evidence-index-next').hidden, false);
    }
  }
});

test('loaded comparison choices preserve the current selection and clear removed references without rebuilding the report', async () => {
  // RPT-07: only an earlier equal-length window can be the analyze baseline, so the retained choice is the two days
  // before the report (the same window was offered before, which the server always refused).
  const row = id => ({
    id,
    gateway: 'meta_native_action',
    account_id: '100',
    semantics: {source_name: id, currency: 'USD', date_from: '2026-08-30', date_to: '2026-08-31'},
    captured_at: 1,
  });
  const f = fixture(undefined, args =>
    args.search
      ? {reports: [], has_more: false, next_cursor: null}
      : args.cursor
        ? {reports: [row('more')], has_more: false, next_cursor: null}
        : {reports: [row('baseline')], has_more: true, next_cursor: 'opaque'},
  );
  f.report.gateway = 'meta_native_action';
  f.report.account_id = '100';
  await f.render();
  await f.open();
  const reference = f.node('select[name="reference_id"]'),
    baseline = f.node('select[name="baseline_id"]');
  reference.value = 'baseline';
  baseline.value = 'baseline';
  const original = f.node('#report-detail').innerHTML;
  await f.bindings.get('#evidence-index-next')();
  assert.equal(reference.value, 'baseline');
  assert.equal(baseline.value, 'baseline');
  assert.match(reference.innerHTML, /value="more"/);
  assert.equal(f.node('#report-detail').innerHTML, original);
  f.node('#report-result').innerHTML = 'old comparison';
  f.node('#evidence-index-query').value = 'no matches';
  await f.bindings.get('#evidence-index-search')();
  assert.equal(reference.value, '');
  assert.equal(baseline.value, '');
  assert.equal(f.node('#report-result').innerHTML, '');
  assert.equal(f.node('#report-detail').innerHTML, original);
});

test('late report lists and their failures do not render after identity changes', async () => {
  for (const fail of [false, true]) {
    let resolve, reject;
    const pending = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const f = fixture(undefined, () => pending);
    const rendering = f.render();
    f.context.identityGeneration++;
    if (fail) reject(Error('Previous identity list error'));
    else resolve({reports: [f.report]});
    await assert.doesNotReject(rendering);
    assert.equal(f.node('#content').innerHTML, '');
    assert.equal(f.node('#decision-report-list').innerHTML, '');
  }
});
test('report metric cards localize known labels and distinguish unknown metrics from exact zero', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(undefined, undefined, locale);
    f.report.totals = {spend: '1.000001', clicks: null, conversions: '0'};
    await f.render();
    await f.open();
    const html = f.node('#report-detail').innerHTML;
    assert.match(html, /1\.000001/);
    assert.match(html, locale === 'ar' ? /الإنفاق/ : /Spend/);
    assert.match(html, locale === 'ar' ? /مرات الظهور/ : /Impressions/);
    const unknown = locale === 'ar' ? 'غير معروف' : 'Unknown';
    assert.equal(html.match(new RegExp('<strong>' + unknown + '</strong>', 'g'))?.length, 2);
    assert.match(html, /<strong>0<\/strong>/);
    assert.doesNotMatch(html, /<span>spend|<span>impressions/);
  }
});
test('captured evidence appears in the current report list immediately without a reload', async () => {
  const f = fixture();
  await f.render();
  assert.match(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
  await f.open();
  assert.match(f.node('#decision-report-list').innerHTML, /Newly captured evidence/);
  assert.doesNotMatch(f.node('#decision-report-list').innerHTML, /No evidence captured yet/);
  assert.match(f.node('#decision-report-list').innerHTML, /data-report="new-report"/);
  assert.equal(f.url(), '/reports?id=new-report');
  assert.equal(f.focused(), '#report-detail');
});
test('report selection names its source and account and escapes untrusted names in accessible labels', async () => {
  const source = name => ({
    id: name,
    account_id: name === 'A' ? '100' : '200',
    captured_at: 1,
    semantics: {
      source_name: name === 'A' ? 'Client "A" <evidence>' : 'Client B',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      currency: 'USD',
    },
  });
  const f = fixture(undefined, () => ({reports: [source('A'), source('B')]}));
  await f.render();
  const html = f.node('#decision-report-list').innerHTML;
  assert.match(
    html,
    /aria-label="Open report Client &quot;A&quot; &lt;evidence> for account 100, 2026-09-01 — 2026-09-02"/,
  );
  assert.match(html, /aria-label="Open report Client B for account 200, 2026-09-01 — 2026-09-02"/);
  assert.doesNotMatch(html, /<evidence>/);
});

test('detailed reports mount all-row downloads under the current report selection', async () => {
  const f = fixture();
  await f.render();
  await f.open();
  assert.match(f.node('#report-detail').innerHTML, /id="report-evidence-download"/);
  assert.equal(f.downloadMounts.length, 1);
  assert.equal(f.downloadMounts[0].report, f.report);
  assert.equal(f.downloadMounts[0].current(), true);
  await f.open();
  assert.equal(f.downloadMounts[0].current(), false);
  assert.equal(f.downloadMounts[1].current(), true);
});
test('detailed reports mount readable row paging and retain collection/account lineage in source details', async () => {
  const f = fixture();
  f.report.native_account_evidence = {checks: [{source_hash: 'account-hash'}]};
  f.report.source_pages = [{page: 1, source_hash: 'page-hash'}];
  f.report.source_collection = 'tiktok_daily_pages';
  f.report.source_lineage = {overview_id: 'retained-snapshot'};
  await f.render();
  await f.open();
  assert.match(f.node('#report-detail').innerHTML, /id="report-native-rows"/);
  assert.equal(f.rowMounts.length, 1);
  assert.equal(f.rowMounts[0].report.id, f.report.id);
  assert.equal(f.rowMounts[0].current(), true);
  const details = f.records.find(r => r.title === 'Source and measurement definitions').value;
  for (const key of ['native_account_evidence', 'source_pages', 'source_collection', 'source_lineage'])
    assert.deepEqual(JSON.parse(JSON.stringify(details[key])), f.report[key]);
  f.context.identityGeneration++;
  assert.equal(f.rowMounts[0].current(), false);
});

test('a report response cannot replace the current page or URL after the user navigates away', async () => {
  let resolve;
  const pending = new Promise(r => {
    resolve = r;
  });
  const f = fixture(() => pending);
  await f.render();
  const opening = f.open();
  f.context.navigationGeneration++;
  f.node('#report-detail').innerHTML = 'Current destination';
  resolve(f.report);
  await opening;
  assert.equal(f.node('#report-detail').innerHTML, 'Current destination');
  assert.equal(f.url(), undefined);
  assert.equal(f.focused(), undefined);
});
test('a late retained report cannot paint or raise errors in a new identity', async () => {
  for (const fail of [false, true]) {
    let resolve, reject;
    const pending = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    const f = fixture(() => pending);
    await f.render();
    const opening = f.open();
    f.context.identityGeneration++;
    f.node('#report-detail').innerHTML = 'New identity';
    if (fail) reject(Error('obsolete report'));
    else resolve(f.report);
    await opening;
    assert.equal(f.node('#report-detail').innerHTML, 'New identity');
    assert.equal(f.url(), undefined);
  }
});
