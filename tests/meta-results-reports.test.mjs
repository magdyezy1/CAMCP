// Package meta-results: what a person sees of Meta's own results. A v4 Meta row says where its result came from, per row:
// the platform's own result (nothing to flag), or AMCP's mapping (flagged on the website, in the exports and in the pack), and a
// report that has both shows both. Synthetic rows through the real queue, worker and collectors; no provider is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import ExcelJS from 'exceljs';
import {granularConfig, granularSource, overviewGranularityFixture} from './fixtures/overview-granularity-data.mjs';
import {reportTable} from '../dist/src/report-table.js';
import {reportPack} from '../dist/src/report-packs.js';
import {reportWorkbook} from '../dist/src/report-artifacts.js';
import {artifactLocale} from '../dist/src/report-localization.js';
import {metaIndicatorDefinition, metaResultIndicators, metaResultRules} from '../dist/src/meta-report-results.js';

const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
const mappedLimitation =
  'Results shown as mapped are chosen by AMCP from the platform’s reported fields; they are not read from a result column of the platform’s own.';
const v3Definition = 'Objective-mapped lead, purchase or app-install action; aliases are not summed';
const metrics = ['spend', 'impressions', 'clicks', 'conversions', 'primary_result', 'cost_per_result'];
const wire = (value, window = 'default') => ({value, attribution_windows: [window]});
const results = (indicator, ...values) => [{indicator, values}];

async function run(f, config) {
  const queued = await f.overview.handle({action: 'run', config, confirmed: true}, f.actor);
  assert.equal(await f.worker.once(), true);
  const id = queued.id;
  return {
    read: await f.overview.handle({action: 'get', id, limit: 100}, f.actor),
    stored: f.store.document(f.actor.tenantId, 'overview_report', id),
  };
}
function campaignConfig(grain = 'daily', report_options) {
  const {objective, level, report_options: _v3, ...source} = granularSource('meta', 'campaign'),
    sources = [{...source, levels: ['campaign'], ...(report_options ? {report_options} : {})}];
  return {...granularConfig(sources[0], grain), contract_version: 'overview-config-v4', sources, metrics};
}
function detailConfig(level, report_options) {
  const {objective, level: _level, report_options: _v3, ...source} = granularSource('meta', level),
    sources = [{...source, levels: [level], report_options: {complete_window: true, ...report_options}}];
  return {...granularConfig(sources[0]), contract_version: 'overview-config-v4', sources, metrics};
}
/** Two campaigns a day: 101 has Meta's results (an explicit 7d_click count of 4 and a default of 10), 102 has none. */
const twoCampaigns = (rows, platform) =>
  platform !== 'meta'
    ? rows
    : rows.flatMap(row => [
        {
          ...row,
          objective: 'OUTCOME_LEADS',
          optimization_goal: 'LEAD_GENERATION',
          spend: '12',
          results: results('actions:lead', wire('4', '7d_click'), wire('10')),
          actions: [{action_type: 'lead', value: '10', '7d_click': '4'}],
        },
        {
          ...row,
          campaign_id: '102',
          campaign_name: 'Second campaign',
          objective: 'OUTCOME_TRAFFIC',
          optimization_goal: 'LINK_CLICKS',
          inline_link_clicks: '6',
          spend: '12',
          actions: [{action_type: 'link_click', value: '9', '7d_click': '9'}],
        },
      ]);

test('a v4 campaign row is Meta’s own result under the windows asked for, with Meta’s label and no mapped flag', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({
            ...row,
            objective: 'OUTCOME_SALES',
            optimization_goal: 'OFFSITE_CONVERSIONS',
            spend: '10',
            results: results(
              'actions:offsite_conversion.fb_pixel_purchase',
              wire('4', '7d_click'),
              wire('1', '1d_view'),
              wire('7'),
            ),
            cost_per_result: results(
              'actions:offsite_conversion.fb_pixel_purchase',
              wire('2.5', '7d_click'),
              wire('10', '1d_view'),
              wire('1.4'),
            ),
            actions: [{action_type: 'purchase', value: '7', '7d_click': '4', '1d_view': '1'}],
          }))
        : rows,
    );
    const {read, stored} = await run(f, campaignConfig());
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    assert.equal(read.rows.length, 2);
    for (const row of read.rows) {
      // 7d_click 4 + 1d_view 1: the requested windows, not the ad set’s setting of 7.
      assert.equal(row.result.value, '5');
      assert.equal(row.result.label, 'Website purchases');
      assert.equal(row.result.definition_id, 'meta:website_purchases');
      assert.equal(row.result_context.source, 'provider');
      // 4 + 1 differs from the default value of 7, so the cost is spend over the sum (10 / 5), not Meta’s default cost.
      assert.equal(row.result.cost_per_result, '2');
      assert.equal(row.result_context.cost_source, 'derived');
      assert.equal(row.metrics.primary_result, '5');
    }
    // Nothing says "mapped" about a result Meta supplied: no column, no pack limitation.
    assert.equal(reportTable(stored)[0].includes('Result mapped from'), false);
    assert.equal(reportPack(stored).limitations.includes(mappedLimitation), false);
    // The exports name the result by Meta’s label, never by a key such as meta:website_purchases.
    const table = reportTable(stored),
      column = table[0].indexOf('Primary result');
    assert.ok(column > 0);
    assert.deepEqual(
      table
        .slice(1)
        .filter(cells => cells[table[0].indexOf('Campaign ID')] !== '')
        .map(cells => cells[column]),
      ['Website purchases', 'Website purchases'],
    );
    assert.deepEqual(
      [...new Set(reportPack(stored).summary.map(summary => summary.result_definition))],
      ['Website purchases'],
    );
    // The source states the definition once; a result the platform supplied is named as the platform’s.
    assert.deepEqual(
      read.sources[0].result_definitions.map(d => [d.id, d.label, d.aggregation]),
      [['meta:website_purchases', 'Website purchases', 'sum']],
    );
  } finally {
    f.close();
  }
});

test('a report with Meta’s results on one campaign and the mapped table on another shows both, per row', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(twoCampaigns);
    const {read, stored} = await run(f, campaignConfig());
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    const byCampaign = id => read.rows.filter(row => row.entity_id === id);
    assert.equal(byCampaign('101').length, 2);
    assert.equal(byCampaign('102').length, 2);
    for (const row of byCampaign('101')) {
      assert.deepEqual([row.result.value, row.result.label, row.result_context.source], ['4', 'Leads', 'provider']);
    }
    for (const row of byCampaign('102')) {
      assert.deepEqual([row.result.value, row.result.label, row.result_context.source], ['6', 'Link clicks', 'mapped']);
    }
    // Exports flag the mapped rows only, by the native field they were mapped from.
    const table = reportTable(stored),
      header = table[0],
      mapped = header.indexOf('Result mapped from'),
      campaign = header.indexOf('Campaign ID');
    assert.ok(mapped > 0, header.join('|'));
    assert.deepEqual(
      table
        .slice(1)
        // The note rows under the data rows (coverage of the summaries) have no campaign.
        .filter(cells => cells[campaign] !== '')
        .map(cells => [cells[campaign], cells[mapped]])
        .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)),
      [
        ['101', ''],
        ['101', ''],
        ['102', 'inline_link_clicks'],
        ['102', 'inline_link_clicks'],
      ],
    );
    assert.ok(reportPack(stored).limitations.includes(mappedLimitation), 'the pack says some results are mapped');
    // The two kinds never add: they are different result definitions.
    assert.deepEqual(read.sources[0].result_definitions.map(d => d.id).sort(), ['meta:leads', 'meta:link_clicks']);
  } finally {
    f.close();
  }
});

test('a summary that adds the results of different campaigns is AMCP’s total, not Meta’s own result', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform !== 'meta'
        ? rows
        : rows.flatMap(row =>
            ['101', '103'].map(id => ({
              ...row,
              campaign_id: id,
              campaign_name: 'Campaign ' + id,
              objective: 'OUTCOME_LEADS',
              optimization_goal: 'LEAD_GENERATION',
              spend: '12',
              results: results('actions:lead', wire('4', '7d_click'), wire('10')),
            })),
          ),
    );
    const {read} = await run(f, campaignConfig('daily'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    for (const row of read.rows)
      assert.equal(row.result_context.source, 'provider', 'each campaign’s result is Meta’s');
    const group = read.summary[0].result_groups?.[0] ?? read.summary[0].result_context;
    assert.equal(group.definition?.id ?? group.definition_id, 'meta:leads');
    assert.equal(group.source, 'mapped', 'the sum of two campaigns is AMCP’s');
    assert.equal(read.summary[0].metrics.primary_result, '8');
  } finally {
    f.close();
  }
});

test('the source’s result definition says what is true of its rows: results, mapped, or both', async () => {
  const definitions = [];
  for (const [name, mutate] of [
    ['results only', rows => rows.filter(row => row.campaign_id === '101')],
    ['mapped only', rows => rows.filter(row => row.campaign_id === '102')],
    ['both', rows => rows],
  ]) {
    const f = overviewGranularityFixture();
    try {
      f.mutate((rows, platform) => (platform === 'meta' ? mutate(twoCampaigns(rows, platform)) : rows));
      const {read} = await run(f, campaignConfig());
      assert.equal(read.state, 'complete', name);
      definitions.push(read.sources[0].result_definition);
    } finally {
      f.close();
    }
  }
  const [fromResults, fromMapping, both] = definitions;
  assert.notEqual(fromResults, fromMapping);
  assert.match(fromResults, /insights results/);
  assert.doesNotMatch(fromResults, /mapped/i, 'a report of Meta’s own results does not say mapped');
  assert.equal(fromMapping, v3Definition, 'a report of mapped rows keeps the sentence it always had');
  assert.match(both, /insights results/);
  assert.match(both, /mapped/);
  assert.notEqual(both, fromResults);
  assert.notEqual(both, fromMapping);
});

test('a v3 report keeps the definition sentence it always had', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate(twoCampaigns);
    const {objective, level, report_options, ...source} = granularSource('meta', 'campaign'),
      {read} = await run(f, granularConfig(source, 'daily'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    assert.equal(read.sources[0].result_definition, v3Definition);
    assert.equal(read.rows[0].result, undefined, 'a v3 row has no v4 result');
  } finally {
    f.close();
  }
});

test('a multi-day detail row is the sum of Meta’s own daily results, so it is still Meta’s result', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({
            ...row,
            optimization_goal: 'LANDING_PAGE_VIEWS',
            spend: '9',
            results: results('actions:landing_page_view', wire(row.date_start === '2026-09-01' ? '3' : '6')),
            cost_per_result: results('actions:landing_page_view', wire('3')),
          }))
        : rows,
    );
    const {read} = await run(f, detailConfig('ad'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    assert.equal(read.rows.length, 1);
    const [row] = read.rows;
    // Day one 3, day two 6; spend 9 + 9 over 9 results is 2, derived because Meta’s daily costs do not add.
    assert.deepEqual(
      [row.result.value, row.result.cost_per_result, row.result.label],
      ['9', '2', 'Landing page views'],
    );
    assert.deepEqual([row.result_context.source, row.result_context.cost_source], ['provider', 'derived']);
    assert.equal(row.result_context.coverage, undefined, 'both days counted');
  } finally {
    f.close();
  }
});

test('days of two kinds, Meta’s results and the mapped field, are two result groups and are not added', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({
            ...row,
            optimization_goal: 'LINK_CLICKS',
            inline_link_clicks: '3',
            spend: '9',
            ...(row.date_start === '2026-09-01' ? {results: results('actions:link_click', wire('4'))} : {}),
          }))
        : rows,
    );
    const {read} = await run(f, detailConfig('ad'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    const [row] = read.rows;
    // Day one is Meta’s (4 link clicks, results), day two is the goal’s mapped field (3 inline link clicks): the same label
    // but two different measurements, so they are separate result groups and the row has no single result.
    assert.equal(row.result.value, null);
    assert.equal(row.result_context.unavailable_reason, 'mixed_goals');
    assert.equal(row.result_groups.length, 2);
    assert.deepEqual(row.result_groups.map(group => group.source).sort(), ['mapped', 'provider']);
  } finally {
    f.close();
  }
});

test('days that name different indicators are different results, so they are never added', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({
            ...row,
            optimization_goal: 'LINK_CLICKS',
            spend: '9',
            results:
              row.date_start === '2026-09-01'
                ? results('actions:link_click', wire('4'))
                : results('actions:landing_page_view', wire('5')),
          }))
        : rows,
    );
    const {read} = await run(f, detailConfig('ad'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    const [row] = read.rows;
    assert.equal(row.result.value, null, 'no total of 9: link clicks and landing page views are not one result');
    assert.equal(row.result_context.unavailable_reason, 'mixed_goals');
    assert.deepEqual(row.result_groups.map(group => [group.result.definition_id, group.result.value]).sort(), [
      ['meta:landing_page_views', '5'],
      ['meta:link_clicks', '4'],
    ]);
  } finally {
    f.close();
  }
});

test('a detail row whose days are all mapped stays mapped', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({...row, optimization_goal: 'LINK_CLICKS', inline_link_clicks: '3', spend: '9'}))
        : rows,
    );
    const {read} = await run(f, detailConfig('ad'));
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    const [row] = read.rows;
    assert.deepEqual([row.result.value, row.result.label, row.result_context.source], ['6', 'Link clicks', 'mapped']);
  } finally {
    f.close();
  }
});

test('a results shape that is not the recorded one is an unknown result on its row, and the row keeps its other metrics', async () => {
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform === 'meta'
        ? rows.map(row => ({
            ...row,
            objective: 'OUTCOME_TRAFFIC',
            optimization_goal: 'LINK_CLICKS',
            inline_link_clicks: '6',
            spend: '12',
            results: 'oops',
          }))
        : rows,
    );
    const {read} = await run(f, campaignConfig());
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    for (const row of read.rows) {
      assert.equal(row.result.value, null);
      assert.equal(row.result_context.unavailable_reason, 'unverified_native_shape');
      assert.equal(row.result_context.source, 'unknown');
      assert.equal(row.metrics.spend, '12');
      assert.equal(row.metrics.impressions, '100');
      assert.equal(row.metrics.clicks, '10');
    }
  } finally {
    f.close();
  }
});

// The website’s source details of a row (web/reporting-overview.js), read in the page’s own scripts as the browser runs them.
function page(locale) {
  const context = createContext({
    document: {addEventListener() {}},
    pretty: String,
    date: value => new Date(value).toISOString(),
    esc: value =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;'),
    catalog,
  });
  const run = source => new Script(source).runInContext(context);
  for (const file of ['localization', 'report-library', 'report-quality', 'report-workflows', 'reporting-overview'])
    run(readFileSync('web/' + file + '.js', 'utf8'));
  run(`uiLocale='${locale}'; uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});`);
  return run;
}
const sourceDetails = (run, row) => {
  const markup = String(
    run(
      'renderReportTable(' +
        JSON.stringify({
          config: {name: 'Synthetic', grain: 'total', date_range: {since: '2026-09-01', until: '2026-09-02'}},
          rows: [
            {
              campaign_id: '101',
              campaign_name: 'Synthetic campaign',
              account_id: '100',
              objective_group: 'sales',
              objective_source: 'provider',
              attribution: 'Meta 7d_click; impression time',
              timezone: 'UTC',
              native: {},
              metrics: {},
              recommendation: {decision: 'needs_review', reason: ''},
              ...row,
            },
          ],
        }) +
        ',[],{platforms:[{id:"meta",name:"Meta"},{id:"google",name:"Google"}],metrics:{}})',
    ),
  );
  return /<summary>[^<]*<\/summary><p>([^<]*)<br>/.exec(markup)?.[1];
};
for (const locale of ['en', 'ar'])
  test('the website names a Meta row’s result by its label, in the interface language (' + locale + ')', () => {
    const run = page(locale),
      label = 'Website purchases';
    assert.equal(
      sourceDetails(run, {platform: 'meta', result_definition: label}),
      locale === 'ar' ? catalog[label] : label,
    );
    // Another platform’s definition text is not looked up: it stays as the platform sent it.
    assert.equal(sourceDetails(run, {platform: 'google', result_definition: label}), label);
  });

test('every label of Meta’s results has Arabic, on the website and in the Arabic exports', () => {
  const listed = [
    'Link clicks',
    'Post engagements',
    'Messaging conversations started',
    'Landing page views',
    'Landing page views (all channels)',
    'Website purchases',
    'Website adds to cart',
    'Calls placed',
    'Event responses',
    'Page likes',
    'Leads',
    'App installs',
    '2-second continuous video plays',
    'Profile visits',
    'Total profile visits',
    'Reach',
    'Impressions',
    'Estimated ad recall lift (people)',
    'Selected Meta action',
  ];
  // And every named label the code declares, so a label added later cannot ship without its Arabic. (A result Meta adds later
  // is named by its own indicator: the next test.)
  const declared = [...Object.values(metaResultIndicators), ...Object.values(metaResultRules.selectors[0].values)].map(
    definition => definition.label,
  );
  assert.ok(declared.length >= 23);
  assert.deepEqual(
    declared.filter(label => !listed.includes(label)),
    [],
    'a declared label this test does not know',
  );
  const labels = [...new Set([...listed, ...declared])];
  const arabic = artifactLocale({artifact_language: 'ar'}),
    english = artifactLocale({});
  for (const label of labels) {
    assert.match(catalog[label] ?? '', /[؀-ۿ]/u, 'website: ' + label);
    assert.match(arabic.result(label), /[؀-ۿ]/u, 'Arabic export: ' + label);
    assert.equal(arabic.result(label), catalog[label], 'the export says what the website says: ' + label);
    assert.equal(english.result(label), label, 'English export: ' + label);
  }
});

// The three results Meta adds later (a custom conversion, an action, a metric) are named by their own indicator, in the label every
// surface shows, so two of them in one report never share a label (the lead's ruling on the table of the brief).
const templates = [
  [
    'Custom conversion {id}',
    'actions:offsite_conversion.custom.1000000000000001',
    'Custom conversion 1000000000000001',
    '1000000000000001',
  ],
  [
    'Meta action {action}',
    'actions:onsite_conversion.post_save',
    'Meta action onsite_conversion.post_save',
    'onsite_conversion.post_save',
  ],
  ['Meta result {indicator}', 'thruplay_views', 'Meta result thruplay_views', 'thruplay_views'],
];
for (const [template, indicator, label, value] of templates)
  test('the label of ' + indicator + ' carries its own value, and has Arabic on the website and in the exports', () => {
    assert.equal(metaIndicatorDefinition(indicator).label, label);
    const slot = /\{[a-z]+\}/.exec(template)[0],
      translated = catalog[template];
    assert.match(translated ?? '', /[؀-ۿ]/u, 'Arabic for ' + template);
    assert.ok(translated.includes(slot), 'the Arabic keeps the slot ' + slot);
    const expected = translated.replace(slot, value);
    assert.equal(artifactLocale({artifact_language: 'ar'}).result(label), expected, 'Arabic export');
    assert.equal(artifactLocale({}).result(label), label, 'English export');
    assert.equal(sourceDetails(page('ar'), {platform: 'meta', result_definition: label}), expected, 'Arabic website');
    assert.equal(sourceDetails(page('en'), {platform: 'meta', result_definition: label}), label, 'English website');
  });

test('two custom conversions, an action and a metric Meta adds later in one report show four labels: MCP, exports and website', async () => {
  const indicators = [
      ['101', 'actions:offsite_conversion.custom.1000000000000001', 'Custom conversion 1000000000000001'],
      ['102', 'actions:offsite_conversion.custom.1000000000000002', 'Custom conversion 1000000000000002'],
      ['103', 'actions:onsite_conversion.post_save', 'Meta action onsite_conversion.post_save'],
      ['104', 'thruplay_views', 'Meta result thruplay_views'],
    ],
    labels = indicators.map(([, , label]) => label),
    arabic = label => {
      const [template, , , value] =
        templates.find(([, , english]) => label.startsWith(english.split(' ').slice(0, -1).join(' '))) ?? [];
      return template && catalog[template].replace(/\{[a-z]+\}/, label.slice(label.lastIndexOf(' ') + 1));
    };
  const f = overviewGranularityFixture();
  try {
    f.mutate((rows, platform) =>
      platform !== 'meta'
        ? rows
        : rows.flatMap(row =>
            indicators.map(([id, indicator]) => ({
              ...row,
              campaign_id: id,
              campaign_name: 'Campaign ' + id,
              objective: 'OUTCOME_SALES',
              optimization_goal: 'OFFSITE_CONVERSIONS',
              spend: '12',
              results: results(indicator, wire('6')),
            })),
          ),
    );
    const {read, stored} = await run(f, campaignConfig());
    assert.equal(read.state, 'complete', JSON.stringify(read.sources?.[0]?.error));
    // MCP: each row, each definition of the source and each summary names its own result.
    assert.deepEqual(
      [...new Set(read.rows.map(row => row.entity_id + ' ' + row.result.label))].sort(),
      indicators.map(([id, , label]) => id + ' ' + label),
    );
    assert.deepEqual(read.sources[0].result_definitions.map(definition => definition.label).sort(), [...labels].sort());
    assert.deepEqual([...new Set(read.summary.map(summary => summary.result_definition))].sort(), [...labels].sort());
    // Exports: the table's Primary result column, the pack's summaries and the Arabic workbook.
    const table = reportTable(stored),
      column = table[0].indexOf('Primary result'),
      campaign = table[0].indexOf('Campaign ID');
    assert.deepEqual(
      [
        ...new Set(
          table
            .slice(1)
            .filter(cells => cells[campaign] !== '')
            .map(cells => cells[campaign] + ' ' + cells[column]),
        ),
      ].sort(),
      indicators.map(([id, , label]) => id + ' ' + label),
    );
    assert.deepEqual(
      [...new Set(reportPack(stored).summary.map(summary => summary.result_definition))].sort(),
      [...labels].sort(),
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await reportWorkbook(stored, {artifact_language: 'ar'}));
    const cells = book.worksheets.flatMap(sheet => sheet.getSheetValues().flat().filter(Boolean));
    for (const label of labels) {
      assert.ok(cells.includes(arabic(label)), 'the Arabic workbook says ' + arabic(label));
      assert.equal(cells.includes(label), false, 'and no longer the English ' + label);
    }
    // Website: the source details of each row, in both languages.
    for (const [locale, expected] of [
      ['en', label => label],
      ['ar', arabic],
    ]) {
      const run = page(locale);
      for (const [id, , label] of indicators) {
        const row = stored.rows.find(item => item.campaign_id === id);
        assert.equal(
          sourceDetails(run, {platform: 'meta', result_definition: row.result_definition}),
          expected(label),
          locale + ' ' + id,
        );
      }
    }
  } finally {
    f.close();
  }
});
