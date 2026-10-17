import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

function browserFixture(api) {
  const root = {
      innerHTML: '',
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
    },
    context = createContext({
      api,
      Intl,
      URLSearchParams,
      clearTimeout() {},
      pollTimer: null,
      deliveryTimer: null,
      session: {workspaceRole: 'owner'},
      document: {querySelector: () => null, addEventListener() {}},
      location: {pathname: '/reporting-overview'},
      authBind() {},
      workspaceBind() {},
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
  // WEB-07: report requests and display labels are shell helpers (web/workspace.js) since the report builder's script
  // left the shell.
  const workspace = readFileSync('web/workspace.js', 'utf8');
  new Script(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  ).runInContext(context);
  new Script('overviewState.bootstrap={platforms:[],metrics:{}}').runInContext(context);
  return {root, run: code => new Script(code).runInContext(context), context};
}
const snapshot = id => ({
  id,
  state: 'complete',
  rows: [],
  row_count: 0,
  sources: [],
  summary: [],
  exports: [],
  config: {name: id, date_range: {since: '2026-09-01', until: '2026-09-01'}, metrics: ['spend'], custom_metrics: []},
  job: {state: 'complete'},
});

test('switching snapshots fences an older response so it cannot replace the newly selected report', async () => {
  let release;
  const gate = new Promise(r => (release = r)),
    f = browserFixture(async (_url, options) => {
      const {id} = JSON.parse(options.body);
      if (id === 'old snapshot') await gate;
      return {success: true, data: snapshot(id)};
    });
  const old = f.run("loadOverviewReport('old snapshot')");
  await f.run("loadOverviewReport('new snapshot')");
  release();
  await old;
  assert.equal(f.run('overviewState.report.id'), 'new snapshot');
  assert.match(f.root.innerHTML, /new snapshot/);
  assert.ok(!f.root.innerHTML.includes('old snapshot'));
});

test('starting a separate client setup fences an in-flight report response and clears destination identity', async () => {
  let release;
  const gate = new Promise(r => (release = r)),
    f = browserFixture(async () => {
      await gate;
      return {success: true, data: snapshot('old snapshot')};
    });
  f.run(
    "overviewState.selection={kind:'view',id:'old-client',revision:1};overviewState.destinationId='old-tab';overviewState.deliveryDraft={schedule_kind:'monthly'}",
  );
  const pending = f.run("loadOverviewReport('old snapshot')");
  f.run('resetOverviewSelection()');
  release();
  await pending;
  assert.equal(f.run('overviewState.report'), null);
  assert.equal(f.run('overviewState.selection'), null);
  assert.equal(f.run('overviewState.destinationId'), null);
  assert.equal(f.run('overviewState.deliveryDraft'), null);
  assert.equal(f.root.innerHTML, '');
});

test('unavailable saved sources remain explicit selections and untrusted library names are escaped', () => {
  const f = browserFixture(async () => ({}));
  f.context.config = {sources: [{platform: 'meta', connection_id: 'revoked-login', account_id: '100'}]};
  f.context.bootstrap = {platforms: [{id: 'meta', accounts: []}]};
  const html = f.run('renderUnavailableReportSources(config,bootstrap)');
  assert.match(html, /explicitly uncheck/);
  assert.match(html, /revoked-login/);
  assert.match(html, /checked/);
  f.context.library = {views: [{id: 'one', config: {client_name: '<script>', name: 'Untrusted'}}], templates: []};
  const options = f.run('overviewLibraryOptions(library)');
  assert.ok(!options.includes('<script>'));
  assert.match(options, /&lt;script>/);
});

test('a report names the native field behind each metric on each of its platforms', () => {
  const f = browserFixture(async () => ({}));
  f.context.b = {
    platforms: [
      {id: 'google', name: 'Google Ads'},
      {id: 'reddit', name: 'Reddit'},
    ],
    metrics: {
      spend: {label: 'Spend'},
      conversions: {label: 'Primary conversions'},
      cpa: {label: 'Cost per conversion', formula: 'spend / conversions'},
    },
    metric_sources: {
      google: {
        spend: {from: 'metrics.cost_micros', divisor: 1000000},
        conversions: {from: 'metrics.conversions', note: 'conversion actions included in Conversions'},
      },
      reddit: {spend: {from: 'spend', divisor: 1000000}},
    },
  };
  f.context.r = {config: {sources: [{platform: 'google'}, {platform: 'reddit'}, {platform: 'google'}]}};
  const html = f.run("renderMetricSources(r,['spend','conversions','cpa'],b)");
  assert.match(html, /<th scope="col">Google Ads<\/th><th scope="col">Reddit<\/th>/);
  assert.match(html, /metrics\.cost_micros<\/code> ÷ 1,000,000/);
  assert.match(
    html,
    /<th scope="row">Primary conversions<\/th><td><code>metrics\.conversions<\/code><small>conversion actions included in Conversions<\/small><\/td><td><span class="muted">Not reported<\/span>/,
  );
  assert.ok(
    !html.includes('Cost per conversion'),
    'calculated metrics are explained by their formula, not a native field',
  );
  assert.equal(f.run("renderMetricSources({config:{sources:[{platform:'adjust'}]}},['spend'],b)"), '');
});

test('detailed metric explanations use the captured account and connection mapping, retaining mixed campaign rules', () => {
  const f = browserFixture(async () => ({})),
    purchase = {platform: 'meta', account_id: '100', connection_id: 'original', level: 'ad'},
    lead = {platform: 'meta', account_id: '200', connection_id: 'second', level: 'adset'},
    missing = {platform: 'meta', account_id: '400', connection_id: 'missing', level: 'ad'};
  f.context.b = {
    platforms: [
      {
        id: 'meta',
        name: 'Meta',
        entity_levels: [
          {id: 'ad', label: 'Ads'},
          {id: 'adset', label: 'Ad sets'},
        ],
      },
      {id: 'google', name: 'Google Ads', entity_levels: [{id: 'campaign', label: 'Campaigns'}]},
    ],
    metrics: {
      spend: {label: 'Spend'},
      conversions: {label: 'Primary conversions'},
      cpa: {label: 'Cost per conversion', formula: 'spend / conversions'},
    },
    metric_sources: {
      meta: {conversions: {from: 'campaign alias rule'}},
      google: {spend: {from: 'metrics.cost_micros', divisor: 1000000}, conversions: {from: 'metrics.conversions'}},
    },
  };
  f.context.r = {
    config: {sources: [purchase, lead, {platform: 'google', account_id: '300', connection_id: 'third'}, missing]},
    sources: [
      {source: {...purchase, connection_id: 'foreign'}, metric_mapping: {conversions: '/foreign-login'}},
      {source: purchase, metric_mapping: {spend: '/spend', conversions: {path: '/actions', action_type: 'purchase'}}},
      {source: lead, metric_mapping: {conversions: {path: '/actions', action_type: 'lead<&'}}},
    ],
  };
  const html = f.run("renderMetricSources(r,['spend','conversions','cpa'],b)");
  assert.match(html, /<bdi>100<\/bdi><br>Reporting level: Ads/);
  assert.match(html, /<bdi>200<\/bdi><br>Reporting level: Ad sets/);
  assert.match(html, /<bdi>300<\/bdi><br>Reporting level: Campaigns/);
  assert.match(html, /\/actions\[action_type=purchase\]/);
  assert.match(html, /\/actions\[action_type=lead&lt;&amp;\]/);
  assert.match(html, /metrics\.cost_micros<\/code> ÷ 1,000,000/);
  assert.match(html, /Native mapping unavailable/);
  assert.match(html, /Not reported/);
  assert.ok(!html.includes('foreign-login'));
  assert.ok(!html.includes('campaign alias rule'));
  assert.ok(!html.includes('Cost per conversion'));
});

test('report rows are announced by campaign, carry their time zone and show dates in the viewer locale', async () => {
  const row = {
    campaign_name: 'Spring sale',
    campaign_id: 'c-1',
    account_id: 'a-1',
    currency: 'EUR',
    timezone: 'Europe/Berlin',
    platform: 'google',
    objective_group: 'sales',
    result_definition: 'Purchases',
    attribution: 'Platform default',
    native: {},
    metrics: {spend: 12.5},
    recommendation: {decision: 'keep', reason: 'Within target', evidence: []},
    date_from: '2026-09-01',
    date_to: '2026-09-07',
  };
  const f = browserFixture(async () => ({
    success: true,
    data: {
      ...snapshot('weekly'),
      rows: [row],
      row_count: 1,
      config: {...snapshot('weekly').config, grain: 'weekly', sources: []},
    },
  }));
  f.run(
    "overviewState.bootstrap={platforms:[{id:'google',name:'Google Ads',accounts:[]}],metrics:{spend:{label:'Spend',format:'currency'}}}",
  );
  await f.run("loadOverviewReport('weekly')");
  const html = f.root.innerHTML;
  assert.match(
    html,
    /<th scope="col" role="columnheader">Campaign \/ ad set \/ ad \/ resource<\/th><th scope="col" role="columnheader">Platform · objective<\/th><th scope="col" role="columnheader">Period<\/th><th scope="col" role="columnheader">Spend<\/th>/,
  );
  // RPT-05: the row header is the campaign name only; IDs, account, currency and time zone moved to the context cell
  // (the earlier expectation encoded a ~110-character row header that screen readers repeated on every cell).
  assert.match(
    html,
    /<tr role="row"><th scope="row" role="rowheader"><strong dir="auto" data-native>Spring sale<\/strong><\/th><td role="cell" class="report-row-context" data-label="Platform · objective"><span>Google Ads<\/span><small>Sales<\/small><small>c-1<br>a-1 · EUR · Europe\/Berlin<\/small>/,
  );
  assert.match(html, /<td role="cell" data-label="Period">1 Sept? 2026<br>7 Sept? 2026<\/td>/);
  assert.ok(!html.includes('<td>2026-09-01'), 'no raw ISO period');
});
