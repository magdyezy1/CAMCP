import test from 'node:test';
import assert from 'node:assert/strict';
import {campaign, googleWorld} from '../dist/tests/helpers/google-write-fake.js';

/**
 * R2.5 field fix r25-field-pausedspend (the owner's "yes", 2026-11-19), the plan of the owner's report: a Google launch of 16 steps (a
 * budget, a paused campaign, its targeting, four ad groups with their keywords and ads, and a negatives step) cost about thirty extra
 * calls, because the review of every one of 14 steps asked for spend_change_confirmed and `run` stopped at each. Nothing in it can serve
 * until the campaign is enabled, which is a reviewed write of its own: with the plan's approval alone, `run` now needs no spend flag and
 * completes, and a plan whose steps would serve still stops at them. Synthetic customer 123.
 */
const ref = id => ({$ref: id + '#/data/results/0/resourceName'});
const step = (id, action, depends_on, operations) => ({
  id,
  kind: 'write',
  depends_on,
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: {action: 'google_ads_v23_' + action, payload: {operations}},
});
const adBody = parent => ({
  ad_group: parent,
  status: 'ENABLED',
  ad: {
    final_urls: ['https://example.test/'],
    responsive_search_ad: {
      headlines: [{text: 'Running shoes'}, {text: 'Free returns'}, {text: 'New season'}],
      descriptions: [{text: 'Shoes for every run.'}, {text: 'Order today.'}],
    },
  },
});
/** The children of an ad group: its group (ENABLED, with a bid), its keywords and its ad, under the campaign `parent` names. */
const family = (n, parent, after) => [
  step('adgroup_' + n, 'ad_group_mutate_ad_groups', after, [
    {
      create: {
        name: 'DNU group ' + n,
        campaign: parent,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
        cpc_bid_micros: '1500000',
      },
    },
  ]),
  step(
    'adgroup_' + n + '_keywords',
    'ad_group_criterion_mutate_ad_group_criteria',
    ['adgroup_' + n],
    [
      {
        create: {
          ad_group: ref('adgroup_' + n),
          status: 'ENABLED',
          keyword: {text: 'dnu shoes ' + n, match_type: 'EXACT'},
        },
      },
      {create: {ad_group: ref('adgroup_' + n), negative: true, keyword: {text: 'jobs', match_type: 'BROAD'}}},
    ],
  ),
  step(
    'adgroup_' + n + '_ads',
    'ad_group_ad_mutate_ad_group_ads',
    ['adgroup_' + n],
    [{create: adBody(ref('adgroup_' + n))}],
  ),
];
/** The owner's plan: 1 budget + 1 campaign + 1 targeting + 4 x (ad group, keywords, ads) + 1 negatives = 16 steps. */
const sixteenSteps = () => [
  step(
    'budget',
    'campaign_budget_mutate_campaign_budgets',
    [],
    [{create: {name: 'DNU budget', amount_micros: '40000000', delivery_method: 'STANDARD', explicitly_shared: false}}],
  ),
  step(
    'campaign',
    'campaign_mutate_campaigns',
    ['budget'],
    [
      {
        create: {
          name: 'DNU campaign',
          status: 'PAUSED',
          advertising_channel_type: 'SEARCH',
          campaign_budget: ref('budget'),
          manual_cpc: {},
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    ],
  ),
  step(
    'targeting',
    'campaign_criterion_mutate_campaign_criteria',
    ['campaign'],
    [
      {create: {campaign: ref('campaign'), location: {geo_target_constant: 'geoTargetConstants/2840'}}},
      {create: {campaign: ref('campaign'), language: {language_constant: 'languageConstants/1000'}}},
    ],
  ),
  ...[1, 2, 3, 4].flatMap(n => family(n, ref('campaign'), ['campaign'])),
  step(
    'negatives',
    'campaign_criterion_mutate_campaign_criteria',
    ['campaign'],
    [{create: {campaign: ref('campaign'), negative: true, keyword: {text: 'free', match_type: 'PHRASE'}}}],
  ),
];
const noParents = {campaigns: {}, adGroups: {}, assetGroups: {}};
const plan = async (x, steps) => {
  const created = await x.call('amcp_campaign', {action: 'create', name: 'DNU launch', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  return created.data.id;
};
/** The approval of a plan: what `approve` shows, and the call that records it, with or without the spend acknowledgement it offers. */
const approve = async (x, id, spend = false) => {
  const summary = (await x.call('amcp_campaign', {action: 'approve', id})).data;
  const approved = await x.call('amcp_campaign', {
    ...summary.next_call.arguments,
    ...(spend ? summary.next_call.add_after_user_approval : {}),
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  return summary;
};
/** `run` until it stops for a reason other than its own time limit; every call is counted. */
const run = async (x, id) => {
  const calls = [];
  for (let i = 0; i < 8; i++) {
    const out = await x.call('amcp_campaign', {action: 'run', id});
    assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
    calls.push(out.data);
    if (out.data.run?.stopped !== 'limit') break;
  }
  return calls;
};
const stopped = calls => calls.at(-1).run.stopped;

test('the 16-step plan of the owner’s report: with the approval alone, run needs no spend flag and completes', async () => {
  const x = googleWorld({world: noParents});
  try {
    const id = await plan(x, sixteenSteps());
    const summary = await approve(x, id);
    assert.equal(summary.approval.steps.length, 16);
    assert.equal(x.writes(), 0, 'approving sends nothing');
    const calls = await run(x, id);
    assert.equal(stopped(calls), 'complete', JSON.stringify(calls.at(-1).run).slice(0, 600));
    assert.equal(calls.at(-1).state, 'complete');
    assert.equal(x.writes(), 16, 'one provider write for each step, and no more');
    assert.ok(calls.length <= 2, 'run took ' + calls.length + ' calls');
    const executed = calls.flatMap(c => c.run.executed);
    assert.equal(new Set(executed).size, 16);
    // The campaign was created PAUSED, and so were nothing but its children's own statuses: it serves nothing until it is enabled.
    const made = [...x.created.values()].find(r => r.advertisingChannelType === 'SEARCH');
    assert.equal(made.status, 'PAUSED');
  } finally {
    x.store.close();
  }
});

test('the same plan through prepare_next: no step of it names spend_change_confirmed in its execute_requirements', async () => {
  const x = googleWorld({world: noParents});
  try {
    const id = await plan(x, sixteenSteps());
    await approve(x, id);
    for (let n = 0; n < 16; n++) {
      const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
      assert.equal(prepared.success, true, n + ' ' + JSON.stringify(prepared).slice(0, 600));
      const review = prepared.data.review;
      assert.ok(review?.review_id, n + ' ' + JSON.stringify(prepared.data).slice(0, 400));
      assert.equal(review.execute_requirements.spend_change_confirmed, false, prepared.data.step_id);
      assert.equal(prepared.data.next_call.add_after_user_approval, undefined, prepared.data.step_id);
      const executed = await x.call('amcp_campaign', {
        action: 'execute_next',
        id,
        review_id: review.review_id,
        idempotency_key: review.review_id,
        confirmed: true,
      });
      assert.equal(executed.success, true, prepared.data.step_id + ' ' + JSON.stringify(executed).slice(0, 600));
    }
    assert.equal(x.writes(), 16);
  } finally {
    x.store.close();
  }
});

test('children under an existing campaign that serves still stop run at the first of them, until the approval gives the flag (Q1)', async () => {
  for (const spend of [false, true]) {
    const x = googleWorld({
      world: {campaigns: {[campaign(9)]: {status: 'ENABLED', channel: 'SEARCH'}}, adGroups: {}, assetGroups: {}},
    });
    try {
      const id = await plan(x, family(1, campaign(9), []));
      await approve(x, id, spend);
      const calls = await run(x, id);
      if (spend) {
        assert.equal(stopped(calls), 'complete', JSON.stringify(calls.at(-1).run).slice(0, 600));
        assert.equal(x.writes(), 3);
      } else {
        assert.equal(stopped(calls), 'needs_spend_change_confirmed', JSON.stringify(calls.at(-1).run).slice(0, 600));
        assert.equal(calls.at(-1).step_id, 'adgroup_1');
        assert.equal(x.writes(), 0, 'nothing was sent before the user gave the flag');
      }
    } finally {
      x.store.close();
    }
  }
});

test('enabling an existing campaign, in a plan, still stops run for the flag, and so does a budget raise', async () => {
  const x = googleWorld({
    world: {
      campaigns: {[campaign(9)]: {status: 'PAUSED', channel: 'SEARCH'}},
      adGroups: {},
      assetGroups: {},
      campaignBudgets: {'customers/123/campaignBudgets/1': {}},
    },
  });
  try {
    for (const [label, steps] of [
      [
        'enable',
        [
          step(
            'enable',
            'campaign_mutate_campaigns',
            [],
            [{update: {resource_name: campaign(9), status: 'ENABLED'}, update_mask: 'status'}],
          ),
        ],
      ],
      [
        'raise',
        [
          step(
            'raise',
            'campaign_budget_mutate_campaign_budgets',
            [],
            [
              {
                update: {resource_name: 'customers/123/campaignBudgets/1', amount_micros: '90000000'},
                update_mask: 'amount_micros',
              },
            ],
          ),
        ],
      ],
    ]) {
      const id = await plan(x, steps);
      await approve(x, id);
      const calls = await run(x, id);
      assert.equal(
        stopped(calls),
        'needs_spend_change_confirmed',
        label + ' ' + JSON.stringify(calls.at(-1).run).slice(0, 400),
      );
      assert.equal(x.writes(), 0, label);
    }
  } finally {
    x.store.close();
  }
});

test('a campaign enabled between two steps of the plan takes the exemption from the steps after it', async () => {
  const x = googleWorld({world: noParents});
  try {
    const id = await plan(x, sixteenSteps());
    await approve(x, id);
    for (const expected of ['budget', 'campaign']) {
      const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
      assert.equal(prepared.data.step_id, expected);
      assert.equal(prepared.data.review.execute_requirements.spend_change_confirmed, false);
      const executed = await x.call('amcp_campaign', {
        action: 'execute_next',
        id,
        review_id: prepared.data.review.review_id,
        idempotency_key: prepared.data.review.review_id,
        confirmed: true,
      });
      assert.equal(executed.success, true, JSON.stringify(executed).slice(0, 600));
    }
    // Someone enables the new campaign (outside the plan): its children would now serve.
    const made = [...x.created.values()].find(r => r.advertisingChannelType === 'SEARCH');
    made.status = 'ENABLED';
    const calls = await run(x, id);
    assert.equal(stopped(calls), 'needs_spend_change_confirmed', JSON.stringify(calls.at(-1).run).slice(0, 600));
    assert.equal(x.writes(), 2, 'nothing of its children was sent');
  } finally {
    x.store.close();
  }
});

test('a plan step execute_next without the flag is refused when its review asks for it', async () => {
  const x = googleWorld({
    world: {campaigns: {[campaign(9)]: {status: 'ENABLED', channel: 'SEARCH'}}, adGroups: {}, assetGroups: {}},
  });
  try {
    const id = await plan(x, family(1, campaign(9), []));
    await approve(x, id);
    const prepared = await x.call('amcp_campaign', {action: 'prepare_next', id});
    assert.equal(prepared.data.review.execute_requirements.spend_change_confirmed, true);
    const refused = await x.call('amcp_campaign', {
      action: 'execute_next',
      id,
      review_id: prepared.data.review.review_id,
      idempotency_key: prepared.data.review.review_id,
      confirmed: true,
    });
    // A plan reports the refusal of a step in the plan's own view: the step stays review_ready, and nothing was sent.
    const row = refused.data.steps.find(s => s.id === 'adgroup_1');
    assert.equal(row.status, 'review_ready');
    assert.equal(row.error, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(x.writes(), 0);
  } finally {
    x.store.close();
  }
});
