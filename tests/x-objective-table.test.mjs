import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveObjective} from '../dist/src/report-objectives.js';
import {normalizeNativeRowV4} from '../dist/src/report-native.js';
import {xReportSource} from '../dist/src/x-report-source.js';
import {xObjectivesMixedWarning} from '../dist/src/x-campaign-report.js';
import {overviewGranularityFixture, granularSource, granularConfig} from './fixtures/overview-granularity-data.mjs';

// docs.x.com/x-ads-api/campaign-management, section "Objective Based Campaigns" (read 2026-11-06): objectives are set on
// line items, and the section lists exactly these eight values. X campaigns carry no objective of their own.
const documented = {
  APP_ENGAGEMENTS: 'engagement',
  APP_INSTALLS: 'app_installs',
  FOLLOWERS: 'engagement',
  ENGAGEMENTS: 'engagement',
  REACH: 'awareness',
  VIDEO_VIEWS: 'video_views',
  PREROLL_VIEWS: 'video_views',
  WEBSITE_CLICKS: 'traffic',
};
const resolve = (native, inputs = {}) =>
  resolveObjective({platform: 'x', table: xReportSource.objectives, native, mappedInputs: inputs});

for (const [native, group] of Object.entries(documented))
  test('the X line item objective ' + native + ' is pinned from the provider as ' + group, () => {
    const resolved = resolve(native);
    assert.equal(resolved.source, 'provider');
    assert.equal(resolved.group, group);
    assert.equal(resolved.native, native);
    assert.equal(resolved.reason, null);
  });

test('an objective the X documentation does not list is inferred or unknown, never labelled as from the provider', () => {
  // WEBSITE_CONVERSIONS is seen in AMCP's code, but the objective section does not list it (the page names it only as an
  // example under target bidding), so it keeps the shared inference.
  const conversions = resolve('WEBSITE_CONVERSIONS');
  assert.equal(conversions.source, 'provider_inferred');
  assert.equal(conversions.group, 'sales');
  const unlisted = resolve('SOMETHING_NEW');
  assert.equal(unlisted.source, 'unknown');
  assert.equal(unlisted.group, 'unknown');
  assert.equal(
    unlisted.reason,
    'X returned the objective SOMETHING_NEW, which AMCP does not group yet; choose one in the report.',
  );
});

test('the pinned X table lists the documented values and the synthetic mixed value, and nothing else', () => {
  assert.deepEqual(Object.keys(xReportSource.objectives.values).sort(), [...Object.keys(documented), 'MIXED'].sort());
});

function collection({lineItems, campaigns = [{id: 'one', name: 'Synthetic', entity_status: 'ACTIVE'}]}) {
  return {
    source: {reporting_contract: 'overview-config-v4'},
    account: 'synthetic',
    range: {since: '2026-09-01', until: '2026-09-01'},
    timezone: 'UTC',
    extra: [],
    checkpoint: {x_active_fallback: true},
    warnings: [],
    context: {},
    save() {},
    plan: (path, query = {}) => ({path, query, accountId: 'synthetic'}),
    async run(plan) {
      if (plan.path.endsWith('/campaigns')) return {data: campaigns};
      if (plan.path.endsWith('/line_items')) return {data: lineItems};
      return {
        data: campaigns.map(campaign => ({
          id: campaign.id,
          id_data: [{segment: null, metrics: {impressions: Array(24).fill('1'), clicks: Array(24).fill('1')}}],
        })),
      };
    },
  };
}
const line = (id, objective) => ({id, campaign_id: 'one', objective});

test('a campaign whose line items differ is the shared mixed group, with a reason naming their objectives', async () => {
  const c = collection({lineItems: [line('a', 'WEBSITE_CLICKS'), line('b', 'REACH'), line('c', 'WEBSITE_CLICKS')]});
  await xReportSource.collect(c);
  assert.equal(c.raw[0].objective, 'MIXED');
  assert.deepEqual(c.raw[0].line_item_objectives, ['REACH', 'WEBSITE_CLICKS']);
  assert.ok(c.warnings.includes(xObjectivesMixedWarning));
  const resolved = resolve(c.raw[0].objective, c.raw[0]);
  assert.deepEqual(
    {group: resolved.group, source: resolved.source, reason: resolved.reason},
    {
      group: 'mixed',
      source: 'provider',
      reason: 'This campaign’s line items have different objectives: REACH, WEBSITE_CLICKS.',
    },
  );
  const row = normalizeNativeRowV4('x', c.raw[0]);
  assert.equal(row.objective, 'MIXED');
  assert.equal(row.objective_group, 'mixed');
  const result = xReportSource.readResult(c.raw[0], {
    objective: row.objective,
    level: 'campaign',
    range: {since: '2026-09-01', until: '2026-09-01'},
  });
  assert.equal(result.result.value, null, 'results of different objectives are never combined');
});

test('a campaign whose line items agree takes their objective, and one without line items stays unknown', async () => {
  const c = collection({
    campaigns: [
      {id: 'one', name: 'One'},
      {id: 'two', name: 'Two'},
    ],
    lineItems: [line('a', 'REACH'), line('b', 'REACH')],
  });
  await xReportSource.collect(c);
  const byId = Object.fromEntries(c.raw.map(row => [row.id, row]));
  assert.equal(byId.one.objective, 'REACH');
  assert.equal(byId.one.line_item_objectives, undefined);
  assert.equal(byId.two.objective, undefined, 'no line items, no objective');
  assert.equal(c.warnings.includes(xObjectivesMixedWarning), false);
});

test('a checkpoint written before the mixed list existed still resolves differing line items as mixed', async () => {
  const c = collection({lineItems: []});
  c.checkpoint = {
    x_active_fallback: true,
    x_inventory: [{id: 'one', name: 'Synthetic'}],
    x_objectives: {campaigns: {one: null}},
  };
  await xReportSource.collect(c);
  assert.equal(c.raw[0].objective, 'MIXED');
  assert.deepEqual(c.raw[0].line_item_objectives, []);
  assert.equal(resolve('MIXED', c.raw[0]).reason, 'This campaign’s line items have different objectives.');
});

test('the full report shows a campaign whose line items differ as the mixed group from the provider', async t => {
  const f = overviewGranularityFixture();
  t.after(() => f.close());
  f.hook(url => {
    if (url.hostname === 'ads-api.x.com' && url.pathname.endsWith('/line_items'))
      return Response.json({
        data: [
          {id: 'l1', campaign_id: 'c1', name: 'One', objective: 'WEBSITE_CLICKS', entity_status: 'ACTIVE'},
          {id: 'l2', campaign_id: 'c1', name: 'Two', objective: 'REACH', entity_status: 'ACTIVE'},
        ],
        next_cursor: null,
      });
  });
  const source = {...granularSource('x', 'campaign'), levels: ['campaign'], delivered_only: false},
    queued = await f.overview.handle(
      {
        action: 'run',
        config: {...granularConfig(source), contract_version: 'overview-config-v4'},
        confirmed: true,
      },
      f.actor,
    );
  assert.equal(await f.worker.once(), true);
  const report = await f.overview.handle({action: 'get', id: queued.id}, f.actor);
  assert.equal(report.state, 'complete', JSON.stringify(report.sources));
  const row = report.rows.find(candidate => candidate.entity_id === 'c1');
  assert.deepEqual(row.objective, {
    native: 'MIXED',
    group: 'mixed',
    source: 'provider',
    reason: 'This campaign’s line items have different objectives: REACH, WEBSITE_CLICKS.',
  });
  assert.equal(row.result.value, null, 'the results of different objectives are not combined');
  assert.ok(report.sources[0].warnings.includes(xObjectivesMixedWarning));
});
