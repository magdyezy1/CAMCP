import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';

const plain = value => JSON.parse(JSON.stringify(value));
function fixture(locale) {
  const nodes = new Map(),
    lists = new Map(),
    bindings = new Map(),
    calls = [],
    confirmations = [];
  const node = key => {
    if (!nodes.has(key))
      nodes.set(key, {
        value: '',
        innerHTML: '',
        textContent: '',
        dataset: {},
        elements: {},
        values: {},
        isConnected: true,
        open: false,
        addEventListener() {},
        focus() {},
        reportValidity: () => true,
        closest: () => ({hidden: false}),
        insertAdjacentHTML(_position, html) {
          this.innerHTML += html;
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(key);
  };
  const config = {
    name: 'Home',
    client_name: 'Home <img>',
    grain: 'weekly',
    partial_delivery: 'complete_only',
    sources: [{platform: 'google', connection_id: 'login-001', account_id: '001'}],
    date_range: {preset: 'last_complete_days', days: 14, offset_days: 2, timezone: 'Africa/Cairo'},
    metrics: ['spend'],
    custom_metrics: [{id: 'home', label: 'Home', formula: 'spend / clicks', format: 'currency'}],
    targets: {},
    objectives: [],
  };
  const bootstrap = {
    platforms: [{id: 'google', name: 'Google Ads', accounts: [{connection_id: 'login-001', account_id: '001'}]}],
    metrics: {spend: {label: 'Spend', format: 'currency'}},
    views: [],
    templates: [],
    schedules: [],
    sheets_connections: [],
    destinations: [],
    file_destinations: [],
  };
  let handler = args =>
    args.action === 'bootstrap' ? bootstrap : {id: 'view-001', revision: 8, config: args.config ?? config};
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    crypto: {randomUUID: () => 'stable-idempotency-key'},
    document: {addEventListener() {}, querySelector: node, querySelectorAll: s => lists.get(s) ?? []},
    $: node,
    content: node('content'),
    esc: v =>
      String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    authBind: (s, fn) => bindings.set(s, fn),
    workspaceBind: (s, fn) => bindings.set(s, fn),
    date: String,
    badge: String,
    blank: String,
    toast() {},
    clearTimeout() {},
    setTimeout() {},
    pollTimer: null,
    navigationGeneration: 1,
    identityGeneration: 1,
    session: {workspaceRole: 'owner', authenticated: true},
    location: {pathname: '/reporting-overview', search: ''},
    history: {replaceState() {}},
    approved: false,
    confirm: () => context.approved,
    confirmAction: async options => {
      confirmations.push(plain(options));
      return context.approved;
    },
    api: async (_url, options) => {
      const args = JSON.parse(options.body);
      calls.push(args);
      return {success: true, data: await handler(args)};
    },
    FormData: class {
      constructor(form) {
        this.values = form.values;
      }
      get(k) {
        return this.values[k] ?? null;
      }
      getAll(k) {
        const v = this.values[k];
        return Array.isArray(v) ? v : v === undefined ? [] : [v];
      }
      *[Symbol.iterator]() {
        yield* Object.entries(this.values);
      }
    },
    config,
    bootstrap,
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
  });
  const run = code => new Script(code).runInContext(context);
  for (const file of [
    'localization',
    'report-library',
    'report-quality',
    'report-workflows',
    'report-delivery',
    'reporting-overview',
  ])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});overviewState.bootstrap=bootstrap;overviewState.config=config;overviewState.custom=config.custom_metrics;renderReportingOverview=async()=>{};`,
  );
  for (const key of [
    'report_name',
    'partial_delivery',
    'schedule_kind',
    'hour',
    'minute',
    'weekday',
    'day',
    'timezone',
    'preset',
    'days',
    'offset_days',
    'window_timezone',
  ])
    node('#report-schedule').elements[key] = node('schedule:' + key);
  return {
    run,
    context,
    node,
    lists,
    bindings,
    calls,
    confirmations,
    config,
    bootstrap,
    respond: fn => {
      handler = fn;
    },
  };
}

test('Arabic report builder keeps client names, custom formulas, exact account IDs and save revisions unchanged', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.node('#overview-config').values = {
      name: 'Home',
      client_name: 'Home <img>',
      grain: 'weekly',
      rangeMode: 'last_complete_days',
      days: '14',
      offset_days: '2',
      timezone: 'Africa/Cairo',
      partial_delivery: 'complete_only',
    };
    f.lists.set('[data-report-account]:checked', [{value: JSON.stringify(['google', 'login-001', '001'])}]);
    f.lists.set('[data-report-metric]:checked', [{value: 'spend'}]);
    f.node('[data-objective-for="google"]').value = 'sales';
    f.node('[data-report-level="google"]').value = 'campaign';
    f.node('[data-native-for="google"]').value = 'metrics.cost_micros,metrics.conversions';
    f.run(
      "overviewState.selection={kind:'view',id:'view-001',revision:7};overviewState.destinationId='destination-001'",
    );
    const html = f.run('renderReportSetupFields(config)');
    assert.match(html, /value="Home"/);
    assert.match(html, /Home &lt;img&gt;/);
    assert.equal(f.run('overviewDefault().name'), 'Campaign performance');
    if (locale === 'ar') assert.match(html, /اسم العميل/);
    await f.run('saveOverviewDefinition()');
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  const saved = transcripts[0][0];
  assert.equal(saved.expected_revision, 7);
  assert.equal(saved.destination_id, 'destination-001');
  assert.deepEqual(saved.config.sources, [
    {
      platform: 'google',
      connection_id: 'login-001',
      account_id: '001',
      objective: 'sales',
      native_metrics: ['metrics.cost_micros', 'metrics.conversions'],
    },
  ]);
  assert.deepEqual(saved.config.custom_metrics, [
    {id: 'home', label: 'Home', formula: 'spend / clicks', format: 'currency'},
  ]);
  assert.deepEqual(saved.config.date_range, {
    preset: 'last_complete_days',
    days: 14,
    offset_days: 2,
    timezone: 'Africa/Cairo',
  });
});

test('Arabic file delivery keeps format and retention consent explicit and submits the same destination', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    await f.run('renderReportDelivery()');
    const html = f.node('#report-delivery-content').innerHTML;
    assert.match(html, /value="Home files"/);
    assert.doesNotMatch(html, /name="(?:formats|confirmed)"[^>]*checked/);
    if (locale === 'ar') assert.match(html, /وجهة/);
    const form = {
      dataset: {},
      values: {
        name: 'Home',
        formats: ['pdf', 'xlsx'],
        brand_name: 'Home',
        accent_color: '#354B67',
        footer: 'Home <img>',
        template: 'compact',
      },
    };
    await f.bindings.get('#report-bind-files')(form);
    assert.equal(f.calls.length, 1, 'unchecked retention consent sends no mutation');
    form.values.confirmed = 'on';
    await f.bindings.get('#report-bind-files')(form);
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0][1], {
    action: 'bind_file_destination',
    confirmed: true,
    idempotency_key: 'stable-idempotency-key',
    file_destination: {
      name: 'Home',
      formats: ['pdf', 'xlsx'],
      presentation: {brand_name: 'Home', accent_color: '#354B67', footer: 'Home <img>', template: 'compact'},
    },
  });
});

test('Arabic report scheduling preserves separate delivery and reporting clocks and both saved revisions', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.bootstrap.views.push({id: 'view-001', revision: 7, config: f.config, schedule_id: 'schedule-001'});
    f.bootstrap.schedules.push({
      id: 'schedule-001',
      view_id: 'view-001',
      revision: 9,
      config: f.config,
      schedule_kind: 'weekly',
      timezone: 'Africa/Cairo',
      schedule_config: {hour: 23, minute: 55, weekday: 0},
      is_active: false,
    });
    f.run("overviewState.selection={kind:'view',id:'view-001',revision:7}");
    await f.run('renderReportDelivery()');
    const html = f.node('#report-delivery-content').innerHTML;
    if (locale === 'ar') assert.match(html, /المنطقة الزمنية للتسليم/);
    f.node('#report-destination').value = 'destination-001';
    f.respond(args => {
      assert.equal(args.action, 'update_schedule');
      // A departed view must still send the reviewed values, but cannot adopt its response.
      f.context.identityGeneration++;
      return {view_id: 'view-001', is_active: false};
    });
    await f.bindings.get('#report-schedule')({
      dataset: {},
      values: {
        report_name: 'Home',
        partial_delivery: 'complete_only',
        schedule_kind: 'weekly',
        hour: '23',
        minute: '55',
        weekday: '0',
        timezone: 'Africa/Cairo',
        preset: 'last_complete_days',
        days: '14',
        offset_days: '2',
        window_timezone: 'America/New_York',
      },
    });
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  const saved = transcripts[0][1];
  assert.equal(saved.action, 'update_schedule');
  assert.equal(saved.expected_revision, 9);
  assert.equal(saved.expected_view_revision, 7);
  assert.deepEqual(saved.schedule, {
    schedule_kind: 'weekly',
    timezone: 'Africa/Cairo',
    destination_id: 'destination-001',
    schedule_config: {minute: 55, hour: 23, weekday: 0},
  });
  assert.deepEqual(saved.config.date_range, {
    preset: 'last_complete_days',
    timezone: 'America/New_York',
    days: 14,
    offset_days: 2,
  });
  assert.equal(saved.config.partial_delivery, 'complete_only');
});

test('Arabic measurement context keeps supplied booleans, KPI direction and notes distinct from missing values', () => {
  const contexts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale),
      supplied = {
        note: 'Home',
        seasonal_event: 'Home <img>',
        recent_change: false,
        tracking_verified: true,
        budget_available: false,
        current_daily_budget: 12.34,
        maximum_daily_budget: 100,
        secondary_kpi: {kpi: 'cpa', target: 2.5, direction: 'lower'},
      };
    f.context.supplied = supplied;
    const html = f.run("reportTargetContext('sales',supplied)");
    assert.match(html, /Home &lt;img&gt;/);
    assert.match(html, /value="false" selected/);
    if (locale === 'ar') assert.match(html, /سياق العمل/);
    f.lists.set(
      '[data-target-context]',
      Object.entries({...supplied, secondary_kpi: undefined, capacity_available: ''})
        .filter(([key]) => key !== 'secondary_kpi')
        .map(([key, value]) => ({dataset: {targetContext: 'sales:' + key}, value: String(value)})),
    );
    f.lists.set(
      '[data-target-secondary]',
      Object.entries(supplied.secondary_kpi).map(([key, value]) => ({
        dataset: {targetSecondary: 'sales:' + key},
        value: String(value),
      })),
    );
    contexts.push(plain(f.run("readTargetContext('sales')")));
    assert.deepEqual(contexts.at(-1), supplied);
  }
  assert.deepEqual(contexts[1], contexts[0]);
});

test('Arabic snapshot dates and numeric display follow the chosen language without rewriting precise strings or download identities', () => {
  const f = fixture('ar');
  assert.equal(
    f.run("metricFormat('spend',12.34,'SAR')"),
    new Intl.NumberFormat('ar', {maximumFractionDigits: 2, style: 'currency', currency: 'SAR'}).format(12.34),
  );
  // RPT-05: an exact decimal string is formatted at its exact value (no binary rounding) instead of being shown raw;
  // the table keeps the original string on hover.
  assert.equal(
    f.run("metricFormat('spend','0012.340000','SAR')"),
    new Intl.NumberFormat('ar', {numberingSystem: 'latn', style: 'currency', currency: 'SAR'}).format('12.34'),
  );
  assert.equal(
    f.run("reportDay('2026-09-07')"),
    new Intl.DateTimeFormat('ar', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(
      new Date('2026-09-07T00:00:00Z'),
    ),
  );
  const html = f.run(
    "reportFileLinks({id:'original export',files:[{format:'pdf',size_bytes:1234,download_path:'javascript:private'}]})",
  );
  assert.match(html, /تنزيل PDF/);
  assert.match(html, /original%20export\.pdf/);
  assert.doesNotMatch(html, /javascript:/);
});

test('Arabic library deletion names the original report and cancelled confirmation sends nothing', async () => {
  const transcripts = [];
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.run("overviewState.selection={kind:'view',id:'view-001',revision:7};bindOverviewLibrary()");
    await f.bindings.get('#overview-delete')();
    assert.equal(f.calls.length, 0);
    if (locale === 'ar') assert.match(f.confirmations[0].title, /حذف/);
    assert.match(f.confirmations[0].title, /Home/);
    f.context.approved = true;
    await f.bindings.get('#overview-delete')();
    transcripts.push(f.calls);
  }
  assert.deepEqual(transcripts[1], transcripts[0]);
  assert.deepEqual(transcripts[0], [{action: 'delete_view', id: 'view-001', expected_revision: 7, confirmed: true}]);
});

test('Arabic rendered snapshot translates known metric labels while preserving custom labels and native source evidence', async () => {
  const f = fixture('ar');
  const snapshot = {
    id: 'snapshot-001',
    state: 'complete',
    row_count: 1,
    offset: 0,
    has_more: false,
    created_at: 1,
    config: f.config,
    summary: [],
    sources: [],
    exports: [],
    job: {state: 'complete'},
    rows: [
      {
        campaign_name: 'Home <img>',
        campaign_id: '001',
        account_id: '001',
        currency: 'SAR',
        timezone: 'Africa/Cairo',
        platform: 'google',
        objective_group: 'sales',
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        result_definition: 'Home',
        attribution: 'Home',
        native: {Home: '0012.340000'},
        metrics: {spend: 12.34, home: '0012.340000'},
        recommendation: {decision: 'maintain', reason: 'Original evidence', evidence: {}},
      },
    ],
  };
  f.respond(() => snapshot);
  await f.run("loadOverviewReport('snapshot-001')");
  const html = f.node('#overview-results').innerHTML;
  assert.match(html, /<th scope="col">الإنفاق<\/th><th scope="col">Home<\/th>/);
  assert.match(html, /Home &lt;img&gt;/);
  assert.match(html, /0012\.340000/);
  assert.match(html, /Original evidence/);
  assert.doesNotMatch(html, /<img/);
  f.context.source = {
    quality: {sampled: true, thresholded: true, restricted_metrics: ['Home']},
    lineage: {field: 'Home'},
    query_fingerprint: 'original-fingerprint',
  };
  const quality = f.run('reportQualityDetails(source)');
  assert.match(quality, /مبني على عينة/);
  assert.match(quality, /مقاييس مقيدة: Home/);
  assert.match(quality, /original-fingerprint/);
});

test('Arabic snapshot recommendations translate authored reasons and structured targets without changing rows', async () => {
  const f = fixture('ar');
  const snapshot = {
    id: 'snapshot-001',
    state: 'complete',
    row_count: 1,
    offset: 0,
    has_more: false,
    created_at: 1,
    config: f.config,
    summary: [],
    sources: [],
    exports: [],
    job: {state: 'complete'},
    rows: [
      {
        campaign_name: 'Home',
        campaign_id: '001',
        account_id: '001',
        currency: 'SAR',
        timezone: 'Africa/Cairo',
        platform: 'google',
        objective_group: 'sales',
        date_from: '2026-09-01',
        date_to: '2026-09-07',
        result_definition: 'Home',
        attribution: 'Home',
        native: {Home: '0012.340000'},
        metrics: {spend: 12.34, home: '0012.340000'},
        recommendation: {
          decision: 'needs_target',
          reason: 'Set a CPA target in SAR for this objective or campaign.',
          reason_localization: {key: 'target_required', kpi: 'CPA', currency: 'SAR'},
          evidence: {},
        },
      },
    ],
  };
  const original = JSON.stringify(snapshot);
  f.respond(() => snapshot);
  await f.run("loadOverviewReport('snapshot-001')");
  assert.match(f.node('#overview-results').innerHTML, /حدّد هدفًا لمؤشر CPA بعملة SAR/);
  assert.equal(JSON.stringify(snapshot), original);
  snapshot.rows[0].recommendation = {
    decision: 'maintain',
    reason: 'Performance is close to the configured target. Maintain delivery and monitor.',
    evidence: {},
  };
  await f.run("loadOverviewReport('snapshot-001')");
  assert.match(f.node('#overview-results').innerHTML, /الأداء قريب من الهدف المحدد/);
});

test('RPT-02 completeness and scope labels render in English and Arabic', () => {
  const expected = {
    en: [
      /Reporting window declared incomplete/,
      /Includes an in-progress day/,
      /Scope limit: sessions without a GA4 campaign ID/,
      /Scope limit: Search Console top rows only/,
    ],
    ar: [/فترة التقرير مُعلَنة غير مكتملة/, /تتضمن يومًا لم ينتهِ بعد/, /حدّ النطاق: جلسات بلا معرّف حملة في GA4/],
  };
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.context.source = {
      quality: {
        reporting_window_declared_complete: false,
        open_window: true,
        scope_limitations: ['ga4_unattributed_sessions', 'search_console_top_rows'],
      },
      lineage: [],
      query_fingerprint: 'original-fingerprint',
    };
    const quality = f.run('reportQualityDetails(source)');
    for (const label of expected[locale]) assert.match(quality, label);
    f.context.held = {
      decision: 'wait',
      reason: 'The reporting window includes a day that has not ended in the source time zone. Wait until it closes.',
    };
    assert.match(
      f.run('uiRecommendationReason(held)'),
      locale === 'ar' ? /تتضمن فترة التقرير يومًا لم ينتهِ بعد/ : /has not ended in the source time zone/,
    );
  }
});

test('RPT-02 source warnings for an open or declared-incomplete window render in Arabic, other text unchanged', async () => {
  // Regression: the two collector warnings had no Arabic and source health printed them raw.
  const {openWindowWarning} = await import('../dist/src/report-windows.js');
  const declared =
    'The reporting window was declared incomplete. The source stays partial and recommendations are held until a complete window is collected.';
  assert.match(readFileSync('src/overview-granularity.ts', 'utf8'), new RegExp(declared.replace(/\./g, '\\.')));
  const f = fixture('ar');
  f.context.warnings = [openWindowWarning, declared, 'Native provider note 42.'];
  const out = f.run('warnings.map(uiSourceWarning)');
  assert.match(out[0], /تتضمن يومًا لم ينتهِ بعد: لم ينتهِ آخر يوم/);
  assert.match(out[1], /أُعلِن أن فترة التقرير غير مكتملة\. يبقى المصدر جزئيًا/);
  assert.equal(out[2], 'Native provider note 42.');
  const en = fixture('en');
  en.context.warnings = [openWindowWarning];
  assert.deepEqual(plain(en.run('warnings.map(uiSourceWarning)')), [openWindowWarning]);
});

test('DEC-01 target cards show the derived direction and recommendations show as-of and expiry', () => {
  for (const locale of ['en', 'ar']) {
    const f = fixture(locale);
    f.run(
      "Object.assign(overviewState.bootstrap.metrics,{ctr:{label:'Click-through rate',better:'higher'},cpa:{label:'Cost per conversion',better:'lower'},profit:{label:'Profit'}})",
    );
    const ar = locale === 'ar';
    assert.match(f.run("reportTargetDirection('ctr')"), ar ? /القيمة الأعلى أفضل/ : /^Higher is better$/);
    assert.match(f.run("reportTargetDirection('cpa')"), ar ? /القيمة الأقل أفضل/ : /^Lower is better$/);
    assert.match(f.run("reportTargetDirection('cost_per_engagement')"), ar ? /القيمة الأقل أفضل/ : /Lower/);
    assert.match(f.run("reportTargetDirection('profit')"), ar ? /حدّد اتجاهًا لهذا المؤشر/ : /Set a direction/);
    assert.match(f.run("reportTargetDirection('cpa','higher')"), ar ? /القيمة الأعلى أفضل/ : /Higher/);
    const captured = Date.now() - 3600000;
    f.context.fresh = {
      captured_at: captured,
      recommendation: {decision: 'scale', as_of: captured, valid_until: captured + 48 * 3600000},
    };
    f.context.stale = {captured_at: captured - 72 * 3600000, recommendation: {decision: 'scale'}};
    const fresh = f.run('reportRecommendationAsOf(fresh)'),
      stale = f.run('reportRecommendationAsOf(stale)');
    assert.match(fresh, ar ? /وفق بيانات/ : /As of/);
    assert.doesNotMatch(fresh, ar ? /منتهية الصلاحية/ : /Expired/);
    // A snapshot without valid_until expires 48 hours after its capture.
    assert.match(stale, ar ? /منتهية الصلاحية — حدّث التقرير/ : /Expired — refresh before acting/);
    f.context.windowed = {basis: 'entity_window', evidence: {date_from: '2026-08-01', date_to: '2026-08-03'}};
    assert.match(
      f.run('reportRecommendationBasis(windowed)'),
      ar ? /بناءً على الفترة كاملة/ : /Based on the whole window/,
    );
    assert.equal(f.run('reportRecommendationBasis({decision: "scale"})'), '');
  }
});

test('DEC-01 a website save keeps MCP-only targets and saves other-currency targets with the card rules', () => {
  const f = fixture('en');
  const card = (objective, target, currency, kpi) => {
    f.node('[data-target-currency="' + objective + '"]').value = currency;
    f.node('[data-target-kpi="' + objective + '"]').value = kpi;
    f.node('[data-target-sample="' + objective + '"]').value = '12';
    f.node('[data-target-lag="' + objective + '"]').value = '4';
    return {value: target, dataset: {objectiveTarget: objective}};
  };
  const rows = entries => {
    f.lists.set(
      '[data-currency-target-value]',
      entries.map(([row, currency, value]) => {
        f.node('[data-currency-target-currency="' + row + '"]').value = currency;
        return {value, dataset: {currencyTargetValue: row}};
      }),
    );
  };
  f.node('#overview-config').values = {name: 'Home', rangeMode: 'custom', since: '2026-08-01', until: '2026-08-07'};
  f.context.previous = {
    'meta:100:101': {target: 3, currency: 'USD', kpi: 'profit', direction: 'higher'},
    sales: {target: 5, currency: 'USD', kpi: 'cpa', direction: 'lower', minimum_spend: 25, maximum_change_percent: 15},
    'sales:EUR': {target: 9, currency: 'EUR'},
  };
  f.run('overviewState.config={...config,targets:previous}');
  f.lists.set('[data-objective-target]', [card('sales', '10', 'usd', 'cpa')]);
  rows([['sales:7', 'sar', '40']]);
  const targets = f.run('overviewConfig().targets');
  // Before DEC-01 a website save rebuilt targets from the cards only: the campaign target, minimum_spend and the
  // explicit direction were dropped, and only one currency per objective could be saved.
  assert.deepEqual(plain(targets), {
    'meta:100:101': {target: 3, currency: 'USD', kpi: 'profit', direction: 'higher'},
    sales: {
      direction: 'lower',
      minimum_spend: 25,
      maximum_change_percent: 15,
      context: {},
      kpi: 'cpa',
      minimum_results: 12,
      conversion_lag_days: 4,
      target: 10,
      currency: 'USD',
    },
    'sales:SAR': {context: {}, kpi: 'cpa', minimum_results: 12, conversion_lag_days: 4, target: 40, currency: 'SAR'},
  });
  // A KPI change drops the old explicit direction; the new KPI's derived direction applies.
  f.lists.set('[data-objective-target]', [card('sales', '10', 'USD', 'roas')]);
  assert.equal(f.run('overviewConfig().targets.sales.direction'), undefined);
  rows([
    ['sales:7', 'SAR', '40'],
    ['sales:8', 'sar', '41'],
  ]);
  assert.throws(() => f.run('overviewConfig()'), /Use each currency once per objective/);
  const html = f.run(
    "reportCurrencyTargets('sales',{sales:{target:5,currency:'USD'},'sales:SAR':{target:40,currency:'SAR'},'meta:1:2':{target:1,currency:'SAR'}})",
  );
  assert.match(html, /value="SAR"/);
  assert.match(html, /value="40"/);
  assert.doesNotMatch(html, /value="USD"/);
  assert.match(html, /data-currency-target-add="sales"/);
  const arabic = fixture('ar').run("reportCurrencyTargets('sales',{})");
  assert.match(arabic, /قيمة مستهدفة لعملة أخرى/);
});
