import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {saveSpendPolicy} from '../dist/src/spend-policy.js';
import {
  approvalFields,
  approvalMoney,
  approvalSpends,
  approvalStep,
  approvalSummary,
} from '../dist/src/plan-approval.js';
import * as spendEffects from '../dist/src/campaign-spend-effects.js';
import {providerAdapters} from '../dist/src/provider-adapters.js';

/**
 * R2.5 package r25-approval-effects (lead review of the field3 merge, S2-1): a plan approval stands in for the confirmation of each
 * step's review, so it must show every step that deletes, by the one rule the reviews apply and not by the action's name. A TikTok step
 * that deletes through `operation_status: DELETE` was summarized as `{fields_total: 0, spend_effect: false}`, and two campaigns were
 * deleted under that approval. Each platform below deletes in its own way (a status value, a `remove` operation, a DELETE method, a
 * family hook); the summary compiles each step as its review does, so none of them is a list of spellings. Everything is synthetic and
 * local: nothing is sent.
 */
let tenants = 0;
const step = (id, gateway, args, extra = {}) => ({
  id,
  kind: 'write',
  gateway,
  connection_id: 'c',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on: [],
  ...extra,
});
const planOf = steps => ({id: 'plan1', plan_hash: 'ph', steps});
/** The summary of a plan of steps, with the effects its steps compile to. */
function summarize(f, steps) {
  assert.equal(typeof spendEffects.stepEffects, 'function', 'campaign-spend-effects exports stepEffects');
  return approvalSummary(planOf(steps), spendEffects.stepEffects(f.service, steps));
}
const entry = (summary, id) => summary.steps.find(s => s.id === id);

/**
 * One deleting step and one sibling that only pauses, for each platform with a write family that can delete or end an entity. `via` says
 * how the platform deletes: a value of a status field, a `remove` operation, or a DELETE method.
 */
const platforms = [
  {
    name: 'google',
    gateway: 'google_ads_native_action',
    via: 'a remove operation',
    deletes: {action: 'REMOVE_CAMPAIGN', payload: {operations: [{remove: 'customers/123/campaigns/1'}]}},
    pauses: {
      action: 'UPDATE_CAMPAIGN',
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/1', status: 'PAUSED'}, update_mask: 'status'}],
      },
    },
  },
  {
    name: 'google (a status of REMOVED)',
    gateway: 'google_ads_native_action',
    via: 'status REMOVED',
    deletes: {
      action: 'UPDATE_CAMPAIGN',
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/1', status: 'REMOVED'}, update_mask: 'status'}],
      },
    },
    pauses: {
      action: 'UPDATE_CAMPAIGN',
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/1', status: 'PAUSED'}, update_mask: 'status'}],
      },
    },
  },
  {
    name: 'meta',
    gateway: 'meta_native_action',
    via: 'status DELETED',
    deletes: {action: 'meta_campaign_update', campaign_id: '111', payload: {status: 'DELETED'}},
    pauses: {action: 'meta_campaign_update', campaign_id: '111', payload: {status: 'PAUSED'}},
  },
  {
    name: 'tiktok',
    gateway: 'tiktok_native_action',
    via: 'operation_status DELETE',
    deletes: {
      action: 'tiktok_campaign_status_update',
      payload: {advertiser_id: '123', campaign_ids: ['1'], operation_status: 'DELETE'},
    },
    pauses: {
      action: 'tiktok_campaign_status_update',
      payload: {advertiser_id: '123', campaign_ids: ['1'], operation_status: 'DISABLE'},
    },
  },
  {
    name: 'tiktok (smart+)',
    gateway: 'tiktok_native_action',
    via: 'operation_status DELETE',
    deletes: {
      action: 'tiktok_smart_plus_campaign_status_update',
      payload: {advertiser_id: '123', campaign_ids: ['1'], operation_status: 'DELETE'},
    },
    pauses: {
      action: 'tiktok_smart_plus_campaign_status_update',
      payload: {advertiser_id: '123', campaign_ids: ['1'], operation_status: 'DISABLE'},
    },
  },
  {
    name: 'microsoft',
    gateway: 'microsoft_ads_native_action',
    via: 'Status Deleted',
    deletes: {action: 'UpdateCampaigns', payload: {Campaigns: [{Id: '1', Status: 'Deleted'}]}},
    pauses: {action: 'UpdateCampaigns', payload: {Campaigns: [{Id: '1', Status: 'Paused'}]}},
  },
  {
    name: 'linkedin',
    gateway: 'linkedin_native_action',
    via: 'status PENDING_DELETION',
    deletes: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      path_params: {ad_account_id: '123', campaign_id: '1'},
      restli_method: 'PARTIAL_UPDATE',
      payload: {patch: {$set: {status: 'PENDING_DELETION'}}},
    },
    pauses: {
      action: 'linkedin_rest_ad_accounts_ad_account_id_ad_campaigns_campaign_id_post',
      path_params: {ad_account_id: '123', campaign_id: '1'},
      restli_method: 'PARTIAL_UPDATE',
      payload: {patch: {$set: {status: 'PAUSED'}}},
    },
  },
  {
    name: 'reddit',
    gateway: 'reddit_native_action',
    via: 'configured_status DELETED',
    deletes: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'UPDATE_CAMPAIGN',
        payload: {data: {configured_status: 'DELETED'}},
        params: {campaign_id: '100'},
      },
    },
    pauses: {
      operation: 'reddit_campaign_ops',
      arguments: {
        action: 'UPDATE_CAMPAIGN',
        payload: {data: {configured_status: 'PAUSED'}},
        params: {campaign_id: '100'},
      },
    },
  },
  {
    name: 'dv360',
    gateway: 'dv360_native_action',
    via: 'entity_status scheduled for deletion',
    deletes: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
      params: {advertiserId: '123', campaignId: '1', updateMask: 'entityStatus'},
      body: {entityStatus: 'ENTITY_STATUS_SCHEDULED_FOR_DELETION'},
    },
    pauses: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
      params: {advertiserId: '123', campaignId: '1', updateMask: 'entityStatus'},
      body: {entityStatus: 'ENTITY_STATUS_PAUSED'},
    },
  },
  {
    name: 'dv360 (a DELETE method)',
    gateway: 'dv360_native_action',
    via: 'the DELETE method',
    deletes: {action: 'DV360_ADVERTISERS_CAMPAIGNS_DELETE', params: {advertiserId: '123', campaignId: '1'}},
    pauses: {
      action: 'DV360_ADVERTISERS_CAMPAIGNS_PATCH',
      params: {advertiserId: '123', campaignId: '1', updateMask: 'entityStatus'},
      body: {entityStatus: 'ENTITY_STATUS_PAUSED'},
    },
  },
  {
    name: 'snapchat',
    gateway: 'snapchat_native_action',
    via: 'the DELETE method',
    deletes: {action: 'snapchat_campaign_delete', campaign_id: 'c1'},
    pauses: {
      action: 'snapchat_campaign_update',
      params: {ad_account_id: '123', campaign_id: 'c1'},
      body: [{op: 'replace', path: '/status', value: 'PAUSED'}],
    },
  },
  {
    name: 'x',
    gateway: 'x_ads_native_action',
    via: 'the DELETE method',
    deletes: {action: 'x_accounts_account_id_campaigns_campaign_id_delete', campaign_id: 'c1'},
    pauses: {
      action: 'x_accounts_account_id_campaigns_campaign_id_put',
      params: {account_id: '123', campaign_id: 'c1'},
      payload: {entity_status: 'PAUSED'},
    },
  },
  {
    name: 'apple',
    gateway: 'apple_ads_native_action',
    via: 'the DELETE method',
    deletes: {action: 'apple_ads_v1_campaign_delete', params: {id: '1'}},
    pauses: {action: 'apple_ads_v1_campaign_update', path_params: {id: '1'}, payload: {status: 'PAUSED'}},
  },
];

test('every platform that can delete shows its deleting step as destructive and its pausing sibling as not', t => {
  const f = googleReconcileFixture({tenant: 'approval-effects-' + ++tenants});
  t.after(() => f.store.close());
  const unseen = [];
  for (const p of platforms) {
    const summary = summarize(f, [step('remove', p.gateway, p.deletes), step('pause', p.gateway, p.pauses)]);
    assert.deepEqual(
      entry(summary, 'remove').effects,
      {destructive: true, irreversible: true},
      p.name + ' via ' + p.via,
    );
    assert.equal(entry(summary, 'pause').effects, undefined, p.name + ' pause shows no effect');
    assert.deepEqual(
      summary.effects.map(e => e.step_id),
      ['remove'],
      p.name + ': the plan-level effects name the deleting step and no other',
    );
    if (!summary.effects.length) unseen.push(p.name);
  }
  assert.deepEqual(unseen, []);
});

test('the platforms with a write family are each covered, or cannot delete through a plan for a reason named here', () => {
  const covered = new Set(platforms.map(p => p.gateway));
  // The adapters with a body-value deletion declaration, and every active adapter's reviewed writes, are all in the table above.
  for (const a of providerAdapters.filter(a => a.deletions && a.status === 'active'))
    assert.ok(covered.has(a.gateway), a.gateway + ' declares a deletion and has a case above');
  // Not in the table, with the reason: Google Business, GA4, Search Console, Drive, Sheets and Adjust have no campaign, ad group or ad to
  // end; GTM deletes workspace entities by its own family hooks (src/gtm-*.ts), which the same compile asks; Criteo, WooCommerce and Amazon
  // are parked (no write family is reachable through a plan).
  const reasons = new Set([
    'google_business',
    'ga4',
    'gsc',
    'drive',
    'sheets',
    'adjust',
    'gtm',
    'criteo',
    'woocommerce',
    'amazon',
  ]);
  const missing = providerAdapters.filter(a => !covered.has(a.gateway) && !reasons.has(a.id)).map(a => a.id);
  assert.deepEqual(missing, [], 'a platform that is neither covered nor explained');
});

test('a step that cannot be compiled is shown as possibly destructive, never as safe', t => {
  const f = googleReconcileFixture({tenant: 'approval-effects-' + ++tenants});
  t.after(() => f.store.close());
  const unknown = step('odd', 'tiktok_native_action', {action: 'tiktok_no_such_action', payload: {}}),
    summary = summarize(f, [
      unknown,
      step('pause', 'meta_native_action', {
        action: 'meta_campaign_update',
        campaign_id: '1',
        payload: {status: 'PAUSED'},
      }),
    ]);
  assert.deepEqual(entry(summary, 'odd').effects, {destructive: true, irreversible: true, checked: false});
  assert.equal(entry(summary, 'pause').effects, undefined);
  assert.deepEqual(
    summary.effects.map(e => e.step_id),
    ['odd'],
  );
  // A write step the effects name no entry for is judged the same way (a map that is incomplete, or a compile that failed altogether).
  const steps = [
    step('a', 'meta_native_action', {action: 'meta_campaign_update', campaign_id: '1', payload: {status: 'PAUSED'}}),
  ];
  for (const map of [
    new Map(),
    new Map([['other', {spend: false, destructive: false, irreversible: false, checked: true}]]),
  ])
    assert.deepEqual(entry(approvalSummary(planOf(steps), map), 'a').effects, {
      destructive: true,
      irreversible: true,
      checked: false,
    });
});

test('a Google remove operation and a DELETE-method step are destructive by the old rule too, with no compile at all', () => {
  const steps = [
    step('remove', 'google_ads_native_action', {
      action: 'x',
      payload: {operations: [{remove: 'customers/123/campaigns/1'}]},
    }),
    step('gone', 'meta_native_action', {action: 'meta_campaign_delete', campaign_id: '1'}),
    step('keep', 'meta_native_action', {action: 'meta_campaign_update', campaign_id: '1', payload: {status: 'PAUSED'}}),
  ];
  const summary = approvalSummary(planOf(steps));
  assert.deepEqual(entry(summary, 'remove').effects, {destructive: true, irreversible: true});
  assert.deepEqual(entry(summary, 'gone').effects, {destructive: true, irreversible: true});
  assert.equal(entry(summary, 'keep').effects, undefined);
  assert.deepEqual(
    summary.effects.map(e => e.step_id),
    ['remove', 'gone'],
  );
});

test('the summary_hash of a plan with no deleting step and no newly listed status key is the one of 47f04276', t => {
  const f = googleReconcileFixture({tenant: 'approval-effects-' + ++tenants});
  t.after(() => f.store.close());
  const steps = [
    step('campaign', 'meta_native_action', {
      action: 'meta_campaign_update',
      campaign_id: '1',
      payload: {name: 'Renamed', daily_budget: '5000', status: 'PAUSED'},
    }),
    step('rename', 'google_ads_native_action', {
      action: 'UPDATE_CAMPAIGN',
      payload: {
        operations: [{update: {resource_name: 'customers/123/campaigns/1', name: 'Renamed'}, update_mask: 'name'}],
      },
    }),
  ];
  // Pinned from the summary this plan had at 47f04276, with the spend effects the compile gave each step then (a plan of a boolean map).
  const pinned = '327e4e30b549db93c58dddc9471a8aff432dacd726ab37406a8679fb93f87302';
  const legacy = approvalSummary(
    planOf(steps),
    new Map([
      ['campaign', true],
      ['rename', false],
    ]),
  );
  assert.equal(legacy.summary_hash, pinned);
  const compiled = summarize(f, steps);
  assert.deepEqual(
    compiled.steps.map(s => s.spend_effect),
    [true, false],
  );
  assert.equal(compiled.summary_hash, pinned);
  assert.equal(approvalSummary(planOf(steps)).summary_hash, approvalSummary(planOf(steps)).summary_hash);
});

test('a plan that deletes under the destructive tier of the owner policy still stops for its acknowledgement, and its approval summary now shows the deletion', async t => {
  const f = googleReconcileFixture({tenant: 'approval-effects-' + ++tenants});
  t.after(() => f.store.close());
  f.row('campaign', {resource_name: at('campaigns', '10'), name: 'Existing', status: 'PAUSED'});
  for (const n of [1, 2])
    f.row('ad_group', {
      resource_name: at('adGroups', String(20 + n)),
      name: 'Group ' + n,
      status: 'PAUSED',
      campaign: at('campaigns', '10'),
    });
  saveSpendPolicy(
    f.store,
    {tenantId: f.actor.tenantId, userId: 'owner', role: 'admin'},
    {
      gateway: 'google_ads_native_action',
      account_id: '123',
      confirmed: true,
      policy: {allow_deletion: true, require_destructive_confirmation: true},
    },
  );
  const action = 'google_ads_v23_ad_group_mutate_ad_groups';
  const g = (id, payload) => step(id, 'google_ads_native_action', {action, payload}, {connection_id: 'g'});
  const made = await f.call('amcp_campaign', {
    action: 'create',
    name: 'Tidy up',
    brief: 'Synthetic.',
    steps: [
      g('rename', {
        operations: [{update: {resource_name: at('adGroups', '21'), name: 'Renamed'}, update_mask: 'name'}],
      }),
      g('remove', {operations: [{remove: at('adGroups', '22')}]}),
    ],
  });
  assert.equal(made.success, true, JSON.stringify(made).slice(0, 600));
  const id = made.data.id,
    shown = await f.call('amcp_campaign', {action: 'approve', id});
  assert.equal(shown.success, true, JSON.stringify(shown).slice(0, 600));
  assert.deepEqual(
    shown.data.approval.steps.map(s => [s.id, s.effects?.destructive === true]),
    [
      ['rename', false],
      ['remove', true],
    ],
  );
  assert.deepEqual(shown.data.approval.effects, [{step_id: 'remove', destructive: true, irreversible: true}]);
  const approved = await f.call('amcp_campaign', {
    ...shown.data.next_call.arguments,
    ...(shown.data.next_call.add_after_user_approval ?? {}),
  });
  assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
  const ran = await f.call('amcp_campaign', {action: 'run', id});
  assert.equal(ran.data.run.stopped, 'needs_destructive_confirmed', JSON.stringify(ran.data.run).slice(0, 400));
  assert.deepEqual(ran.data.run.executed, ['rename']);
  assert.equal(f.db.ad_group.length, 2, 'nothing was deleted');
});
