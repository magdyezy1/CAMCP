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
    bindings = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        innerHTML: '',
        isConnected: true,
        events: new Map(),
        addEventListener(e, f) {
          this.events.set(e, f);
        },
        setAttribute() {},
        focus() {},
      });
    return nodes.get(id);
  };
  const reports = ['current', 'reference'].map(id => ({
    id,
    gateway: 'google_ads_native_action',
    account_id: '001',
    connection_id: 'login',
    preset: 'google_campaign',
    semantics: {
      source_name: id,
      complete: true,
      currency: 'USD',
      timezone: 'UTC',
      date_from: '2026-09-01',
      date_to: '2026-09-02',
      attribution: 'native',
      conversion_definition: 'primary',
    },
    totals: {spend: '9007199254740993.13', impressions: '100', clicks: '10', conversions: null},
    rows: [],
  }));
  const outcome = {
    matched: true,
    comparison_kind: 'manual_totals',
    context_compatible: null,
    independently_verified: false,
    differences: [
      {
        metric: 'spend',
        actual: '9007199254740993.13',
        reference: '9007199254740993.13',
        difference: '0',
        matched: true,
      },
    ],
  };
  let response = () => outcome;
  const context = createContext({
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    content: node('content'),
    $: node,
    FormData: class {
      constructor(form) {
        this.values = Object.entries(form.values);
      }
      [Symbol.iterator]() {
        return this.values[Symbol.iterator]();
      }
    },
    URLSearchParams,
    location: {search: '?id=current'},
    history: {replaceState() {}},
    controls: () => '',
    mountScenarioModel() {},
    mountCaptureWizard: async () => {},
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    workspaceCall: async (_tool, args) => {
      calls.push(args);
      return args.action === 'list'
        ? {reports}
        : args.action === 'get'
          ? reports.find(r => r.id === args.id)
          : response(args);
    },
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    badge: String,
    blank: String,
    date: String,
    pretty: String,
    recordDetails: (v, title) => `<details><summary>${title}</summary>${JSON.stringify(v)}</details>`,
  });
  const run = value => new Script(value).runInContext(context);
  run(readFileSync('web/localization.js', 'utf8'));
  run(readFileSync('web/report-quality.js', 'utf8'));
  if (locale === 'ar') {
    context.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    run('uiLocale="ar";uiMessages=new Map(Object.entries(catalog))');
  }
  const source = readFileSync(process.env.AMCP_RECONCILIATION_UI_SOURCE || 'web/workspace.js', 'utf8');
  run(source.slice(source.indexOf('async function renderDecisionReports()')));
  return {
    node,
    bindings,
    calls,
    context,
    outcome,
    render: () => run('renderDecisionReports()'),
    respond: fn => {
      response = fn;
    },
  };
}
test('manual matching totals are described as numerical agreement, never verified evidence', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.render();
    await f.bindings.get('#reconcile-report')({
      values: {label: 'Reference', spend: '9007199254740993.13', clicks: '', conversions: ''},
    });
    const html = f.node('#report-result').innerHTML;
    assert.doesNotMatch(html, />verified<|>تم التحقق</);
    assert.match(html, locale === 'ar' ? /تطابق عددي فقط/ : /Numerical agreement only/);
    assert.match(html, /9007199254740993\.13/);
    assert.match(html, /<table/);
  }
});
test('retained reference form binds the chosen report and displays exact metric differences in both languages', async () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.render();
    assert.equal(typeof f.bindings.get('#reconcile-retained'), 'function');
    f.respond(() => ({
      ...f.outcome,
      comparison_kind: 'retained_reports',
      context_compatible: true,
      reference_report_id: 'reference',
    }));
    await f.bindings.get('#reconcile-retained')({values: {reference_id: 'reference'}});
    assert.equal(f.calls.at(-1).action, 'reconcile_report');
    assert.equal(f.calls.at(-1).id, 'current');
    assert.equal(f.calls.at(-1).reference_id, 'reference');
    assert.match(
      f.node('#report-result').innerHTML,
      locale === 'ar' ? /إعدادات التقارير المحفوظة متوافقة/ : /Retained report settings align/,
    );
    assert.match(f.node('#report-result').innerHTML, /9007199254740993\.13/);
  }
});
test('reconciliation results and errors cannot outlive edited inputs or overwrite a newer comparison', async () => {
  const f = fixture();
  await f.render();
  const first = deferred();
  f.respond(() => first.promise);
  const pending = f.bindings.get('#reconcile-report')({
    values: {label: 'Old', spend: '1', clicks: '', conversions: ''},
  });
  f.node('#reconcile-report').events.get('input')({});
  first.resolve(f.outcome);
  await pending;
  assert.equal(f.node('#report-result').innerHTML, '');
  const stale = deferred();
  f.respond(() => stale.promise);
  const old = f.bindings.get('#reconcile-report')({values: {label: 'Old', spend: '1', clicks: '', conversions: ''}});
  f.respond(() => ({...f.outcome, comparison_kind: 'retained_reports', context_compatible: true}));
  await f.bindings.get('#reconcile-retained')({values: {reference_id: 'reference'}});
  const html = f.node('#report-result').innerHTML;
  stale.reject(Error('obsolete'));
  await old;
  assert.equal(f.node('#report-result').innerHTML, html);
});
test('a numerical match within a declared tolerance shows the allowance and keeps the exact difference visible', async () => {
  const f = fixture();
  await f.render();
  f.respond(() => ({
    ...f.outcome,
    comparison_kind: 'retained_reports',
    context_compatible: true,
    differences: [
      {
        metric: 'spend',
        actual: '9007199254740993.13',
        reference: '9007199254740993.12',
        difference: '0.01',
        tolerance: '0.01',
        matched: true,
      },
    ],
  }));
  await f.bindings.get('#reconcile-retained')({values: {reference_id: 'reference'}});
  assert.match(f.node('#report-result').innerHTML, /Within tolerance/);
  assert.match(f.node('#report-result').innerHTML, /Tolerance/);
  assert.doesNotMatch(f.node('#report-result').innerHTML, /Compared totals match/);
});
