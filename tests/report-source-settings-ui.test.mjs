import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {reportSource} from '../dist/src/report-sources.js';

const plain = value => JSON.parse(JSON.stringify(value));
const key = account => JSON.stringify(['meta', 'login', account]);
function fixture(sources = [], contract = 'overview-config-v4') {
  const roots = new Map(),
    globals = new Map(),
    controls = new Map();
  const node = value => ({value, checked: false, dataset: {}});
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    pollTimer: null,
    deliveryTimer: null,
    clearTimeout() {},
    CSS: {escape: String},
    pretty: String,
    reportRangeLabel: () => 'September 2026',
    reportQualityDetails: () => '',
    uiSourceWarning: value => value,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('"', '&quot;'),
    FormData: class {
      get(name) {
        return {name: 'Scoped setup', rangeMode: 'custom', since: '2026-09-01', until: '2026-09-02'}[name] ?? null;
      }
    },
    $: selector => roots.get(selector) ?? globals.get(selector) ?? null,
    document: {
      addEventListener() {},
      querySelectorAll: selector =>
        selector === '[data-report-account]:checked'
          ? sources.map(source => ({value: key(source.account_id)}))
          : selector === '[data-report-metric]:checked'
            ? [{value: 'spend'}]
            : [],
    },
  });
  const run = code => new Script(code).runInContext(context);
  for (const name of ['localization', 'report-library', 'report-source-settings', 'reporting-overview'])
    run(fs.readFileSync('web/' + name + '.js', 'utf8'));
  const meta = reportSource('meta').overview;
  context.platform = {
    id: 'meta',
    reporting_v4: {...meta, provider_configured_options: meta.legacy.provider_configured_options},
  };
  context.sources = sources;
  context.contract = contract;
  run(
    'overviewState.bootstrap={platforms:[platform],metrics:{}};overviewState.config={contract_version:contract,sources,source_defaults:{},targets:{}}',
  );
  globals.set('[data-native-for="meta"]', node((sources[0]?.native_metrics ?? []).join(', ')));
  globals.set(
    '[data-objective-for="meta"]',
    node(sources[0]?.objective_fallback ?? sources[0]?.objective ?? 'provider'),
  );
  function root(
    account,
    {
      levels = ['campaign'],
      statuses = ['all'],
      delivered = true,
      ids = {},
      complete = null,
      action = '',
      windows = ['7d_click', '1d_view'],
      profile = true,
    } = {},
  ) {
    const values = new Map(),
      select = options => ({selectedOptions: options.map(value => ({value}))});
    values.set('[data-report-level="meta"]', select(levels));
    values.set('[data-report-statuses="meta"]', select(statuses));
    values.set('[data-report-delivered="meta"]', {...node(''), checked: delivered});
    values.set('[data-report-complete-window="meta"]', {
      ...node(''),
      checked: complete === true,
      dataset: {originalComplete: complete === false ? 'false' : 'null'},
    });
    values.set('[data-report-result="meta"]', node(action));
    values.set('[data-report-campaign-profile="meta"]', {...node(''), checked: profile});
    values.set('[data-report-click-window="meta"]', node(windows.find(value => value.endsWith('_click')) ?? ''));
    values.set('[data-report-window-flag="1d_view"]', {...node(''), checked: windows.includes('1d_view')});
    values.set('[data-report-window-flag="1d_ev"]', {...node(''), checked: windows.includes('1d_ev')});
    for (const field of ['campaign_ids', 'adset_ids', 'ad_ids'])
      values.set('[data-report-scope="' + field + '"]', node(ids[field] ?? ''));
    const element = {querySelector: selector => values.get(selector) ?? null};
    roots.set(account ? '[data-report-source="' + key(account) + '"]' : '[data-report-defaults="meta"]', element);
    controls.set(account, values);
    return values;
  }
  return {
    context,
    run,
    roots,
    globals,
    root,
    controls,
    settings: account => plain(run('overviewGranularityConfig("meta", ' + JSON.stringify(key(account)) + ')')),
  };
}

test('each account serializes its own multiple levels, exact IDs, statuses, delivery choice and attribution', () => {
  const f = fixture();
  f.root('100', {
    levels: ['campaign', 'ad'],
    statuses: ['paused'],
    delivered: false,
    ids: {ad_ids: '9007199254740993, 9007199254740995'},
  });
  f.root('200', {levels: ['adset'], statuses: ['active'], complete: true, action: 'lead', windows: ['1d_click']});
  const first = f.settings('100'),
    second = f.settings('200');
  assert.deepEqual(first.levels, ['campaign', 'ad']);
  assert.deepEqual(first.ad_ids, ['9007199254740993', '9007199254740995']);
  assert.deepEqual(first.statuses, ['paused']);
  assert.equal(first.delivered_only, false);
  assert.equal(first.report_options.complete_window, null);
  assert.equal(first.report_options.result_action_type, undefined);
  assert.deepEqual(first.report_options.attribution_windows, ['7d_click', '1d_view']);
  assert.deepEqual(second.levels, ['adset']);
  assert.deepEqual(second.ad_ids, []);
  assert.deepEqual(second.statuses, ['active']);
  assert.equal(second.delivered_only, true);
  assert.equal(second.report_options.complete_window, true);
  assert.equal(second.report_options.result_action_type, 'lead');
  assert.deepEqual(second.report_options.attribution_windows, ['1d_click']);
});

test('new source controls use server defaults and do not preselect a Meta purchase override or completeness', () => {
  const f = fixture();
  const markup = f.run('String(overviewGranularityFields(platform))');
  assert.match(markup, /data-report-level="meta" multiple/);
  assert.match(markup, /value="7d_click" selected/);
  assert.match(markup, /data-report-window-flag="1d_view" checked/);
  assert.match(markup, /data-report-result="meta" value=""/);
  assert.doesNotMatch(markup, /data-report-result="meta"[^>]*required|data-report-complete-window="meta"[^>]* checked/);
  assert.match(markup, /data-report-delivered="meta" checked/);
});

test('Snapchat editor preserves a genuine legacy campaign filter while ignoring formerly inert scope fields', () => {
  const f = fixture([], 'overview-config-v3'),
    campaign = '33333333-3333-4333-8333-000000000002';
  f.context.snapchat = {id: 'snapchat', reporting_v4: reportSource('snapchat').overview};
  f.context.saved = {
    level: 'adset',
    campaign_id: campaign,
    campaign_ids: ['formerly-ignored'],
    ad_ids: ['also-ignored'],
  };
  const scoped = plain(f.run('overviewEditorSource(snapchat, saved)'));
  assert.deepEqual(scoped.campaign_ids, [campaign]);
  assert.deepEqual(scoped.ad_ids, []);
  assert.equal(scoped.delivered_only, false);
  const markup = f.run('String(overviewAccountFields(snapchat, saved, "account", true))');
  assert.match(markup, /data-report-scope="campaign_ids"[^>]*>33333333-3333-4333-8333-000000000002<\/textarea>/);
  assert.doesNotMatch(markup, /data-report-parent|formerly-ignored/);
  const unscoped = f.run('String(overviewAccountFields(snapchat, {}, "account", true))');
  assert.match(unscoped, /data-report-scope="campaign_ids"[^>]*><\/textarea>/);
  f.run('overviewState.config.contract_version="overview-config-v4"');
  assert.throws(() => f.run('overviewEditorSource(snapchat, saved)'), /conflicts with the selected campaign IDs/);
});

test('opening an unversioned saved report preserves its legacy population and configured profile despite new report defaults', () => {
  const f = fixture();
  f.context.record = {
    id: 'old',
    revision: 1,
    config: {sources: [{platform: 'meta', level: 'campaign', ad_ids: ['formerly-ignored']}], source_defaults: {}},
  };
  f.run('selectOverviewDefinition(record)');
  assert.equal(f.run('overviewState.config.contract_version'), undefined);
  const config = plain(f.run('overviewEditorSource(platform, record.config.sources[0])'));
  assert.deepEqual(config.levels, ['campaign']);
  assert.deepEqual(config.statuses, ['all']);
  assert.equal(config.delivered_only, false);
  assert.deepEqual(config.ad_ids, []);
  assert.equal(config.report_options.attribution_windows, null);
  const markup = f.run('String(overviewGranularityFields(platform, record.config.sources[0]))');
  assert.doesNotMatch(markup, /data-report-campaign-profile="meta" checked|data-report-delivered="meta" checked/);
});

// F-L8-05: a retained v3 snapshot opened from History edits with the v3 semantics it ran with, as a saved v3 view does.
test('opening a retained v3 snapshot from History keeps its contract: no v4 defaults appear in its editor', async () => {
  const f = fixture();
  const v3 = {
    name: 'Old',
    sources: [{platform: 'meta', connection_id: 'login', account_id: '100', level: 'campaign'}],
    source_defaults: {},
    date_range: {preset: 'last_complete_days', days: 7},
    metrics: ['spend'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  };
  f.context.snapshot = {id: 's1', config: v3};
  // The page loads the snapshot (the network) and draws the builder (the DOM); both are outside this test.
  f.run(
    `overviewMayLeave = async () => true;
     loadOverviewReport = async id => { overviewState.report = {id, config: snapshot.config}; };
     renderReportingOverview = async () => {};
     $ = () => null;`,
  );
  await f.run("openOverviewHistory('s1')");
  assert.equal(f.run('overviewState.config.contract_version'), undefined, 'the snapshot’s own contract is kept');
  const editor = plain(f.run('overviewEditorSource(platform, overviewState.config.sources[0])'));
  assert.equal(editor.delivered_only, false, 'v3 had no activity filter');
  assert.equal(editor.report_options.attribution_windows, null, 'v3 left the attribution windows to the provider');
  // The same snapshot's saved view opens identically.
  f.context.record = {id: 'view', revision: 1, config: v3};
  f.run('selectOverviewDefinition(record)');
  assert.deepEqual(plain(f.run('overviewEditorSource(platform, overviewState.config.sources[0])')), editor);
  // A v4 snapshot keeps its v4 contract.
  f.context.snapshot = {id: 's2', config: {...v3, contract_version: 'overview-config-v4'}};
  await f.run("openOverviewHistory('s2')");
  assert.equal(f.run('overviewState.config.contract_version'), 'overview-config-v4');
});

// F-L8-14: a detailed level reads its preset metrics, so a platform's additional native metrics do nothing there (a v4
// run accepts them and requests the fields, but no row carries them). The builder says so where both are set.
test('a note appears under the native metrics when a detailed level and native metrics are both set, and only then', () => {
  const nodes = new Map();
  const select = levels => ({selectedOptions: levels.map(value => ({value}))}),
    root = (platform, levels, {hidden = false} = {}) => ({
      hidden,
      dataset: {reportSource: JSON.stringify([platform, 'login', '100'])},
      querySelector: selector => (selector === '[data-report-level="' + platform + '"]' ? select(levels) : null),
    }),
    defaults = (platform, levels) => ({
      hidden: false,
      dataset: {reportDefaults: platform},
      querySelector: selector => (selector === '[data-report-level="' + platform + '"]' ? select(levels) : null),
    }),
    note = platform => nodes.get('note:' + platform);
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    CSS: {escape: String},
    pretty: String,
    esc: value => String(value ?? ''),
    reportRangeLabel: () => '',
    reportQualityDetails: () => '',
    uiSourceWarning: value => value,
    $: selector => nodes.get(selector) ?? null,
    document: {
      addEventListener() {},
      querySelectorAll: selector =>
        selector === '[data-native-detail-note]'
          ? ['meta', 'tiktok'].map(note)
          : selector === '[data-report-source]'
            ? nodes.get('sources')
            : selector.startsWith('[data-report-defaults="')
              ? (nodes.get('defaults:' + /"(.*)"/.exec(selector)[1]) ?? [])
              : [],
    },
  });
  const run = code => new Script(code).runInContext(context);
  for (const name of ['localization', 'report-library', 'report-source-settings', 'reporting-overview'])
    run(fs.readFileSync('web/' + name + '.js', 'utf8'));
  const state = ({sources = [], metrics = '', template = []}) => {
    for (const platform of ['meta', 'tiktok']) {
      nodes.set('note:' + platform, {hidden: true, dataset: {nativeDetailNote: platform}});
      nodes.set('[data-native-for="' + platform + '"]', {value: platform === 'meta' ? metrics : ''});
      nodes.set(
        'defaults:' + platform,
        template.filter(item => item.dataset.reportDefaults === platform),
      );
    }
    nodes.set('sources', sources);
    run('updateOverviewNativeNotes()');
    return {meta: !note('meta').hidden, tiktok: !note('tiktok').hidden};
  };
  assert.deepEqual(state({sources: [root('meta', ['ad'])], metrics: 'inline_link_clicks'}), {
    meta: true,
    tiktok: false,
  });
  assert.deepEqual(state({sources: [root('meta', ['campaign', 'adset'])], metrics: 'inline_link_clicks'}), {
    meta: true,
    tiktok: false,
  });
  // Campaign level only: the metrics are used, so there is nothing to say.
  assert.deepEqual(state({sources: [root('meta', ['campaign'])], metrics: 'inline_link_clicks'}), {
    meta: false,
    tiktok: false,
  });
  // No native metrics, or only blanks: nothing to clear.
  assert.deepEqual(state({sources: [root('meta', ['ad'])], metrics: ''}), {meta: false, tiktok: false});
  assert.deepEqual(state({sources: [root('meta', ['ad'])], metrics: '  \n '}), {meta: false, tiktok: false});
  // An account that is not selected (its controls are hidden) and another platform's account do not count.
  assert.deepEqual(state({sources: [root('meta', ['ad'], {hidden: true})], metrics: 'x'}), {
    meta: false,
    tiktok: false,
  });
  assert.deepEqual(state({sources: [root('tiktok', ['ad'])], metrics: 'x'}), {meta: false, tiktok: false});
  // Any selected account at a detailed level is enough, and a template's defaults count like an account.
  assert.deepEqual(state({sources: [root('meta', ['campaign']), root('meta', ['ad'])], metrics: 'x'}), {
    meta: true,
    tiktok: false,
  });
  assert.deepEqual(state({template: [defaults('meta', ['adset'])], metrics: 'x'}), {meta: true, tiktok: false});
  // The note itself is the server's own sentence for this refusal, with its Arabic already in the catalog.
  const sentence =
      'Detailed reporting uses the preset metrics. Clear additional native metrics before selecting this level.',
    markup = String(run('overviewNativeNote("meta")'));
  assert.match(markup, /<p class="form-note" role="status" data-native-detail-note="meta" hidden>/);
  assert.ok(markup.includes(sentence));
  assert.equal(typeof JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'))[sentence], 'string');
  assert.match(
    fs.readFileSync('src/overview-levels.ts', 'utf8'),
    /'Detailed reporting uses the preset metrics\. Clear additional native metrics before selecting this level\.'/,
  );
});

// F-L8-07: every selected account has the same controls, so each group is named after its account.
for (const language of ['en', 'ar']) {
  test(
    language + ': each account’s settings group is named after its account, so several are told apart (F-L8-07)',
    () => {
      const f = fixture(),
        catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
      f.context.catalog = catalog;
      f.context.language = language;
      f.run('uiLocale=language;uiMessages=new Map(language === "ar" ? Object.entries(catalog) : [])');
      const prefix = language === 'ar' ? catalog['Report settings for'] : 'Report settings for',
        legend = metadata => {
          f.context.metadata = metadata;
          return /<legend>([\s\S]*?)<\/legend>/.exec(
            f.run('String(overviewAccountFields(platform, {}, "key", true, metadata))'),
          )[1];
        };
      assert.equal(
        legend({label: 'Brand A', account_id: '100'}),
        prefix + ' <bdi dir="auto" data-native>Brand A</bdi> (<bdi dir="ltr">100</bdi>)',
      );
      // Two accounts of one name are still told apart by their IDs.
      assert.notEqual(legend({label: 'Shop', account_id: '100'}), legend({label: 'Shop', account_id: '200'}));
      // The name is escaped, and an account named by its own ID is not repeated.
      assert.equal(
        legend({label: '<b>x</b>', account_id: '7'}),
        prefix + ' <bdi dir="auto" data-native>&lt;b&gt;x&lt;/b&gt;</bdi> (<bdi dir="ltr">7</bdi>)',
      );
      assert.equal(legend({label: '100', account_id: '100'}), prefix + ' <bdi dir="auto" data-native>100</bdi>');
      // With nothing to name it by, the group keeps its generic name.
      assert.equal(legend({}), language === 'ar' ? catalog['Account report settings'] : 'Account report settings');
    },
  );
}

test('provider-configured campaign profiles and explicit false declarations survive their own account controls', () => {
  const f = fixture();
  f.root('100', {profile: false, complete: false, delivered: false});
  const config = f.settings('100');
  assert.equal(config.report_options.attribution_windows, null);
  assert.equal(config.report_options.complete_window, false);
  assert.equal(config.delivered_only, false);
});

test('the report serializer keeps account settings and differing native metrics while template defaults exclude entity IDs', () => {
  const sources = [
    {platform: 'meta', account_id: '100', connection_id: 'login', native_metrics: ['inline_link_clicks']},
    {platform: 'meta', account_id: '200', connection_id: 'login', native_metrics: [], objective_fallback: 'leads'},
  ];
  const f = fixture(sources);
  f.root('100', {levels: ['campaign'], ids: {campaign_ids: '101'}});
  f.root('200', {levels: ['ad'], ids: {ad_ids: '9007199254740993'}, delivered: false});
  const config = plain(f.run('overviewConfig()'));
  assert.equal(config.contract_version, 'overview-config-v4');
  assert.deepEqual(
    config.sources.map(source => source.levels),
    [['campaign'], ['ad']],
  );
  assert.deepEqual(config.sources[0].campaign_ids, ['101']);
  assert.deepEqual(config.sources[1].ad_ids, ['9007199254740993']);
  assert.deepEqual(
    config.sources.map(source => source.native_metrics),
    [['inline_link_clicks'], []],
  );
  assert.equal(config.sources[1].objective_fallback, 'leads');
  assert.deepEqual(config.source_defaults.meta.levels, ['campaign']);
  for (const field of ['account_id', 'connection_id', 'campaign_ids', 'adset_ids', 'ad_ids', 'objective_overrides'])
    assert.equal(config.source_defaults.meta[field], undefined);
});

test('scope markup escapes account values and keeps template settings free of entity-ID fields', () => {
  const f = fixture();
  f.context.source = {levels: ['campaign'], ad_ids: ['</textarea><script>alert(1)</script>']};
  const account = f.run('String(overviewGranularityFields(platform, source, true))');
  assert.ok(account.includes('&lt;/textarea&gt;'));
  assert.doesNotMatch(account, /<script>/);
  assert.doesNotMatch(f.run('String(overviewGranularityFields(platform, source))'), /data-report-scope=/);
});

test('unavailable accounts keep their saved v4 settings for the server access check without borrowing another account controls', () => {
  const f = fixture();
  f.root('100', {levels: ['campaign'], ids: {campaign_ids: '101'}});
  f.context.previous = {levels: ['ad'], statuses: ['paused'], delivered_only: false, ad_ids: ['9007199254740993']};
  const config = plain(f.run('overviewGranularityConfig("meta", ' + JSON.stringify(key('200')) + ', previous)'));
  assert.deepEqual(config.levels, ['ad']);
  assert.deepEqual(config.ad_ids, ['9007199254740993']);
  assert.deepEqual(config.campaign_ids, []);
  assert.equal(config.delivered_only, false);
});

for (const language of ['en', 'ar']) {
  test(language + ': terminal collection jobs replace stale running labels without relabelling retained data', () => {
    const f = fixture(),
      catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
    f.context.catalog = catalog;
    f.context.language = language;
    f.run('uiLocale=language;uiMessages=new Map(language === "ar" ? Object.entries(catalog) : [])');
    for (const state of ['failed', 'cancelled']) {
      f.context.report = {state: 'running', job: {state}, config: {}, row_count: 0};
      assert.equal(f.run('reportDisplayState(report)'), f.run('reportLabel(report.job.state)'));
      assert.ok(f.run('String(renderReportEmpty(report))').length > 0);
      for (const retained of ['complete', 'partial']) {
        f.context.report.state = retained;
        f.context.report.row_count = 2;
        assert.equal(f.run('reportDisplayState(report)'), f.run('reportLabel(report.state)'));
      }
    }
  });
  test(language + ': empty v4 reports distinguish excluded scope, unverified scope and objective filtering', () => {
    const f = fixture(),
      catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
    f.context.catalog = catalog;
    f.context.language = language;
    f.run('uiLocale=language;uiMessages=new Map(language === "ar" ? Object.entries(catalog) : [])');
    const text = key => (language === 'ar' ? catalog[key] : key);
    f.context.report = {
      state: 'complete',
      config: {contract_version: 'overview-config-v4', date_range: {}},
      row_count: 0,
      source_row_count: 5,
      scoped_row_count: 0,
      empty_reason: 'scope_filter',
      sources: [],
    };
    let markup = f.run('String(renderReportEmpty(report))');
    assert.ok(markup.includes(text('No rows matched your source filters')));
    assert.ok(markup.includes(text('Review the selected IDs, statuses and activity filter.')));
    f.run('report.state="partial";report.sources=[{level_results:[{scope:{excluded_unknown_rows:1}}]}]');
    markup = f.run('String(renderReportEmpty(report))');
    assert.ok(markup.includes(text('Some rows could not be checked against your source filters')));
    assert.ok(!markup.includes(text('No rows matched your source filters')));
    f.run('report.state="complete";report.empty_reason="objective_filter";report.scoped_row_count=2');
    markup = f.run('String(renderReportEmpty(report))');
    assert.ok(
      markup.includes(
        text('{count} rows matched the source filters. Review the objective selections above.').replace('{count}', '2'),
      ),
    );
    assert.doesNotMatch(markup, /5 rows were returned/);
    assert.ok(
      markup.includes(
        text('There is nothing to export. CSV downloads and Google Sheets updates are disabled for this report.'),
      ),
    );
  });
  test(language + ': source cards distinguish native, derived, supporting and filtered row populations', () => {
    const f = fixture(),
      catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
    f.context.catalog = catalog;
    f.context.language = language;
    f.run('uiLocale=language;uiMessages=new Map(language === "ar" ? Object.entries(catalog) : [])');
    const text = (key, count) => (language === 'ar' ? catalog[key] : key).replace('{count}', String(count));
    f.context.source = {
      source: {platform: 'meta', account_id: '100'},
      complete: true,
      row_count: 0,
      scope_input_row_count: 1,
      scoped_row_count: 1,
      visible_row_count: 1,
      derived_row_count: 1,
      level_results: [{purpose: 'scope_rollup', row_count: 2}],
      warnings: [],
    };
    let markup = f.run('String(renderReportSourceHealth(source,[{id:"meta",name:"Meta"}],0,{}))');
    for (const [key, count] of [
      ['Native rows at requested levels: {count}', 0],
      ['Rows considered for source filters: {count}', 1],
      ['Rows after source filters: {count}', 1],
      ['Rolled-up rows: {count}', 1],
      ['Rows read at supporting levels: {count}', 2],
    ])
      assert.ok(markup.includes(text(key, count)), key);
    assert.equal(f.run('reportSourceHealthLabel(source)'), language === 'ar' ? catalog.Complete : 'Complete');
    f.run('source.row_count=4;source.scoped_row_count=0;source.visible_row_count=0;source.derived_row_count=0');
    assert.equal(
      f.run('reportSourceHealthLabel(source)'),
      language === 'ar' ? catalog['Filtered out'] : 'Filtered out',
    );
    f.run('source.complete=false');
    assert.equal(
      f.run('reportSourceHealthLabel(source)'),
      language === 'ar' ? catalog['Limited coverage'] : 'Limited coverage',
    );
  });
}
