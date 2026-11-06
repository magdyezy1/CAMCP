import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {reportPlatforms} from '../../dist/src/report-metrics.js';

// Exercise the real definitions, worker and row assembly with supplied, already-collected native rows.
// No provider transport is used. Collector request shapes are tested separately.
// `rowsFor(source)` supplies the rows of one collected source (account and level) instead of `rows`, and `accounts`
// are the accounts the one login may read.
export function objectiveReportFixture(t, {platform = 'meta', rows = [], rowsFor, accounts = ['100']} = {}) {
  const actor = {tenantId: 'synthetic-objective-report', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 121).toString('base64'));
  t.after(() => store.close());
  const gateway = reportPlatforms[platform].gateway;
  store.putConnection(
    actor,
    {id: 'login', tenantId: actor.tenantId, gateway, accounts, enabled: true, scopes: [], label: 'Synthetic'},
    {accessToken: 'synthetic'},
  );
  const fetcher = async () => {
    throw new Error('Unexpected provider request in objective assembly fixture');
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {}));
  const overview = new ReportingOverview(service, fetcher);
  overview.native.collect = async (source, dates) => ({
    source,
    rows: structuredClone(rowsFor ? rowsFor(source) : rows),
    currency: 'USD',
    timezone: 'UTC',
    complete: true,
    collection_complete: true,
    source_kind: reportPlatforms[platform].kind,
    date_range: dates,
    warnings: [],
    lineage: [],
    captured_at: Date.now(),
    result_definition: 'Synthetic results',
    attribution: 'Synthetic click window',
  });
  overview.native.verifyAccount = async () => undefined;
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (tenant, kind, input) => overview.work(tenant, kind, input),
  );
  const config = {
    name: 'Synthetic objective report',
    sources: [{platform, account_id: '100', connection_id: 'login'}],
    date_range: {since: '2026-09-01', until: '2026-09-02'},
    metrics: ['spend', 'impressions', 'clicks', 'conversions'],
  };
  const finish = async run => {
    await worker.once();
    return overview.handle({action: 'get', id: run.id}, actor);
  };
  return {
    store,
    actor,
    service,
    overview,
    worker,
    config,
    finish,
    run: async (changes = {}) =>
      finish(await overview.handle({action: 'run', config: {...config, ...changes}, confirmed: true}, actor)),
  };
}
