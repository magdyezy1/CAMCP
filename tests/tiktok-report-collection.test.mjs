import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, Script} from 'node:vm';
import {inspectReportingFailures} from '../tools/check-locales.mjs';
import {Store} from '../dist/src/store.js';
import {paginate} from '../dist/src/pagination.js';
import {collectTikTokDailyReport} from '../dist/src/tiktok-reporting.js';
import * as rules from '../dist/src/tiktok-report-pagination.js';
import {DecisionReporting} from '../dist/src/decision-reporting.js';
import {collectDetailedOverview} from '../dist/src/overview-granularity.js';
import {tiktokPageFixtures, reportDay} from './fixtures/tiktok-report-pages.mjs';

const actor = {tenantId: 'synthetic-tiktok-pages', userId: 'owner', role: 'admin'};
const connection = 'ffffffff-1111-4111-8111-111111111115';
const semantics = {
  currency: 'USD',
  timezone: 'Etc/GMT',
  date_from: reportDay,
  date_to: reportDay,
  attribution: 'unknown',
  source_name: 'Synthetic pages',
  complete: true,
};
const query = {
  advertiser_id: '100',
  report_type: 'BASIC',
  data_level: 'AUCTION_CAMPAIGN',
  dimensions: ['campaign_id', 'stat_time_day'],
  metrics: ['spend', 'impressions', 'clicks', 'conversion'],
  start_date: reportDay,
  end_date: reportDay,
  page: 1,
  page_size: 1000,
};
const plan = {
  gateway: 'tiktok_native_action',
  action: 'tiktok_report_integrated_get',
  method: 'GET',
  path: '/v1.3/report/integrated/get/',
  query,
  headers: {},
  readOnly: true,
  destructive: false,
  requiresConfirmation: false,
  accountId: '100',
  evidence: 'SYNTHETIC',
  warnings: [],
};
function fixture(t, data) {
  const store = new Store(':memory:', Buffer.alloc(32, 116).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: plan.gateway,
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const calls = [];
  const call = async (_tool, args) => {
    calls.push(args);
    const native =
      args.action === 'tiktok_advertiser_info_get'
        ? {list: [{advertiser_id: '100', currency: 'USD', timezone: 'Etc/GMT'}]}
        : data.pages[(args.query.page ?? 1) - 1];
    assert.ok(native, 'only the declared pages are requested');
    return {success: true, data: {data: {code: 0, data: native}}};
  };
  return {store, calls, call};
}
const pageKeys = ['list_length', 'page', 'page_size', 'rule', 'total_number', 'total_page'];
for (const sample of tiktokPageFixtures()) {
  for (const collector of ['guided', 'integrated']) {
    test(collector + ': ' + sample.name, async t => {
      const f = fixture(t, sample);
      const run = () =>
        collector === 'guided'
          ? collectTikTokDailyReport(
              f.store,
              f.call,
              actor,
              {action: plan.action, account_id: '100', connection_id: connection, query},
              semantics,
              {allowPartial: true},
            )
          : paginate(plan, async request => ({code: 0, data: sample.pages[request.query.page - 1]}));
      if (sample.expected.code) {
        await assert.rejects(run, error => {
          assert.equal(error.code, sample.expected.code);
          assert.equal(error.details.page_facts.rule, sample.expected.rule);
          assert.deepEqual(Object.keys(error.details.page_facts).sort(), pageKeys);
          assert.doesNotMatch(JSON.stringify(error.details.page_facts), /campaign_id|spend|dimensions/);
          return true;
        });
        return;
      }
      const result = await run();
      const returned = collector === 'guided' ? result.source.data.data.list.length : result.data.data.list.length;
      const declared = sample.pages[0].page_info.total_number ?? 0;
      const collection = collector === 'guided' ? result.collection : rules.tiktokCollectionCounts(declared, returned);
      assert.equal(collection.complete, sample.expected.complete);
      if (sample.expected.complete === false) {
        assert.equal(returned, sample.expected.returned);
        const warning = 'TikTok declared 1,500 rows and returned ' + returned.toLocaleString('en-US') + '.';
        assert.ok((collection.warnings ?? [collection.warning]).includes(warning));
      }
      if (collector === 'integrated') assert.deepEqual(result.data.data.page_info, sample.pages[0].page_info);
      if (sample.expected.rule) {
        const checked = rules.tiktokPageCheck(sample.pages[0], {page: 1, size: 1000}, {total: null, returned: 0});
        assert.equal(checked.facts.rule, sample.expected.rule);
      }
    });
  }
}

test('evidence captures refuse partial collections with both counts and keep no evidence', async t => {
  const f = fixture(
    t,
    tiktokPageFixtures().find(sample => sample.name === 'short middle page'),
  );
  const reporting = new DecisionReporting(f.store, f.call);
  await assert.rejects(
    reporting.handle(
      {action: 'capture_preset', preset: 'tiktok_campaign', account_id: '100', connection_id: connection, semantics},
      actor,
    ),
    error =>
      error.code === 'REPORT_INCOMPLETE' &&
      error.details.declared_rows === 1500 &&
      error.details.returned_rows === 1400,
  );
  assert.equal(f.store.documents(actor.tenantId, 'decision_report').length, 0);
});

test('the overview retains partial guided rows with both counts and held recommendations', async t => {
  const sample = tiktokPageFixtures().find(sample => sample.name === 'short middle page');
  for (const page of sample.pages)
    for (const row of page.list) {
      row.dimensions.adgroup_id = row.dimensions.campaign_id;
      delete row.dimensions.campaign_id;
    }
  const f = fixture(t, sample);
  const source = {
    platform: 'tiktok',
    account_id: '100',
    connection_id: connection,
    level: 'adset',
    report_options: {complete_window: true, attribution: 'unknown'},
  };
  const lookup = {detailParents: {parents: {}, lineage: []}};
  // Retained parent records avoid unrelated inventory reads in this collection test.
  for (const page of sample.pages)
    for (const row of page.list)
      lookup.detailParents.parents[row.dimensions.adgroup_id] = {campaign_id: '9', campaign_name: 'Synthetic'};
  const result = await collectDetailedOverview(
    {store: f.store, call: f.call},
    source,
    {since: reportDay, until: reportDay},
    actor,
    {},
    'USD',
    'Etc/GMT',
    lookup,
  );
  assert.equal(result.collection_complete, false);
  assert.equal(result.complete, false);
  assert.ok(result.warnings.includes('TikTok declared 1,500 rows and returned 1,400.'));
});

test('integrated merging retains the first page’s total_metrics', async () => {
  const sample = tiktokPageFixtures()[0];
  sample.pages[0].total_metrics = {spend: '1500', impressions: '15000', clicks: '3000', conversion: '1500'};
  sample.pages[1].total_metrics = {spend: '500'};
  const result = await paginate(plan, async request => ({code: 0, data: sample.pages[request.query.page - 1]}));
  assert.deepEqual(result.data.data.total_metrics, sample.pages[0].total_metrics);
});

test('a guided collection cannot become complete after reaching its page cap', async t => {
  const sample = tiktokPageFixtures()[0];
  sample.pages[0].page_info.total_page = 11;
  const f = fixture(t, sample);
  await assert.rejects(
    collectTikTokDailyReport(
      f.store,
      f.call,
      actor,
      {action: plan.action, account_id: '100', connection_id: connection, query},
      semantics,
      {allowPartial: true},
    ),
    {code: 'REPORT_COLLECTION_LIMIT'},
  );
  assert.equal(f.calls.length, 2);
});

test('page-count diagnostics and partial counts are authored in English and Arabic', () => {
  const catalog = JSON.parse(readFileSync('web/locales/ar.json', 'utf8'));
  const messages = inspectReportingFailures(
    readFileSync('src/tiktok-report-pagination.ts', 'utf8'),
    'src/tiktok-report-pagination.ts',
  );
  assert.ok(messages.has(rules.tiktokPageCountMessage));
  assert.match(catalog[rules.tiktokPageCountMessage], /[\u0600-\u06ff]/);
  const context = createContext({document: {addEventListener() {}}});
  new Script(readFileSync('web/localization.js', 'utf8')).runInContext(context);
  new Script(readFileSync('web/report-quality.js', 'utf8')).runInContext(context);
  context.catalog = catalog;
  new Script('uiLocale = "ar"; uiMessages = new Map(Object.entries(catalog));').runInContext(context);
  const shown = new Script('uiSourceWarning("TikTok declared 1,500 rows and returned 1,400.")').runInContext(context);
  assert.match(shown, /[\u0600-\u06ff]/);
  assert.match(shown, /1,500/);
  assert.match(shown, /1,400/);
});
