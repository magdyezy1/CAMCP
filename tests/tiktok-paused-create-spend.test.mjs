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
 * parent of an ENABLE child (PARENT_SERVING when the parent's status is unread, and again at execute; under a serving
 * parent the child asks for the flag since R2.5 M4, Q1), and the shape that pins a campaign DISABLE.
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
  // R2.5 M4 (r25-m4-smartweb, L1-05): the Smart+ ad group and ad are paused-parent levels now, so their ENABLE moved here from `stays`
  // below, as the standard ones are. Their parents are read at prepare and execute (tests/tiktok-smart-plus-enable-children.test.mjs).
  [
    'a Smart+ ad group created ENABLE (under a paused campaign the review reads)',
    () => smartPlus(smartPlusAdgroups, status('ENABLE')),
  ],
  [
    'a Smart+ ad created ENABLE (under a paused ad group or campaign the review reads)',
    () => smartPlus(smartPlusAds, status('ENABLE')),
  ],
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
  // The Smart+ ad group and ad created ENABLE were rows here until R2.5 M4 (r25-m4-smartweb, L1-05): see the `paused` rows above. What
  // stays for the ad group is a status that is neither DISABLE nor ENABLE, which TikTok would read as its default (ENABLE). The ad names no
  // spend field, so its own spelling is proven refused by the test after this table.
  [
    'a Smart+ ad group that names a status of its own spelling',
    () => smartPlus(smartPlusAdgroups, status('PAUSED')),
    'INVALID_TIKTOK_SMART_PLUS_ADGROUP',
  ],
];
for (const [what, plan, code] of stays)
  test(what + ' still needs spend_change_confirmed, and is refused by its shape', () => {
    const p = plan();
    assertRefused(shapeRefusal(p), code);
    assert.equal(needsFlag(p), true);
    assert.equal(effectClass(p), 'spend_affecting');
  });

test('a Smart+ ad that names a status of its own spelling is refused by its shape (R2.5 M4, L1-05)', () => {
  assertRefused(shapeRefusal(smartPlus(smartPlusAds, status('PAUSED'))), 'INVALID_TIKTOK_SMART_PLUS_AD');
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

/**
 * The White Friday request, with invented values: a paused Search traffic campaign with an infinite budget mode. Both
 * defects met in it: the advertiser row it read rotated (T1, STATE_CHANGED at execute) and its budget_mode asked for
 * spend_change_confirmed (Q14). It now prepares and executes with the licence ticket rotating, the balance falling and no
 * flag, and sends exactly what was reviewed. Run both with TikTok narrowing its answer to `fields` (what it does) and
 * ignoring them (the projection alone holds the row steady).
 */
for (const honourFields of [true, false])
  test(
    'the White Friday campaign create prepares and executes with a rotating advertiser row and no spend flag (TikTok ' +
      (honourFields ? 'narrows its answer to fields' : 'ignores fields') +
      ')',
    async () => {
      await withCreates(
        async f => {
          const review = await reviewOf(f, 'campaign', p => ({
            ...p,
            campaign_name: 'Synthetic_WhiteFriday_Search_Traffic',
            is_search_campaign: true,
          }));
          assert.equal(review.execute_requirements.spend_change_confirmed, false);
          const done = await f.execute(review, {});
          assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
          assert.ok(f.world.reads >= 2, 'the advertiser is read at prepare and again at execute');
          assert.deepEqual(f.sent, [
            {
              path: '/v1.3/campaign/create/',
              body: {
                advertiser_id: f.world.id,
                campaign_name: 'Synthetic_WhiteFriday_Search_Traffic',
                objective_type: 'TRAFFIC',
                is_search_campaign: true,
                budget_mode: 'BUDGET_MODE_INFINITE',
                operation_status: 'DISABLE',
              },
            },
          ]);
        },
        {rotating: true, honourFields},
      );
    },
  );

// R2.5 M4, package r25-m4-smartops (Q1, owner 2026-11-15; the lead's design (b) of L5): this test was "an ENABLE ad group under a serving
// campaign is refused at prepare, with or without the flag". Q1 lets the child start ENABLE there with the spend flag, which the review's
// state now asks for: at prepare (execute_requirements) and at execute (refused without it, sent once with it). An unread parent still
// refuses (the next test), and the full matrix is tests/tiktok-serving-parent-children.test.mjs.
test('an ENABLE ad group or ad under serving parents asks for spend_change_confirmed, is refused without it and sent once with it (Q1)', async () => {
  for (const [kind, edit] of [
    ['adgroup', status('ENABLE')],
    ['ad', creativeStatus('ENABLE')],
  ])
    await withCreates(async f => {
      f.parents.campaign = 'ENABLE';
      f.parents.adgroup = 'ENABLE';
      const review = await reviewOf(f, kind, edit);
      assert.equal(review.execute_requirements.spend_change_confirmed, true, kind);
      assert.equal(review.effect, 'spend_affecting', kind);
      assertRefused(await f.execute(review, {}), 'SPEND_CONFIRMATION_REQUIRED', {writes: () => f.sent.length});
      const done = await f.execute(review, {spend_change_confirmed: true});
      assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 600));
      assert.equal(f.sent.length, 1, kind);
    });
});

test('an ENABLE ad group whose campaign status cannot be read is refused at prepare', async () => {
  await withCreates(async f => {
    f.parents.campaign = undefined;
    const refused = await f.prepare('adgroup', status('ENABLE'));
    assertRefused(refused, 'PARENT_SERVING', {writes: () => f.sent.length});
    assert.equal(refused.error.details.parent_status, null);
    // R2.5 M4 (r25-m4-smartops, Q1): the refusal says the parent was not read, which is all that refuses it now.
    assert.equal(refused.error.details.parent_unread, true);
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
