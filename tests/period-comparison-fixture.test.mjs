// closing-fixes item 2. The period comparison fixture (the synthetic Meta account the rendered browser run reads) answered
// every request that was not an insights read with the account object. When the v4 report source began to read each
// campaign's current status from the account's campaigns edge (1c8e0922), that answer had no `data` list, the read refused
// ("Native entity metadata is malformed."), both snapshots failed and the comparison never appeared: 16 of 16 browser cases.
// These tests keep the fixture honest on its own, without a browser: it answers like Meta's API for the routes the report
// source reads, and refuses every other request, as its header says.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  periodComparisonFixture,
  comparisonConnection,
  comparisonWindow,
  comparisonBaselineWindow,
} from './fixtures/period-comparison-data.mjs';

const graph = 'https://graph.facebook.com/v26.0';
/** The run the website's run bar queues for the case: one Meta account at campaign level (v4), with the previous window. */
async function websiteRun(f) {
  const meta = (await f.overview.handle({action: 'bootstrap'}, f.actor)).platforms.find(p => p.id === 'meta'),
    caps = meta.reporting_v4;
  return f.overview.handle(
    {
      action: 'run',
      compare: 'previous_period',
      confirmed: true,
      config: {
        contract_version: 'overview-config-v4',
        partial_delivery: 'allow_marked',
        name: 'Weekly comparison',
        client_name: '',
        grain: 'total',
        source_defaults: {},
        sources: [
          {
            platform: 'meta',
            connection_id: comparisonConnection,
            account_id: '100',
            objective: 'sales',
            native_metrics: [],
            level: 'campaign',
            levels: ['campaign'],
            statuses: ['all'],
            delivered_only: true,
            report_options: {...caps.defaults},
          },
        ],
        date_range: comparisonWindow,
        metrics: ['spend', 'impressions', 'clicks', 'conversions', 'cpa', 'roas', 'reach'],
        custom_metrics: [],
        targets: {},
        objectives: [],
      },
    },
    f.actor,
  );
}
const stored = (f, id) => f.store.document(f.actor.tenantId, 'overview_report', id);

test('a v4 run of the case collects both windows: every route the report source reads is answered the way Meta answers it', async t => {
  const f = periodComparisonFixture();
  t.after(() => f.close());
  await f.reset();
  const queued = await websiteRun(f);
  assert.deepEqual(queued.comparison.baseline_date_range, comparisonBaselineWindow);
  assert.equal(await f.drain(), 2, 'the run and its previous equal window');
  for (const id of [queued.id, queued.comparison.baseline_id]) {
    const report = stored(f, id);
    assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(source => source.error?.code)));
    assert.ok(report.rows.length >= 2, 'campaign rows were collected');
    // Every campaign row carries the current status the account's campaigns edge listed for it (103 is paused now).
    for (const row of report.rows)
      assert.equal(row.status, {101: 'active', 102: 'active', 103: 'paused'}[row.campaign_id], row.campaign_id);
  }
  // Reads of the account, its campaigns and their insights, and nothing else.
  assert.deepEqual(
    [...new Set(f.requests.map(request => request.method + ' ' + request.path.replace(/^\/v\d+\.\d+/, '')))].sort(),
    ['GET /act_100', 'GET /act_100/campaigns', 'GET /act_100/insights'],
  );
  assert.equal(f.writes(), 0);
});

test('the fixture lists the account campaigns in Meta’s shape, answers the account only on its own path, and refuses the rest', async t => {
  const f = periodComparisonFixture();
  t.after(() => f.close());
  const account = await (await f.fetcher(graph + '/act_100')).json();
  assert.deepEqual(Object.keys(account).sort(), ['account_id', 'currency', 'id', 'name', 'timezone_name']);
  assert.equal(account.id, 'act_100');
  const edge = await (await f.fetcher(graph + '/act_100/campaigns?limit=500')).json();
  assert.ok(Array.isArray(edge.data) && edge.data.length >= 3, 'a list, as the edge answers');
  assert.equal(edge.account_id, undefined, 'the edge is a list, not the account object');
  for (const campaign of edge.data) {
    assert.match(campaign.id, /^[1-9][0-9]{0,31}$/, 'Meta campaign IDs are numeric text');
    assert.equal(campaign.account_id, '100');
    for (const field of ['status', 'configured_status', 'effective_status'])
      assert.match(campaign[field], /^[A-Z_]+$/, field);
  }
  // Every other path is refused, whatever the method, and so is every other provider: the header's promise.
  for (const path of [
    '/act_100/ads',
    '/act_100/adsets',
    '/act_200',
    '/act_100/campaigns/101',
    '/me',
    '/act_100/insights/x',
  ])
    await assert.rejects(f.fetcher(graph + path), /answers only/, path);
  await assert.rejects(f.fetcher('https://adsapi.snapchat.com/v1/me'), /refuses mutations and other providers/);
  assert.equal(f.writes(), 1, 'the request to another provider is counted with the writes');
  await assert.rejects(
    f.fetcher(graph + '/act_100/campaigns', {method: 'POST'}),
    /refuses mutations and other providers/,
  );
  assert.equal(f.writes(), 2);
});
