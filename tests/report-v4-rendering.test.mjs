// F-L8-09, and the findings it hid (F-L8-02, F-L8-03, F-L8-06, F-L10-08): the website draws what the server stores.
// The snapshots here are built by the real server path (the reporting overview's run, worker and `get`, which call
// reportSummary, projectOverviewV4Rows and overviewV4Sources) from synthetic provider responses, then drawn by the
// page's own scripts in English and Arabic. The page was only ever tested with hand-built flat rows, so its objective
// cells, its coverage and its cross-level check could drift from the server with every test still green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Script, createContext} from 'node:vm';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';
import {reportSource} from '../dist/src/report-sources.js';
import {reportSummary} from '../dist/src/report-summary.js';

const catalog = JSON.parse(fs.readFileSync('web/locales/ar.json', 'utf8')),
  locales = ['en', 'ar'];
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[character],
  );
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plainText = html =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  // The shell's own date helper (web/app.js).
  run("var date = value => (value ? uiDate(value) : uiText('Not synced'));");
  // The shell helpers the report scripts share: pretty() and the source diagnostic.
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
  const raw = (expression, values = {}) => {
    Object.assign(context, values);
    return run('(' + expression + ')');
  };
  return {
    run,
    raw,
    /** The page's own result for an expression, as text, with `values` as variables. */
    call: (expression, values = {}) => String(raw(expression, values)),
    /** The message as the language shows it: the catalog's Arabic, or the English key itself. */
    text: key => (locale === 'ar' ? catalog[key] : key),
  };
}

const metaConnection = granularSource('meta', 'campaign');
/** A Meta v4 snapshot through the real run, worker and `get` (the page's own request), and the server's bootstrap. */
async function snapshot(t, {levels = ['campaign', 'ad'], scope = {}, grain = 'daily', rows = row => row} = {}) {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.mutate((all, platform) => (platform === 'meta' ? all.map(rows) : all));
  const meta = reportSource('meta').overview,
    source = {
      platform: 'meta',
      connection_id: metaConnection.connection_id,
      account_id: metaConnection.account_id,
      levels,
      statuses: ['all'],
      delivered_only: false,
      ...scope,
      report_options: {...meta.defaults, complete_window: true},
    };
  const queued = await f.overview.handle(
    {
      action: 'run',
      config: {...granularConfig(source, grain), contract_version: 'overview-config-v4'},
      confirmed: true,
    },
    f.actor,
  );
  await f.worker.once();
  const report = await f.overview.handle(
      {action: 'get', id: queued.id, offset: 0, limit: 100, include: {native: true, lineage: true}},
      f.actor,
    ),
    bootstrap = await f.overview.handle({action: 'bootstrap'}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(source => source.error ?? source.warnings)));
  assert.equal(report.config.contract_version, 'overview-config-v4');
  return {report, bootstrap};
}
/** The leading <small> lines of each rows-table context cell: the objective group, then its source or reason. */
const contextLines = html =>
  [...html.matchAll(/<td role="cell" class="report-row-context"[^>]*>([\s\S]*?)<details>/g)].map(cell =>
    [...cell[1].matchAll(/<small>([\s\S]*?)<\/small>/g)].map(small => plainText(small[1])),
  );
/** The summary cards of a rendered summary, as text. */
const cards = html =>
  [...html.matchAll(/<article class="report-summary-card[^"]*">([\s\S]*?)<\/article>/g)].map(card => card[1]);
/** The cross-level lines of a snapshot, as the page prints them. */
const levelCheck = (view, report) =>
  [...view.call('renderReportLevelCheck(report)', {report}).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(item =>
    plainText(item[1]),
  );

for (const locale of locales) {
  test(locale + ': a real v4 table shows each row’s objective group, source and reason (F-L8-02)', async t => {
    const scope = {ad_ids: ['9007199254740993']},
      provider = await snapshot(t, {
        levels: ['ad'],
        grain: 'total',
        scope,
        rows: row => ({...row, objective: 'OUTCOME_LEADS'}),
      }),
      unread = await snapshot(t, {levels: ['ad'], grain: 'total', scope});
    // The page asks `get` for native rows, and the server nests the objective and drops the flat fields.
    for (const {report} of [provider, unread]) {
      assert.equal(typeof report.rows[0].objective, 'object', 'the projected row nests its objective');
      assert.equal(report.rows[0].objective_group, undefined, 'and carries no flat objective_group');
    }
    const view = page(locale, provider.bootstrap),
      table = ({report}) =>
        contextLines(
          view.call('renderReportTable(report,metrics,bootstrap)', {report, metrics: report.config.metrics}),
        )[0];
    // A provider objective: the group, then where it came from.
    assert.deepEqual(table(provider).slice(0, 2), [view.text('Leads'), view.text('From the platform')]);
    // No objective: the group is Unknown and the server's reason is given in the page's language.
    const [group, reason] = table(unread);
    assert.equal(group, view.text('Unknown'));
    assert.equal(reason, view.text('Meta returned no objective for this campaign.'));
    if (locale === 'ar') assert.doesNotMatch(reason, /returned no objective/);
  });

  test(
    locale + ': a real v4 summary names each card’s level, so the campaign and ad cards are never identical (F-L8-06)',
    async t => {
      const {report, bootstrap} = await snapshot(t, {grain: 'total', scope: {ad_ids: ['9007199254740993']}});
      const view = page(locale, bootstrap),
        drawn = cards(view.call('renderReportSummary(report)', {report})).map(plainText),
        level = id => view.text('Reporting level: {level}').replace('{level}', view.text(id));
      assert.equal(drawn.length, 2, drawn.join(' | '));
      assert.notEqual(drawn[0], drawn[1]);
      assert.match(drawn[0], new RegExp(literal(level('Campaign'))));
      assert.match(drawn[1], new RegExp(literal(level('Ad'))));
    },
  );
}

const adSpend = spend => row => (row.ad_id ? {...row, spend} : row);
for (const locale of locales) {
  test(
    locale +
      ': levels that add up say so; a shortfall is a cover percentage that is cut, never rounded up to 100 (F-L8-03, F-L10-08)',
    async t => {
      const agree = await snapshot(t),
        short = await snapshot(t, {rows: adSpend('0.097000001')}),
        nearly = await snapshot(t, {rows: adSpend('0.0997')}),
        above = await snapshot(t, {rows: adSpend('0.3')});
      // The server's own verdicts, so the lines below are tied to real data and not to what the page assumes.
      assert.deepEqual(
        agree.report.sources[0].cross_level.map(item => item.state),
        ['agree', 'agree', 'agree'],
      );
      assert.deepEqual(
        short.report.sources[0].cross_level.map(item => item.state),
        ['gap', 'agree', 'agree'],
      );
      assert.equal(short.report.sources[0].cross_level[0].coverage_percent, '97.00000003');
      assert.equal(nearly.report.sources[0].cross_level[0].coverage_percent, '99.699999003');
      const view = page(locale, agree.bootstrap),
        name = key => view.text(key),
        // The metric words are the server's own labels, from the bootstrap the page receives.
        metric = key => view.text(agree.bootstrap.metrics[key].label),
        lower = text => (locale === 'en' ? text.toLowerCase() : text),
        list = items => view.call('uiList(items)', {items}),
        agreeOn = metrics =>
          view
            .text('Levels agree on {metrics} ({baseline} and {comparison}).')
            .replace('{metrics}', list(metrics.map(key => lower(metric(key)))))
            .replace('{baseline}', name('Campaign'))
            .replace('{comparison}', name('Ad')),
        sentence = (template, percent) =>
          view
            .text(template)
            .replace('{comparison}', name('Ad'))
            .replace('{percent}', percent)
            .replace('{baseline}', lower(name('Campaign')))
            .replace('{metric}', lower(metric('spend')));
      assert.deepEqual(levelCheck(view, agree.report), [agreeOn(['spend', 'impressions', 'clicks'])]);
      // A shortfall is its own line, and the metrics that still agree keep theirs.
      assert.deepEqual(levelCheck(view, short.report), [
        sentence('{comparison} rows cover {percent} of {baseline} {metric}.', '97%'),
        agreeOn(['impressions', 'clicks']),
      ]);
      assert.equal(
        levelCheck(view, nearly.report)[0],
        sentence('{comparison} rows cover {percent} of {baseline} {metric}.', '99%'),
        '99.7% is cut, not rounded up to 100%',
      );
      assert.doesNotMatch(levelCheck(view, nearly.report).join(' '), /100\s*%/);
      assert.equal(
        levelCheck(view, above.report)[0],
        sentence('{comparison} rows add up to {percent} of {baseline} {metric}.', '299%'),
      );
      // The exact server figure stays available on the line.
      assert.match(
        view.call('renderReportLevelCheck(report)', {report: short.report}),
        /title="97\.00000003%"/,
        'the exact percentage is kept on hover',
      );
    },
  );

  test(
    locale + ': a level with unknown values is a partial check, and rolled-up parents are not compared at all',
    async t => {
      const partial = await snapshot(t, {
          rows: row => (row.ad_id && row.date_start === '2026-09-02' ? {...row, spend: undefined} : row),
        }),
        rolled = await snapshot(t, {grain: 'total', scope: {ad_ids: ['9007199254740993']}});
      assert.equal(partial.report.sources[0].cross_level[0].state, 'partial');
      assert.equal(rolled.report.sources[0].cross_level[0].unavailable_reason, 'derived_parent_population');
      const view = page(locale, partial.bootstrap),
        name = key => view.text(key),
        metric = key => view.text(partial.bootstrap.metrics[key].label),
        list = items => view.call('uiList(items)', {items}),
        [first] = levelCheck(view, partial.report);
      assert.equal(
        first,
        view
          .text(
            '{metrics} could not be fully compared between {baseline} and {comparison} rows: some values are unknown, or a level was not fully collected.',
          )
          .replace('{metrics}', metric('spend'))
          .replace('{baseline}', name('Campaign'))
          .replace('{comparison}', name('Ad')),
      );
      assert.doesNotMatch(first, /50\s*%/, 'a half-known level is not reported as covering half');
      assert.deepEqual(levelCheck(view, rolled.report), [
        view
          .text('{metrics} cannot be compared between {baseline} and {comparison} rows: {reason}.')
          .replace('{metrics}', list(['spend', 'impressions', 'clicks'].map(metric)))
          .replace('{baseline}', name('Campaign'))
          .replace('{comparison}', name('Ad'))
          .replace('{reason}', name('the parent rows are rolled up from the selected child rows')),
      ]);
    },
  );
}

test('a gap that rounds to 100 is never shown as covering 100%; a single level prints no check; percentages are cut', () => {
  const comparison = (overrides = {}) => ({
    metric: 'spend',
    currency: 'USD',
    timezone: 'UTC',
    baseline: {level: 'campaign', value: '1000000000'},
    comparison: {level: 'ad', value: '1000000001'},
    state: 'gap',
    delta: '1',
    coverage_percent: '100',
    unavailable_reason: null,
    ...overrides,
  });
  const view = page('en', {
      platforms: [{id: 'meta', name: 'Meta', entity_levels: reportSource('meta').overview.levels}],
      metrics: {spend: {label: 'Spend'}, impressions: {label: 'Impressions'}, clicks: {label: 'Clicks'}},
    }),
    report = cross_level => ({sources: [{source: {platform: 'meta', account_id: '100'}, cross_level}]});
  // The server computed 100 after rounding to nine places, yet the totals differ: the line says they differ.
  assert.deepEqual(levelCheck(view, report([comparison()])), ['Ad rows and campaign rows differ on spend.']);
  // A baseline of zero has no percentage to give.
  assert.deepEqual(
    levelCheck(
      view,
      report([
        comparison({
          coverage_percent: null,
          baseline: {level: 'campaign', value: '0'},
          comparison: {level: 'ad', value: '5'},
        }),
      ]),
    ),
    ['Ad rows and campaign rows differ on spend.'],
  );
  assert.equal(view.call('renderReportLevelCheck(report)', {report: report([])}), '');
  assert.equal(view.call('renderReportLevelCheck(report)', {report: {sources: [{source: {platform: 'meta'}}]}}), '');
  // Whole percent, cut and never rounded; more digits only where the cut would read as 0 or as exactly 100.
  for (const [value, shown] of [
    ['97', '97%'],
    ['97.00000003', '97%'],
    ['99.999999999', '99%'],
    ['100', '100%'],
    ['100.4', '100.4%'],
    ['100.0000001', '100.0000001%'],
    ['0', '0%'],
    ['0.04', '0.04%'],
    ['299.999997', '299%'],
    ['1500.5', '1,500%'],
  ])
    assert.equal(view.raw('reportPercent(value)', {value}), shown, value);
  for (const value of [null, undefined, '', '-5', 'abc', '1e3', '97.5.1'])
    assert.equal(view.raw('reportPercent(value)', {value}), null, String(value));
});

// The audit's case: three rows, one with unknown spend, in a complete source. Spend adds two rows, clicks three, and
// the cost per click divides the two rows that have both, so the figures cannot reconcile unless the card says why.
const row = (id, spend, clicks) => ({
  platform: 'linkedin',
  account_id: '507',
  currency: 'USD',
  timezone: 'UTC',
  objective_group: 'traffic',
  result_definition: 'clicks',
  attribution: 'unknown',
  date_from: '2026-09-01',
  date_to: '2026-09-07',
  entity_level: 'campaign',
  native_entity_type: 'campaign',
  entity_id: id,
  entity_key: id,
  complete: true,
  metrics: {spend, clicks, impressions: 1000, conversions: null},
  recommendation: {decision: 'observe'},
  result: {metric: null, label: null, value: null, cost_per_result: null, definition_id: null},
  result_context: {},
});
for (const locale of locales)
  test(
    locale +
      ': a total or ratio built from some of its rows says "n of m rows" and why the figures do not divide (F-L8-03)',
    () => {
      const summary = reportSummary([row('1', '10.5', 5), row('2', null, 7), row('3', '20', 9)], [], true);
      assert.equal(summary[0].metrics_coverage.spend.known, 2);
      assert.equal(summary[0].metrics_coverage.clicks.known, 3);
      assert.equal(summary[0].metrics_coverage.cpc.known_pairs, 2);
      const view = page(locale, {
          platforms: [{id: 'linkedin', name: 'LinkedIn', entity_levels: reportSource('linkedin').overview.levels}],
          metrics: {
            spend: {label: 'Spend', format: 'currency'},
            clicks: {label: 'Clicks', format: 'number'},
            cpc: {label: 'Cost per click', format: 'currency'},
          },
        }),
        report = {
          config: {contract_version: 'overview-config-v4'},
          summary,
          sources: [{source: {platform: 'linkedin', account_id: '507'}, complete: true, row_count: 3}],
          rows: [],
        },
        [card] = cards(view.call('renderReportSummary(report)', {report}));
      /** A figure of the card: its value and, when it has one, the small coverage line under it. */
      const figure = label => {
        const found = [
          ...card.matchAll(
            /<span>([^<]*)<strong>([^<]*)<\/strong>(?:<small class="report-coverage">([^<]*)<\/small>)?<\/span>/g,
          ),
        ].find(match => match[1] === label);
        return {value: found?.[2], coverage: found?.[3]};
      };
      const of = (known, total) =>
        view.text('{known} of {count} rows').replace('{known}', String(known)).replace('{count}', String(total));
      assert.equal(figure(view.text('Spend')).coverage, of(2, 3));
      assert.equal(figure('CPC').coverage, of(2, 3));
      assert.equal(figure(view.text('Clicks')).coverage, undefined, 'clicks come from all three rows and say nothing');
      const text = plainText(card);
      assert.ok(
        text.includes(
          view
            .text('Some rows have no value for {metrics}. They are left out of the total and never counted as 0.')
            .replace('{metrics}', view.text('Spend')),
        ),
        text,
      );
      assert.ok(
        text.includes(
          view
            .text(
              'Ratios ({metrics}) use only the rows that have every value they need, so they can differ from one total divided by another.',
            )
            .replace('{metrics}', 'CPC'),
        ),
        text,
      );
    },
  );

test('a single row of a partly known metric reads "0 of 1 row", and complete figures print no coverage', () => {
  const view = page('en', {
    platforms: [{id: 'linkedin', name: 'LinkedIn', entity_levels: []}],
    metrics: {spend: {label: 'Spend', format: 'currency'}},
  });
  const report = rows => ({
      config: {contract_version: 'overview-config-v4'},
      summary: reportSummary(rows, [], true),
      sources: [],
      rows: [],
    }),
    drawn = rows => cards(view.call('renderReportSummary(report)', {report: report(rows)}))[0];
  assert.match(drawn([row('1', null, 5)]), /<small class="report-coverage">0 of 1 row<\/small>/);
  assert.doesNotMatch(drawn([row('1', '10.5', 5), row('2', '20', 9)]), /report-coverage| of \d+ rows?</);
});

test('the objective reader takes the nested v4 shape and the flat shape recorded before it', () => {
  const view = page('en', {platforms: [], metrics: {}}),
    read = value => JSON.parse(view.call('JSON.stringify(reportRowObjective(row))', {row: value}));
  assert.deepEqual(read({objective: {native: 'X', group: 'leads', source: 'provider', reason: null}}), {
    group: 'leads',
    source: 'provider',
  });
  assert.deepEqual(read({objective: {native: null, group: 'unknown', source: 'unknown', reason: 'No objective.'}}), {
    group: 'unknown',
    source: 'unknown',
    reason: 'No objective.',
  });
  // Rows recorded before v4 keep a native objective string beside the flat fields and render exactly as recorded.
  assert.deepEqual(read({objective: 'OUTCOME_LEADS', objective_group: 'leads', objective_source: 'provider_mapped'}), {
    group: 'leads',
    source: 'provider_mapped',
  });
  assert.deepEqual(read({objective: null, objective_group: 'sales', objective_reason: 'Because.'}), {
    group: 'sales',
    reason: 'Because.',
  });
  assert.deepEqual(read({}), {});
});
