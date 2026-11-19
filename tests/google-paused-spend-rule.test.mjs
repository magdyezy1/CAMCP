import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {authorizeExecution, spendConfirmationError} from '../dist/src/preflight.js';
import {effectClass} from '../dist/src/effect-class.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * R2.5 field fix r25-field-pausedspend (the owner's "yes", 2026-11-19): a Google create that the review reads as under a PAUSED parent
 * can start no spend, so it asks for no spend_change_confirmed. The rule decides from the plan and the state the review holds; with no
 * state (inspect, the effect taxonomy of a bare plan, a plan's local compile) it asks, as it always did. Part one of the package's tests:
 * the rule itself, on compiled plans and hand-built state rows. tests/google-paused-spend.test.mjs runs the review lifecycle.
 */
const compiler = new Compiler(new Registry()),
  options = {mode: 'strict', flags: {}};
const actor = {tenantId: 't', userId: 'u', role: 'operator'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const google = 'google_ads_native_action';
const campaign = id => 'customers/123/campaigns/' + id;
const compile = (action, operations) =>
  applyExecutionRisk(
    compiler.compile(
      google,
      {action: 'google_ads_v23_' + action, account_id: '123', payload: {operations}, dry_run: true},
      options,
    ),
  );
const adGroups = operations => compile('ad_group_mutate_ad_groups', operations);
const group = (status = 'ENABLED', parent = campaign(9), extra = {}) => ({
  create: {name: 'DNU group', campaign: parent, type: 'SEARCH_STANDARD', status, ...extra},
});
/** The state the review holds of the campaigns: one read per campaign, rows as Google's search returns them. */
const rowOf = (id, status) => ({campaign: {resourceName: campaign(id), ...(status ? {status} : {})}});
const stateOf = (...rows) => rows.map(row => ({results: [row]}));
const paused = stateOf(rowOf(9, 'PAUSED'));
const asks = (plan, state) => spendConfirmationError(plan, state) !== undefined;
/** What execute's own check does with the state, the flag left out: the refusal it raises, or undefined. */
const executeRefusal = (plan, state) => {
  try {
    authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: 'k'}, policy, true, state);
    return undefined;
  } catch (e) {
    return e;
  }
};

test('an ENABLED ad group asks for the flag when no state is given, however the rule is asked', () => {
  const plan = adGroups([group()]);
  assert.equal(asks(plan), true);
  assert.equal(asks(plan, undefined), true);
  assert.equal(effectClass(plan), 'spend_affecting');
  assertRefused(spendConfirmationError(plan), 'SPEND_CONFIRMATION_REQUIRED');
  assertRefused(executeRefusal(plan), 'SPEND_CONFIRMATION_REQUIRED');
});

test('with a state that reads its campaign PAUSED, an ENABLED ad group asks for no flag, in every caller that is given the state', () => {
  const plan = adGroups([group()]);
  assert.equal(spendConfirmationError(plan, paused), undefined);
  assert.equal(effectClass(plan, paused), 'config_write');
  assert.equal(executeRefusal(plan, paused), undefined);
  // The same plan with no state: the state is what lifted the flag.
  assert.equal(asks(plan), true);
  assertRefused(executeRefusal(plan), 'SPEND_CONFIRMATION_REQUIRED');
});

test('any reading of the campaign but PAUSED asks for the flag: serving, removed, unnamed, absent, another campaign, no rows', () => {
  const plan = adGroups([group()]);
  for (const [what, state] of [
    ['an ENABLED campaign', stateOf(rowOf(9, 'ENABLED'))],
    ['a REMOVED campaign', stateOf(rowOf(9, 'REMOVED'))],
    ['a status Google does not name (UNSPECIFIED)', stateOf(rowOf(9, 'UNSPECIFIED'))],
    ['a status Google does not name (UNKNOWN)', stateOf(rowOf(9, 'UNKNOWN'))],
    ['a lower-case status', stateOf(rowOf(9, 'paused'))],
    ['a row with no status', stateOf(rowOf(9))],
    ['only another campaign, PAUSED', stateOf(rowOf(8, 'PAUSED'))],
    ['no rows', [{results: []}]],
    ['no reads', []],
    ['a read that is no list of rows', [{}]],
    ['a state that is no list', {results: [rowOf(9, 'PAUSED')]}],
    ['null', null],
  ])
    assert.equal(asks(plan, state), true, what);
});

test('the campaign read is the one the create names, in either spelling of the rows', () => {
  const both = stateOf(rowOf(8, 'PAUSED'), rowOf(9, 'ENABLED'));
  assert.equal(asks(adGroups([group('ENABLED', campaign(9))]), both), true);
  assert.equal(asks(adGroups([group('ENABLED', campaign(8))]), both), false);
  // The same rows as Google's JSON keeps them (camelCase) and as AMCP normalizes them (snake_case).
  const snake = [{results: [{campaign: {resource_name: campaign(9), status: 'PAUSED'}}]}];
  assert.equal(asks(adGroups([group()]), snake), false);
});

test('a campaign read twice with different statuses is not read as PAUSED', () => {
  const plan = adGroups([group()]);
  assert.equal(asks(plan, [{results: [rowOf(9, 'PAUSED'), rowOf(9, 'ENABLED')]}]), true);
  assert.equal(asks(plan, stateOf(rowOf(9, 'ENABLED'), rowOf(9, 'PAUSED'))), true);
  // The same reading twice is one reading.
  assert.equal(asks(plan, stateOf(rowOf(9, 'PAUSED'), rowOf(9, 'PAUSED'))), false);
});

test('every operation needs a parent the state reads PAUSED', () => {
  const state = stateOf(rowOf(8, 'PAUSED'), rowOf(9, 'ENABLED'));
  assert.equal(asks(adGroups([group('ENABLED', campaign(8)), group('ENABLED', campaign(8))]), state), false);
  assert.equal(asks(adGroups([group('ENABLED', campaign(8)), group('ENABLED', campaign(9))]), state), true);
  assert.equal(asks(adGroups([group('ENABLED', campaign(9)), group('ENABLED', campaign(8))]), state), true);
});

test('the exemption is for creates only: an update or a removal in the request keeps the flag', () => {
  const update = {update: {resourceName: 'customers/123/adGroups/100', status: 'ENABLED'}, updateMask: 'status'};
  assert.equal(asks(adGroups([group()]), paused), false);
  assert.equal(asks(adGroups([group(), update]), paused), true);
  assert.equal(asks(adGroups([update, group()]), paused), true);
  assert.equal(asks(adGroups([update]), paused), true);
  // A PAUSED create names a bid, which asks by itself; a removal beside it is not a create, so the request is not exempt.
  const bid = group('PAUSED', campaign(9), {cpcBidMicros: '1000000'});
  assert.equal(asks(adGroups([bid]), paused), false);
  assert.equal(asks(adGroups([bid, {remove: 'customers/123/adGroups/100'}]), paused), true);
  // An operation that is a create and something else too is no create only.
  assert.equal(asks(adGroups([{...group(), remove: 'customers/123/adGroups/100'}]), paused), true);
});

test('the exemption is Google Ads only: the same request under another gateway asks, whatever the state says', () => {
  const plan = adGroups([group()]);
  for (const gateway of ['meta_native_action', 'tiktok_native_action', 'snapchat_native_action', 'x_ads_native_action'])
    assert.equal(asks({...plan, gateway}, paused), true, gateway);
});

test('a request that creates no child keeps its flag whatever the state says: an update of a campaign, a bid change of an ad group', () => {
  for (const plan of [
    compile('campaign_mutate_campaigns', [
      {update: {resourceName: campaign(9), status: 'ENABLED'}, updateMask: 'status'},
    ]),
    compile('ad_group_mutate_ad_groups', [
      {update: {resourceName: 'customers/123/adGroups/100', cpcBidMicros: '2000000'}, updateMask: 'cpc_bid_micros'},
    ]),
  ])
    assert.equal(asks(plan, paused), true, plan.path);
});
