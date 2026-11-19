import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {authorizeExecution, spendConfirmationError} from '../dist/src/preflight.js';
import {effectClass} from '../dist/src/effect-class.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
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

/**
 * Item 2: a Google campaign create is pinned PAUSED by the write shape (googleWriteShape), so it can start no spend, whatever it names: its
 * campaign_budget and bidding_strategy are names that move no money until the campaign is enabled, which is a reviewed write of its own and
 * asks. This is Q14's principle for TikTok's creates (`pausedCreation`), and it needs no state: the shape is the proof.
 */
const campaigns = operations => compile('campaign_mutate_campaigns', operations);
const campaignCreate = (status = 'PAUSED', extra = {}) => ({
  create: {
    name: 'DNU campaign',
    ...(status === null ? {} : {status}),
    advertisingChannelType: 'SEARCH',
    campaignBudget: 'customers/123/campaignBudgets/1',
    manualCpc: {},
    ...extra,
  },
});
const shapeRefusal = plan => {
  try {
    assertWriteShape(plan);
    return undefined;
  } catch (e) {
    return e;
  }
};

test('a PAUSED campaign create asks for no flag, with or without a state, though it names a budget and a bidding strategy', () => {
  for (const extra of [
    {},
    {biddingStrategy: 'customers/123/biddingStrategies/1'},
    {maximizeConversions: {targetCpaMicros: '25000000'}},
  ]) {
    const plan = campaigns([campaignCreate('PAUSED', extra)]);
    assert.equal(shapeRefusal(plan), undefined, 'the shape accepts it');
    for (const state of [undefined, [], paused, stateOf(rowOf(9, 'ENABLED'))]) {
      assert.equal(asks(plan, state), false, JSON.stringify(extra) + JSON.stringify(state));
      assert.equal(executeRefusal(plan, state), undefined);
    }
    assert.equal(effectClass(plan), 'config_write');
    assert.equal(effectClass(plan, paused), 'config_write');
  }
  // Several PAUSED creates in one request are as free as one.
  assert.equal(asks(campaigns([campaignCreate(), campaignCreate('PAUSED', {name: 'DNU two'})])), false);
});

test('a campaign create that is not pinned PAUSED asks for the flag, and the shape refuses it too', () => {
  for (const [what, status] of [
    ['ENABLED', 'ENABLED'],
    ['no status (Google would enable it)', null],
    ['REMOVED', 'REMOVED'],
  ]) {
    const plan = campaigns([campaignCreate(status)]);
    assert.equal(asks(plan), true, what);
    assert.equal(asks(plan, paused), true, what);
    assertRefused(shapeRefusal(plan), 'PAUSED_CREATION_REQUIRED');
  }
  // A number and a lower-case name are no PAUSED: they ask, and the Discovery contract refuses them before the shape can.
  for (const status of [3, 'paused']) {
    const plan = campaigns([campaignCreate(status)]);
    assert.equal(asks(plan), true, String(status));
    assertRefused(shapeRefusal(plan), 'INVALID_VENDOR_BODY');
  }
});

test('a request that holds more than PAUSED campaign creates asks: an ENABLED create, an update, a removal, an operation that is two things', () => {
  const enable = {update: {resourceName: campaign(9), status: 'ENABLED'}, updateMask: 'status'};
  for (const [what, operations] of [
    ['a PAUSED create beside an ENABLED one', [campaignCreate(), campaignCreate('ENABLED')]],
    ['a PAUSED create beside an ENABLE update', [campaignCreate(), enable]],
    ['a PAUSED create beside a removal', [campaignCreate(), {remove: campaign(8)}]],
    ['a create that is a removal too', [{...campaignCreate(), remove: campaign(8)}]],
    [
      'an update that names a budget',
      [
        {
          update: {resourceName: campaign(9), campaignBudget: 'customers/123/campaignBudgets/2'},
          updateMask: 'campaign_budget',
        },
      ],
    ],
  ])
    assert.equal(asks(campaigns(operations), paused), true, what);
});

test('the campaign exemption is the campaigns route of Google Ads, a POST, and nothing near it', () => {
  const plan = campaigns([campaignCreate()]);
  assert.equal(asks(plan), false);
  for (const gateway of ['meta_native_action', 'tiktok_native_action', 'snapchat_native_action', 'x_ads_native_action'])
    assert.equal(asks({...plan, gateway}), true, gateway);
  assert.equal(asks({...plan, method: 'PUT'}), true, 'another method');
  assert.equal(asks({...plan, body: [plan.body]}), true, 'a body that is no record');
  assert.equal(
    asks({...plan, body: {...plan.body, mutate_operations: []}}),
    false,
    'an unknown extra key does not change what the operations are',
  );
  for (const path of [
    plan.path.replace('campaigns:mutate', 'campaignBudgets:mutate'),
    plan.path.replace('campaigns:mutate', 'adGroups:mutate'),
    plan.path.replace('campaigns:mutate', 'campaignCriteria:mutate'),
    plan.path.replace('/customers/123/campaigns:mutate', '/customers/123/campaigns:mutateX'),
    plan.path.replace('/customers/123/', '/customers/123/x/'),
  ])
    assert.equal(asks({...plan, path}), true, path);
});

test('the budget of an existing campaign and the enabling of one still ask, whatever the state says', () => {
  const budget = compile('campaign_budget_mutate_campaign_budgets', [
    {update: {resourceName: 'customers/123/campaignBudgets/1', amountMicros: '90000000'}, updateMask: 'amount_micros'},
  ]);
  const enable = campaigns([{update: {resourceName: campaign(9), status: 'ENABLED'}, updateMask: 'status'}]);
  for (const state of [undefined, [], paused]) {
    assert.equal(asks(budget, state), true, 'a budget update');
    assert.equal(asks(enable, state), true, 'enabling a campaign');
  }
});

/**
 * Item 3: the other children. Where each kind's parent is read: an asset group and a campaign criterion under their campaign; an ad and an
 * ad-group criterion (a keyword) under their ad group, which the review reads with its campaign's status beside it, so either one reading
 * PAUSED covers the child.
 */
const adGroup = id => 'customers/123/adGroups/' + id;
const adGroupRow = (id, groupStatus, campaignStatus) => ({
  adGroup: {resourceName: adGroup(id), ...(groupStatus ? {status: groupStatus} : {})},
  campaign: {...(campaignStatus ? {status: campaignStatus} : {})},
});
const ad = (status = 'ENABLED', parent = adGroup(100)) => ({
  create: {
    adGroup: parent,
    status,
    ad: {
      finalUrls: ['https://example.test/'],
      responsiveSearchAd: {
        headlines: [{text: 'Running shoes'}, {text: 'Free returns'}, {text: 'New season'}],
        descriptions: [{text: 'Shoes for every run.'}, {text: 'Order today.'}],
      },
    },
  },
});
const keyword = (extra = {}, parent = adGroup(100)) => ({
  create: {adGroup: parent, keyword: {text: 'dnu shoes', matchType: 'PHRASE'}, ...extra},
});
const location = (extra = {}, parent = campaign(9)) => ({
  create: {campaign: parent, location: {geoTargetConstant: 'geoTargetConstants/2840'}, ...extra},
});
const assetGroup = (status = 'ENABLED', parent = campaign(9)) => ({
  create: {name: 'DNU asset group', campaign: parent, status},
});
/** Each kind of child, its plan, and where its parent is read: the campaign alone, or the ad group with its campaign. */
const children = [
  {
    label: 'an asset group',
    parents: 'campaign',
    plan: () => compile('asset_group_mutate_asset_groups', [assetGroup()]),
    planUnder: parent => compile('asset_group_mutate_asset_groups', [assetGroup('ENABLED', parent)]),
  },
  {
    label: 'a location criterion of a campaign',
    parents: 'campaign',
    plan: () => compile('campaign_criterion_mutate_campaign_criteria', [location()]),
    planUnder: parent => compile('campaign_criterion_mutate_campaign_criteria', [location({}, parent)]),
  },
  {
    label: 'an ad',
    parents: 'ad group',
    plan: () => compile('ad_group_ad_mutate_ad_group_ads', [ad()]),
    planUnder: parent => compile('ad_group_ad_mutate_ad_group_ads', [ad('ENABLED', parent)]),
  },
  {
    label: 'a keyword',
    parents: 'ad group',
    plan: () => compile('ad_group_criterion_mutate_ad_group_criteria', [keyword({status: 'ENABLED'})]),
    planUnder: parent => compile('ad_group_criterion_mutate_ad_group_criteria', [keyword({status: 'ENABLED'}, parent)]),
  },
];
const readingsOf = (kind, ...statuses) =>
  kind.parents === 'campaign'
    ? stateOf(rowOf(9, statuses[1] ?? statuses[0]))
    : stateOf(adGroupRow(100, statuses[0], statuses[1]));
for (const kind of children) {
  test(kind.label + ' under a parent the state reads PAUSED asks for no flag, in every caller given the state', () => {
    const plan = kind.plan();
    assert.equal(asks(plan), true, 'with no state it asks, as it always did');
    const readings =
      kind.parents === 'campaign'
        ? [['PAUSED']]
        : [
            ['PAUSED', 'ENABLED'],
            ['ENABLED', 'PAUSED'],
            ['PAUSED', 'PAUSED'],
            ['PAUSED', undefined],
            [undefined, 'PAUSED'],
          ];
    for (const reading of readings) {
      const state = readingsOf(kind, ...reading);
      assert.equal(spendConfirmationError(plan, state), undefined, JSON.stringify(reading));
      assert.equal(effectClass(plan, state), 'config_write', JSON.stringify(reading));
      assert.equal(executeRefusal(plan, state), undefined, JSON.stringify(reading));
    }
  });
  test(
    kind.label +
      ' under a parent that does not read PAUSED asks for the flag: serving, removed, unnamed, absent, disagreeing',
    () => {
      const plan = kind.plan();
      const readings =
        kind.parents === 'campaign'
          ? [['ENABLED'], ['REMOVED'], ['UNSPECIFIED'], ['UNKNOWN'], ['paused'], [undefined]]
          : [
              ['ENABLED', 'ENABLED'],
              ['REMOVED', 'ENABLED'],
              ['ENABLED', 'REMOVED'],
              ['UNSPECIFIED', 'ENABLED'],
              ['ENABLED', 'UNKNOWN'],
              ['paused', 'ENABLED'],
              ['ENABLED', 'paused'],
              [undefined, 'ENABLED'],
              ['ENABLED', undefined],
              [undefined, undefined],
            ];
      for (const reading of readings)
        assert.equal(asks(plan, readingsOf(kind, ...reading)), true, JSON.stringify(reading));
      for (const [what, state] of [
        ['no rows', [{results: []}]],
        ['no reads', []],
        ['a state that is no list', {results: []}],
        [
          'another parent only',
          kind.parents === 'campaign' ? stateOf(rowOf(8, 'PAUSED')) : stateOf(adGroupRow(101, 'PAUSED', 'PAUSED')),
        ],
      ])
        assert.equal(asks(plan, state), true, what);
    },
  );
  test(
    kind.label + ': a parent read twice with two statuses, or one parent of two that reads otherwise, is not PAUSED',
    () => {
      const plan = kind.plan();
      const twice =
        kind.parents === 'campaign'
          ? [{results: [rowOf(9, 'PAUSED'), rowOf(9, 'ENABLED')]}]
          : [{results: [adGroupRow(100, 'PAUSED', 'ENABLED'), adGroupRow(100, 'ENABLED', 'ENABLED')]}];
      assert.equal(asks(plan, twice), true);
      const other = kind.planUnder(kind.parents === 'campaign' ? campaign(8) : adGroup(101));
      const both =
        kind.parents === 'campaign'
          ? stateOf(rowOf(9, 'PAUSED'), rowOf(8, 'ENABLED'))
          : stateOf(adGroupRow(100, 'PAUSED', 'PAUSED'), adGroupRow(101, 'ENABLED', 'ENABLED'));
      assert.equal(asks(other, both), true, 'the create names the parent that reads serving');
      assert.equal(asks(plan, both), false, 'the create names the parent that reads PAUSED');
    },
  );
}

test('a negative criterion, a status-free criterion and a PAUSED one under a PAUSED parent ask for nothing, and a removal beside them asks', () => {
  const group = stateOf(adGroupRow(100, 'PAUSED', 'ENABLED')),
    plan = extra => compile('ad_group_criterion_mutate_ad_group_criteria', [keyword(extra)]);
  for (const extra of [{}, {status: 'PAUSED'}, {status: 'ENABLED'}, {negative: true}, {cpcBidMicros: '1000000'}])
    assert.equal(asks(plan(extra), group), false, JSON.stringify(extra));
  const removal = {remove: 'customers/123/adGroupCriteria/100~200'};
  assert.equal(
    asks(compile('ad_group_criterion_mutate_ad_group_criteria', [keyword(), removal]), group),
    true,
    'a removal widens delivery',
  );
  const campaignLevel = stateOf(rowOf(9, 'PAUSED'));
  for (const extra of [{}, {negative: true}, {status: 'ENABLED'}])
    assert.equal(asks(compile('campaign_criterion_mutate_campaign_criteria', [location(extra)]), campaignLevel), false);
  assert.equal(
    asks(compile('campaign_criterion_mutate_campaign_criteria', [location(), removal]), campaignLevel),
    true,
  );
});

test('a Shopping tree node (a create that carries listing_group) is no covered child: it asks under a PAUSED ad group', () => {
  const group = stateOf(adGroupRow(100, 'PAUSED', 'PAUSED'));
  const node = {
    create: {adGroup: adGroup(100), status: 'ENABLED', listingGroup: {type: 'UNIT_INCLUDED'}},
  };
  assert.equal(asks(compile('ad_group_criterion_mutate_ad_group_criteria', [node]), group), true);
  const snake = {create: {ad_group: adGroup(100), status: 'ENABLED', listing_group: {type: 'UNIT_INCLUDED'}}};
  assert.equal(asks(compile('ad_group_criterion_mutate_ad_group_criteria', [snake]), group), true);
});

test('a create that names its parent in both spellings reads nothing, and asks', () => {
  const both = stateOf(adGroupRow(100, 'PAUSED', 'PAUSED'), adGroupRow(101, 'PAUSED', 'PAUSED'));
  const ads = compile('ad_group_ad_mutate_ad_group_ads', [
    {create: {...ad().create, ad_group: adGroup(100), adGroup: adGroup(101)}},
  ]);
  const keywords = compile('ad_group_criterion_mutate_ad_group_criteria', [
    {create: {...keyword().create, ad_group: adGroup(100), adGroup: adGroup(101)}},
  ]);
  assert.equal(asks(ads, both), true);
  assert.equal(asks(keywords, both), true);
  // The same creates naming one parent, in either spelling, are read.
  assert.equal(asks(compile('ad_group_ad_mutate_ad_group_ads', [ad()]), both), false);
  assert.equal(
    asks(
      compile('ad_group_ad_mutate_ad_group_ads', [
        {create: (({adGroup: _camel, ...rest}) => ({...rest, ad_group: adGroup(100)}))(ad().create)},
      ]),
      both,
    ),
    false,
  );
});
test('the kinds that are no children keep asking under a PAUSED parent: a shared list, an asset, an ad edit, a campaign shared set', () => {
  const state = [...stateOf(rowOf(9, 'PAUSED')), ...stateOf(adGroupRow(100, 'PAUSED', 'PAUSED'))];
  for (const plan of [
    compile('campaign_shared_set_mutate_campaign_shared_sets', [
      {create: {campaign: campaign(9), sharedSet: 'customers/123/sharedSets/5', status: 'ENABLED'}},
    ]),
    compile('shared_set_mutate_shared_sets', [
      {create: {name: 'DNU list', type: 'NEGATIVE_KEYWORDS', status: 'ENABLED'}},
    ]),
  ])
    assert.equal(asks(plan, state), true, plan.path);
});
