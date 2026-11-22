import test from 'node:test';
import assert from 'node:assert/strict';
import {step as providerStep, world} from './helpers/plan-reference-world.mjs';
import {approvalSummary} from '../dist/src/plan-approval.js';
import {assertRefused} from './helpers/assert-refused.mjs';

/**
 * Package r25-field3-refs, UNVERIFIED 2 of the analysis (AMCP-01): a plan approved before this change, whose step that names two different results counted as
 * spending only because its local compile failed on the collapsed stand-ins, now computes that it does not. The plan's approval summary binds each step's
 * spend effect (`summary_hash`), so the summary changes. The test is the stored approval: it never covers more than the summary it showed, the old
 * summary_hash no longer approves the plan (PLAN_CHANGED, the one re-approval), and the approval recorded from the current summary covers what that summary
 * shows. Synthetic Snapchat product sets; the old effects are the ones the old compile gave, written out here.
 *
 * What this test shows is the approve call: the old summary_hash is PLAN_CHANGED, and the re-approval covers what the current summary shows. The run of such
 * a stored approval is N8 of tests/plan-reference-lifecycle.test.mjs (the lead's review S4-5): `run` compares the plan hash only, so the stored approval
 * still runs the plan, and its spend confirmation reaches only the steps it showed as spending. This synthetic world sends nothing, so it cannot run.
 */
const gateway = 'snapchat_native_action',
  filter = {AVAILABILITY: {EQ: 'IN_STOCK'}};
const create = name => ({
  action: 'snapchat_catalogs_catalog_id_product_sets_create',
  params: {catalog_id: 'cat-1'},
  payload: {product_sets: [{name, filter}]},
});
const steps = () => [
  providerStep(gateway, 'set_a', create('Synthetic set A')),
  providerStep(gateway, 'set_b', create('Synthetic set B')),
  providerStep(
    gateway,
    'rename',
    {
      action: 'snapchat_catalogs_catalog_id_product_sets_update',
      params: {catalog_id: 'cat-1'},
      payload: {
        product_sets: [
          {id: {$ref: 'set_a#/data/product_sets/0/product_set/id'}, name: 'Synthetic one', filter},
          {id: {$ref: 'set_b#/data/product_sets/0/product_set/id'}, name: 'Synthetic two', filter},
        ],
      },
    },
    ['set_a', 'set_b'],
  ),
];

test('a plan approved when its step counted as spending: the old summary no longer approves it, and no approval covers more than the summary it showed', async () => {
  const w = world([gateway]);
  try {
    const created = await w.service.call(
      'amcp_campaign',
      {action: 'create', name: 'Synthetic plan', brief: 'Synthetic.', steps: steps()},
      w.actor,
    );
    assert.equal(created.success, true, JSON.stringify(created).slice(0, 600));
    const id = created.data.id,
      call = input => w.service.call('amcp_campaign', {id, ...input}, w.actor);
    // The current summary: the step that names two different results compiles, and does not spend.
    const preview = await call({action: 'approve'});
    assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 600));
    assert.deepEqual(
      preview.data.approval.steps.map(s => [s.id, s.spend_effect]),
      [
        ['set_a', false],
        ['set_b', false],
        ['rename', false],
      ],
    );
    assert.deepEqual(preview.data.approval.spend_steps, []);
    assert.equal(
      preview.data.next_call.add_after_user_approval,
      undefined,
      'no spending is offered for a plan that does not spend',
    );
    // The approval stored before this change: the summary its step counted as spending, as the failed compile made it, with the flag given.
    const run = w.store.document(w.actor.tenantId, 'campaign_run', id),
      old = approvalSummary(
        run,
        new Map([
          ['set_a', false],
          ['set_b', false],
          ['rename', true],
        ]),
      );
    assert.notEqual(old.summary_hash, preview.data.summary_hash, 'the spend effect is in the summary the hash binds');
    run.approval = {
      plan_hash: run.plan_hash,
      summary_hash: old.summary_hash,
      by: w.actor.userId,
      at: Date.now(),
      spend_change_confirmed: true,
      spend_steps: ['rename'],
      spend_effect_steps: ['rename'],
    };
    w.store.putDocument(w.actor.tenantId, 'campaign_run', id, run, run.revision);
    // The old summary_hash does not approve the plan as it now stands: the person is shown the current summary first.
    const stale = await call({
      action: 'approve',
      plan_hash: run.plan_hash,
      summary_hash: old.summary_hash,
      confirmed: true,
      spend_change_confirmed: true,
    });
    assertRefused(stale, 'PLAN_CHANGED');
    assert.equal(stale.error.details.summary_hash, preview.data.summary_hash, 'it names the current summary to show');
    // The approval of the current summary replaces the stored one: what it covers is what that summary shows, which is nothing that spends.
    const approved = await call({...preview.data.next_call.arguments});
    assert.equal(approved.success, true, JSON.stringify(approved).slice(0, 600));
    const now = w.store.document(w.actor.tenantId, 'campaign_run', id).approval;
    assert.equal(now.summary_hash, preview.data.summary_hash);
    assert.equal(now.spend_change_confirmed, false);
    assert.deepEqual(now.spend_steps, []);
    assert.deepEqual(now.spend_effect_steps, []);
  } finally {
    w.close();
  }
});
