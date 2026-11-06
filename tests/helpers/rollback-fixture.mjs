import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';
import {reportPlatforms} from '../../dist/src/report-metrics.js';

export const allReportPlatforms = [
  'google',
  'meta',
  'tiktok',
  'snapchat',
  'linkedin',
  'x',
  'microsoft',
  'reddit',
  'apple',
  'ga4',
  'gsc',
];
export const rollingWindow = {preset: 'last_complete_days', days: 7, timezone: 'UTC'};

/**
 * The real service, worker and ReportingOverview over an in-memory store with one login per platform (account 100).
 * Collection is replaced by supplied rows, so no provider request exists to make. The same pieces the stored-data
 * tests use: real `handle`, real `tick`, real worker.
 */
export function rollbackFixture(t, {platforms = allReportPlatforms, rows = {}} = {}) {
  const actor = {tenantId: 'synthetic-rollback', userId: 'owner', role: 'admin'};
  const store = new Store(':memory:', Buffer.alloc(32, 121).toString('base64'));
  t.after(() => store.close());
  for (const platform of platforms)
    store.putConnection(
      actor,
      {
        id: 'login-' + platform,
        tenantId: actor.tenantId,
        gateway: reportPlatforms[platform].gateway,
        accounts: ['100'],
        enabled: true,
        scopes: [],
        label: 'Synthetic ' + platform,
      },
      {accessToken: 'synthetic'},
    );
  const fetcher = async () => {
    throw new Error('Unexpected provider request in a stored-data fixture');
  };
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher, async () => {}));
  const overview = new ReportingOverview(service, fetcher);
  const collected = [];
  overview.native.collect = async (source, dates) => {
    collected.push(source.platform);
    return {
      source,
      rows: structuredClone(rows[source.platform] ?? []),
      currency: 'USD',
      timezone: 'UTC',
      complete: true,
      collection_complete: true,
      source_kind: reportPlatforms[source.platform].kind,
      date_range: dates,
      warnings: [],
      lineage: [],
      captured_at: Date.now(),
      result_definition: 'Synthetic results',
      attribution: 'Synthetic click window',
    };
  };
  overview.native.verifyAccount = async () => undefined;
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (tenant, kind, input) => overview.work(tenant, kind, input),
  );
  return {
    store,
    actor,
    service,
    overview,
    worker,
    collected,
    /** A source of the account every login holds. */
    source: (platform, extra = {}) => ({
      platform,
      account_id: '100',
      connection_id: 'login-' + platform,
      ...extra,
    }),
    /** A definition body; callers add `contract_version` and levels as the client under test would. */
    body: (sources, extra = {}) => ({
      name: 'Synthetic stored report',
      sources,
      date_range: {since: '2026-09-01', until: '2026-09-02'},
      metrics: ['spend', 'impressions', 'clicks', 'conversions'],
      ...extra,
    }),
    document: (kind, id) => store.document(actor.tenantId, kind, id),
    documents: kind => store.documents(actor.tenantId, kind),
    handle: input => overview.handle(input, actor),
    drain: async (turns = 6) => {
      for (let i = 0; i < turns; i++) await worker.once();
    },
  };
}
