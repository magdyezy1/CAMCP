import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {fingerprint} from '../dist/src/report-quality.js';

const actor = {tenantId: 'li-overview-evidence', userId: 'owner', role: 'admin'};
const source = {
  platform: 'linkedin',
  account_id: '100',
  connection_id: 'aaaaaaaa-1111-4111-8111-111111111111',
  objective: 'sales',
};
const dates = {since: '2026-09-01', until: '2026-09-02'};
const nativeDate = date => {
  const [year, month, day] = date.split('-').map(Number);
  return {year, month, day};
};
const row = (extra = {}) => ({
  pivotValues: ['urn:li:sponsoredCampaign:9007199254740993'],
  dateRange: {start: nativeDate(dates.since), end: nativeDate(dates.until)},
  costInLocalCurrency: '100.123456789',
  impressions: 1000,
  clicks: 100,
  externalWebsiteConversions: 20,
  ...extra,
});
function fixture(response = {elements: [row()]}, account = {id: 100, currency: 'USD', name: 'Synthetic'}) {
  const store = new Store(':memory:', Buffer.alloc(32, 74).toString('base64')),
    calls = [];
  const connection = {
    id: source.connection_id,
    tenantId: actor.tenantId,
    gateway: 'linkedin_native_action',
    accounts: ['100'],
    enabled: true,
    scopes: ['r_ads', 'r_ads_reporting'],
    label: 'Synthetic',
  };
  store.putConnection(actor, connection, {accessToken: 'synthetic'});
  let afterRead = () => {};
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (raw, init) => {
      const url = new URL(raw);
      calls.push(url);
      assert.equal(init.method, 'GET');
      assert.ok(['/rest/adAccounts/100', '/rest/adAnalytics'].includes(url.pathname));
      const out =
        url.pathname === '/rest/adAccounts/100' ? account : typeof response === 'function' ? response(url) : response;
      afterRead(url.pathname);
      return Response.json(out);
    }),
  );
  const native = new NativeCampaignReports(service),
    overview = new ReportingOverview(service);
  const config = {
    name: 'LinkedIn report',
    sources: [source],
    date_range: dates,
    metrics: ['spend', 'conversions', 'cpa'],
    targets: {sales: {target: 10, currency: 'USD', minimum_results: 10}},
  };
  return {
    store,
    calls,
    connection,
    overview,
    config,
    collect: () => native.collect(source, dates, actor),
    afterRead: fn => {
      afterRead = fn;
    },
  };
}
test('LinkedIn Overview refuses ambiguous empty, partial, duplicate and mismatched-period evidence', async () => {
  for (const response of [
    {},
    {elements: []},
    {elements: [row()], paging: {links: [{rel: 'next', href: '/ignored'}]}},
    {elements: [row()], metadata: {nextPageToken: 'more'}},
    {elements: [row(), row()]},
    {elements: [row({dateRange: {start: nativeDate('2026-08-01'), end: nativeDate('2026-08-31')}})]},
    {elements: [row({pivotValues: ['urn:li:sponsoredCreative:11']})]},
    {elements: Array.from({length: 15000}, () => row())},
  ]) {
    const f = fixture(response);
    try {
      await assert.rejects(
        f.collect(),
        e =>
          [
            'REPORT_SHAPE_CHANGED',
            'REPORT_EMPTY_AMBIGUOUS',
            'REPORT_INCOMPLETE',
            'REPORT_DUPLICATE_ROWS',
            'REPORT_DATE_MISMATCH',
          ].includes(e.code),
        JSON.stringify(response).slice(0, 160),
      );
    } finally {
      f.store.close();
    }
  }
});
test('LinkedIn Overview checks native account ID and currency before analytics and current access before returning', async () => {
  for (const account of [{id: 999, currency: 'USD'}, {currency: 'USD'}, {id: 100}, {id: 100, currency: 'usd'}]) {
    const f = fixture(undefined, account);
    try {
      await assert.rejects(f.collect());
      assert.equal(f.calls.length, 1);
    } finally {
      f.store.close();
    }
  }
  const f = fixture();
  try {
    f.afterRead(path => {
      if (path === '/rest/adAnalytics')
        f.store.putConnection(actor, {...f.connection, enabled: false}, {accessToken: 'synthetic'});
    });
    await assert.rejects(f.collect());
  } finally {
    f.store.close();
  }
});
test('LinkedIn Overview retains native period evidence and unknown attribution instead of authorizing a scale recommendation', async () => {
  const f = fixture();
  try {
    const run = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, actor);
    await f.overview.work(actor.tenantId, 'report_overview', {report_id: run.id});
    const report = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(report.state, 'complete');
    assert.equal(report.rows[0].campaign_id, '9007199254740993');
    assert.equal(report.rows[0].native.costInLocalCurrency, '100.123456789');
    assert.equal(report.rows[0].attribution, 'unknown');
    assert.equal(report.rows[0].recommendation.decision, 'needs_review');
    assert.equal(report.rows[0].timezone, 'UTC');
    assert.equal(report.sources[0].contract_version, 'campaign-source-v4');
    assert.equal(report.sources[0].lineage.length, 2);
    assert.match(report.sources[0].warnings.join(' '), /attribution.*not.*verified/i);
  } finally {
    f.store.close();
  }
});
test('LinkedIn empty calendar periods remain explicit incomplete coverage and block complete-only exports', async () => {
  const f = fixture(url =>
    url.searchParams.get('dateRange').includes('start:(year:2026,month:9,day:1)')
      ? {elements: [row({dateRange: {start: nativeDate(dates.since), end: nativeDate(dates.since)}})]}
      : {elements: []},
  );
  try {
    const run = await f.overview.handle(
      {action: 'run', config: {...f.config, grain: 'daily', partial_delivery: 'complete_only'}, confirmed: true},
      actor,
    );
    await f.overview.work(actor.tenantId, 'report_overview', {report_id: run.id});
    const report = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(report.state, 'partial');
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0].complete, false);
    assert.equal(report.sources[0].period_errors[0].error.code, 'REPORT_EMPTY_AMBIGUOUS');
    const destination = await f.overview.handle(
      {
        action: 'bind_file_destination',
        confirmed: true,
        idempotency_key: 'li-partial-evidence',
        file_destination: {name: 'Synthetic files', formats: ['pdf']},
      },
      actor,
    );
    await assert.rejects(
      f.overview.handle({action: 'export', report_id: run.id, destination_id: destination.id, confirmed: true}, actor),
      e => e.code === 'PARTIAL_DELIVERY_BLOCKED',
    );
  } finally {
    f.store.close();
  }
});
test('older LinkedIn checkpoints require a new snapshot and preserve retained evidence without re-reading', async () => {
  for (const kind of ['source', 'periods']) {
    const f = fixture();
    try {
      const run = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, actor);
      const original = f.store.document(actor.tenantId, 'overview_report', run.id);
      const prior = {...(await f.collect()), contract_version: 'campaign-source-v2'};
      f.calls.length = 0;
      const config = {...original.config, source_contract_version: 'campaign-source-v2'};
      const checkpoints =
        kind === 'source' ? {'0': {result: {...prior, source}}} : {'0': {periods: {'0': {result: prior}}}};
      f.store.putDocument(actor.tenantId, 'overview_report', run.id, {
        ...original,
        config,
        checkpoints,
        collection_budget: {
          version: 1,
          definition: fingerprint(config),
          requests: 2,
          rows: 1,
          bytes: 100,
          elapsed_ms: 100,
          row_counts: {'0': 1},
        },
      });
      await assert.rejects(
        f.overview.work(actor.tenantId, 'report_overview', {report_id: run.id}),
        e => e.code === 'REPORT_RESTART_REQUIRED',
      );
      const saved = f.store.document(actor.tenantId, 'overview_report', run.id);
      assert.deepEqual(saved.checkpoints, checkpoints);
      assert.equal(saved.state, 'failed');
      assert.equal(f.calls.length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('an older queued LinkedIn snapshot with no previous reads adopts the current evidence contract before collection', async () => {
  const f = fixture();
  try {
    const run = await f.overview.handle({action: 'run', config: f.config, confirmed: true}, actor);
    const original = f.store.document(actor.tenantId, 'overview_report', run.id);
    f.store.putDocument(actor.tenantId, 'overview_report', run.id, {
      ...original,
      config: {...original.config, source_contract_version: 'campaign-source-v2'},
    });
    await f.overview.work(actor.tenantId, 'report_overview', {report_id: run.id});
    const report = await f.overview.handle({action: 'get', id: run.id}, actor);
    assert.equal(report.state, 'complete');
    assert.equal(report.config.source_contract_version, 'campaign-source-v4');
    assert.equal(report.sources[0].contract_version, report.config.source_contract_version);
    assert.equal(f.calls.length, 2);
  } finally {
    f.store.close();
  }
});
