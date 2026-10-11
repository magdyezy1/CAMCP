// RPT-05: populated results layout. Grouped snapshots open with whole-window account tiles (keyed without dates) and a
// spend sparkline instead of one card per period; row headers name the entity in at most 40 characters and stay
// visible while the metrics scroll; daily grain has one Date column; phones read rows as cards. Each test names the
// defect it guards against. All data are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {reportSummary, reportWindowSummary} from '../dist/src/report-summary.js';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';

const arabic = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));

function browserFixture({locale = 'en', reply} = {}) {
  const root = {
      innerHTML: '',
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
    },
    context = createContext({
      api: async (_url, options) => ({success: true, data: await reply(JSON.parse(options.body))}),
      Intl,
      Date,
      URLSearchParams,
      setTimeout() {},
      clearTimeout() {},
      pollTimer: null,
      deliveryTimer: null,
      session: {workspaceRole: 'owner', authenticated: true},
      document: {querySelector: () => null, querySelectorAll: () => [], addEventListener() {}},
      location: {pathname: '/reporting-overview', search: ''},
      authBind() {},
      workspaceBind() {},
      toast() {},
      date: () => '',
      esc: value =>
        String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('"', '&quot;'),
      $: selector => (selector === '#overview-results' ? root : null),
    });
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = arabic;
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  new Script(
    "overviewState.bootstrap={platforms:[{id:'meta',name:'Meta',entity_levels:[{id:'ad',label:'Ads'}]}],metrics:{spend:{label:'Spend',format:'currency'},clicks:{label:'Clicks',format:'number'},conversions:{label:'Primary conversions',format:'number'},cpc:{label:'Cost per click',format:'currency'},cpa:{label:'Cost per conversion',format:'currency'},roas:{label:'Return on ad spend',format:'decimal'}}}",
  ).runInContext(context);
  return {root, context, run: code => new Script(code).runInContext(context)};
}

const longName = 'Autumn retargeting — Riyadh, Jeddah and Dammam lookalike audiences, carousel v3';
const dailyRow = (day, spend, extra = {}) => ({
  platform: 'meta',
  account_id: '100',
  currency: 'USD',
  timezone: 'Asia/Riyadh',
  objective_group: 'sales',
  result_definition: 'purchase',
  attribution: '7d_click',
  entity_level: 'ad',
  native_entity_type: 'ad',
  entity_id: '9007199254740993',
  entity_key: 'meta:100:ad:9007199254740993',
  entity_name: longName,
  parent_ids: {campaign_id: '101', adset_id: '201'},
  date_from: day,
  date_to: day,
  complete: true,
  metrics: {spend, clicks: 10, conversions: 2, reach: 80, frequency: 1.25},
  native: {},
  recommendation: {decision: 'maintain', reason: 'Synthetic', basis: 'entity_window'},
  ...extra,
});
const groupedSnapshot = (grain = 'daily', extra = {}) => {
  const rows = [dailyRow('2026-09-01', 10), dailyRow('2026-09-02', 30), dailyRow('2026-09-03', 20)];
  return {
    id: 'snapshot-daily',
    state: 'complete',
    rows,
    row_count: rows.length,
    offset: 0,
    has_more: false,
    sources: [],
    summary: reportSummary(rows),
    window_summary: reportWindowSummary(rows),
    exports: [],
    config: {
      name: 'Daily report',
      date_range: {since: '2026-09-01', until: '2026-09-03'},
      grain,
      metrics: ['spend', 'clicks'],
      custom_metrics: [],
      sources: [],
      source_contract_version: 'campaign-source-v4',
    },
    job: {state: 'complete'},
    ...extra,
  };
};

test('RPT-05: the whole-window summary totals additive metrics per account without dates and never sums reach', () => {
  // Before RPT-05 a daily report had only per-period summaries: one card per day and no window total.
  const rows = [
    dailyRow('2026-09-02', 30),
    dailyRow('2026-09-01', 10),
    dailyRow('2026-09-01', 5, {entity_id: '2', entity_key: 'meta:100:ad:2', recommendation: {decision: 'scale'}}),
    dailyRow('2026-09-01', 7, {account_id: '200', currency: 'SAR'}),
  ];
  const [usd, sar] = reportWindowSummary(rows);
  assert.equal(usd.account_id, '100');
  assert.equal(usd.date_from, '2026-09-01');
  assert.equal(usd.date_to, '2026-09-02');
  assert.equal(usd.period_count, 2);
  assert.equal(usd.entity_count, 2);
  assert.equal(usd.metrics.spend, 45);
  assert.equal(usd.metrics.clicks, 30);
  assert.equal(usd.metrics.conversions, 6);
  assert.equal(usd.metrics.cpa, 7.5, 'ratios are recomputed from the window totals');
  assert.equal(usd.metrics.reach, null, 'reach is never summed across periods');
  assert.equal(usd.metrics.frequency, null);
  assert.deepEqual(usd.decisions, {maintain: 1, scale: 1}, 'each entity counts once, not once per period');
  assert.deepEqual(
    usd.series.map(p => [p.date_from, p.spend]),
    [
      ['2026-09-01', 15],
      ['2026-09-02', 30],
    ],
    'oldest period first',
  );
  assert.equal(sar.account_id, '200', 'another account and currency is never combined');
  assert.equal(sar.metrics.spend, 7);
  assert.equal(reportSummary(rows).length, 3, 'the per-period summary is unchanged');
});

test('RPT-05: a grouped snapshot stores the window summary, get returns it and list pages leave it out', async () => {
  const f = overviewGranularityFixture();
  try {
    const queued = await f.overview.handle(
      {action: 'run', config: granularConfig(granularSource('meta'), 'daily'), confirmed: true},
      f.actor,
    );
    assert.equal(await f.worker.once(), true);
    const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(report.state, 'complete', JSON.stringify(report.sources));
    assert.equal(report.rows.length, 2);
    assert.equal(report.window_summary.length, 1);
    const [window] = report.window_summary;
    assert.equal(window.period_count, 2);
    assert.equal(window.date_from, report.config.date_range.since);
    assert.equal(window.date_to, report.config.date_range.until);
    assert.equal(window.metrics.spend, report.rows[0].metrics.spend + report.rows[1].metrics.spend);
    assert.equal(window.metrics.reach, null);
    assert.equal(window.series.length, 2);
    const listed = await f.overview.handle({action: 'list'}, f.actor);
    assert.equal(listed.reports[0].id, queued.id);
    assert.equal(listed.reports[0].window_summary, undefined, 'list pages stay lean');
    assert.ok(Array.isArray(listed.reports[0].summary));
    const total = await f.overview.handle(
      {action: 'run', config: granularConfig(granularSource('meta')), confirmed: true},
      f.actor,
    );
    assert.equal(await f.worker.once(), true);
    const totalReport = await f.overview.handle({action: 'get', id: total.id}, f.actor);
    assert.equal(totalReport.window_summary, undefined, 'a total-grain snapshot is already one window');
  } finally {
    f.close();
  }
});

test('RPT-05: a daily snapshot opens with one account tile and a spend sparkline instead of one card per day', async () => {
  const f = browserFixture({reply: () => groupedSnapshot()});
  await f.run("loadOverviewReport('snapshot-daily')");
  const html = f.root.innerHTML;
  assert.equal(html.match(/class="report-summary-card/g)?.length, 1, 'one tile for the whole window');
  assert.match(html, /class="report-summary-card report-window-tile"><small>Meta · 100 · USD<\/small>/);
  assert.match(html, /1 Sept? 2026 — 3 Sept? 2026 · 3 periods/);
  assert.match(html, /1 entity\/resource</);
  assert.match(html, /Spend<strong>\$60\.00<\/strong>/);
  assert.match(html, /CPA<strong>\$10\.00<\/strong>/);
  assert.match(
    html,
    /<svg class="report-sparkline" viewBox="0 0 200 36" preserveAspectRatio="none" role="img" aria-label="Spend per period from 1 Sept? 2026 to 3 Sept? 2026: lowest \$10\.00 \(1 Sept? 2026\), highest \$30\.00 \(2 Sept? 2026\)\.">/,
  );
  assert.match(html, /<polyline points="0\.0,34\.0 100\.0,2\.0 200\.0,18\.0"/);
  assert.match(html, /1 Maintain/);
  // A grouped snapshot from before RPT-05 has no window summary and keeps its per-period cards.
  const legacy = browserFixture({reply: () => ({...groupedSnapshot(), window_summary: undefined})});
  await legacy.run("loadOverviewReport('snapshot-daily')");
  assert.equal(legacy.root.innerHTML.match(/class="report-summary-card/g)?.length, 3);
  assert.ok(!legacy.root.innerHTML.includes('report-sparkline'));
});

test('RPT-05: an unknown period leaves a gap in the sparkline and one known period draws none', async () => {
  const f = browserFixture({reply: () => ({})});
  f.context.g = {
    currency: 'USD',
    series: [
      {date_from: '2026-09-01', spend: 1},
      {date_from: '2026-09-02', spend: null},
      {date_from: '2026-09-03', spend: 3},
      {date_from: '2026-09-04', spend: 2},
    ],
  };
  const svg = f.run('reportSparkline(g)');
  assert.match(svg, /<circle cx="0\.0" cy="34\.0"/, 'the period before the gap is a point, not a line through it');
  assert.match(svg, /<polyline points="133\.3,2\.0 200\.0,18\.0"/);
  f.context.one = {currency: 'USD', series: [{date_from: '2026-09-01', spend: 1}]};
  assert.equal(f.run('reportSparkline(one)'), '');
});

test('RPT-05: row headers name the entity in at most 40 characters; IDs and account move to the context cell', async () => {
  // Before RPT-05 each row header held the name, ID, level, parents, account, currency, time zone and source details
  // (about 110 characters), and screen readers repeated it on every cell.
  const f = browserFixture({reply: () => groupedSnapshot()});
  await f.run("loadOverviewReport('snapshot-daily')");
  const html = f.root.innerHTML,
    headers = [...html.matchAll(/<th scope="row" role="rowheader">(.*?)<\/th>/g)].map(m =>
      m[1].replace(/<[^>]+>/g, '').replaceAll('&amp;', '&'),
    );
  assert.equal(headers.length, 3);
  for (const header of headers) assert.ok(Array.from(header).length <= 40, header);
  assert.equal(headers[0], Array.from(longName).slice(0, 39).join('') + '…');
  // QA-03 marks the name as a literal user value (data-native).
  assert.match(html, new RegExp(`<strong dir="auto" data-native title="${longName}">`), 'the full name stays on hover');
  assert.match(
    html,
    /<td role="cell" class="report-row-context" data-label="Platform · objective"><span>Meta<\/span><small>Sales<\/small><small><span dir="auto" data-native>Autumn retargeting/,
  );
  assert.match(
    html,
    /9007199254740993<br>Reporting level: Ads<br>Campaign: 101<br>Ad set \/ ad group: 201<br>100 · USD · Asia\/Riyadh/,
  );
  assert.ok(
    headers.every(h => !h.includes('9007199254740993') && !h.includes('Asia/Riyadh')),
    'IDs and account details are not part of the row header',
  );
  // A short name is kept whole, without a tooltip.
  const short = groupedSnapshot();
  short.rows = [dailyRow('2026-09-01', 10, {entity_name: 'Spring sale'})];
  const plain = browserFixture({reply: () => short});
  await plain.run("loadOverviewReport('snapshot-daily')");
  assert.match(
    plain.root.innerHTML,
    /<th scope="row" role="rowheader"><strong dir="auto" data-native>Spring sale<\/strong><\/th>/,
  );
});

test('RPT-05: daily grain has one Date column with one date; weekly grain keeps its period', async () => {
  // Before RPT-05 the daily Period column repeated the same date twice.
  const f = browserFixture({reply: () => groupedSnapshot()});
  await f.run("loadOverviewReport('snapshot-daily')");
  assert.match(f.root.innerHTML, /<th scope="col" role="columnheader">Date<\/th>/);
  assert.match(f.root.innerHTML, /<td role="cell" data-label="Date">1 Sept? 2026<\/td>/);
  assert.ok(!f.root.innerHTML.includes('>Period</th>'));
  const weekly = groupedSnapshot('weekly');
  weekly.rows = [dailyRow('2026-09-01', 10, {date_to: '2026-09-07'})];
  const w = browserFixture({reply: () => weekly});
  await w.run("loadOverviewReport('snapshot-daily')");
  assert.match(w.root.innerHTML, /<td role="cell" data-label="Period">1 Sept? 2026<br>7 Sept? 2026<\/td>/);
  // Every value cell names its column for the phone card layout.
  assert.match(f.root.innerHTML, /<td role="cell" data-label="Spend" title="10">\$10\.00<\/td>/);
  assert.match(f.root.innerHTML, /<td role="cell" class="recommendation" data-label="Recommended next move">/);
});

test('RPT-05: the window tile, sparkline summary and Date column are Arabic in the Arabic interface', async () => {
  const f = browserFixture({locale: 'ar', reply: () => groupedSnapshot()});
  await f.run("loadOverviewReport('snapshot-daily')");
  const html = f.root.innerHTML;
  assert.ok(html.includes('عدد الفترات: 3'), 'period count');
  assert.ok(html.includes(arabic['{count} entity/resource'].replace('{count}', '1')));
  assert.match(html, /aria-label="الإنفاق لكل فترة من /);
  assert.ok(html.includes(`<th scope="col" role="columnheader">${arabic.Date}</th>`));
  assert.doesNotMatch(html, /[٠-٩]/, 'Latin digits (D27)');
});

test('RPT-05: row headers stay visible while scrolling and phones read report rows as cards', () => {
  // Before RPT-05 the identity column was static (only the header row stuck) and phones scrolled a 1,706 px table.
  const css = readFileSync('web/reporting.css', 'utf8'),
    rule = selector => css.slice(css.indexOf(selector + ' {'), css.indexOf('}', css.indexOf(selector + ' {')));
  const rowHeader = rule('.report-table tbody th');
  assert.match(rowHeader, /position: sticky;/);
  assert.match(rowHeader, /top: auto;/, 'row headers must not also stick to the top');
  assert.match(rowHeader, /inset-inline-start: 0;/, 'inline-start keeps RTL right');
  assert.match(rowHeader, /background: var\(--white\);/, 'an opaque background hides the scrolled cells');
  assert.match(rule('.report-rows-table thead th:first-child'), /inset-inline-start: 0;/);
  const phone = css.slice(css.indexOf('@media (max-width: 600px) {\n  .report-table-wrap:has(.report-rows-table)'));
  assert.ok(phone.length > 0);
  assert.match(phone, /\.report-rows-table tbody tr \{\n\s+display: grid;/);
  assert.match(phone, /\.report-rows-table td\[data-label\]::before \{\n\s+content: attr\(data-label\);/);
  assert.match(
    phone,
    /\.report-rows-table thead \{\n\s+position: absolute;/,
    'column headers stay for assistive technology',
  );
  assert.match(css, /html\[dir='rtl'\] \.report-sparkline \{\n\s+transform: scaleX\(-1\);/, 'time runs from the start');
});
