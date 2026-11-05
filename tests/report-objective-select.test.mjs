import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {objectiveFallbackGroups} from '../dist/src/report-objectives.js';

const plain = value => JSON.parse(JSON.stringify(value));
function page(locale = 'en', sources = []) {
  const nodes = new Map(),
    lists = new Map();
  const node = selector => {
    if (!nodes.has(selector))
      nodes.set(selector, {value: '', checked: false, dataset: {}, values: {}, addEventListener() {}});
    return nodes.get(selector);
  };
  const context = createContext({
    document: {addEventListener() {}, querySelector: node, querySelectorAll: key => lists.get(key) ?? []},
    $: node,
    CSS: {escape: String},
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    pretty: String,
    FormData: class {
      constructor(form) {
        this.values = form.values;
      }
      get(key) {
        return this.values[key] ?? null;
      }
    },
    catalog: JSON.parse(readFileSync('web/locales/ar.json', 'utf8')),
    groups: [...objectiveFallbackGroups],
    sources,
  });
  const run = code => new Script(code).runInContext(context);
  for (const file of [
    'localization',
    'report-library',
    'report-source-settings',
    'report-quality',
    'report-workflows',
    'reporting-overview',
  ])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)}; uiMessages = new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'}); overviewState.bootstrap={platforms:[{id:'meta',name:'Meta',accounts:[]}],metrics:{},objectives:[...groups,'unknown'],objective_fallback_groups:groups}; overviewState.config={sources,targets:{},source_defaults:{}};`,
  );
  node('#overview-config').values = {
    name: 'Synthetic report',
    rangeMode: 'custom',
    since: '2026-09-01',
    until: '2026-09-02',
  };
  node('[data-report-level="meta"]').value = 'campaign';
  node('[data-objective-for="meta"]').value = 'provider';
  lists.set(
    '[data-report-account]:checked',
    sources.map(source => ({value: JSON.stringify([source.platform, source.connection_id, source.account_id])})),
  );
  lists.set('[data-report-metric]:checked', [{value: 'spend'}]);
  return {context, node, lists, run};
}
const source = {platform: 'meta', connection_id: 'login', account_id: '100'};

test('the objective select names a fallback and uses exactly the server’s fallback groups', () => {
  const f = page();
  const html = f.run('String(reportObjectiveSelect("meta", {}, groups))');
  assert.match(html, /Objective when the platform gives none/);
  assert.match(html, /<option value="provider">No fallback \(show unknown\)<\/option>/);
  const values = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(values, ['provider', ...objectiveFallbackGroups]);
  assert.doesNotMatch(html, /value="unknown"|value="mixed"/);
});

test('choosing a fallback writes objective_fallback on sources and defaults, never the legacy objective', () => {
  const f = page('en', [source]);
  f.node('[data-objective-for="meta"]').value = 'leads';
  const config = plain(f.run('overviewConfig()'));
  assert.equal(config.sources[0].objective_fallback, 'leads');
  assert.equal(Object.hasOwn(config.sources[0], 'objective'), false);
  assert.equal(config.contract_version, 'overview-config-v4');
  assert.equal(config.source_defaults.meta.objective_fallback, 'leads');
  assert.deepEqual(config.source_defaults.meta.levels, ['campaign']);
  assert.equal(config.source_defaults.meta.campaign_ids, undefined);
});

test('a saved choice is presented and serialized as a fallback while explicit fallback and campaign overrides survive', () => {
  const previous = {
    ...source,
    objective: 'leads',
    objective_fallback: 'traffic',
    objective_overrides: {'101': 'sales'},
  };
  const f = page('en', [previous]);
  f.context.previous = previous;
  const html = f.run('String(reportObjectiveSelect("meta", previous, groups))');
  assert.match(html, /value="traffic" selected>Traffic<\/option>/);
  assert.doesNotMatch(html, /saved:/);
  f.node('[data-objective-for="meta"]').value = 'traffic';
  let config = plain(f.run('overviewConfig()'));
  assert.equal(config.sources[0].objective, undefined);
  assert.equal(config.sources[0].objective_fallback, 'traffic');
  assert.deepEqual(config.sources[0].objective_overrides, {'101': 'sales'});
  assert.equal(Object.hasOwn(config.source_defaults.meta, 'objective_overrides'), false);
  f.node('[data-objective-for="meta"]').value = 'sales';
  config = plain(f.run('overviewConfig()'));
  assert.equal(Object.hasOwn(config.sources[0], 'objective'), false);
  assert.equal(config.sources[0].objective_fallback, 'sales');
  assert.deepEqual(config.sources[0].objective_overrides, {'101': 'sales'});
  f.node('[data-objective-for="meta"]').value = 'provider';
  config = plain(f.run('overviewConfig()'));
  assert.equal(Object.hasOwn(config.sources[0], 'objective'), false);
  assert.equal(Object.hasOwn(config.sources[0], 'objective_fallback'), false);
  assert.deepEqual(config.sources[0].objective_overrides, {'101': 'sales'});
});

test('an unchanged platform select preserves different choices for each existing account', () => {
  const originals = [
    {...source, objective: 'leads'},
    {...source, account_id: '200', objective: 'sales'},
    {...source, account_id: '300', objective_fallback: 'traffic'},
  ];
  const f = page('en', originals);
  f.node('[data-objective-for="meta"]').value = 'leads';
  const config = plain(f.run('overviewConfig()'));
  assert.equal(config.sources[0].objective, undefined);
  assert.equal(config.sources[1].objective, undefined);
  assert.equal(config.sources[0].objective_fallback, 'leads');
  assert.equal(config.sources[1].objective_fallback, 'sales');
  assert.equal(Object.hasOwn(config.sources[2], 'objective'), false);
  assert.equal(config.sources[2].objective_fallback, 'traffic');
});

test('an unchanged fallback select preserves each account’s existing fallback', () => {
  const originals = [
    {...source, objective_fallback: 'traffic'},
    {...source, account_id: '200', objective_fallback: 'sales'},
  ];
  const f = page('en', originals);
  f.node('[data-objective-for="meta"]').value = 'traffic';
  const config = plain(f.run('overviewConfig()'));
  assert.equal(config.sources[0].objective_fallback, 'traffic');
  assert.equal(config.sources[1].objective_fallback, 'sales');
});

test('a new report has no fallback until the user chooses one, and saved unknown is not offered as a choice', () => {
  const f = page('en', [source]);
  const config = plain(f.run('overviewConfig()'));
  assert.equal(Object.hasOwn(config.sources[0], 'objective'), false);
  assert.equal(Object.hasOwn(config.sources[0], 'objective_fallback'), false);
  const html = f.run('String(reportObjectiveSelect("meta", {objective:"unknown"}, groups))');
  assert.doesNotMatch(html, /saved:unknown/);
});

const labels = {
  provider: 'From the platform',
  provider_mapped: 'Mapped from campaign settings',
  provider_inferred: 'Inferred from the platform’s value',
  user_override: 'Your choice',
  user_fallback: 'Your fallback',
};
for (const locale of ['en', 'ar'])
  test(locale + ' labels each objective source and translates unknown reasons while preserving native values', () => {
    const f = page(locale),
      catalog = f.context.catalog;
    for (const [source, label] of Object.entries(labels)) {
      f.context.row = {objective_source: source};
      assert.equal(f.run('reportObjectiveSource(row)'), locale === 'ar' ? catalog[label] : label);
    }
    for (const reason of [
      'TikTok returned no objective for this campaign.',
      'TikTok’s APP_RETARGETING has no matching AMCP objective; choose one in the report.',
      'TikTok returned the objective FUTURE_$&_{platform}, which AMCP does not group yet; choose one in the report.',
    ]) {
      f.context.row = {objective_source: 'unknown', objective_reason: reason};
      const rendered = f.run('reportObjectiveSource(row)');
      if (locale === 'en') assert.equal(rendered, reason);
      else {
        assert.match(rendered, /[\u0600-\u06ff]/);
        assert.doesNotMatch(rendered, /choose one in the report|returned no objective/);
      }
      if (reason.includes('APP_RETARGETING')) assert.match(rendered, /APP_RETARGETING/);
      if (reason.includes('FUTURE_')) assert.ok(rendered.includes('FUTURE_$&_{platform}'));
    }
    const html = f.run('String(reportObjectiveSelect("meta", {objective:"leads"}, groups))');
    if (locale === 'ar') {
      assert.ok(html.includes(catalog['Objective when the platform gives none']));
      assert.ok(html.includes(catalog['No fallback (show unknown)']));
      assert.ok(html.includes('value="leads" selected>' + catalog.Leads));
      assert.doesNotMatch(html, /Saved:|No fallback/);
    }
    assert.equal(f.run('reportLabel("mixed")'), locale === 'ar' ? catalog.Mixed : 'Mixed');
  });

test('select markup escapes platform, group and saved display values', () => {
  const f = page();
  const html = f.run('String(reportObjectiveSelect("<platform>",{objective:"<group>"},["<group>"]))');
  assert.doesNotMatch(html, /<platform>|<group>/);
  assert.match(html, /&lt;platform&gt;/);
  assert.match(html, /&lt;group&gt;/);
});

test('the report table displays the objective reason as escaped text', () => {
  const f = page();
  f.context.report = {
    config: {name: 'Synthetic report', grain: 'total', date_range: {since: '2026-09-01', until: '2026-09-02'}},
    rows: [
      {
        campaign_id: '101',
        campaign_name: 'Synthetic campaign',
        platform: 'meta',
        account_id: '100',
        objective_group: 'unknown',
        objective_source: 'unknown',
        objective_reason:
          'Meta returned the objective <img src=x>, which AMCP does not group yet; choose one in the report.',
        native: {},
        metrics: {},
        recommendation: {decision: 'needs_review', reason: ''},
      },
    ],
  };
  const html = f.run('renderReportTable(report,[],{platforms:[{id:"meta",name:"Meta"}],metrics:{}})');
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
});
