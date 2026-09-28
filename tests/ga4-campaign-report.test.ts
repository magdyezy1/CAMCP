import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Registry} from '../src/catalog.js';
import {MirrorService} from '../src/service.js';
import {NativeTransport} from '../src/transport.js';
import {ReportingOverview} from '../src/reporting-overview.js';
import {ReportWorker} from '../src/worker.js';
import type {Actor, JsonObject} from '../src/types.js';

const actor: Actor = {tenantId: 'ga4-report-test', userId: 'owner', role: 'admin'},
  key = Buffer.alloc(32, 44).toString('base64');
const source = {platform: 'ga4', account_id: '153293282', connection_id: 'ga4-connection'};
const range = {since: '2025-01-01', until: '2025-01-31'};
const config = {
  name: 'GA4 campaign sessions',
  sources: [source],
  date_range: range,
  metrics: ['sessions', 'conversions'],
  custom_metrics: [],
};
const row = (dims: string[], values: string[]) => ({
  dimensionValues: dims.map(value => ({value})),
  metricValues: values.map(value => ({value})),
});

/** rows are [sessionCampaignId, sessionCampaignName, sessions] combinations the property holds. */
function fixture(rows: [string, string, string][]) {
  const store = new Store(':memory:', key),
    bodies: JsonObject[] = [];
  store.putConnection(
    actor,
    {
      id: source.connection_id,
      tenantId: actor.tenantId,
      gateway: 'ga4_native_action',
      accounts: [source.account_id],
      enabled: true,
      label: 'Synthetic property',
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    },
    {accessToken: 'synthetic-test-token'},
  );
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(
      async (url, init) => {
        const u = new URL(String(url));
        if (!u.pathname.endsWith(':runReport'))
          return Response.json({name: 'properties/' + source.account_id, currencyCode: 'SAR', timeZone: 'Asia/Riyadh'});
        const body = JSON.parse(String(init?.body)) as JsonObject;
        bodies.push(body);
        const dims = (body.dimensions as JsonObject[]).map(d => String(d.name)),
          names = (body.metrics as JsonObject[]).map(m => String(m.name));
        // GA4 aggregates by exactly the dimensions requested, which is what this fixture reproduces.
        const grouped = new Map<string, {dims: string[]; sessions: number}>();
        for (const [id, name, sessions] of rows) {
          const keyDims = dims.map(d => (d === 'sessionCampaignId' ? id : name)),
            k = keyDims.join('||'),
            seen = grouped.get(k);
          if (seen) seen.sessions += Number(sessions);
          else grouped.set(k, {dims: keyDims, sessions: Number(sessions)});
        }
        const out = [...grouped.values()].map(g =>
          row(
            g.dims,
            names.map(n => (n === 'sessions' ? String(g.sessions) : '1')),
          ),
        );
        return Response.json({
          rows: out,
          rowCount: out.length,
          metricHeaders: names.map(name => ({name})),
          dimensionHeaders: dims.map(name => ({name})),
        });
      },
      async () => {},
    ),
  );
  const overview = new ReportingOverview(service, async () => {
    throw Error('Unexpected Google Sheets request');
  });
  const worker = new ReportWorker(
    store,
    async () => ({}),
    (t, k, i) => overview.work(t, k, i),
  );
  const run = async () => {
    const queued = (await overview.handle({action: 'run', config, confirmed: true}, actor)) as any;
    await worker.once();
    return overview.handle({action: 'get', id: queued.id}, actor) as any;
  };
  return {store, run, bodies};
}

test('one GA4 campaign ID reported under several campaign names resolves to a single row', async () => {
  // The exact shape that used to raise DUPLICATE_CAMPAIGN_ROWS: one utm_id, renamed mid-flight.
  const f = fixture([
    ['p994w', 'Sedra_Q3', '10'],
    ['p994w', 'sedra q3', '5'],
    ['ou7jh', 'Warefa', '7'],
  ]);
  try {
    const report = await f.run();
    assert.equal(report.state, 'complete', JSON.stringify(report));
    const rows = report.rows as JsonObject[];
    assert.equal(rows.length, 2);
    const sedra = rows.find(r => r.campaign_id === 'p994w')!;
    assert.equal(sedra.campaign_name, 'Sedra_Q3', 'the name with the most sessions wins');
    // Metrics must come from the ID-only report, never a client-side sum of the split rows.
    assert.equal((sedra.metrics as JsonObject).sessions, 15);
    assert.equal(
      f.bodies.filter(b => (b.dimensions as JsonObject[]).length === 1).length,
      1,
      'metrics are requested with sessionCampaignId alone',
    );
    assert.ok(
      (report.sources[0].warnings as string[]).some(w => /more than one campaign name/.test(w)),
      JSON.stringify(report.sources),
    );
  } finally {
    f.store.close();
  }
});

test('GA4 sessions with no utm_id collapse into one (not set) row and warn instead of failing', async () => {
  const f = fixture([
    ['(not set)', 'Sedra_Q3', '10'],
    ['(not set)', 'Warefa', '5'],
    ['(not set)', 'Al Danah', '3'],
  ]);
  try {
    const report = await f.run();
    // An unattributable bucket is reported, not fatal: the run completes as partial.
    assert.equal(report.state, 'partial', JSON.stringify(report));
    const rows = report.rows as JsonObject[];
    assert.equal(rows.length, 1);
    // The bucket must not borrow a real campaign name -- it is not one campaign.
    assert.equal(rows[0]!.campaign_id, '(not set)');
    assert.equal(rows[0]!.campaign_name, '(not set)');
    assert.equal((rows[0]!.metrics as JsonObject).sessions, 18);
    assert.ok(
      (report.sources[0].warnings as string[]).some(w => /utm_id/.test(w)),
      JSON.stringify(report.sources),
    );
  } finally {
    f.store.close();
  }
});
