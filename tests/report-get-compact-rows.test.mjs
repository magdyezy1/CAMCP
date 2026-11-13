// Package website-get (W1): the rows table is drawn from the compact answer of `get`, the one the page asks for, exactly as it
// is drawn from the full answer (include.native), which carries the whole row. A compact v4 row names its account by
// `source_ref`, nests its parents and keeps its recommendation whole (ruling 14); the page rebuilds from the row and its
// source what its renderers read, and loads the rest when a row's "Source details" opens. The snapshots are real: the
// run, the worker, row assembly and the `get` projection over synthetic provider responses and a fake collector, drawn by
// the page's own scripts in English and Arabic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {reportEngine} from './helpers/report-engine.mjs';
import {row as packetRow} from './helpers/report-packets.mjs';
import {reportSource} from '../dist/src/report-sources.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8'));
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character],
  );
const wire = value => JSON.parse(JSON.stringify(value));

/** The page's scripts in a VM, in one language, with the given bootstrap. */
function page(locale, bootstrap) {
  const context = createContext({
    Intl,
    Date,
    URLSearchParams,
    structuredClone,
    esc,
    catalog,
    bootstrap,
    $: () => null,
    CSS: {escape: String},
    location: {pathname: '/reporting-overview', search: ''},
    document: {addEventListener() {}, querySelector: () => null, querySelectorAll: () => []},
  });
  const run = code => new Script(code).runInContext(context);
  run(fs.readFileSync('web/localization.js', 'utf8'));
  run("var date = value => (value ? uiDate(value) : uiText('Not synced'));");
  const workspace = fs.readFileSync('web/workspace.js', 'utf8');
  run(
    workspace.slice(
      workspace.indexOf('const overviewCall = async input => {'),
      workspace.indexOf('const capabilityFeatureLabels'),
    ),
  );
  for (const file of ['report-library', 'report-source-settings', 'report-quality', 'reporting-overview'])
    run(fs.readFileSync('web/' + file + '.js', 'utf8'));
  run(
    `uiLocale=${JSON.stringify(locale)};uiMessages=new Map(${locale === 'ar' ? 'Object.entries(catalog)' : '[]'});overviewState.bootstrap=bootstrap;`,
  );
  return {
    table(report) {
      Object.assign(context, {report, keys: report.config.metrics, bootstrap});
      return String(run('renderReportTable(report, keys, bootstrap)'));
    },
  };
}

/** Each row of a drawn table, without its "Source details": the compact row loads those when they are opened. */
const rowsOf = html =>
  [...html.matchAll(/<tr role="row">(<th scope="row"[\s\S]*?)<\/tr>(?=<tr role="row">|<\/tbody>)/g)].map(match =>
    match[1].replace(/<details[\s\S]*?<\/details><\/td>/, '</td>'),
  );

/** A v4 snapshot of one platform through the real run, worker and `get`, in its two answers and its bootstrap. */
async function snapshot(t, {platform, levels, grain = 'total', targets = {}}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const base = granularSource(platform, 'ad'),
    {level, objective, report_options, ...rest} = base,
    source = {
      ...rest,
      levels,
      statuses: ['all'],
      delivered_only: false,
      ...(platform === 'snapchat' && levels.includes('adset') ? {campaign_id: base.campaign_id} : {}),
      report_options:
        platform === 'meta' ? {...reportSource('meta').overview.defaults, complete_window: true} : report_options,
    },
    queued = await f.overview.handle(
      {
        action: 'run',
        config: {...granularConfig(source, grain), contract_version: 'overview-config-v4', targets},
        confirmed: true,
      },
      f.actor,
    );
  await f.worker.once();
  const get = include =>
    f.overview.handle({action: 'get', id: queued.id, offset: 0, limit: 100, ...(include ? {include} : {})}, f.actor);
  return {
    compact: wire(await get()),
    full: wire(await get({native: true})),
    bootstrap: wire(await f.overview.handle({action: 'bootstrap'}, f.actor)),
  };
}

const compare = (locale, {compact, full, bootstrap}) => {
  const view = page(locale, bootstrap),
    drawn = report => rowsOf(view.table(report));
  assert.ok(['complete', 'partial'].includes(compact.state), compact.state);
  const a = drawn(full),
    b = drawn(compact);
  assert.ok(a.length > 0, 'the case has rows');
  assert.equal(b.length, a.length);
  a.forEach((expected, index) => assert.equal(b[index], expected, locale + ' row ' + index));
  return b;
};

const cases = [];
for (const platform of ['google', 'meta', 'tiktok', 'linkedin', 'x'])
  for (const grain of ['total', 'daily']) cases.push({platform, grain, levels: ['campaign', 'adset', 'ad']});
cases.push({platform: 'snapchat', grain: 'total', levels: ['campaign', 'adset']});

for (const c of cases)
  test(`${c.platform}, ${c.grain} grain: the compact answer draws the rows the full answer draws, in both languages`, async t => {
    const s = await snapshot(t, c);
    for (const locale of ['en', 'ar']) compare(locale, s);
    // The case is real: a compact row names its account by its source and holds none of the row's account fields.
    assert.ok(
      s.compact.rows.every(r => r.source_ref !== undefined && r.platform === undefined && r.native === undefined),
    );
    if (c.grain === 'daily')
      assert.match(
        page('en', s.bootstrap).table(s.compact),
        /Based on the whole window: /,
        'the whole-window note of a grouped row comes from the compact row’s evidence',
      );
  });

test('a recommendation’s target and actual, and a campaign group’s results by objective, are drawn from the compact row', async t => {
  const target = {kpi: 'cpm', target: 5, currency: 'USD', minimum_results: 1, conversion_lag_days: 0, context: {}},
    mixedResults = [
      {objective: 'LEAD_GENERATION', group: 'leads', result_definition: 'LinkedIn leads (one-click)', value: '3.3'},
      {objective: 'VIDEO_VIEW', group: 'video_views', result_definition: 'LinkedIn video views', value: '7'},
    ],
    drawnCases = [];
  for (const [platform, rows, definition] of [
    [
      'meta',
      [packetRow('campaign', 'c1', {spend: '30'}), packetRow('campaign', 'c2', {spend: '10'})],
      {targets: {leads: target}},
    ],
    [
      'linkedin',
      [
        packetRow(
          'campaign',
          '20',
          {spend: '5.5'},
          {
            objective: 'MIXED',
            objective_group: 'mixed',
            objective_source: 'provider',
            objective_reason: 'This campaign group’s campaigns have different objectives: LEAD_GENERATION, VIDEO_VIEW.',
            result_definition: 'Mixed',
            results_by_objective: mixedResults,
          },
        ),
      ],
      {},
    ],
  ]) {
    const e = reportEngine(t, {platform, packet: {source_kind: 'paid'}, rowsFor: () => rows}),
      queued = await e.queue(['campaign'], definition);
    await e.worker.once();
    const get = include =>
        e.overview.handle({action: 'get', id: queued.id, limit: 100, ...(include ? {include} : {})}, e.actor),
      answers = {
        compact: wire(await get()),
        full: wire(await get({native: true})),
        bootstrap: wire(await e.overview.handle({action: 'bootstrap'}, e.actor)),
      };
    for (const locale of ['en', 'ar']) compare(locale, answers);
    drawnCases.push([platform, page('en', answers.bootstrap).table(answers.compact)]);
  }
  const [[, meta], [, linkedin]] = drawnCases;
  assert.match(meta, /<small>cpm target 5 · actual 300\.00<\/small>/);
  assert.match(linkedin, /This campaign group’s campaigns have different objectives: LEAD_GENERATION, VIDEO_VIEW\./);
});

test('a snapshot of an earlier contract is drawn as it was: its rows are whole whatever the answer is asked for', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const queued = await f.overview.handle(
    {action: 'run', config: granularConfig(granularSource('meta', 'ad')), confirmed: true},
    f.actor,
  );
  await f.worker.once();
  const plain = wire(await f.overview.handle({action: 'get', id: queued.id}, f.actor)),
    full = wire(await f.overview.handle({action: 'get', id: queued.id, include: {native: true}}, f.actor)),
    bootstrap = wire(await f.overview.handle({action: 'bootstrap'}, f.actor));
  assert.notEqual(plain.config.contract_version, 'overview-config-v4');
  assert.ok(
    plain.rows.every(r => r.platform === 'meta' && r.native !== undefined),
    'an earlier row is whole',
  );
  const view = page('en', bootstrap);
  assert.equal(view.table(plain), view.table(full), 'the whole table, details included');
});
