// RPT-05: one precision-preserving number format, Sheets number formats, readable report packs, compact native evidence
// tables and prefilled capture settings. Each test names the defect it guards against. All data are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {Store} from '../dist/src/store.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {rememberAccountMetadata} from '../dist/src/account-metadata.js';
import {reportTable, sheetsPresentationRequests} from '../dist/src/google-sheets.js';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';

const arabic = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function localization(locale = 'en', extra = {}) {
  const context = createContext({Intl, Date, URLSearchParams, esc, document: {addEventListener() {}}, ...extra});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  if (locale === 'ar') {
    context.catalog = arabic;
    new Script("uiLocale='ar';uiMessages=new Map(Object.entries(catalog))").runInContext(context);
  }
  return {context, run: code => new Script(code).runInContext(context)};
}

test('RPT-05: currencies use their own minor units and exact decimal strings keep every digit', () => {
  // Before RPT-05 metricFormat forced at most two decimals (KWD truncated) and exact strings were shown raw.
  const f = localization();
  const currency = code => new Intl.NumberFormat('en', {style: 'currency', currency: code});
  assert.equal(f.run("uiDecimal('12.3456', {currency: 'KWD'})"), currency('KWD').format('12.3456'));
  assert.match(f.run("uiDecimal('12.3456', {currency: 'KWD'})"), /12\.346/);
  assert.match(f.run("uiDecimal('1234.5', {currency: 'JPY'})"), /1,235$/);
  assert.match(f.run("uiDecimal('0.105', {currency: 'SAR'})"), /0\.11$/, 'the exact decimal rounds half up, not 0.10');
  assert.equal(f.run("uiDecimal('1360087087465.889943', {currency: 'USD'})"), '$1,360,087,087,465.89');
  const long = '90071992547409931234.5678';
  assert.equal(f.run(`uiDecimal('${long}')`), '90,071,992,547,409,931,234.57');
  assert.notEqual(
    f.run(`uiDecimal('${long}')`),
    new Intl.NumberFormat('en', {maximumFractionDigits: 2}).format(Number(long)),
    'a binary double would lose the trailing integer digits',
  );
  assert.equal(f.run("uiDecimal('12.3456', {minorUnitsOf: 'KWD'})"), '12.346');
  assert.equal(f.run("uiDecimal('7', {minorUnitsOf: 'JPY'})"), '7');
  assert.equal(f.run("uiDecimal('n/a')"), 'n/a', 'text stays as it is');
  assert.equal(f.run('uiDecimal(null)'), '');
  assert.match(f.run("uiDecimal(5, {currency: 'XYZ'})"), /XYZ/, 'an unlisted currency keeps its code');
  assert.equal(f.run("uiDecimal(5, {currency: 'dollars'})"), '5 dollars', 'a malformed code is kept as written');
  assert.equal(
    f.run("uiDecimalMarkup('12.3456', {minorUnitsOf: 'USD'})"),
    '<data value="12.3456" title="12.3456">12.35</data>',
  );
  const ar = localization('ar');
  assert.doesNotMatch(ar.run("uiDecimal('1234.5678', {currency: 'KWD'})"), /[٠-٩]/, 'Latin digits (D27)');
  assert.match(ar.run("uiDecimal('1234.5678', {currency: 'KWD'})"), /1,234\.568/);
});

function overview(metrics = {}) {
  const root = {
      innerHTML: '',
      insertAdjacentHTML(_position, html) {
        this.innerHTML += html;
      },
    },
    context = createContext({
      api: async () => ({success: true, data: {}}),
      Intl,
      Date,
      URLSearchParams,
      setTimeout() {},
      clearTimeout() {},
      pollTimer: null,
      deliveryTimer: null,
      session: {workspaceRole: 'owner'},
      document: {querySelector: () => null, querySelectorAll: () => [], addEventListener() {}},
      location: {pathname: '/reporting-overview', search: ''},
      authBind() {},
      workspaceBind() {},
      date: () => '',
      esc,
      $: selector => (selector === '#overview-results' ? root : null),
    });
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    new Script(readFileSync('web/' + file + '.js', 'utf8')).runInContext(context);
  context.metrics = {
    spend: {label: 'Spend', format: 'currency'},
    clicks: {label: 'Clicks', format: 'number'},
    roas: {label: 'Return on ad spend', format: 'decimal'},
    ...metrics,
  };
  new Script("overviewState.bootstrap={platforms:[{id:'meta',name:'Meta'}],metrics}").runInContext(context);
  return {root, context, run: code => new Script(code).runInContext(context)};
}

test('RPT-05: Overview values keep Gulf-currency precision, show ROAS as a multiple and keep exact totals on hover', async () => {
  const f = overview();
  assert.match(f.run("metricFormat('spend', 12.3456, 'KWD')"), /12\.346/, 'before RPT-05 this read 12.35');
  assert.match(f.run("metricFormat('spend', 1234.5, 'JPY')"), /1,235$/);
  assert.equal(f.run("metricFormat('roas', 2.5)"), '2.5×');
  assert.equal(f.run("metricFormat('clicks', 1234)"), '1,234');
  const row = {
    entity_level: 'ad',
    entity_id: '1',
    entity_name: 'Ad',
    account_id: '100',
    currency: 'USD',
    platform: 'meta',
    objective_group: 'sales',
    metrics: {spend: 90071992547409931234.5678, clicks: 3, roas: 2},
    native: {exact_totals: {spend: '90071992547409931234.5678'}},
    recommendation: {decision: 'observe', reason: 'Synthetic'},
  };
  f.context.row = row;
  const cell = f.run("metricCell(row, 'spend')");
  assert.match(cell, /title="90071992547409931234\.5678"/);
  assert.match(cell, /\$90,071,992,547,409,931,234\.57/, 'the exact retained total, not the rounded double');
  // A campaign row's provider object is not an exact-total source.
  f.context.campaign = {...row, entity_level: undefined, metrics: {spend: 12.5}, native: {exact_totals: {spend: '1'}}};
  assert.match(f.run("metricCell(campaign, 'spend')"), /\$12\.50/);
});

test('RPT-05: a Sheets export sends number formats per metric column in the same batch, with values unchanged', async () => {
  // Before RPT-05 Sheets cells held raw doubles and no numberFormat request was sent. Since the merge with EXP-04 the
  // formats are part of the version 2 tab contract (sheetsPresentationRequests): each column is found by its name, so
  // the trailing Recommendation basis column cannot shift them, and a version 1 delivery sends none.
  const report = {
    id: 'r',
    state: 'complete',
    config: {metrics: ['spend', 'clicks', 'ctr', 'roas', 'frequency', 'native_meta_spend'], custom_metrics: []},
    rows: [
      {currency: 'KWD', metrics: {}, quality: {}, captured_at: 0, recommendation: {decision: 'observe'}},
      {currency: 'USD', metrics: {}, quality: {}, captured_at: 0, recommendation: {decision: 'observe'}},
    ],
    sources: [],
  };
  const table = reportTable(report, 0),
    header = table[0],
    formats = (r, t) =>
      sheetsPresentationRequests(r, t, 9, 100, t[0].length).filter(
        x => x.repeatCell?.fields === 'userEnteredFormat.numberFormat',
      ),
    requests = formats(report, table),
    pattern = key =>
      requests.find(
        r =>
          r.repeatCell.range.startColumnIndex === header.indexOf(key) &&
          r.repeatCell.range.endColumnIndex === header.indexOf(key) + 1,
      )?.repeatCell.cell.userEnteredFormat?.numberFormat?.pattern;
  assert.equal(header.at(-1), 'Recommendation basis', 'a version 2 table');
  assert.deepEqual(requests[0].repeatCell, {
    range: {sheetId: 9, startRowIndex: 1, endRowIndex: 100, startColumnIndex: 0, endColumnIndex: header.length},
    cell: {},
    fields: 'userEnteredFormat.numberFormat',
  });
  assert.equal(pattern('spend'), '#,##0.000', 'KWD needs three decimals');
  assert.equal(pattern('clicks'), '#,##0');
  assert.equal(pattern('ctr'), '#,##0.00"%"');
  assert.equal(pattern('roas'), '#,##0.00"×"');
  assert.equal(pattern('frequency'), '#,##0.00');
  assert.equal(pattern('native_meta_spend'), undefined, 'native fields stay unformatted');
  assert.ok(requests.every(r => r.repeatCell.fields === 'userEnteredFormat.numberFormat'));
  const jpy = {...report, rows: [{...report.rows[0], currency: 'JPY'}]};
  assert.equal(
    formats(jpy, reportTable(jpy, 0)).find(
      r =>
        r.repeatCell.range.startColumnIndex === header.indexOf('spend') &&
        r.repeatCell.range.endColumnIndex === header.indexOf('spend') + 1,
    ).repeatCell.cell.userEnteredFormat.numberFormat.pattern,
    '#,##0',
  );

  const f = overviewGranularityFixture();
  try {
    const queued = await f.overview.handle(
      {action: 'run', config: granularConfig(granularSource('meta', 'ad')), confirmed: true},
      f.actor,
    );
    assert.equal(await f.worker.once(), true);
    const snapshot = await f.overview.handle({action: 'get', id: queued.id, limit: 100}, f.actor);
    const destination = await f.overview.handle(
      {
        action: 'bind_destination',
        connection_id: 'sheets-granular',
        spreadsheet_id: 'syntheticGranularSheet',
        tab_name: 'Formats',
        idempotency_key: 'granular-sheet-formats',
        confirmed: true,
      },
      f.actor,
    );
    await f.overview.handle(
      {action: 'export', report_id: snapshot.id, destination_id: destination.id, confirmed: true},
      f.actor,
    );
    assert.equal(await f.worker.once(), true);
    const batch = f.requests.find(r => r.url.hostname === 'sheets.googleapis.com' && r.method === 'POST').body,
      exported = reportTable(snapshot),
      spend = exported[0].indexOf('spend'),
      formats = batch.requests.filter(r => r.repeatCell?.cell?.userEnteredFormat?.numberFormat);
    assert.ok(
      formats.some(r => r.repeatCell.range.startColumnIndex === spend),
      'the spend column has a number format',
    );
    const cells = f.tabs.get(destination.sheet_id).values;
    assert.deepEqual(cells[1][spend], {numberValue: exported[1][spend]}, 'the value itself is unchanged');
  } finally {
    f.close();
  }
});

test('RPT-05: the client report pack names platforms, localizes dates and shows currency values in their own style', () => {
  // Before RPT-05 the pack showed "meta · 100", ISO dates and "0.1 USD".
  const f = localization('en', {
    pretty: v => String(v),
    date: () => 'date',
    uiReportExplanation: String,
    badge: String,
  });
  const source = readFileSync('web/evidence-workflows.js', 'utf8');
  // The pack reads a figure's coverage and draws a ratio through report-quality.js, which its route loads first (F-L5-01).
  f.run(readFileSync('web/report-quality.js', 'utf8'));
  f.run(source.slice(source.indexOf('function reportPackBody('), source.indexOf('async function renderReportPack(')));
  f.context.pack = {
    title: 'Pack',
    date_range: {since: '2026-09-01', until: '2026-09-07'},
    grain: 'total',
    state: 'complete',
    row_count: 1,
    created_at: 0,
    platform_names: {meta: 'Meta'},
    summary: [
      {
        platform: 'meta',
        account_id: '100',
        objective_group: 'sales',
        currency: 'USD',
        timezone: 'UTC',
        result_definition: 'purchase',
        attribution: 'Meta 7d_click; impression time',
        complete: true,
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        metrics: {spend: 0.1, impressions: 1000, clicks: 10, conversions: 1, cpa: 0.1, ctr: 1},
      },
    ],
    sources: [{platform: 'meta', account_id: '100', complete: true, row_count: 1}],
    limitations: [],
    snapshot_id: 's',
    source_hash: 'h',
  };
  const html = f.run('reportPackBody(pack)');
  assert.match(html, /Meta · 100 · /);
  assert.ok(!html.includes('meta · 100'));
  assert.match(html, /Sep 1, 2026/);
  assert.ok(!html.includes('2026-09-01'));
  assert.match(html, /\$0\.10/);
  assert.ok(!html.includes('0.1 USD'));
});

function evidenceRows({stored} = {}) {
  const nodes = new Map(),
    storage = new Map(stored ? [['amcp.evidence.native_ids', stored]] : []);
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        innerHTML: '',
        value: '',
        checked: false,
        disabled: false,
        isConnected: true,
        events: new Map(),
        addEventListener(type, fn) {
          this.events.set(type, fn);
        },
        setAttribute() {},
        focus() {},
        querySelector: selector => node(selector),
      });
    return nodes.get(key);
  };
  const rows = [
    {
      entity_id: 'customers/1234567890/campaigns/777777',
      entity_name: 'Spring',
      native_country_criterion_id: '2682',
      native_location_type: 'LOCATION_OF_PRESENCE',
      native_geographic_resource: 'customers/1234567890/geographicViews/2682~LOCATION_OF_PRESENCE',
      date: '2026-09-01',
      spend: '12.3456',
      impressions: '1000',
      clicks: '12',
      conversions: '1.5',
    },
  ];
  const report = {
    id: 'country',
    gateway: 'google_ads_native_action',
    account_id: '1234567890',
    connection_id: 'login',
    preset: 'google_campaign_country',
    source: 'provider_read',
    source_hash: 'b'.repeat(64),
    row_count: 1,
    has_more: false,
    rows,
    semantics: {source_name: 'Country', currency: 'KWD'},
    mapping: {
      entity_id: '/campaign/resourceName',
      entity_name: '/campaign/name',
      native_country_criterion_id: '/geographicView/countryCriterionId',
      native_location_type: '/geographicView/locationType',
      native_geographic_resource: '/geographicView/resourceName',
      date: '/segments/date',
      spend: {path: '/metrics/costMicros', divisor: 1000000},
      impressions: '/metrics/impressions',
      clicks: '/metrics/clicks',
      conversions: '/metrics/conversions',
    },
  };
  const f = localization('en', {
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    $: node,
    report,
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    workspaceCall: async () => report,
    toast() {},
  });
  f.run(readFileSync('web/evidence-workflows.js', 'utf8'));
  f.run('mountEvidenceRows(report, () => true)');
  return {html: () => node('#report-native-rows').innerHTML, node, storage};
}

test('RPT-05: native evidence tables hide long resource columns by default and keep exact values readable', () => {
  // Before RPT-05 the Google country table showed both long resource-name columns, raw enums and raw decimals.
  const f = evidenceRows();
  const html = f.html();
  const headers = [...html.matchAll(/<th scope="col">([^<]+)/g)].map(m => m[1]);
  assert.ok(!headers.includes('Native geographic resource'));
  assert.ok(!headers.includes('Entity ID'));
  assert.ok(headers.includes('Entity name'));
  assert.match(html, /<abbr title="LOCATION_OF_PRESENCE">Physical presence<\/abbr>/);
  assert.match(html, /<data value="12\.3456" title="12\.3456">12\.346<\/data>/, 'KWD keeps three decimals');
  assert.match(html, /<th scope="row" dir="auto">Spring<\/th>/);
  assert.match(html, /class="review-table evidence-rows-table"/);
  // The per-viewer toggle shows the native IDs, middle-truncated with a copy button, and is remembered.
  const toggle = f.node('#evidence-native-ids');
  toggle.checked = true;
  toggle.events.get('change')();
  assert.equal(f.storage.get('amcp.evidence.native_ids'), 'shown');
  const shown = f.html();
  assert.match(shown, /<th scope="col">Native geographic resource<\/th>/);
  assert.match(
    shown,
    /<code title="customers\/1234567890\/geographicViews\/2682~LOCATION_OF_PRESENCE">customers\/12…_OF_PRESENCE<\/code> <button type="button" class="button small evidence-copy" data-copy-native="customers\/1234567890\/geographicViews\/2682~LOCATION_OF_PRESENCE"/,
  );
  assert.match(evidenceRows({stored: 'shown'}).html(), /<th scope="col">Entity ID<\/th>/);
});

function captureWizard({target, typed = {}} = {}) {
  const nodes = new Map(),
    calls = [];
  const node = id => {
    if (!nodes.has(id)) {
      const attributes = new Map();
      nodes.set(id, {
        innerHTML: '',
        textContent: '',
        hidden: true,
        value: '',
        checked: false,
        disabled: false,
        readOnly: false,
        isConnected: true,
        events: new Map(),
        getAttribute: key => attributes.get(key) ?? null,
        setAttribute: (key, value) => attributes.set(key, String(value)),
        removeAttribute: key => attributes.delete(key),
        insertAdjacentHTML(_where, text) {
          this.innerHTML += text;
        },
        addEventListener(type, callback) {
          this.events.set(type, callback);
        },
      });
    }
    return nodes.get(id);
  };
  const form = node('#capture-preset');
  form.querySelector = () => node('#capture-submit');
  form.elements = Object.fromEntries(
    [
      'preset',
      'target',
      'source_name',
      'date_from',
      'date_to',
      'currency',
      'timezone',
      'attribution',
      'conversion_definition',
      'complete',
      'campaign_id',
      'result_action_type',
      'attribution_windows',
      'swipe_up_attribution_window',
      'view_attribution_window',
    ].map(key => [key, node('field:' + key)]),
  );
  form.elements.preset.value = 'google_keyword';
  for (const [key, value] of Object.entries(typed)) form.elements[key].value = value;
  const f = localization('en', {
    navigationGeneration: 1,
    identityGeneration: 1,
    document: {addEventListener() {}},
    $: node,
    platforms: [{id: 'google', connections: [{id: 'login-1', enabled: true, accounts: ['123']}]}],
    accountLabel: () => 'Google account',
    controls: () => '',
    workspaceBind() {},
    workspaceCall: async (_tool, input) => {
      calls.push(input);
      return input.connection_id
        ? {presets: [], target}
        : {presets: [{id: 'google_keyword', name: 'Google keyword', gateway: 'google_ads_native_action'}]};
    },
    toast() {},
    errorMessage: e => e.message,
  });
  const source = readFileSync('web/evidence-workflows.js', 'utf8');
  f.run(
    source.slice(source.indexOf('function evidencePresetLabel('), source.indexOf('\nfunction mountScenarioModel(')),
  );
  return {
    form,
    node,
    calls,
    mount: () => f.run('mountCaptureWizard(async () => {})'),
    choose: async () => {
      form.elements.target.value = '0';
      await form.elements.target.events.get('change')();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('RPT-05: capture prefills currency, timezone and the last 7 complete account-local days from the stored account read', async () => {
  // Before RPT-05 "Native currency" and "Native IANA timezone" were blank although AMCP stores them per account.
  const recent = new Date(Date.now() - 3600000).toISOString();
  const f = captureWizard({target: {currency: 'KWD', timezone: 'Asia/Kuwait', checked_at: recent, stale: false}});
  await f.mount();
  await f.choose();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), {
    action: 'capture_presets',
    connection_id: 'login-1',
    account_id: '123',
  });
  assert.equal(f.form.elements.currency.value, 'KWD');
  assert.equal(f.form.elements.timezone.value, 'Asia/Kuwait');
  assert.equal(f.form.elements.currency.readOnly, false, 'prefilled values stay editable');
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Kuwait'}).format(new Date()),
    day = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  assert.equal(f.form.elements.date_to.value, day(-1));
  assert.equal(f.form.elements.date_from.value, day(-7));
  const hint = f.node('#capture-account-metadata');
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /^Currency and timezone from the account read on .+\. Edit them if they changed/);
});

test('RPT-05: capture labels account details older than 7 days and never replaces typed values', async () => {
  const old = new Date(Date.now() - 9 * 86400000).toISOString();
  const f = captureWizard({
    target: {currency: 'KWD', timezone: 'Asia/Kuwait', checked_at: old, stale: true},
    typed: {currency: 'USD', date_from: '2026-08-01', date_to: '2026-08-07'},
  });
  await f.mount();
  await f.choose();
  assert.equal(f.form.elements.currency.value, 'USD', 'a typed currency is kept');
  assert.equal(f.form.elements.timezone.value, 'Asia/Kuwait');
  assert.equal(f.form.elements.date_from.value, '2026-08-01');
  assert.match(f.node('#capture-account-metadata').textContent, /more than 7 days ago/);
  const missing = captureWizard({target: {currency: null, timezone: null, checked_at: null, stale: true}});
  await missing.mount();
  await missing.choose();
  assert.equal(missing.form.elements.currency.value, '');
  assert.match(missing.node('#capture-account-metadata').textContent, /No account read is stored/);
});

test('RPT-05: capture_presets returns one account target from stored metadata without a provider read', async t => {
  const store = new Store(':memory:', Buffer.alloc(32, 77).toString('base64')),
    actor = {tenantId: 'capture-targets', userId: 'owner', role: 'admin'};
  try {
    store.putConnection(
      actor,
      {
        id: 'login-1',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['123'],
        enabled: true,
        label: 'Synthetic',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    const calls = [],
      reporting = new DecisionReporting(store, async (...args) => calls.push(args));
    assert.deepEqual(Object.keys(await reporting.handle({action: 'capture_presets'}, actor)), ['presets']);
    const unread = await reporting.handle(
      {action: 'capture_presets', connection_id: 'login-1', account_id: '123'},
      actor,
    );
    assert.deepEqual(unread.target, {
      gateway: 'google_ads_native_action',
      connection_id: 'login-1',
      account_id: '123',
      currency: null,
      timezone: null,
      checked_at: null,
      stale: true,
    });
    rememberAccountMetadata(store, actor.tenantId, 'login-1', '123', {
      name: 'Synthetic',
      currency: 'KWD',
      timezone: 'Asia/Kuwait',
    });
    const read = await reporting.handle(
      {action: 'capture_presets', connection_id: 'login-1', account_id: '123'},
      actor,
    );
    assert.equal(read.target.currency, 'KWD');
    assert.equal(read.target.timezone, 'Asia/Kuwait');
    assert.equal(read.target.stale, false);
    const later = Date.now() + 8 * 86400000;
    t.mock.method(Date, 'now', () => later);
    assert.equal(
      (await reporting.handle({action: 'capture_presets', connection_id: 'login-1', account_id: '123'}, actor)).target
        .stale,
      true,
      'metadata older than 7 days is labelled stale',
    );
    t.mock.restoreAll();
    await assert.rejects(
      reporting.handle({action: 'capture_presets', connection_id: 'login-1', account_id: '999'}, actor),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    // Another workspace cannot read this account's stored currency and timezone.
    await assert.rejects(
      reporting.handle(
        {action: 'capture_presets', connection_id: 'login-1', account_id: '123'},
        {...actor, tenantId: 'other-workspace'},
      ),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    // A disabled connection is not a capture target.
    store.putConnection(
      actor,
      {
        id: 'login-2',
        tenantId: actor.tenantId,
        gateway: 'google_ads_native_action',
        accounts: ['456'],
        enabled: false,
        label: 'Disabled',
        scopes: [],
      },
      {accessToken: 'synthetic'},
    );
    await assert.rejects(
      reporting.handle({action: 'capture_presets', connection_id: 'login-2', account_id: '456'}, actor),
      e => e.code === 'CONNECTION_REQUIRED',
    );
    assert.equal(calls.length, 0, 'no provider read');
  } finally {
    store.close();
  }
});
