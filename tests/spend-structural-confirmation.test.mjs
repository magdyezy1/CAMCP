import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {authorizeExecution} from '../dist/src/preflight.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {activatesEntity, activationFields} from '../dist/src/spend-policy.js';

// Edits of existing entities that change bids, bid targets, pacing, schedules, targeting or optimization need
// spend_change_confirmed even when no field name contains "budget", "bid" or "spend"; names and pauses do not.
const registry = new Registry(),
  compiler = new Compiler(registry),
  options = {mode: 'strict', flags: {}};
const actor = {tenantId: 't', userId: 'u', role: 'operator'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const compile = (gateway, args) => applyExecutionRisk(compiler.compile(gateway, {...args, dry_run: true}, options));
const google = (update, mask) =>
  compile('google_ads_native_action', {
    action: 'google_ads_v23_campaign_mutate_campaigns',
    params: {customer_id: '1234567890'},
    payload: {operations: [{update: {resourceName: 'customers/1234567890/campaigns/1', ...update}, updateMask: mask}]},
  });
const linkedin = set =>
  compile('linkedin_native_action', {
    action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
    params: {ad_account_id: '123', campaign_id: '456'},
    restli_method: 'PARTIAL_UPDATE',
    payload: {patch: {$set: set}},
  });
const meta = payload =>
  compile('meta_native_action', {action: 'meta_ad_set_id_update', params: {ad_set_id: '1234'}, payload});
const tiktok = payload =>
  compile('tiktok_native_action', {
    action: 'tiktok_adgroup_update',
    payload: {advertiser_id: '123', adgroup_id: '456', ...payload},
  });
const dv360 = (params, body) =>
  compile('dv360_native_action', {
    action: 'DV360_ADVERTISERS_LINE_ITEMS_PATCH',
    params: {advertiserId: '123', lineItemId: '456', ...params},
    body,
  });
const refusal = (plan, input = {}) => {
  try {
    assertWriteShape(plan);
    authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: 'k', ...input}, policy, true);
    return undefined;
  } catch (e) {
    return e;
  }
};

const delivery = [
  [
    'Google Ads target CPA',
    () => google({maximizeConversions: {targetCpaMicros: '90000000'}}, 'maximize_conversions.target_cpa_micros'),
    'maximize_conversions',
  ],
  [
    'Google Ads target ROAS',
    () => google({maximizeConversionValue: {targetRoas: 0.5}}, 'maximize_conversion_value.target_roas'),
    'maximize_conversion_value',
  ],
  ['Google Ads end date', () => google({endDateTime: '2027-12-31 23:59:59'}, 'end_date_time'), 'end_date_time'],
  ['LinkedIn bid (unitCost)', () => linkedin({unitCost: {amount: '50.00', currencyCode: 'USD'}}), 'unit_cost'],
  ['LinkedIn schedule', () => linkedin({runSchedule: {start: 1790000000000, end: 1800000000000}}), 'run_schedule'],
  [
    'LinkedIn targeting',
    () =>
      linkedin({
        targetingCriteria: {include: {and: [{or: {'urn:li:adTargetingFacet:locations': ['urn:li:geo:103644278']}}]}},
      }),
    'targeting_criteria',
  ],
  ['Meta targeting', () => meta({targeting: {geo_locations: {countries: ['US', 'CA']}}}), 'targeting'],
  ['Meta end time', () => meta({end_time: '2027-01-01T00:00:00+0000'}), 'end_time'],
  ['Meta optimization goal', () => meta({optimization_goal: 'REACH'}), 'optimization_goal'],
  ['TikTok locations', () => tiktok({location_ids: ['6252001']}), 'location_ids'],
  ['TikTok schedule', () => tiktok({schedule_end_time: '2027-01-01 00:00:00'}), 'schedule_end_time'],
  [
    'DV360 pacing',
    () =>
      dv360(
        {updateMask: 'pacing'},
        {pacing: {pacingPeriod: 'PACING_PERIOD_DAILY', pacingType: 'PACING_TYPE_ASAP', dailyMaxMicros: '900000000000'}},
      ),
    'pacing',
  ],
];
for (const [name, plan, field] of delivery)
  test(name + ' edits of an existing entity need spend_change_confirmed', () => {
    const p = plan(),
      e = refusal(p);
    assert.equal(e?.code, 'SPEND_CONFIRMATION_REQUIRED', name + ': ' + (e ? e.code + ' ' + e.message : 'no refusal'));
    assert.ok(e.details.fields.includes(field), JSON.stringify(e.details));
    assert.equal(refusal(p, {spend_change_confirmed: true}), undefined);
  });

test('names and pauses of existing entities stay free of spending confirmation', () => {
  for (const plan of [
    google({name: 'Renamed'}, 'name'),
    google({status: 'PAUSED'}, 'status'),
    linkedin({name: 'Renamed'}),
    linkedin({status: 'PAUSED'}),
    meta({name: 'Renamed'}),
    meta({status: 'PAUSED'}),
    tiktok({adgroup_name: 'Renamed'}),
    dv360({updateMask: 'displayName'}, {displayName: 'Renamed'}),
    dv360({updateMask: 'entityStatus'}, {entityStatus: 'ENTITY_STATUS_PAUSED'}),
  ])
    assert.equal(refusal(plan), undefined, JSON.stringify(plan.body));
});

test('a numeric status cannot be shown to leave an entity paused', () => {
  // Google Ads CampaignStatus 2 is ENABLED; ProtoJSON accepts enum numbers, so a reviewed write names the status instead.
  const e = refusal(google({status: 2}, 'status'));
  assert.equal(e?.code, 'INVALID_VENDOR_BODY', e?.message);
  assert.match(JSON.stringify(e.details.errors), /enum name/);
  // DV360 numeric entityStatus needs confirmation, and the owner policy treats it as possible activation.
  const d = dv360({updateMask: 'entityStatus'}, {entityStatus: 1}),
    r = refusal(d);
  assert.equal(r?.code, 'SPEND_CONFIRMATION_REQUIRED', r?.message);
  assert.deepEqual(r.details.fields, ['/body/entityStatus']);
  assert.equal(activatesEntity({body: {entityStatus: 1}}, activationFields.dv360_native_action), true);
  assert.equal(
    activatesEntity({body: [{op: 'replace', path: '/status', value: 1}]}, activationFields.snapchat_native_action),
    true,
  );
  assert.equal(
    activatesEntity({body: {operations: [{update: {status: 'PAUSED'}}]}}, activationFields.google_ads_native_action),
    false,
  );
});
