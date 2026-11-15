import test from 'node:test';
import assert from 'node:assert/strict';
import {Registry} from '../dist/src/catalog.js';
import {Compiler} from '../dist/src/compiler.js';
import {applyExecutionRisk} from '../dist/src/execution-risk.js';
import {authorizeExecution} from '../dist/src/preflight.js';
import {assertWriteShape} from '../dist/src/write-shape.js';
import {effectClass} from '../dist/src/effect-class.js';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {assertRefused} from './helpers/assert-refused.mjs';
import {advertiserWorld} from './helpers/tiktok-advertiser-noise.mjs';
import {standardBodies, standardCreates} from './helpers/tiktok-standard-creates.mjs';
import smartPlusCampaigns from './family-descriptors/tiktok-smart-plus-campaigns.mjs';
import smartPlusAdgroups from './family-descriptors/tiktok-smart-plus-adgroups.mjs';
import smartPlusAds from './family-descriptors/tiktok-smart-plus-ads.mjs';

/**
 * Q14, Round 2.5 (package r25-m0-t1; owner, 2026-11-15): a paused TikTok create, standard or Smart+, stops needing
 * spend_change_confirmed. A key named budget_mode or budget in a campaign created DISABLE named a spend the create
 * cannot make (L1-04, L5-11). What stays, and is proven below to refuse still: the owner's caps (POLICY_BUDGET_LIMIT),
 * allow_activation, the flag on every ENABLE of an existing object and on every update that widens spend, the paused
 * parent of an ENABLE child (PARENT_SERVING, also when the parent's status is unread, and again at execute), and the
 * shape that pins a campaign DISABLE.
 *
 * Part one decides a compiled request the way execute does (assertWriteShape, then authorizeExecution): the plan alone,
 * as the effect taxonomy and a plan's execute_requirements read it. Part two runs the real review lifecycle.
 */
const registry = new Registry(),
  compiler = new Compiler(registry),
  options = {mode: 'strict', flags: {}};
const actor = {tenantId: 't', userId: 'u', role: 'operator'},
  policy = {allowWrites: true, maxBudgetChange: 0, requireBeforeState: true};
const gateway = 'tiktok_native_action';
const compile = (action, payload, args = {}) =>
  applyExecutionRisk(compiler.compile(gateway, {action, account_id: '123', payload, dry_run: true, ...args}, options));
const create = (kind, edit = p => p) => {
  const {action, payload} = standardBodies('123')[kind];
  return compile(action, edit(structuredClone(payload)));
};
const smartPlus = (d, edit = p => p) =>
  compile(d.request.action, edit({advertiser_id: '123', ...structuredClone(d.request.payload)}));
const shapeRefusal = plan => {
  try {
    assertWriteShape(plan);
    return undefined;
  } catch (e) {
    return e;
  }
};
/** True when execute without spend_change_confirmed would be refused for the spend acknowledgement. */
const needsFlag = plan => {
  try {
    authorizeExecution(actor, plan, {dry_run: false, confirmed: true, idempotency_key: 'k'}, policy, true);
    return false;
  } catch (e) {
    if (e.code === 'SPEND_CONFIRMATION_REQUIRED') return true;
    throw e;
  }
};
const status = value => p => ({...p, operation_status: value});
const creativeStatus = value => p => ({...p, creatives: [{...p.creatives[0], operation_status: value}]});

const paused = [
  [
    'a standard campaign created DISABLE with a daily budget',
    () => create('campaign', p => ({...p, budget_mode: 'BUDGET_MODE_DAY', budget: 500})),
  ],
  ['a standard campaign created DISABLE with an infinite budget mode', () => create('campaign')],
  ['a standard ad group created DISABLE with budget, bid and schedule fields', () => create('adgroup')],
  [
    'a standard ad group created ENABLE (under a paused campaign the review reads)',
    () => create('adgroup', status('ENABLE')),
  ],
  ['a standard ad created DISABLE', () => create('ad')],
  [
    'a standard ad created ENABLE (under a paused ad group the review reads)',
    () => create('ad', creativeStatus('ENABLE')),
  ],
  ['a Smart+ campaign created DISABLE with a budget', () => smartPlus(smartPlusCampaigns)],
  ['a Smart+ ad group created DISABLE with a bid and no budget of its own', () => smartPlus(smartPlusAdgroups)],
  ['a Smart+ ad created DISABLE', () => smartPlus(smartPlusAds)],
];
for (const [what, plan] of paused)
  test(what + ' needs no spend_change_confirmed, and is no spending effect', () => {
    const p = plan();
    assert.equal(shapeRefusal(p), undefined, 'the create is valid');
    assert.equal(needsFlag(p), false);
    assert.equal(effectClass(p), 'config_write');
  });

// Each of these still needs it, or is refused before it matters.
const stays = [
  ['a standard campaign created ENABLE', () => create('campaign', status('ENABLE')), 'PAUSED_CREATION_REQUIRED'],
  [
    'a standard campaign that names no status (TikTok would enable it)',
    () => create('campaign', ({operation_status: _status, ...p}) => p),
    'PAUSED_CREATION_REQUIRED',
  ],
  [
    'a standard ad group that names no status',
    () => create('adgroup', ({operation_status: _status, ...p}) => p),
    'PAUSED_CREATION_REQUIRED',
  ],
  [
    'a standard ad created with two creatives, one of them ENABLE',
    () => create('ad', p => ({...p, creatives: [p.creatives[0], {...p.creatives[0], operation_status: 'ENABLE'}]})),
    'WRITE_CONTRACT_UNAVAILABLE',
  ],
  [
    'a Smart+ campaign created ENABLE',
    () => smartPlus(smartPlusCampaigns, status('ENABLE')),
    'INVALID_TIKTOK_SMART_PLUS_CAMPAIGN',
  ],
  [
    'a Smart+ ad group created ENABLE',
    () => smartPlus(smartPlusAdgroups, status('ENABLE')),
    'INVALID_TIKTOK_SMART_PLUS_ADGROUP',
  ],
  ['a Smart+ ad created ENABLE', () => smartPlus(smartPlusAds, status('ENABLE')), 'INVALID_TIKTOK_SMART_PLUS_AD'],
];
for (const [what, plan, code] of stays)
  test(what + ' still needs spend_change_confirmed, and is refused by its shape', () => {
    const p = plan();
    assertRefused(shapeRefusal(p), code);
    assert.equal(needsFlag(p), true);
    assert.equal(effectClass(p), 'spend_affecting');
  });

const existing = [
  [
    'enabling an existing campaign',
    () =>
      compile('tiktok_campaign_status_update', {
        advertiser_id: '123',
        campaign_ids: ['300'],
        operation_status: 'ENABLE',
      }),
  ],
  [
    'enabling an existing ad group',
    () =>
      compile('tiktok_adgroup_status_update', {advertiser_id: '123', adgroup_ids: ['200'], operation_status: 'ENABLE'}),
  ],
  [
    'raising the budget of an existing campaign',
    () => compile('tiktok_campaign_update', {advertiser_id: '123', campaign_id: '300', budget: 900}),
  ],
  [
    'changing the budget mode of an existing ad group',
    () =>
      compile('tiktok_adgroup_update', {
        advertiser_id: '123',
        adgroup_id: '200',
        budget_mode: 'BUDGET_MODE_TOTAL',
        budget: 900,
      }),
  ],
  [
    'changing the bid of an existing ad group',
    () => compile('tiktok_adgroup_update', {advertiser_id: '123', adgroup_id: '200', bid_price: 5}),
  ],
];
for (const [what, plan] of existing)
  test(what + ' still needs spend_change_confirmed', () => {
    const p = plan();
    assert.equal(shapeRefusal(p), undefined);
    assert.equal(needsFlag(p), true);
    assert.equal(effectClass(p), 'spend_affecting');
  });

test('the exemption is TikTok’s create routes alone: another provider, another method or another route still names a spend', () => {
  const campaign = create('campaign', p => ({...p, budget_mode: 'BUDGET_MODE_DAY', budget: 500}));
  // The same request under another provider's gateway, which names no such creation.
  assert.equal(needsFlag({...campaign, gateway: 'meta_native_action'}), true);
  assert.equal(needsFlag({...campaign, method: 'PUT'}), true);
  // A route that edits or copies something under the same advertiser, with the same fields and a DISABLE status.
  for (const path of [
    '/v1.3/campaign/update/',
    '/v1.3/ad/update/',
    '/v1.3/smart_plus/campaign/update/',
    '/v1.3/campaign/copy_task/create/',
  ])
    assert.equal(needsFlag({...campaign, path}), true, path);
  // A body that is no record.
  assert.equal(needsFlag({...campaign, body: [{operation_status: 'DISABLE', budget: 5}]}), true);
});

/** The review lifecycle: prepare and execute through MirrorService, the flag decided by what execute is given. */
const withCreates = async (body, changes = {}) => {
  const f = standardCreates(advertiserWorld({rotating: false, honourFields: false, ...changes}), {
    tenant: 'paused-create-spend',
  });
  try {
    return await body(f);
  } finally {
    f.close();
  }
};
const reviewOf = async (f, kind, edit) => {
  const p = await f.prepare(kind, edit);
  assert.equal(p.success, true, 'prepare: ' + JSON.stringify(p.error ?? p).slice(0, 600));
  return p.data;
};

for (const [what, kind, edit] of [
  ['a standard campaign created DISABLE', 'campaign', p => ({...p, budget_mode: 'BUDGET_MODE_DAY', budget: 500})],
  ['a standard ad group created DISABLE', 'adgroup', p => p],
  ['a standard ad group created ENABLE under a paused campaign', 'adgroup', status('ENABLE')],
  ['a standard ad created ENABLE under a paused ad group', 'ad', creativeStatus('ENABLE')],
])
  test(what + ' prepares without asking for spend_change_confirmed and executes without it', async () => {
    await withCreates(async f => {
      const review = await reviewOf(f, kind, edit);
      assert.equal(review.execute_requirements.spend_change_confirmed, false);
      const done = await f.execute(review, {});
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
      assert.equal(f.sent.length, 1);
    });
  });

test('an ENABLE ad group under a serving campaign is refused at prepare, with or without the flag', async () => {
  await withCreates(async f => {
    f.parents.campaign = 'ENABLE';
    assertRefused(await f.prepare('adgroup', status('ENABLE')), 'PARENT_SERVING', {writes: () => f.sent.length});
    f.parents.adgroup = 'ENABLE';
    assertRefused(await f.prepare('ad', creativeStatus('ENABLE')), 'PARENT_SERVING', {writes: () => f.sent.length});
  });
});

test('an ENABLE ad group whose campaign status cannot be read is refused at prepare', async () => {
  await withCreates(async f => {
    f.parents.campaign = undefined;
    const refused = await f.prepare('adgroup', status('ENABLE'));
    assertRefused(refused, 'PARENT_SERVING', {writes: () => f.sent.length});
    assert.equal(refused.error.details.parent_status, null);
  });
});

test('an ENABLE ad group reviewed under a paused campaign is not sent once the campaign serves, flag or none', async () => {
  for (const flags of [{}, {spend_change_confirmed: true}])
    await withCreates(async f => {
      const review = await reviewOf(f, 'adgroup', status('ENABLE'));
      f.parents.campaign = 'ENABLE';
      assertRefused(await f.execute(review, flags), ['STATE_CHANGED', 'PARENT_SERVING'], {writes: () => f.sent.length});
    });
});

const capped = [
  [
    'campaign',
    p => ({...p, budget_mode: 'BUDGET_MODE_DAY', budget: 500}),
    p => ({...p, budget_mode: 'BUDGET_MODE_DAY', budget: 80}),
  ],
  ['adgroup', p => ({...p, budget: 500}), p => ({...p, budget: 80})],
];
const ownerPolicy = (f, rules) =>
  saveSpendPolicy(f.store, f.owner, {scope: 'workspace', confirmed: true, policy: rules});
for (const [kind, over] of capped)
  test('the owner cap still refuses a paused ' + kind + ' create whose budget is above it', async () => {
    await withCreates(async f => {
      ownerPolicy(f, {enforcement: 'block', max_budget_native: 100});
      assertRefused(await f.prepare(kind, over), 'POLICY_BUDGET_LIMIT', {writes: () => f.sent.length});
    });
  });
for (const [kind, , within] of capped)
  test('a paused ' + kind + ' create within the owner cap executes without spend_change_confirmed', async () => {
    await withCreates(async f => {
      ownerPolicy(f, {enforcement: 'block', max_budget_native: 100});
      const review = await reviewOf(f, kind, within);
      assert.equal((await f.execute(review, {})).success, true);
      assert.equal(f.sent.length, 1);
    });
  });

test('allow_activation false still refuses an ENABLE child create under a paused parent', async () => {
  await withCreates(async f => {
    ownerPolicy(f, {allow_activation: false});
    assertRefused(await f.prepare('adgroup', status('ENABLE')), 'POLICY_ACTIVATION_FORBIDDEN', {
      writes: () => f.sent.length,
    });
  });
});
test('allow_activation false lets a paused create through without spend_change_confirmed', async () => {
  await withCreates(async f => {
    ownerPolicy(f, {allow_activation: false});
    const review = await reviewOf(f, 'adgroup', p => p);
    assert.equal((await f.execute(review, {})).success, true);
    assert.equal(f.sent.length, 1);
  });
});

for (const [what, args] of [
  [
    'enabling an existing campaign',
    {action: 'tiktok_campaign_status_update', payload: {campaign_ids: ['300'], operation_status: 'ENABLE'}},
  ],
  [
    'raising the budget of an existing campaign',
    {action: 'tiktok_campaign_update', payload: {campaign_id: '300', budget: 900}},
  ],
  [
    'changing the bid of an existing ad group',
    {action: 'tiktok_adgroup_update', payload: {adgroup_id: '200', bid_price: 5}},
  ],
])
  test(what + ' is still refused at execute without spend_change_confirmed, and sent with it', async () => {
    await withCreates(async f => {
      const prepared = await f.write({
        action: 'prepare',
        arguments: {account_id: f.world.id, action: args.action, payload: {advertiser_id: f.world.id, ...args.payload}},
      });
      assert.equal(prepared.success, true, JSON.stringify(prepared.error ?? prepared).slice(0, 600));
      assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
      const review = prepared.data,
        input = {action: 'execute', review_id: review.review_id, idempotency_key: review.review_id, confirmed: true};
      assertRefused(await f.write(input), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.sent.length});
      assert.equal((await f.write({...input, spend_change_confirmed: true})).success, true);
      assert.equal(f.sent.length, 1);
    });
  });
