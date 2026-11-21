// DEC-02: allocation factor provenance and descriptive indicators. Synthetic fixtures only; no provider request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocationCalibrationFixture,
  calibrationNow,
  calibrationReport,
  calibrationIds,
} from './fixtures/allocation-calibration-data.mjs';
import {snapchatAllocationData} from './fixtures/snapchat-allocation-data.mjs';
import {Store} from '../dist/src/store.js';
import {Registry} from '../dist/src/catalog.js';
import {MirrorService} from '../dist/src/service.js';
import {NativeTransport} from '../dist/src/transport.js';
import {
  calibratedFactorsLimitation,
  declaredFactorsLimitation,
  outsideRangeLimitation,
} from '../dist/src/report-allocation.js';
import {budgetUtilization} from '../dist/src/allocation-plan.js';
import {allocationReport} from './fixtures/allocation-data.mjs';

const calibrate = (f, ids = calibrationIds) =>
  f.call({
    action: 'calibrate_allocation',
    id: f.input.id,
    ids,
    options: {training_days: 7, minimum_training_conversions: 10, maximum_age_days: 7, central_share_percent: 80},
  });
// 14 days of 10 (first) and 20 (second) spend a day, at the same efficiency: the calibration envelope is exactly 1–1.
const options = (extra = {}) => ({
  budget: '450',
  efficiency_low: 1,
  efficiency_high: 1,
  maximum_age_days: 7,
  minimum_conversions: 10,
  allocations: [
    {entity_id: calibrationIds[0], minimum: '100', maximum: '300'},
    {entity_id: calibrationIds[1], minimum: '150', maximum: '350'},
  ],
  ...extra,
});
const allocate = (f, input) => f.call({action: 'allocation', id: f.input.id, options: input});
const ok = r => {
  assert.equal(r.success, true, JSON.stringify(r));
  return r.data;
};

test('a proposal built on a retained calibration records it and gets its own model fingerprint', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    calibration = ok(await calibrate(f));
  const declared = ok(await allocate(f, options()));
  assert.deepEqual(declared.assumptions.factor_provenance, {kind: 'declared'});
  assert.ok(declared.limitations.includes(declaredFactorsLimitation));
  const source = {
    kind: 'calibration',
    evidence_fingerprint: calibration.evidence_fingerprint,
    ids: calibrationIds,
    options: {training_days: 7, minimum_training_conversions: 10, maximum_age_days: 7, central_share_percent: 80},
  };
  const derived = ok(await allocate(f, options({factor_source: source})));
  const provenance = derived.assumptions.factor_provenance;
  assert.equal(provenance.kind, 'calibration');
  assert.equal(provenance.evidence_fingerprint, calibration.evidence_fingerprint);
  assert.deepEqual(provenance.factor_envelope, {efficiency_low: '1', efficiency_high: '1', applicable: true});
  assert.equal(provenance.horizon_days, 1);
  assert.ok(derived.limitations.includes(calibratedFactorsLimitation));
  assert.ok(!derived.limitations.includes(declaredFactorsLimitation));
  // The same numbers with and without provenance are different proposals.
  assert.notEqual(derived.model_fingerprint, declared.model_fingerprint);
  assert.deepEqual(derived.allocations, declared.allocations);
  assert.equal(f.nativeCalls(), 0);
});

test('forged, edited or mismatched factor provenance is refused', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    calibration = ok(await calibrate(f)),
    partial = ok(await calibrate(f, [calibrationIds[0]]));
  const source = (extra = {}) => ({
    kind: 'calibration',
    evidence_fingerprint: calibration.evidence_fingerprint,
    ids: calibrationIds,
    options: {training_days: 7, minimum_training_conversions: 10, maximum_age_days: 7, central_share_percent: 80},
    ...extra,
  });
  for (const input of [
    options({factor_source: source({evidence_fingerprint: 'f'.repeat(64)})}),
    options({factor_source: source({kind: 'declared'})}),
    // The factors were edited after they were copied from the calibration.
    options({factor_source: source(), efficiency_high: 1.2}),
    // The calibration evaluated only the first entity, so it cannot vouch for the second.
    options({
      factor_source: source({evidence_fingerprint: partial.evidence_fingerprint, ids: [calibrationIds[0]]}),
    }),
  ]) {
    const r = await allocate(f, input);
    assert.equal(r.success, false, JSON.stringify(input.factor_source));
    assert.equal(r.error.code, 'ALLOCATION_FACTOR_PROVENANCE', JSON.stringify(r.error));
  }
  // Changed evidence changes the calibration it would reproduce: the old fingerprint no longer matches.
  const changed = calibrationReport();
  changed.rows[9].conversions = '3';
  const g = allocationCalibrationFixture(t, changed),
    r = await allocate(g, options({factor_source: source()}));
  assert.equal(r.error.code, 'ALLOCATION_FACTOR_PROVENANCE');
});

test('indicators compare each proposal with the observed daily spend and say when the model extrapolates', async t => {
  t.mock.method(Date, 'now', () => calibrationNow);
  const f = allocationCalibrationFixture(t),
    out = ok(await allocate(f, options()));
  const [first, second] = out.allocation_indicators;
  // The first entity spent 10 a day; 300 over 14 days is 21.428571428 a day, above anything observed.
  assert.deepEqual(first, {
    entity_id: calibrationIds[0],
    observed_daily_spend_min: '10',
    observed_daily_spend_max: '10',
    proposed_daily_average: '21.428571428',
    proposed_to_observed_spend: '2.142857',
    position: 'above',
    outside_observed_range: true,
  });
  // The second spent 20 a day; 150 over 14 days is below it.
  assert.equal(second.position, 'below');
  assert.equal(second.proposed_to_observed_spend, '0.535714');
  assert.ok(out.limitations.includes(outsideRangeLimitation));
  const within = ok(
    await allocate(
      f,
      options({
        budget: '420',
        allocations: [
          {entity_id: calibrationIds[0], minimum: '140', maximum: '140'},
          {entity_id: calibrationIds[1], minimum: '280', maximum: '280'},
        ],
      }),
    ),
  );
  assert.deepEqual(
    within.allocation_indicators.map(i => [i.position, i.outside_observed_range, i.proposed_to_observed_spend]),
    [
      ['within', false, '1'],
      ['within', false, '1'],
    ],
  );
  assert.ok(!within.limitations.includes(outsideRangeLimitation));
  // Indicators sit beside the allocations, so existing proposal hashes are unchanged by them.
  assert.equal(within.allocations[0].position, undefined);
});

test('budget utilization divides observed spend by the current daily budget over the evidence days', () => {
  assert.deepEqual(budgetUtilization('100', 200000000n, 2), {budget_utilization: '0.25', low_budget_utilization: true});
  assert.deepEqual(budgetUtilization('400', 200000000n, 2), {budget_utilization: '1', low_budget_utilization: false});
  assert.deepEqual(budgetUtilization('320.000000001', 200000000n, 2), {
    budget_utilization: '0.8',
    low_budget_utilization: false,
  });
  assert.equal(budgetUtilization('1', 0n, 2).budget_utilization, null);
});

test('a preview shows each target’s budget utilization and the draft brief names the factor provenance', async t => {
  const data = snapchatAllocationData(),
    store = new Store(':memory:', Buffer.alloc(32, 123).toString('base64')),
    owner = {tenantId: 'allocation-depth', userId: 'owner', role: 'admin'},
    actor = store.authenticate(store.createKey(owner));
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: data.report.connection_id,
      tenantId: actor.tenantId,
      gateway: data.report.gateway,
      accounts: [data.report.account_id],
      writeAccounts: [data.report.account_id],
      enabled: true,
      label: 'Synthetic',
      scopes: ['snapchat-marketing-api'],
    },
    {accessToken: 'synthetic'},
  );
  store.putDocument(actor.tenantId, 'decision_report', 'source', data.report);
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      assert.equal(init.method, 'GET', 'previews and drafts never write');
      return Response.json(data.response(url));
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const call = args => service.call('amcp_reporting', args, actor);
  const p = ok(
    await call({action: 'preview_allocation_plan', id: 'source', conversion: 'equal_daily', options: data.options}),
  );
  // Each ad squad spent 100 over two days against a current daily budget of 200: a quarter of it.
  assert.deepEqual(
    p.targets.map(t => [t.budget_utilization, t.low_budget_utilization]),
    [
      ['0.25', true],
      ['0.25', true],
    ],
  );
  const created = ok(
    await call({
      action: 'create_allocation_plan',
      id: 'source',
      preview_id: p.preview_id,
      preview_hash: p.preview_hash,
      confirmed: true,
    }),
  );
  assert.match(
    store.document(actor.tenantId, 'campaign_run', created.id).brief,
    /efficiency factors declared by the operator/,
  );
});

/** A Google allocation preview whose indicator read answers `indicator(query)` (a Response or a JSON body). */
function googlePreview(t, indicator) {
  const store = new Store(':memory:', Buffer.alloc(32, 124).toString('base64')),
    owner = {tenantId: 'allocation-depth-google', userId: 'owner', role: 'admin'},
    actor = store.authenticate(store.createKey(owner)),
    connection = '22222222-2222-4222-8222-222222222222',
    customer = {id: '123', currencyCode: 'USD', timeZone: 'UTC'};
  t.after(() => store.close());
  store.putConnection(
    owner,
    {
      id: connection,
      tenantId: actor.tenantId,
      gateway: 'google_ads_native_action',
      accounts: ['123'],
      writeAccounts: ['123'],
      enabled: true,
      label: 'Synthetic',
      scopes: ['https://www.googleapis.com/auth/adwords'],
    },
    {accessToken: 'synthetic', developerToken: 'synthetic'},
  );
  const report = allocationReport();
  store.putDocument(actor.tenantId, 'decision_report', 'source', {
    ...report,
    gateway: 'google_ads_native_action',
    preset: 'google_campaign',
    connection_id: connection,
    account_id: '123',
  });
  const queries = [];
  const service = new MirrorService(
    new Registry(),
    store,
    new NativeTransport(async (url, init) => {
      const q = JSON.parse(init.body).query;
      queries.push(q);
      if (q.includes('search_budget_lost_impression_share')) {
        const out = indicator(q);
        return out instanceof Response ? out : Response.json(out);
      }
      const ids = q.match(/campaign.id IN \(([^)]+)\)/)[1].split(',');
      return Response.json({
        results: ids.map(id => ({
          customer,
          campaign: {
            id,
            resourceName: 'customers/123/campaigns/' + id,
            status: 'ENABLED',
            campaignBudget: 'customers/123/campaignBudgets/1' + id,
          },
          campaignBudget: {
            resourceName: 'customers/123/campaignBudgets/1' + id,
            amountMicros: '200000000',
            referenceCount: '1',
            period: 'DAILY',
            status: 'ENABLED',
          },
        })),
      });
    }),
    undefined,
    {allowWrites: true, requireBeforeState: true, maxBudgetChange: 0},
  );
  const preview = () =>
    service.call(
      'amcp_reporting',
      {
        action: 'preview_allocation_plan',
        id: 'source',
        conversion: 'equal_daily',
        options: {
          budget: '200',
          efficiency_low: 0.8,
          efficiency_high: 1.2,
          maximum_age_days: 7,
          minimum_conversions: 5,
          allocations: [
            {entity_id: '10', minimum: '25', maximum: '125'},
            {entity_id: '20', minimum: '50', maximum: '175'},
          ],
        },
      },
      actor,
    );
  return {preview, queries, report};
}

test('a Google preview shows each campaign’s Search budget-lost impression share over the evidence period', async t => {
  const f = googlePreview(t, () => ({
      results: [
        {campaign: {id: '10', advertisingChannelType: 'SEARCH'}, metrics: {searchBudgetLostImpressionShare: 0.25}},
        {campaign: {id: '20', advertisingChannelType: 'DISPLAY'}, metrics: {}},
      ],
    })),
    p = ok(await f.preview());
  assert.deepEqual(
    p.targets.map(t => t.search_budget_lost_impression_share),
    [{status: 'read', share: '0.25', above_90_percent: false}, {status: 'not_search'}],
  );
  // One read over exactly the evidence period, after the two budget observations, kept as its own reference.
  const asked = f.queries.filter(q => q.includes('search_budget_lost_impression_share'));
  assert.equal(asked.length, 1);
  assert.match(asked[0], new RegExp(`BETWEEN '${f.report.semantics.date_from}' AND '${f.report.semantics.date_to}'`));
  assert.equal(f.queries.at(-1), asked[0]);
  assert.equal(p.native_source_references.length, 2, 'the budget observations are unchanged');
  assert.equal(p.indicator_source_references.length, 1);
});

test('a Search share Google reports above 90% is named so; an omitted campaign or a refused read stays unknown', async t => {
  const capped = googlePreview(t, () => ({
    results: [
      {campaign: {id: '10', advertisingChannelType: 'SEARCH'}, metrics: {searchBudgetLostImpressionShare: 0.9001}},
    ],
  }));
  const p = ok(await capped.preview());
  assert.deepEqual(p.targets[0].search_budget_lost_impression_share, {
    status: 'read',
    share: '0.9001',
    above_90_percent: true,
  });
  assert.deepEqual(p.targets[1].search_budget_lost_impression_share, {status: 'not_reported'});
  // A provider refusal or a malformed answer never blocks the preview: the indicator is unavailable.
  for (const answer of [
    () => new Response(JSON.stringify({error: {code: 400, message: 'Bad metric'}}), {status: 400}),
    () => ({results: [{campaign: {id: '99', advertisingChannelType: 'SEARCH'}, metrics: {}}]}),
    () => ({results: 'not a list'}),
  ]) {
    const refused = ok(await googlePreview(t, answer).preview());
    assert.deepEqual(
      refused.targets.map(t => t.search_budget_lost_impression_share),
      [{status: 'unavailable'}, {status: 'unavailable'}],
    );
  }
});

// Package r25-field2-google, G5 (the field report of 2026-11-21, the same omitted-results pattern): with segments.date Google returns no
// row for a campaign that had no impressions in the window, and its REST API then omits `results`. When that is every selected campaign,
// each is not_reported (nothing is guessed), not an unavailable indicator, which is for a read that failed.
test('a budget-lost read with no row for any campaign gives each campaign not_reported', async t => {
  const fieldMask = 'campaign.id,campaign.advertisingChannelType,metrics.searchBudgetLostImpressionShare';
  for (const answer of [
    () => ({fieldMask, queryResourceConsumption: '2'}),
    () => ({results: [], fieldMask, queryResourceConsumption: '2'}),
  ]) {
    const f = googlePreview(t, answer),
      p = ok(await f.preview());
    assert.deepEqual(
      p.targets.map(t => t.search_budget_lost_impression_share),
      [{status: 'not_reported'}, {status: 'not_reported'}],
    );
    assert.equal(f.queries.filter(q => q.includes('search_budget_lost_impression_share')).length, 1);
    assert.equal(p.indicator_source_references.length, 1);
  }
});
test('a failed, truncated or malformed budget-lost read still leaves the indicator unavailable', async t => {
  for (const [name, answer] of [
    ['a refusal', () => new Response(JSON.stringify({error: {code: 400, message: 'Bad metric'}}), {status: 400})],
    ['a next page and no results', () => ({nextPageToken: 'more', fieldMask: 'campaign.id'})],
    ['a next page with an empty list', () => ({results: [], nextPageToken: 'more'})],
    ['results as an object', () => ({results: {}})],
    ['results as null', () => ({results: null})],
    ['results as a string', () => ({results: 'none'})],
    [
      'a row of another campaign',
      () => ({results: [{campaign: {id: '99', advertisingChannelType: 'SEARCH'}, metrics: {}}]}),
    ],
  ]) {
    const refused = ok(await googlePreview(t, answer).preview());
    assert.deepEqual(
      refused.targets.map(t => t.search_budget_lost_impression_share),
      [{status: 'unavailable'}, {status: 'unavailable'}],
      name,
    );
  }
});
