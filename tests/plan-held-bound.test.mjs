import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerprint} from '../dist/src/workspace-core.js';
import {retireReview} from '../dist/src/write-record-repository.js';
import {T, approver, budgets, planned, stored} from './helpers/plan-lifecycle-kit.mjs';

/**
 * r25-planmodel, M8 of the review of 451169fd: a plan held for a continuation by an earlier release, which this release refuses to continue (a plan that activates a launch,
 * or one that retires catalog products: a new plan would not carry its gates, its second approver or its check of the catalog). The hold names a continuation that can never
 * be finished, and get named continue_as_new, whose refusal named get, for ten minutes, until the editor's cancel: two reads that named each other. Now the reads and the
 * refusals of such a plan name the read of the plan until its hold is stale, then the cancel that releases it, and never continue_as_new.
 */
const bindings = {
  'an activation plan': {
    activation_of: {id: 'launch', plan_hash: 'launch-hash', recipe_id: 'google_search_clicks', platform: 'google'},
  },
  'a plan that retires catalog products': {
    catalog_retirement: {retailer_ids: ['SKU-HELD'], availability: 'discontinued'},
  },
};
/** The plan as a continuation cut short before it made the new plan leaves it: held, the new plan not made, its review retired. */
async function held(binding) {
  const {x, id, review} = await planned(budgets(2)),
    {id: _id, revision, ...data} = stored(x, id),
    to = fingerprint({
      kind: 'campaign-create',
      tenant: T,
      user: 'operator',
      key:
        'continue-' +
        String(id)
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 80),
    });
  x.store.putDocument(
    T,
    'campaign_run',
    id,
    {
      ...data,
      ...binding,
      state: 'superseded',
      superseded_by: {pending: true, to, at: Date.now() - 1000, by: 'operator'},
    },
    revision,
  );
  assert.equal(retireReview(x.store, T, review, {plan_id: id, step_id: 'step1', reason: 'continued'}), 'marked');
  return {x, id, to};
}
const named = call =>
  call && {tool: call.tool, arguments: call.arguments, add_after_user_approval: call.add_after_user_approval};
const readCall = id => ({tool: 'amcp_campaign', arguments: {action: 'get', id}, add_after_user_approval: undefined});
const cancelCall = id => ({
  tool: 'amcp_campaign',
  arguments: {action: 'cancel', id},
  add_after_user_approval: {confirmed: true},
});
/** Every call the plan answers: the read, and the refusal of each action another person or the holder might make. */
const answers = (x, id) => [
  ['get', x.call('amcp_campaign', {action: 'get', id})],
  ['get full', x.call('amcp_campaign', {action: 'get', id, detail: 'full'})],
  ['prepare_next', x.call('amcp_campaign', {action: 'prepare_next', id})],
  ['execute_next', x.call('amcp_campaign', {action: 'execute_next', id, review_id: 'none', confirmed: true})],
  ['recover_step', x.call('amcp_campaign', {action: 'recover_step', id, step_id: 'step1', confirmed: true})],
  ['archive', x.call('amcp_campaign', {action: 'archive', id, confirmed: true})],
  [
    'continue_as_new (the person who held it)',
    x.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true}),
  ],
  [
    'continue_as_new (another person)',
    x.service.call('amcp_campaign', {action: 'continue_as_new', id, confirmed: true}, approver),
  ],
];
const nextOf = result => result.data?.next_call ?? result.error?.details?.next_call;

for (const [kind, binding] of Object.entries(bindings)) {
  test(
    'M8: ' +
      kind +
      ' held by an earlier release: the reads and refusals name the read of the plan until the hold is stale, then the cancel, and never continue_as_new',
    async () => {
      const {x, id} = await held(binding),
        realNow = Date.now;
      try {
        // Young: nothing can finish it, and nothing names the continuation; the read names itself, the person waits, and an editor's cancel is refused until the hold has stood.
        for (const [label, pending] of answers(x, id)) {
          const result = await pending,
            next = nextOf(result);
          assert.deepEqual(named(next), readCall(id), label + ' names the read of the plan: ' + JSON.stringify(next));
          assert.doesNotMatch(
            String(result.data?.notice ?? result.error?.message ?? ''),
            /continue_as_new/,
            label + ' does not tell anyone to repeat the continuation',
          );
        }
        const cancelled = await x.call('amcp_campaign', {action: 'cancel', id, confirmed: true});
        assert.equal(cancelled.success, false, 'an editor cannot cancel it yet');
        assert.equal(stored(x, id).state, 'superseded');
        assert.equal(stored(x, id).superseded_by.pending, true);
        // Stale: the cancel that releases it is named, by every read and refusal.
        Date.now = () => realNow() + 11 * 60000;
        for (const [label, pending] of answers(x, id)) {
          const result = await pending;
          assert.deepEqual(
            named(nextOf(result)),
            cancelCall(id),
            label + ' names the cancel: ' + JSON.stringify(nextOf(result)),
          );
        }
        // The call it names, as an editor makes it, releases the plan: cancelled, with no hold.
        const next = nextOf(await x.call('amcp_campaign', {action: 'get', id})),
          done = await x.call('amcp_campaign', {...next.arguments, ...next.add_after_user_approval});
        assert.equal(done.success, true, JSON.stringify(done.error ?? done).slice(0, 300));
        assert.equal(stored(x, id).state, 'cancelled');
        assert.equal(stored(x, id).superseded_by, undefined);
        assert.equal(x.writes(), 0, 'nothing was sent');
      } finally {
        Date.now = realNow;
        x.store.close();
      }
    },
  );
}
