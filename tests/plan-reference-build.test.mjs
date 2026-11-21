import test from 'node:test';
import assert from 'node:assert/strict';
import {at, googleReconcileFixture} from './helpers/google-reconcile-fixture.mjs';
import {campaignPreflight} from '../dist/src/campaign-preflight.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Package r25-field3-refs, item 4 (the owner's second Google report of 2026-11-21, AMCP-02): a later step names the campaign or the asset group a
 * build creates. The preflight refused every pointer into a build, `/data/mutateOperationResponses/<i>/<result>/resourceName`, because its Google hook
 * knew only the service form `/data/results/<i>/resourceName` and read `operations` where a build holds `mutateOperations` (it answered
 * INVALID_REFERENCE with `details: {}`), although prepare would have resolved the pointer: the step result of a build keeps Google's own answer.
 * The hook now accepts exactly that grammar, with the result field the operation at <i> answers with (the build’s own table of operation types), in the
 * camelCase of Google's JSON, and says what to send when it refuses. Customer 123 and invented numbers only.
 */
const build = 'google_ads_v23_google_ads_mutate',
  pointerTo = (i, result) => '/data/mutateOperationResponses/' + i + '/' + result + '/resourceName';
let tenants = 0;
const google = () => googleReconcileFixture({tenant: 'plan-reference-build-' + ++tenants});
const step = (id, args, depends_on = []) => ({
  id,
  kind: 'write',
  gateway: 'google_ads_native_action',
  connection_id: 'g',
  account_id: '123',
  description: id,
  arguments: args,
  depends_on,
});
const ref = pointer => ({$ref: 'ar_build#' + pointer});

/** A Performance Max build; its operations are 0 the budget, 1 the campaign, 2 to 8 the texts, 9 the asset group, 10 to 16 their links. */
function pmaxBuild() {
  const text = (n, value) => ({
      asset_operation: {create: {resource_name: at('assets', '-' + n), text_asset: {text: value}}},
    }),
    words = [
      ['HEADLINE', 'Synthetic one'],
      ['HEADLINE', 'Synthetic two'],
      ['HEADLINE', 'Synthetic three'],
      ['LONG_HEADLINE', 'Synthetic long headline'],
      ['DESCRIPTION', 'Synthetic words.'],
      ['DESCRIPTION', 'More words.'],
      ['BUSINESS_NAME', 'Synthetic'],
    ];
  return [
    {
      campaign_budget_operation: {
        create: {
          resource_name: at('campaignBudgets', '-1'),
          name: 'Synthetic budget',
          amount_micros: '50000000',
          delivery_method: 'STANDARD',
          explicitly_shared: false,
        },
      },
    },
    {
      campaign_operation: {
        create: {
          resource_name: at('campaigns', '-2'),
          name: 'Synthetic PMax',
          status: 'PAUSED',
          advertising_channel_type: 'PERFORMANCE_MAX',
          campaign_budget: at('campaignBudgets', '-1'),
          maximize_conversions: {},
          brand_guidelines_enabled: false,
          contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        },
      },
    },
    ...words.map(([, value], i) => text(100 + i, value)),
    {
      asset_group_operation: {
        create: {
          resource_name: at('assetGroups', '-20'),
          name: 'Synthetic group',
          campaign: at('campaigns', '-2'),
          final_urls: ['https://example.test/'],
          status: 'ENABLED',
        },
      },
    },
    ...words.map(([type], i) => ({
      asset_group_asset_operation: {
        create: {asset_group: at('assetGroups', '-20'), asset: at('assets', '-' + (100 + i)), field_type: type},
      },
    })),
    {
      asset_group_asset_operation: {
        create: {asset_group: at('assetGroups', '-20'), asset: at('assets', '501'), field_type: 'MARKETING_IMAGE'},
      },
    },
    {
      asset_group_asset_operation: {
        create: {
          asset_group: at('assetGroups', '-20'),
          asset: at('assets', '502'),
          field_type: 'SQUARE_MARKETING_IMAGE',
        },
      },
    },
    {
      asset_group_asset_operation: {
        create: {asset_group: at('assetGroups', '-20'), asset: at('assets', '503'), field_type: 'LOGO'},
      },
    },
  ];
}
const buildStep = () => step('ar_build', {action: build, payload: {mutate_operations: pmaxBuild()}});
const campaignLink = campaign =>
  step(
    'ar_ext_links',
    {
      action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
      payload: {operations: [{create: {campaign, field_type: 'SITELINK', asset: at('assets', '900')}}]},
    },
    ['ar_build'],
  );
const groupSignal = group =>
  step(
    'ar_signal',
    {
      action: 'google_ads_v23_asset_group_signal_mutate_asset_group_signals',
      payload: {operations: [{create: {asset_group: group, search_theme: {text: 'synthetic theme'}}}]},
    },
    ['ar_build'],
  );
/** The preflight of the build and one step after it; the check of that step. */
async function checked(f, after) {
  const out = await campaignPreflight(f.service, f.actor, [buildStep(), after]);
  const build = out.checks.find(c => c.step === 'ar_build');
  assert.equal(build.status, 'contract_checked', 'the build itself passes: ' + JSON.stringify(build.error));
  return out.checks.find(c => c.step === after.id);
}

test('R1: a campaign-asset link names the campaign the build creates at operation 1', async () => {
  const f = google();
  try {
    const check = await checked(f, campaignLink(ref(pointerTo(1, 'campaignResult'))));
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
    assert.equal(check.references_deferred, 1);
  } finally {
    f.close();
  }
});

test('R2: an asset-group signal names the asset group the build creates at operation 9', async () => {
  const f = google();
  try {
    const check = await checked(f, groupSignal(ref(pointerTo(9, 'assetGroupResult'))));
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
  } finally {
    f.close();
  }
});

test('R2b: the result field of each operation type a build creates is accepted at its own operation', async () => {
  const f = google();
  try {
    // The link of operation 10 (an asset group asset) is named by assetGroupAssetResult, and a later step may update it.
    const check = await checked(
      f,
      step(
        'ar_unlink',
        {
          action: 'google_ads_v23_asset_group_asset_mutate_asset_group_assets',
          payload: {operations: [{remove: ref(pointerTo(10, 'assetGroupAssetResult'))}]},
        },
        ['ar_build'],
      ),
    );
    assert.equal(check.status, 'contract_checked', JSON.stringify(check.error));
  } finally {
    f.close();
  }
});

test('R3: the result field of another operation type is refused INVALID_REFERENCE, naming the operation, its type and the pointer to send', async () => {
  const f = google();
  try {
    const check = await checked(f, groupSignal(ref(pointerTo(9, 'campaignResult'))));
    assert.equal(check.status, 'blocked');
    assertRefused({code: check.error.code}, 'INVALID_REFERENCE');
    assert.equal(check.error.details.operation, 9);
    assert.equal(check.error.details.operation_type, 'asset_group_operation');
    assert.equal(check.error.details.expected_pointer, pointerTo(9, 'assetGroupResult'));
    assert.equal(check.error.details.operations, pmaxBuild().length);
  } finally {
    f.close();
  }
});

test('R4: an operation the build does not have is refused INVALID_REFERENCE, naming how many it has', async () => {
  const f = google();
  try {
    const total = pmaxBuild().length;
    for (const i of [total, total + 40]) {
      const check = await checked(f, groupSignal(ref(pointerTo(i, 'assetGroupResult'))));
      assert.equal(check.status, 'blocked', String(i));
      assertRefused({code: check.error.code}, 'INVALID_REFERENCE');
      assert.equal(check.error.details.operations, total);
      assert.equal(check.error.details.operation, undefined, 'there is no such operation to name');
      assert.equal(check.error.details.received_pointer, pointerTo(i, 'assetGroupResult'));
    }
  } finally {
    f.close();
  }
});

test('R5: a snake_case pointer is refused, and the refusal names the camelCase form', async () => {
  const f = google();
  try {
    for (const snake of [
      '/data/mutate_operation_responses/1/campaign_result/resource_name',
      '/data/mutateOperationResponses/1/campaign_result/resourceName',
      '/data/mutateOperationResponses/1/campaignResult/resource_name',
    ]) {
      const check = await checked(f, campaignLink(ref(snake)));
      assert.equal(check.status, 'blocked', snake);
      assertRefused({code: check.error.code}, 'INVALID_REFERENCE');
      assert.equal(check.error.details.expected_pointer, pointerTo(1, 'campaignResult'), snake);
      assert.equal(check.error.details.received_pointer, snake);
    }
    // Any other pointer is refused with the grammar, and no operation is named.
    for (const other of [
      '/data/results/1/resourceName',
      '/data/mutateOperationResponses/1/campaignResult',
      '/data/mutateOperationResponses/x/campaignResult/resourceName',
    ]) {
      const check = await checked(f, campaignLink(ref(other)));
      assert.equal(check.status, 'blocked', other);
      assertRefused({code: check.error.code}, 'INVALID_REFERENCE');
      assert.equal(check.error.details.accepted_form, '/data/mutateOperationResponses/<i>/<result>/resourceName');
      assert.equal(check.error.details.expected_pointer, undefined, other);
    }
  } finally {
    f.close();
  }
});

// N1 (the gate stays): a reference whose pointer is right, to an operation of another type than the field needs, is refused by the step's own contract:
// the stand-in is the asset group's resource name, which is no campaign.
test('N1: a build operation that does not create the type a field needs is refused at the preflight', async () => {
  const f = google();
  try {
    const check = await checked(f, campaignLink(ref(pointerTo(9, 'assetGroupResult'))));
    assert.equal(check.status, 'blocked');
    assertRefused({code: check.error.code}, ['INVALID_ASSET_LINK', 'INVALID_ASSET_PARENT']);
  } finally {
    f.close();
  }
});

// A service mutate keeps its own form: the pointer of a build is no pointer of a service, and the other way round.
test('a build’s pointer is refused on a service predecessor, and a service pointer on a build', async () => {
  const f = google();
  try {
    const service = step('svc', {
        action: 'google_ads_v23_campaign_mutate_campaigns',
        payload: {
          operations: [
            {
              create: {
                name: 'Synthetic campaign',
                status: 'PAUSED',
                advertising_channel_type: 'SEARCH',
                campaign_budget: at('campaignBudgets', '5'),
                manual_cpc: {},
              },
            },
          ],
        },
      }),
      link = (pointer, from) =>
        step(
          'after',
          {
            action: 'google_ads_v23_campaign_asset_mutate_campaign_assets',
            payload: {
              operations: [
                {create: {campaign: {$ref: from + '#' + pointer}, field_type: 'SITELINK', asset: at('assets', '900')}},
              ],
            },
          },
          [from],
        );
    const wrong = await campaignPreflight(f.service, f.actor, [service, link(pointerTo(0, 'campaignResult'), 'svc')]);
    assert.equal(wrong.checks.find(c => c.step === 'after').status, 'blocked');
    const ok = await campaignPreflight(f.service, f.actor, [service, link('/data/results/0/resourceName', 'svc')]);
    assert.equal(ok.checks.find(c => c.step === 'after').status, 'contract_checked');
    const onBuild = await checked(f, campaignLink({$ref: 'ar_build#/data/results/1/resourceName'}));
    assert.equal(onBuild.status, 'blocked');
    assertRefused({code: onBuild.error.code}, 'INVALID_REFERENCE');
  } finally {
    f.close();
  }
});

// R7 (a journey): the build runs and is verified, then the step after it is prepared with the real campaign name read from the build’s own answer.
const searchBuild = [
  {
    campaign_budget_operation: {
      create: {
        resource_name: at('campaignBudgets', '-1'),
        name: 'Synthetic budget',
        amount_micros: '40000000',
        delivery_method: 'STANDARD',
      },
    },
  },
  {
    campaign_operation: {
      create: {
        resource_name: at('campaigns', '-2'),
        name: 'Synthetic campaign',
        status: 'PAUSED',
        advertising_channel_type: 'SEARCH',
        campaign_budget: at('campaignBudgets', '-1'),
        manual_cpc: {},
        network_settings: {target_google_search: true, target_search_network: false, target_content_network: false},
        contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    },
  },
];
async function plan(f, steps) {
  const created = await f.call('amcp_campaign', {action: 'create', name: 'Synthetic plan', brief: 'Synthetic.', steps});
  assert.equal(created.success, true, JSON.stringify(created).slice(0, 800));
  const id = created.data.id,
    call = input => f.call('amcp_campaign', {id, ...input});
  return {
    call,
    async approve({flag = true} = {}) {
      const preview = await call({action: 'approve'});
      assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 800));
      const out = await call({
        ...preview.data.next_call.arguments,
        ...(flag ? preview.data.next_call.add_after_user_approval : {}),
      });
      assert.equal(out.success, true, JSON.stringify(out).slice(0, 800));
      return preview.data;
    },
    async step(stepId) {
      return (await call({action: 'get', detail: 'full'})).data.steps.find(s => s.id === stepId);
    },
  };
}
test('R7: the step after a verified build is prepared with the real campaign the build created', async () => {
  const f = google();
  try {
    const p = await plan(f, [
      step('ar_build', {action: build, payload: {mutate_operations: searchBuild}}),
      step(
        'ar_group',
        {
          action: 'google_ads_v23_ad_group_mutate_ad_groups',
          payload: {
            operations: [
              {create: {campaign: ref(pointerTo(1, 'campaignResult')), name: 'Synthetic ad group', status: 'PAUSED'}},
            ],
          },
        },
        ['ar_build'],
      ),
    ]);
    await p.approve();
    const ran = await p.call({action: 'run'});
    assert.equal(ran.success, true, JSON.stringify(ran).slice(0, 800));
    assert.equal(ran.data.run.stopped, 'complete', JSON.stringify(ran.data.run));
    // The build created the budget (500) and the campaign (501); the ad group is made under that campaign by its real name.
    const made = f.writes.at(-1).body.operations[0].create.campaign;
    assert.equal(made, at('campaigns', '501'));
    assert.equal(f.db.ad_group.length, 1);
    assert.equal(f.db.ad_group[0].campaign, at('campaigns', '501'));
    assert.equal((await p.step('ar_group')).status, 'verified');
  } finally {
    f.close();
  }
});

// N2 (spend confirmation stays): a step that switches the build's campaign on asks for it, whatever the approval says of the build. The first round's test
// stopped at the build itself, which asks for the flag too, so the review of the step that names the build's campaign was never reached (the lead's review S4-4).
// The person now authorizes the build alone, through the build's own call, the build runs, and the step after it is prepared with the real campaign: the plan's
// approval, given without the flag, does not cover it, so the run stops there, and the step's own execute without the flag is refused by its review.
test('N2: a step that names the build’s campaign and switches it on is still refused without spend_change_confirmed, after the build ran', async () => {
  const f = google();
  try {
    const p = await plan(f, [
      step('ar_build', {action: build, payload: {mutate_operations: searchBuild}}),
      step(
        'ar_live',
        {
          action: 'google_ads_v23_campaign_mutate_campaigns',
          payload: {
            operations: [
              {update: {resource_name: ref(pointerTo(1, 'campaignResult')), status: 'ENABLED'}, update_mask: 'status'},
            ],
          },
        },
        ['ar_build'],
      ),
    ]);
    const preview = await p.approve({flag: false});
    assert.deepEqual(
      preview.approval.steps.filter(s => s.spend_effect === true).map(s => s.id),
      ['ar_build', 'ar_live'],
    );
    // The run stops at the build, which needs the flag: nothing is sent.
    const first = await p.call({action: 'run'});
    assert.equal(first.success, true, JSON.stringify(first).slice(0, 800));
    assert.equal(first.data.run.stopped, 'needs_spend_change_confirmed');
    assert.equal(first.data.step_id, 'ar_build');
    assert.equal(f.writes.length, 0, 'nothing was sent');
    // The person authorizes the build alone: its own call, with the flag its review asked for.
    const own = first.data.run.step_call;
    assert.equal(own.arguments.action, 'execute_next');
    const built = await f.call('amcp_campaign', {...own.arguments, ...own.add_after_user_approval});
    assert.equal(built.success, true, JSON.stringify(built).slice(0, 800));
    assert.equal(f.writes.length, 1, 'the build was sent');
    assert.equal((await p.step('ar_build')).status, 'verified');
    // The plan goes on to the step that names the build’s campaign. Its review asks for the flag, and the approval does not give it: the run stops, nothing more is sent.
    const second = await p.call({action: 'run'});
    assert.equal(second.success, true, JSON.stringify(second).slice(0, 800));
    assert.equal(second.data.run.stopped, 'needs_spend_change_confirmed');
    assert.match(second.data.run.reason, /ar_live/);
    assert.equal(f.writes.length, 1, 'the step after the build was not sent');
    // The step’s own execute without the flag is refused by its review, and the review is still there, unspent.
    const prepared = await p.call({action: 'prepare_next'});
    assert.equal(prepared.success, true, JSON.stringify(prepared).slice(0, 800));
    assert.equal(prepared.data.step_id, 'ar_live');
    assert.equal(prepared.data.execute_requirements.spend_change_confirmed, true);
    const refused = await f.call('amcp_campaign', prepared.data.next_call.arguments);
    assert.equal(refused.success, true, JSON.stringify(refused).slice(0, 800));
    assertRefused({code: refused.data.current.error.code}, 'SPEND_CONFIRMATION_REQUIRED');
    assert.equal(refused.data.current.status, 'review_ready');
    assert.equal(f.writes.length, 1, 'still only the build');
    assert.equal(
      f.db.campaign.find(c => c.resource_name === at('campaigns', '501')).status,
      'PAUSED',
      'the campaign is still paused',
    );
  } finally {
    f.close();
  }
});
