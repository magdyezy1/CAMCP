// RPT-07: the Overview period comparison as the rendered browser qualification runs it. One synthetic Meta account
// answers read-only insights per window; every other request and every mutation is refused. No external account is
// used or mutated.
import assert from 'node:assert/strict';
import {Store} from '../../dist/src/store.js';
import {Registry} from '../../dist/src/catalog.js';
import {MirrorService} from '../../dist/src/service.js';
import {NativeTransport} from '../../dist/src/transport.js';
import {ReportingOverview} from '../../dist/src/reporting-overview.js';
import {ReportWorker} from '../../dist/src/worker.js';

export const comparisonConnection = 'aaaaaaaa-7777-4777-8777-000000000007';
/** The window the browser case pulls, and the previous equal window AMCP pairs with it. */
export const comparisonWindow = {since: '2026-08-08', until: '2026-08-14'},
  comparisonBaselineWindow = {since: '2026-08-01', until: '2026-08-07'};
/** Snapshots the case finds already retained: one overlaps the window, one is a day shorter (both refused). */
export const comparisonRefusedWindows = {
  overlap: {since: '2026-08-05', until: '2026-08-11'},
  shorter: {since: '2026-08-02', until: '2026-08-07'},
};
/** Native campaigns per window: c1 grows, c2 spent nothing before, c3 delivered only in the earlier window. */
export const comparisonValues = {
  '2026-08-08': {
    c1: {
      name: 'Spring <sale> العربية',
      spend: '170.3',
      impressions: '1100',
      clicks: '40',
      purchases: '6',
      value: '612',
    },
    c2: {name: 'Second campaign', spend: '12.5', impressions: '250', clicks: '5', purchases: '1', value: '30'},
  },
  '2026-08-01': {
    c1: {
      name: 'Spring <sale> العربية',
      spend: '100.1',
      impressions: '1000',
      clicks: '50',
      purchases: '5',
      value: '500',
    },
    c2: {name: 'Second campaign', spend: '0', impressions: '0', clicks: '0', purchases: '0', value: '0'},
    c3: {name: 'Paused before', spend: '9', impressions: '90', clicks: '9', purchases: '1', value: '20'},
  },
};
const fallback = {
  c1: {name: 'Spring <sale> العربية', spend: '1', impressions: '10', clicks: '1', purchases: '1', value: '2'},
};

export function periodComparisonFixture() {
  const keyByte = 191,
    actor = {tenantId: 'synthetic-period-comparison', userId: 'fixture', role: 'admin'},
    store = new Store(':memory:', Buffer.alloc(32, keyByte).toString('base64')),
    requests = [];
  let writes = 0;
  const fetcher = async (raw, init = {}) => {
    const url = new URL(String(raw)),
      method = String(init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || url.origin !== 'https://graph.facebook.com') {
      writes++;
      throw Error('The period comparison fixture refuses mutations and other providers');
    }
    requests.push({method, path: url.pathname});
    if (!url.pathname.endsWith('/insights'))
      return Response.json({
        id: 'act_100',
        account_id: '100',
        name: 'Synthetic Meta',
        currency: 'USD',
        timezone_name: 'UTC',
      });
    assert.equal(url.searchParams.get('level'), 'campaign');
    const range = JSON.parse(url.searchParams.get('time_range')),
      window = comparisonValues[range.since] ?? fallback;
    return Response.json({
      data: Object.entries(window).map(([id, v]) => ({
        account_id: '100',
        account_currency: 'USD',
        campaign_id: id,
        campaign_name: v.name,
        objective: 'OUTCOME_SALES',
        date_start: range.since,
        date_stop: range.until,
        spend: v.spend,
        impressions: v.impressions,
        clicks: v.clicks,
        reach: v.impressions === '0' ? '0' : '700',
        frequency: v.impressions === '0' ? '0' : '1.5',
        actions: [{action_type: 'purchase', value: v.purchases}],
        action_values: [{action_type: 'purchase', value: v.value}],
      })),
    });
  };
  store.putConnection(
    actor,
    {
      id: comparisonConnection,
      tenantId: actor.tenantId,
      gateway: 'meta_native_action',
      accounts: ['100'],
      enabled: true,
      label: 'Synthetic Meta',
      scopes: ['ads_read'],
    },
    {accessToken: 'synthetic-period-comparison'},
  );
  store.putDocument(actor.tenantId, 'website_assets', comparisonConnection, {
    groups: [{kind: 'ad_accounts', assets: [{id: '100', name: 'Synthetic meta account'}]}],
  });
  const service = new MirrorService(new Registry(), store, new NativeTransport(fetcher), undefined, undefined, fetcher),
    overview = new ReportingOverview(service, fetcher),
    worker = new ReportWorker(
      store,
      async () => ({}),
      (tenant, kind, input) => overview.work(tenant, kind, input),
    );
  // The settings the browser case chooses: one Meta account at campaign level with the provider's attribution.
  const config = (range, name) => ({
    name,
    sources: [{platform: 'meta', connection_id: comparisonConnection, account_id: '100', objective: 'sales'}],
    date_range: range,
    metrics: ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas', 'reach'],
    custom_metrics: [],
    targets: {},
    objectives: [],
  });
  /** Runs every queued job, as the worker process would. */
  const drain = async () => {
    let ran = 0;
    store.db.prepare('UPDATE jobs SET available_at=0').run();
    while (await worker.once()) ran++;
    return ran;
  };
  return {
    keyByte,
    actor,
    store,
    service,
    overview,
    requests,
    writes: () => writes,
    /**
     * Each case starts from the same retained snapshots: earlier cases' runs are removed, and the overlapping and the
     * shorter snapshot are collected again.
     */
    async reset() {
      store.db.prepare("DELETE FROM documents WHERE tenant_id=? AND kind='overview_report'").run(actor.tenantId);
      store.db.prepare('DELETE FROM jobs WHERE tenant_id=?').run(actor.tenantId);
      const ids = {};
      for (const [key, range] of Object.entries(comparisonRefusedWindows)) {
        const run = await overview.handle(
          {action: 'run', config: config(range, 'Retained ' + key + ' window'), confirmed: true},
          actor,
        );
        ids[key] = run.id;
      }
      assert.equal(await drain(), 2);
      for (const id of Object.values(ids))
        assert.equal(store.document(actor.tenantId, 'overview_report', id).state, 'complete');
      return ids;
    },
    drain,
    close: () => store.close(),
  };
}
