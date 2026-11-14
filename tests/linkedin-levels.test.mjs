import test, {after, before, mock} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../dist/src/store.js';
import {MirrorError} from '../dist/src/errors.js';
import {NativeCampaignReports} from '../dist/src/report-native.js';
import {overviewEntityLevels} from '../dist/src/overview-levels.js';
import * as workflows from '../dist/src/workflows.js';
import * as reporting from '../dist/src/linkedin-reporting.js';
import * as linkedin from '../dist/src/linkedin-report-source.js';
import {linkedinGuidedReporting} from '../dist/src/linkedin-guided-reports.js';
import {assertNamesNoProvider} from './helpers/shared-module-seams.mjs';
import {
  linkedinLevelAccount as account,
  linkedinLevelGroup as group,
  linkedinLevelCampaign as campaign,
  linkedinLevelCreative as creative,
  linkedinLevelAnalytics as analytics,
  linkedinLevelRange as range,
} from './fixtures/linkedin-levels-docs.mjs';

// LinkedIn's creative level and its daily evidence read only the current and five previous calendar months of the clock
// (src/linkedin-reporting.ts, src/linkedin-report-source.ts), and these fixtures' report days are 2026-09-01 and 2026-09-02.
// Against the real clock the six tests that reach the creative level start failing in March 2027, so the file runs at a fixed
// instant inside that window (package docs, item 9).
before(() => mock.timers.enable({apis: ['Date'], now: Date.UTC(2026, 10, 6)}));
after(() => mock.timers.reset());

const groupUrn = 'urn:li:sponsoredCampaignGroup:20',
  campaignUrn = 'urn:li:sponsoredCampaign:30',
  creativeUrn = creative.id;
const actor = {tenantId: 'synthetic-linkedin-levels', userId: 'owner', role: 'admin'};
function fixture(
  t,
  {groupRow = group, campaignRow = campaign, creativeRow = creative, analyticsExtra = {}, refused} = {},
) {
  const store = new Store(':memory:', Buffer.alloc(32, 123).toString('base64'));
  t.after(() => store.close());
  store.putConnection(
    actor,
    {
      id: 'login',
      tenantId: actor.tenantId,
      gateway: 'linkedin_native_action',
      accounts: ['100'],
      enabled: true,
      scopes: ['r_ads', 'r_ads_reporting'],
      label: 'Synthetic',
    },
    {accessToken: 'synthetic'},
  );
  const requests = [];
  const service = {
    store,
    runPlan: async plan => {
      requests.push(structuredClone(plan));
      assert.equal(plan.method, 'GET');
      if (refused && plan.path.endsWith(refused))
        throw new MirrorError('UPSTREAM_ERROR', 'Synthetic metadata refusal.', {http_status: 403}, 403);
      let data;
      if (plan.path === '/rest/adAccounts/100') data = account;
      else if (plan.path === '/rest/adAnalytics') data = analytics(plan.query.pivot, analyticsExtra);
      else if (plan.path.endsWith('/adCampaignGroups')) data = {elements: [groupRow], metadata: {}};
      else if (plan.path.endsWith('/adCampaigns')) data = {elements: [campaignRow], metadata: {}};
      else if (plan.path.endsWith('/creatives')) data = {elements: [creativeRow], metadata: {}};
      else throw new Error('Unexpected synthetic LinkedIn path ' + plan.path);
      return {success: true, data: structuredClone(data)};
    },
  };
  const native = new NativeCampaignReports(service);
  return {
    requests,
    collect: (level, lookup, v4 = false) =>
      native.collect(
        {
          platform: 'linkedin',
          account_id: '100',
          connection_id: 'login',
          level,
          ...(v4 ? {reporting_contract: 'overview-config-v4'} : {}),
          ...(!v4 && level === 'campaign' ? {} : {report_options: {complete_window: true, attribution: 'unknown'}}),
        },
        range,
        actor,
        {},
        () => {},
        lookup,
      ),
  };
}

test('Overview and guided presets share the three-position LinkedIn mapping', () => {
  assert.deepEqual(overviewEntityLevels.linkedin, [
    {id: 'campaign', label: 'Campaign group', preset: 'linkedin_campaign_group', native_type: 'sponsoredCampaignGroup'},
    {id: 'adset', label: 'Campaign', preset: 'linkedin_campaign', native_type: 'sponsoredCampaign'},
    {id: 'ad', label: 'Creative', preset: 'linkedin_creative', native_type: 'sponsoredCreative'},
  ]);
  assert.deepEqual(workflows.linkedinReportPivots, {campaign: 'CAMPAIGN_GROUP', adset: 'CAMPAIGN', ad: 'CREATIVE'});
  for (const level of overviewEntityLevels.linkedin) {
    const preset = linkedinGuidedReporting.presets.find(p => p.id === level.preset);
    const request = linkedinGuidedReporting.presetRequest(
      preset,
      {account_id: '100', connection_id: 'login', semantics: {timezone: 'UTC'}},
      range,
    );
    assert.equal(request.arguments.query.pivot, workflows.linkedinReportPivots[level.id]);
  }
});

for (const level of ['campaign', 'adset', 'ad'])
  test(level + ' reads its native ALL pivot and returns the native hierarchy', async t => {
    const f = fixture(t),
      result = await f.collect(level);
    assert.equal(result.complete, true);
    const request = f.requests.find(p => p.path === '/rest/adAnalytics');
    assert.equal(request.query.pivot, {campaign: 'CAMPAIGN_GROUP', adset: 'CAMPAIGN', ad: 'CREATIVE'}[level]);
    assert.equal(request.query.timeGranularity, 'ALL');
    const row = result.rows[0];
    if (level === 'campaign') {
      assert.equal(row.campaign_id, '20');
      assert.equal(row.campaign_name, 'Synthetic group');
      assert.equal(row.objective, 'BRAND_AWARENESS');
      assert.equal(row.parent_ids, undefined);
    } else {
      assert.equal(row.entity_id, level === 'ad' ? creativeUrn : campaignUrn);
      assert.equal(row.campaign_id, '20');
      assert.equal(row.parent_ids.campaign_name, 'Synthetic group');
      assert.equal(row.objective, 'LEAD_GENERATION');
      assert.equal(row.objective_source, 'provider');
      assert.equal(Object.hasOwn(row.parent_ids, 'objective'), false);
      assert.equal(row.native.exact_totals.spend, '100.123456789');
      if (level === 'ad') {
        assert.equal(row.parent_ids.adset_id, '30');
        assert.equal(row.parent_ids.adset_name, 'Synthetic campaign');
        assert.equal(row.entity_name, 'Synthetic creative');
      } else {
        assert.equal(row.entity_name, 'Synthetic campaign');
        assert.equal(row.parent_ids.adset_id, undefined);
      }
    }
  });

for (const level of ['campaign', 'adset', 'ad'])
  test(
    'v4 ' + level + ' selects sponsored-message sends from native campaign type and requests that field',
    async t => {
      const f = fixture(t, {
        groupRow: {...group, objectiveType: 'WEBSITE_VISIT'},
        campaignRow: {...campaign, objectiveType: 'WEBSITE_VISIT', type: 'SPONSORED_INMAILS'},
        analyticsExtra: {sends: '10', landingPageClicks: '999'},
      });
      const result = await f.collect(level, undefined, true);
      assert.equal(result.complete, true);
      assert.equal(result.rows[0].result.metric, 'sends');
      assert.equal(result.rows[0].result.value, '10');
      assert.equal(result.rows[0].result.cost_per_result, '10.012345679');
      for (const request of f.requests.filter(p => p.path === '/rest/adAnalytics')) {
        assert.ok(request.query.fields.split(',').includes('sends'));
        assert.ok(request.query.fields.split(',').length <= 20);
      }
    },
  );

test('v4 campaign metadata binds native type/status and refuses a repeated identity', async () => {
  const native = {...campaign, type: 'SPONSORED_INMAILS'},
    read = async () => ({elements: [native], metadata: {}}),
    v4 = await reporting.linkedInCampaignMetadata('100', [campaignUrn], read, true),
    legacy = await reporting.linkedInCampaignMetadata('100', [campaignUrn], read);
  assert.equal(v4.campaigns[campaignUrn].campaign_type, 'SPONSORED_INMAILS');
  assert.equal(v4.campaigns[campaignUrn].status, 'PAUSED');
  assert.equal(legacy.campaigns[campaignUrn].campaign_type, undefined);
  await assert.rejects(
    () =>
      reporting.linkedInCampaignMetadata(
        '100',
        [campaignUrn],
        async () => ({elements: [native, native], metadata: {}}),
        true,
      ),
    error => error.code === 'REPORT_INCOMPLETE',
  );
});

test('creative names use the native name, otherwise Ad and the exact numeric ID', async t => {
  for (const name of [undefined, '', '   ']) {
    const f = fixture(t, {creativeRow: {...creative, name}}),
      result = await f.collect('ad');
    assert.equal(result.rows[0].entity_name, 'Ad 40');
    assert.doesNotMatch(result.rows[0].entity_name, /urn:li:/);
  }
});

test('native detail keeps exact decimal text and records half-even rounding', () => {
  const rounding = {};
  const result = linkedin.linkedinDetail(
    'ad',
    analytics('CREATIVE', {costInLocalCurrency: '1.2345678905'}).elements,
    {
      campaigns: {[campaignUrn]: {name: 'Campaign', objective_type: 'LEAD_GENERATION', campaign_group: groupUrn}},
      groups: {[groupUrn]: {name: 'Group'}},
      creatives: {[creativeUrn]: {name: 'Creative', campaign: campaignUrn}},
    },
    rounding,
  );
  assert.equal(result.rows[0].spend, '1.23456789');
  assert.equal(rounding.spend, 1);
  assert.equal(result.parents[creativeUrn].objective, 'LEAD_GENERATION');
});

test('campaign metadata retains its exact campaign group URN', async () => {
  const result = await reporting.linkedInCampaignMetadata('100', [campaignUrn], async () => ({
    elements: [campaign],
    metadata: {},
  }));
  assert.equal(result.campaigns[campaignUrn].campaign_group, groupUrn);
});

test('group metadata searches bounded native URNs in batches of 100', async () => {
  const ids = Array.from({length: 201}, (_, n) => 'urn:li:sponsoredCampaignGroup:' + (n + 1)),
    requests = [];
  const result = await reporting.linkedInCampaignGroupMetadata('100', ids, async plan => {
    requests.push(plan);
    assert.equal(plan.path, '/rest/adAccounts/100/adCampaignGroups');
    assert.equal(plan.method, 'GET');
    assert.equal(plan.readOnly, true);
    assert.equal(plan.query.q, 'search');
    assert.equal(plan.query.pageSize, 100);
    return {elements: plan.query.search.id.values.map(urn => ({...group, id: urn.split(':').at(-1)})), metadata: {}};
  });
  assert.deepEqual(
    requests.map(p => p.query.search.id.values.length),
    [100, 100, 1],
  );
  assert.equal(Object.keys(result).length, 201);
  assert.equal(result[groupUrn].objective_type, 'BRAND_AWARENESS');
  assert.equal(result[groupUrn].status, 'PAUSED');
});

test('too many groups are refused before a metadata request', async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      reporting.linkedInCampaignGroupMetadata(
        '100',
        Array.from({length: 2001}, (_, n) => 'urn:li:sponsoredCampaignGroup:' + (n + 1)),
        async () => {
          reads++;
          return {elements: []};
        },
      ),
    error => error.code === 'REPORT_COLLECTION_LIMIT',
  );
  assert.equal(reads, 0);
});

test('a campaign group of another account refuses the source', async t => {
  const f = fixture(t, {groupRow: {...group, account: 'urn:li:sponsoredAccount:999'}});
  await assert.rejects(
    () => f.collect('campaign'),
    error => error.code === 'REPORT_ACCOUNT_MISMATCH',
  );
});

test('repeated, unrequested and incomplete group metadata are refused', async () => {
  for (const data of [
    {elements: [group, group]},
    {elements: [{...group, id: 21}]},
    {elements: [group], metadata: {nextPageToken: 'more'}},
  ])
    await assert.rejects(
      () => reporting.linkedInCampaignGroupMetadata('100', [groupUrn], async () => data),
      error => ['REPORT_SHAPE_CHANGED', 'REPORT_INCOMPLETE'].includes(error.code),
    );
});

test('metadata refusals retain metric rows with fallback names and unknown parents', async t => {
  const f = fixture(t, {refused: '/creatives'}),
    result = await f.collect('ad');
  assert.equal(result.complete, true);
  assert.equal(result.rows[0].entity_name, 'Ad 40');
  assert.equal(result.rows[0].campaign_id, null);
  assert.equal(result.rows[0].objective_source, 'unknown');
  assert.ok(result.warnings.length > 0);
});

test('metadata is read once per reported entity and its cached lineage is retained', async t => {
  const f = fixture(t),
    lookup = {};
  await f.collect('ad', lookup);
  const result = await f.collect('ad', lookup);
  for (const suffix of ['/creatives', '/adCampaigns', '/adCampaignGroups'])
    assert.equal(f.requests.filter(p => p.path.endsWith(suffix)).length, 1, suffix);
  assert.ok(result.lineage.some(p => p.cached === true && p.stage === 'creative_metadata'));
});

test('the shared level and workflow modules name no provider gateway or provider module', () => {
  assertNamesNoProvider('src/workflows.ts');
  assertNamesNoProvider('src/overview-levels.ts');
});
