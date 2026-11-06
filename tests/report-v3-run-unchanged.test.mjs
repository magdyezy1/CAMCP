import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {ReportingOverview} from '../dist/src/reporting-overview.js';
import {ReportWorker} from '../dist/src/worker.js';
import {overviewGranularityFixture, granularConfig, granularSource} from './fixtures/overview-granularity-data.mjs';

// V2-RPT-06: "v3 definitions and schedules run unchanged". A stored v3 definition is upgraded in memory to run, so what
// it produces must equal what the same v3 configuration produced before the upgrade existed: the legacy path, which an
// ad hoc v3 run still takes and which is Work-here's behaviour. TikTok and Snapchat campaign sources used to become
// partial because the upgrade left the window undeclared (F-L6-02).
const declaredIncompleteWarning = /not declared complete/;

function tiktokFixture(t) {
  const actor = {tenantId: 'synthetic-v3-run', userId: 'owner', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, 107).toString('base64')),
    source = {platform: 'tiktok', account_id: '100', connection_id: 'ffffffff-1111-4111-8111-111111111114'};
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'tiktok_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic TikTok',
      scopes: [],
    },
    {accessToken: 'synthetic'},
  );
  const service = new MirrorService(
      new Registry(),
      store,
      new NativeTransport(
        async raw => {
          const url = new URL(raw);
          if (url.pathname.endsWith('/advertiser/info/'))
            return Response.json({
              code: 0,
              data: {list: [{advertiser_id: '100', name: 'Synthetic', currency: 'USD', timezone: 'Etc/GMT'}]},
            });
          if (url.pathname.endsWith('/report/integrated/get/')) {
            // One row of whatever grain and metrics were asked for: the campaign, and the ad group a v4 read adds.
            const dimensions = JSON.parse(url.searchParams.get('dimensions') ?? '[]'),
              metrics = JSON.parse(url.searchParams.get('metrics') ?? '[]');
            return Response.json({
              code: 0,
              data: {
                list: [
                  {
                    dimensions: Object.fromEntries(dimensions.map(name => [name, name === 'adgroup_id' ? '11' : '1'])),
                    metrics: Object.fromEntries(
                      metrics.map(name => [name, name.endsWith('_name') ? 'Synthetic campaign' : '1']),
                    ),
                  },
                ],
                page_info: {page: 1, page_size: 1000, total_number: 1, total_page: 1},
              },
            });
          }
          if (url.pathname.endsWith('/campaign/get/'))
            return Response.json({code: 0, data: {list: [{campaign_id: '1', objective_type: 'TRAFFIC'}]}});
          if (url.pathname.endsWith('/adgroup/get/'))
            return Response.json({
              code: 0,
              data: {list: [{adgroup_id: '11', campaign_id: '1', optimization_goal: 'CLICK'}]},
            });
          throw Error('Unexpected route ' + url.pathname);
        },
        async () => {},
      ),
    ),
    overview = new ReportingOverview(service),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, key, input) => overview.work(tenant, key, input),
    );
  const config = {
    name: 'Synthetic stored TikTok report',
    sources: [source],
    date_range: {since: '2026-09-01', until: '2026-09-02'},
    metrics: ['spend', 'clicks'],
    custom_metrics: [],
    partial_delivery: 'complete_only',
  };
  const finish = async queued => {
    await worker.once();
    return overview.handle({action: 'get', id: queued.id}, actor);
  };
  return {actor, store, overview, config, finish};
}
const outcome = report => ({
  state: report.state,
  source_complete: report.sources.map(source => source.complete),
  collection_complete: report.sources.map(source => source.collection_complete),
  rows: report.rows.length,
  row_complete: report.rows.map(entry => entry.complete),
  decisions: report.rows.map(entry => entry.recommendation?.decision),
  held: report.sources.flatMap(source => source.warnings ?? []).filter(text => declaredIncompleteWarning.test(text)),
});

test('a stored v3 TikTok campaign report completes as it did before, and complete-only delivery still applies to it', async t => {
  const f = tiktokFixture(t);
  f.store.putDocument(f.actor.tenantId, 'overview_view', 'stored-tiktok', {config: f.config, created_at: 1});
  const legacy = await f.finish(await f.overview.handle({action: 'run', config: f.config, confirmed: true}, f.actor)),
    stored = await f.finish(await f.overview.handle({action: 'run', id: 'stored-tiktok', confirmed: true}, f.actor));
  assert.equal(legacy.state, 'complete', JSON.stringify(legacy.sources));
  assert.equal(stored.config.contract_version, 'overview-config-v4', 'the stored definition ran through the upgrade');
  assert.deepEqual(outcome(stored), outcome(legacy));
  assert.deepEqual(outcome(stored).held, []);
  assert.equal(stored.rows.length, 1);
  // With rows, a partial snapshot would be skipped by complete-only delivery; a complete one is not.
  assert.equal(stored.rows[0].complete, true);
});

test('a stored v3 Snapchat campaign report completes as it did before, with and without an attribution profile', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  const windows = {swipe_up_attribution_window: '28_DAY', view_attribution_window: '1_DAY'};
  for (const [label, options] of [
    ['no profile', undefined],
    ['profile', windows],
  ]) {
    const source = {...granularSource('snapchat', 'campaign'), report_options: options};
    if (options === undefined) delete source.report_options;
    const config = {...granularConfig(source), partial_delivery: 'complete_only'},
      id = 'stored-snapchat-' + label.replace(' ', '-');
    f.store.putDocument(f.actor.tenantId, 'overview_view', id, {config, created_at: 1});
    const finish = async queued => {
      for (let i = 0; i < 8; i++) await f.worker.once();
      return f.overview.handle({action: 'get', id: queued.id}, f.actor);
    };
    const legacy = await finish(await f.overview.handle({action: 'run', config, confirmed: true}, f.actor)),
      stored = await finish(await f.overview.handle({action: 'run', id, confirmed: true}, f.actor));
    assert.equal(legacy.state, 'complete', label + ': ' + JSON.stringify(legacy.sources));
    assert.equal(stored.config.contract_version, 'overview-config-v4', label);
    assert.deepEqual(outcome(stored), outcome(legacy), label);
    assert.deepEqual(outcome(stored).held, [], label);
  }
});

test('a detail-level TikTok or Snapchat source without a declaration is still held partial', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  for (const platform of ['tiktok', 'snapchat']) {
    const source = {...granularSource(platform, 'ad'), report_options: undefined, levels: ['ad']};
    delete source.report_options;
    delete source.level;
    const queued = await f.overview.handle(
      {action: 'run', confirmed: true, config: {...granularConfig(source), contract_version: 'overview-config-v4'}},
      f.actor,
    );
    for (let i = 0; i < 8; i++) await f.worker.once();
    const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
    assert.equal(report.state, 'partial', platform + ': ' + JSON.stringify(report.sources));
    assert.ok(outcome(report).held.length > 0, platform + ': the source says its window was not declared complete');
  }
});
