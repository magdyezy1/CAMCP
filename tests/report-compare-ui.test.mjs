// RPT-07: the website's comparison controls. The "Compare to" select offers only compatible earlier snapshots
// (others disabled with the reason), the delta columns show this window, the earlier window and the change, and the
// /reports baseline select applies the server's rule. Rendered in a VM with synthetic data; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function context(locale = 'en', extra = {}) {
  const ctx = createContext({
    document: {addEventListener() {}},
    esc,
    blank: text => '<p class="blank">' + esc(text) + '</p>',
    reportRangeLabel: range => (range ? range.since + ' – ' + range.until : ''),
    overviewState: {bootstrap: {metrics: {spend: {label: 'Spend'}, cpa: {label: 'Cost per conversion'}}}},
    ...extra,
  });
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(ctx);
  if (locale === 'ar') {
    ctx.catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(ctx);
  }
  return ctx;
}
const comparison = {
  current: {id: 'a', date_range: {since: '2026-08-08', until: '2026-08-14'}, window_days: 7},
  baseline: {id: 'b', date_range: {since: '2026-08-01', until: '2026-08-07'}, window_days: 7},
  metrics: ['spend', 'cpa'],
  excluded_metrics: [{metric: 'reach', reason: 'non_additive_multi_day'}],
  rows: [
    {
      entity_key: 'meta:100:c1',
      entity_id: 'c1',
      entity_name: 'Spring <sale>',
      account_id: '100',
      currency: 'USD',
      values: {
        spend: {current: '120.3', baseline: '100.1', delta: '20.2', delta_percent: '20.17982018'},
        cpa: {current: '1', baseline: '0', delta: '1', delta_percent: null, reason: 'baseline_zero'},
      },
    },
  ],
  row_count: 1,
  offset: 0,
  incompatible: [{entity_id: 'c5', account_id: '100', reasons: ['currency']}],
  incompatible_count: 1,
  only_current: [],
  only_current_count: 0,
  only_baseline: [{entity_id: 'c3', account_id: '100', reason: 'not_in_current'}],
  only_baseline_count: 1,
  limitations: ['Observational evidence does not establish causality or adjust for seasonality.'],
};

test('delta columns show this window, the earlier window and the change, with unknowns explained', () => {
  const ctx = context();
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(ctx);
  ctx.out = comparison;
  const html = new Script('renderSnapshotComparison(out)').runInContext(ctx);
  assert.match(html, /<th scope="col" role="columnheader">Spend<\/th>/);
  assert.match(
    html,
    /<strong>120\.3<\/strong><small>Earlier: 100\.1<\/small><small>Change: \+20\.2 \(\+20\.18%\)<\/small>/,
  );
  // A zero earlier value has no percentage; the cell says why instead of dividing by zero.
  assert.match(html, /title="The earlier value is zero, so there is no percentage\.">—/);
  assert.match(html, /Spring &lt;sale&gt;/, 'native names stay escaped');
  assert.match(html, /Not compared:<\/p>|Not compared:/);
  assert.match(html, /reach \(Not additive across days; compared only for single-day windows\)/);
  assert.match(html, /1 entity not compared: measurement definitions differ.*c5.*Currency/s);
  assert.match(html, /1 entity only in the earlier window.*c3.*Not in this window/s);
  assert.match(html, /does not establish causality/);
});

test('the comparison reads in Arabic with literal native values', () => {
  const ctx = context('ar');
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(ctx);
  ctx.out = comparison;
  const html = new Script('renderSnapshotComparison(out)').runInContext(ctx);
  assert.match(html, /سابقًا: /);
  assert.match(html, /التغيّر:/);
  assert.match(html, /لا يُجمع عبر الأيام/);
  assert.match(html, /c5/);
  assert.match(html, /الأدلة الرصدية لا تثبت السببية/);
});

test('"Compare to" lists compatible snapshots, disables the others with the reason and opens the pair', async () => {
  const bindings = new Map(),
    nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {innerHTML: '', elements: {baseline_id: {value: ''}}});
    return nodes.get(id);
  };
  const ctx = context('en', {
    $: node,
    workspaceBind: (selector, fn) => bindings.set(selector, fn),
    overviewCall: async args => {
      calls.push(args);
      if (args.action === 'compare_candidates')
        return {
          paired_baseline_id: 'b',
          candidates: [
            {
              id: 'b',
              name: 'Weekly',
              date_range: {since: '2026-08-01', until: '2026-08-07'},
              eligible: true,
              paired: true,
              reasons: [],
            },
            {
              id: 'x',
              name: 'Overlap',
              date_range: {since: '2026-08-05', until: '2026-08-11'},
              eligible: false,
              paired: false,
              reasons: [{code: 'window_order', message: 'The baseline must end before the current window starts.'}],
            },
          ],
        };
      return comparison;
    },
  });
  new Script(readFileSync('web/report-workflows.js', 'utf8')).runInContext(ctx);
  const root = {
    html: '',
    insertAdjacentHTML(_position, html) {
      this.html += html;
    },
  };
  ctx.root = root;
  new Script("mountSnapshotComparison({id: 'a'}, root)").runInContext(ctx);
  assert.match(root.html, /Compare periods/);
  await bindings.get('#snapshot-compare-choices')();
  const body = node('#snapshot-compare-body').innerHTML;
  assert.match(body, /<option value="b"  selected>2026-08-01 – 2026-08-07 · Weekly · previous equal window<\/option>/);
  assert.match(
    body,
    /<option value="x" disabled >2026-08-05 – 2026-08-11 · Overlap — The baseline must end before the current window starts\.<\/option>/,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {action: 'compare', id: 'a', baseline_id: 'b'});
  assert.match(node('#snapshot-compare-result').innerHTML, /Earlier: 100\.1/);
  // Choosing explicitly compares with that snapshot; nothing is sent to a provider from the page.
  await bindings.get('#snapshot-compare-form')({elements: {baseline_id: {value: 'b'}}});
  assert.ok(calls.every(c => ['compare', 'compare_candidates'].includes(c.action)));
});

test('/reports offers only a compatible earlier window as the analyze baseline, with reasons on the rest', () => {
  const ctx = context();
  const source = readFileSync('web/workspace.js', 'utf8');
  new Script(source.slice(source.indexOf('function evidenceBaselineReason('))).runInContext(ctx);
  const report = {
    id: 'now',
    gateway: 'meta_native_action',
    account_id: '100',
    source: 'provider_read',
    preset: 'meta_campaign',
    grain: 'campaign × day',
    semantics: {
      currency: 'USD',
      timezone: 'UTC',
      attribution: '7d_click',
      conversion_definition: 'purchase',
      date_from: '2026-08-08',
      date_to: '2026-08-14',
    },
  };
  const like = (id, change = {}, semantics = {}) => ({
    ...report,
    id,
    ...change,
    semantics: {
      ...report.semantics,
      source_name: 'Evidence ' + id,
      date_from: '2026-08-01',
      date_to: '2026-08-07',
      ...semantics,
    },
  });
  ctx.report = report;
  ctx.reports = [
    like('other-account', {account_id: '200'}),
    like('ok'),
    like('preset', {preset: 'meta_adset'}),
    like('currency', {}, {currency: 'EUR'}),
    like('length', {}, {date_from: '2026-08-02'}),
    like('overlap', {}, {date_from: '2026-08-05', date_to: '2026-08-11'}),
    like('now'),
  ];
  const html = new Script('evidenceBaselineOptions(report, reports)').runInContext(ctx);
  const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map(m => ({
    id: m[1],
    disabled: m[2].includes('disabled'),
    text: m[3],
  }));
  assert.equal(options[0].id, '');
  assert.equal(options[1].id, 'ok', 'compatible evidence is listed first');
  assert.equal(options[1].disabled, false);
  const reason = id => options.find(o => o.id === id);
  assert.match(reason('other-account').text, /Different account or platform/);
  assert.match(reason('preset').text, /Different report type/);
  assert.match(reason('currency').text, /Different currency, time zone, attribution or result definition/);
  assert.match(reason('length').text, /Different window length/);
  assert.match(reason('overlap').text, /Must end before this report starts/);
  assert.ok(options.slice(2).every(o => o.disabled));
  assert.equal(reason('now'), undefined, 'the report itself is never offered');
  // A paired previous-period capture says the pair is the default and marks it.
  ctx.paired = {...report, paired_baseline_id: 'ok'};
  const pairedHtml = new Script("evidenceBaselineOptions(paired, reports, 'ok')").runInContext(ctx);
  assert.match(pairedHtml, /Paired previous window \(default\)/);
  assert.match(pairedHtml, /<option value="ok"  selected>[^<]*paired previous window/);
});
