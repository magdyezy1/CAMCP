import test from 'node:test';
import assert from 'node:assert/strict';
import {reportSource} from '../dist/src/report-sources.js';
import {linkedinPipeline} from './helpers/linkedin-pipeline.mjs';

// A LinkedIn objective AMCP could not read (refused, or beyond the entities it reads) is never reported as an
// objective LinkedIn returned no value for. Every case runs the real queue, worker and LinkedIn collector.
const owner = 'urn:li:sponsoredAccount:100',
  delivered = {impressions: '100', clicks: '10', costInLocalCurrency: '5.5', landingPageClicks: '4'},
  refusedRead = 'AMCP could not read this campaign’s objective because the platform refused the read',
  limitedRead =
    'AMCP could not read this campaign’s objective because this report has more entities than AMCP reads campaign details for',
  missing = reportSource('linkedin').objectives.missingReason;
const source = level => ({
  platform: 'linkedin',
  account_id: '100',
  connection_id: 'login',
  levels: [level],
  delivered_only: false,
  report_options: {complete_window: true, attribution: 'unknown'},
});
const urnOf = {
  CAMPAIGN_GROUP: id => 'urn:li:sponsoredCampaignGroup:' + id,
  CAMPAIGN: id => 'urn:li:sponsoredCampaign:' + id,
  CREATIVE: id => 'urn:li:sponsoredCreative:' + id,
};
const campaignRecord = (id, objectiveType) => ({
  id,
  account: owner,
  campaignGroup: urnOf.CAMPAIGN_GROUP(20),
  name: 'Campaign ' + id,
  objectiveType,
  status: 'ACTIVE',
  type: 'SPONSORED_UPDATES',
});
const world = (campaignObjective = 'WEBSITE_VISIT', groupObjective) => ({
  groups: {20: {id: 20, account: owner, name: 'Group', objectiveType: groupObjective, status: 'ACTIVE'}},
  campaigns: {30: campaignRecord(30, campaignObjective)},
  creatives: {40: {id: urnOf.CREATIVE(40), account: owner, campaign: urnOf.CAMPAIGN(30), name: 'Creative'}},
});
const entityOf = {CAMPAIGN_GROUP: 20, CAMPAIGN: 30, CREATIVE: 40};
const analytics = pivot => [{pivotValues: [urnOf[pivot](entityOf[pivot])], ...delivered}];
// The creative level reads only the current and five previous months of the real clock; the report dates are September.
const fixClock = t => {
  t.mock.timers.reset();
  t.mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 6)});
};
async function run(t, level, {changes = {}, ...options} = {}) {
  fixClock(t);
  const f = linkedinPipeline(t, {analytics, ...world(), ...options}),
    report = await f.run({contract_version: 'overview-config-v4', sources: [source(level)], ...changes});
  assert.equal(report.state, 'complete', JSON.stringify(report.sources.map(s => s.warnings)));
  return report.rows[0].objective;
}
const fallback = (level, group) => ({sources: [{...source(level), objective_fallback: group}]});

for (const [level, refused] of [
  ['adset', '/adCampaigns'],
  ['ad', '/creatives'],
  ['campaign', '/adCampaigns'],
])
  test('LinkedIn ' + level + ' rows whose metadata read was refused say the objective could not be read', async t => {
    const plain = await run(t, level, {refused: [refused]});
    assert.deepEqual(
      [plain.native, plain.group, plain.source, plain.reason],
      [null, 'unknown', 'unknown', refusedRead + '; choose one in the report.'],
    );
    const covered = await run(t, level, {refused: [refused], changes: fallback(level, 'leads')});
    assert.deepEqual(
      [covered.group, covered.source, covered.reason],
      ['leads', 'user_fallback', refusedRead + ', so your fallback is used.'],
    );
    // The same fallback beside a campaign LinkedIn did return changes nothing.
    const read = await run(t, level, {changes: fallback(level, 'leads')});
    assert.deepEqual(
      [read.native, read.group, read.source, read.reason],
      ['WEBSITE_VISIT', 'traffic', 'provider', null],
    );
  });

test('a campaign group keeps its own LinkedIn objective when the campaign read was refused', async t => {
  const row = await run(t, 'campaign', {refused: ['/adCampaigns'], ...world(undefined, 'BRAND_AWARENESS')});
  assert.deepEqual([row.native, row.group, row.source, row.reason], ['BRAND_AWARENESS', 'awareness', 'provider', null]);
});

test('a campaign group whose own metadata read was refused is unread, though its campaigns name no objective', async t => {
  const row = await run(t, 'campaign', {refused: ['/adCampaignGroups'], ...world(null, null)});
  assert.deepEqual(
    [row.native, row.group, row.source, row.reason],
    [null, 'unknown', 'unknown', refusedRead + '; choose one in the report.'],
  );
});

test('LinkedIn rows read from metadata that carries no objective keep the platform’s own missing reason', async t => {
  for (const level of ['campaign', 'adset', 'ad']) {
    const row = await run(t, level, world(null, null)),
      fallen = await run(t, level, {changes: fallback(level, 'leads'), ...world(null, null)});
    assert.deepEqual([row.native, row.group, row.source, row.reason], [null, 'unknown', 'unknown', missing], level);
    assert.deepEqual([fallen.group, fallen.source, fallen.reason], ['leads', 'user_fallback', null], level);
  }
});

test('LinkedIn campaigns beyond the metadata bound say the objective could not be read, the rest keep theirs', async t => {
  fixClock(t);
  const total = 2002,
    ids = Array.from({length: total}, (_, i) => i + 1),
    f = linkedinPipeline(t, {
      analytics: pivot =>
        pivot === 'CAMPAIGN' ? ids.map(id => ({pivotValues: [urnOf.CAMPAIGN(id)], ...delivered})) : [],
      campaigns: Object.fromEntries(ids.map(id => [id, campaignRecord(id, 'WEBSITE_VISIT')])),
    }),
    queued = await f.overview.handle(
      {
        action: 'run',
        config: {...f.config, contract_version: 'overview-config-v4', sources: [source('adset')]},
        confirmed: true,
      },
      f.actor,
    );
  await f.worker.once();
  const page = await f.overview.handle({action: 'get', id: queued.id, offset: 1999, limit: 10}, f.actor),
    byId = Object.fromEntries(page.rows.map(row => [row.entity_id, row.objective]));
  assert.equal(page.row_count, total);
  assert.equal(byId[urnOf.CAMPAIGN(2000)].source, 'provider');
  for (const id of [2001, 2002])
    assert.deepEqual(
      [byId[urnOf.CAMPAIGN(id)].group, byId[urnOf.CAMPAIGN(id)].source, byId[urnOf.CAMPAIGN(id)].reason],
      ['unknown', 'unknown', limitedRead + '; choose one in the report.'],
    );
});
